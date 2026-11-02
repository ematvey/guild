// Durable machine registry (migration 0046): one row per desktop pairing. The connection hub owns
// liveness; this table is the durable record the machines page and bind
// checks read. Writes happen at socket connect (upsert with fingerprint
// adoption) and on a 30s-throttled ping heartbeat (last_seen).

import { ApiError } from "../errors.js";
import { withTransaction, type PlatformPool, type PoolClient } from "../db.js";
import { pgTimestampToRfc3339 } from "../time.js";

export interface MachineRow {
  machine_id: string;
  org_id: string;
  user_id: string;
  label: string | null;
  hardware_fingerprint: string | null;
  os: string | null;
  os_version: string | null;
  app_version: string | null;
  last_ip: string | null;
  first_connected_at: string;
  last_connected_at: string;
  last_seen_at: string;
  re_paired_at: string | null;
}

const DB_COLUMNS =
  "machine_id, org_id, user_id, label, hardware_fingerprint, os, os_version, " +
  "app_version, last_ip, " +
  "to_char(first_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS first_connected_at, " +
  "to_char(last_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS last_connected_at, " +
  "to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS last_seen_at, " +
  "to_char(re_paired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS re_paired_at";

/** Result of a connect-time registration. `adopted_from` is set when the
 *  fingerprint matched an existing row of the same org and that row was
 *  re-keyed to the incoming machine_id: any live socket still registered
 *  under the old id must be displaced (singleton rule). */
export interface UpsertOutcome {
  row: MachineRow;
  adopted_from: string | null;
}

/** Normalizes the SQL-rendered timestamps into RFC 3339 with 0/3/6/9
 *  fraction digits — the shape the wire contract and the Rust clients
 *  parse. */
function toRow(db: MachineRow): MachineRow {
  return {
    ...db,
    first_connected_at: pgTimestampToRfc3339(db.first_connected_at),
    last_connected_at: pgTimestampToRfc3339(db.last_connected_at),
    last_seen_at: pgTimestampToRfc3339(db.last_seen_at),
    re_paired_at: db.re_paired_at === null ? null : pgTimestampToRfc3339(db.re_paired_at),
  };
}

/** Empty query values are stored as NULL, never as '' (desktop 0.4.0 omits
 *  the metadata params entirely; empty values would be worse than absent). */
function nonEmpty(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && value !== "" ? value : null;
}

/** Result of a deauthorization: the row is gone, or bound projects block it
 *  (their files live on that machine, so they are never silently re-homed).
 *  `session_hash` is the session the machine paired with, for revocation. */
export type DeauthorizeResult =
  | { kind: "removed"; session_hash: string | null }
  | { kind: "blocked"; projects: string[] }
  | { kind: "missing" };

export class MachineStore {
  constructor(readonly pool: PlatformPool) {}

  /** The (user_id, org_id) a machine row belongs to, or null when the id is
   *  unregistered. The connect-path ownership gate reads this before any hub
   *  slot is claimed: a registered machine connects only as its owning
   *  user. */
  async ownerOf(machineId: string): Promise<[string, string] | null> {
    const res = await this.pool.query<{ user_id: string; org_id: string }>(
      "SELECT user_id, org_id FROM machines WHERE machine_id = $1",
      [machineId],
    );
    const row = res.rows[0];
    return row ? [row.user_id, row.org_id] : null;
  }

  /** Registers a machine connect. A known machine_id of the same org AND
   *  same user is a reconnect (metadata refresh only, never a re-key); a
   *  known id owned by a different user is refused — client-issued ids are
   *  untrusted within an org too, so only the row's owner reconnects. An
   *  unknown machine_id is a new registration: a fingerprint match on the
   *  same org and same user adopts the old row — its machine_id is re-keyed
   *  to the incoming one (thread bindings keep working through the caller's
   *  id), and re_paired_at is stamped. No match inserts a fresh row.
   *
   *  A machine_id already registered to a DIFFERENT org is left untouched
   *  (client-issued ids make cross-org claims untrustworthy); the returned
   *  row is the untouched foreign row and the connect is not registered. */
  /** Tells the feed that the owner's registry rows moved. Runs inside the
   *  writing transaction, so the notify lands with the commit. */
  private async notifyWorkspace(client: Pick<PoolClient, "query">, orgId: string, userId: string): Promise<void> {
    await client.query("SELECT pg_notify('guild_workspace', $1)", [
      JSON.stringify({ org_id: orgId, user_id: userId }),
    ]);
  }

  async upsertConnected(
    orgId: string,
    userId: string,
    machineId: string,
    label: string | null,
    fingerprint: string | null,
    os: string | null,
    osVersion: string | null,
    appVersion: string | null,
    ip: string | null,
    sessionHash: string | null = null,
  ): Promise<UpsertOutcome> {
    label = nonEmpty(label);
    fingerprint = nonEmpty(fingerprint);
    os = nonEmpty(os);
    osVersion = nonEmpty(osVersion);
    appVersion = nonEmpty(appVersion);
    ip = nonEmpty(ip);
    sessionHash = nonEmpty(sessionHash);

    const { outcome, notify } = await withTransaction(this.pool, async (client) => {
      const existingRes = await client.query<MachineRow>(
        `SELECT ${DB_COLUMNS} FROM machines WHERE machine_id = $1 FOR UPDATE`,
        [machineId],
      );
      const existing = existingRes.rows[0] ?? null;

      if (existing !== null && existing.org_id !== orgId) {
        return { outcome: { row: toRow(existing), adopted_from: null }, notify: false };
      }

      if (existing !== null && existing.user_id !== userId) {
        // Same-org machine id claimed by another user: refuse. The
        // fingerprint is plaintext registry metadata any member can read, so
        // the id alone proves nothing about who may connect.
        throw ApiError.forbidden("this machine belongs to another user");
      }

      if (existing !== null) {
        // Reconnect of a known machine: refresh metadata and timestamps.
        // NULL metadata never erases what an earlier connect reported.
        const rowRes = await client.query<MachineRow>(
          `UPDATE machines SET
             label = COALESCE($2, label),
             hardware_fingerprint = COALESCE($3, hardware_fingerprint),
             os = COALESCE($4, os),
             os_version = COALESCE($5, os_version),
             app_version = COALESCE($6, app_version),
             last_ip = COALESCE($7, last_ip),
             session_hash = COALESCE($8, session_hash),
             last_connected_at = now(), last_seen_at = now()
           WHERE machine_id = $1
           RETURNING ${DB_COLUMNS}`,
          [machineId, label, fingerprint, os, osVersion, appVersion, ip, sessionHash],
        );
        return { outcome: { row: toRow(rowRes.rows[0]!), adopted_from: null }, notify: true };
      }

      // New registration: fingerprint adoption within the same org AND same
      // user (re-pair is same-user by definition; another member's
      // fingerprint is never adopted).
      if (fingerprint !== null) {
        const oldRes = await client.query<MachineRow>(
          `SELECT ${DB_COLUMNS} FROM machines
           WHERE org_id = $1 AND hardware_fingerprint = $2 AND user_id = $3
           ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE`,
          [orgId, fingerprint, userId],
        );
        const old = oldRes.rows[0];
        if (old) {
          // Same physical machine, new pairing identity: re-key the old row
          // to the incoming machine_id so thread bindings survive, and treat
          // the connect as a fresh pairing.
          const rowRes = await client.query<MachineRow>(
            `UPDATE machines SET
               machine_id = $2, user_id = $3,
               label = COALESCE($4, label),
               os = COALESCE($5, os),
               os_version = COALESCE($6, os_version),
               app_version = COALESCE($7, app_version),
               last_ip = COALESCE($8, last_ip),
               session_hash = COALESCE($9, session_hash),
               last_connected_at = now(), last_seen_at = now(),
               re_paired_at = now()
             WHERE machine_id = $1
             RETURNING ${DB_COLUMNS}`,
            [old.machine_id, machineId, userId, label, os, osVersion, appVersion, ip, sessionHash],
          );
          // Registry identity and all durable execution bindings move together.
          for (const table of ["projects", "chats"]) {
            await client.query(
              `UPDATE ${table} SET machine_id = $2 WHERE machine_id = $1 AND org_id = $3`,
              [old.machine_id, machineId, orgId],
            );
          }
          return { outcome: { row: toRow(rowRes.rows[0]!), adopted_from: old.machine_id }, notify: true };
        }
      }

      const rowRes = await client.query<MachineRow>(
        `INSERT INTO machines
           (machine_id, org_id, user_id, label, hardware_fingerprint, os, os_version, app_version, last_ip, session_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${DB_COLUMNS}`,
        [machineId, orgId, userId, label, fingerprint, os, osVersion, appVersion, ip, sessionHash],
      );
      return { outcome: { row: toRow(rowRes.rows[0]!), adopted_from: null }, notify: true };
    });
    if (notify) await this.notifyWorkspace(this.pool, orgId, userId);
    return outcome;
  }

  /** Removes a machine from the registry for good: the row goes, chats that
   *  ran on it fall back to the server executor, and the caller revokes the
   *  returned session so the app cannot re-register on its next reconnect.
   *  Projects keep their binding — deleting a project is the user's call —
   *  so a machine with bound projects refuses instead. */
  async deauthorize(orgId: string, userId: string, machineId: string): Promise<DeauthorizeResult> {
    return withTransaction(this.pool, async (client): Promise<DeauthorizeResult> => {
      const rowRes = await client.query<{ session_hash: string | null }>(
        `SELECT session_hash FROM machines
         WHERE machine_id = $1 AND org_id = $2 AND user_id = $3 FOR UPDATE`,
        [machineId, orgId, userId],
      );
      const row = rowRes.rows[0];
      if (row === undefined) return { kind: "missing" };
      const boundRes = await client.query<{ name: string }>(
        "SELECT name FROM projects WHERE machine_id = $1 AND org_id = $2 ORDER BY name",
        [machineId, orgId],
      );
      if (boundRes.rows.length > 0) {
        return { kind: "blocked", projects: boundRes.rows.map((r) => r.name) };
      }
      await client.query(
        "UPDATE chats SET machine_id = NULL, machine_label = NULL WHERE machine_id = $1 AND org_id = $2",
        [machineId, orgId],
      );
      await client.query("DELETE FROM machines WHERE machine_id = $1", [machineId]);
      await this.notifyWorkspace(client, orgId, userId);
      return { kind: "removed", session_hash: row.session_hash };
    });
  }

  /** Refreshes the liveness timestamp; called off the ping heartbeat on a
   *  30s throttle. */
  async lastSeen(machineId: string): Promise<void> {
    await this.pool.query("UPDATE machines SET last_seen_at = now() WHERE machine_id = $1", [
      machineId,
    ]);
  }

  /** All registry rows of one user's org that belong to them. */
  async listForUser(orgId: string, userId: string): Promise<MachineRow[]> {
    const res = await this.pool.query<MachineRow>(
      `SELECT ${DB_COLUMNS} FROM machines
       WHERE org_id = $1 AND user_id = $2
       ORDER BY last_connected_at DESC`,
      [orgId, userId],
    );
    return res.rows.map(toRow);
  }

  /** True when the machine is durably registered to the user or their org —
   *  the bind check. Offline machines stay bindable; hub liveness is not
   *  consulted. */
  async bindable(machineId: string, userId: string, orgId: string): Promise<boolean> {
    const res = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM machines
         WHERE machine_id = $1 AND (user_id = $2 OR org_id = $3)
       ) AS ok`,
      [machineId, userId, orgId],
    );
    return res.rows[0]!.ok;
  }
}
