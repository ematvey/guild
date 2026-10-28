// Org event log + emission (spec §4.6/§4.8): emitters insert the record and
// NOTIFY the guild_events
// channel; the WebSocket feed (M5) delivers the fan-out.

import { jsonbText, type PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, uuidv7 } from "../time.js";

export const NOTIFY_CHANNEL = "guild_events";

export interface EventRow {
  id: string;
  org_id: string;
  kind: string;
  payload: unknown;
  created_at: string;
}

export class EventStore {
  constructor(readonly pool: PlatformPool) {}

  /** Records an event and notifies subscribers in one transaction. */
  async emit(orgId: string, kind: string, payload: unknown): Promise<EventRow> {
    const id = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<EventRow>(
        `INSERT INTO events (id, org_id, kind, payload) VALUES ($1, $2, $3, $4)
         RETURNING id, org_id, kind, payload, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
        [id, orgId, kind, jsonbText(payload ?? null)],
      );
      const notifyPayload = JSON.stringify({ org_id: orgId, event_id: id, kind });
      await client.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, notifyPayload]);
      await client.query("COMMIT");
      const row = inserted.rows[0]!;
      return { ...row, created_at: pgTimestampToRfc3339(row.created_at) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(orgId: string, limit: number): Promise<EventRow[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT id, org_id, kind, payload,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM events WHERE org_id = $1 ORDER BY events.created_at DESC LIMIT $2`,
      [orgId, Math.min(Math.max(limit, 1), 500)],
    );
    return res.rows.map((row) => ({ ...row, created_at: pgTimestampToRfc3339(row.created_at) }));
  }

  async get(orgId: string, id: string): Promise<EventRow | null> {
    const res = await this.pool.query<EventRow>(
      `SELECT id, org_id, kind, payload,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM events WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    const row = res.rows[0];
    return row ? { ...row, created_at: pgTimestampToRfc3339(row.created_at) } : null;
  }

  /** Reverse-chronological events whose kind matches any of the given
   *  LIKE prefixes (e.g. 'registry.%', 'skill.%') — the skills activity
   *  feed's query. */
  async listKindPrefixed(orgId: string, prefixes: string[], limit: number): Promise<EventRow[]> {
    const clauses = prefixes.map((_, i) => `kind LIKE $${i + 2}`).join(" OR ");
    const res = await this.pool.query<EventRow>(
      `SELECT id, org_id, kind, payload,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM events WHERE org_id = $1 AND (${clauses}) ORDER BY created_at DESC LIMIT $${prefixes.length + 2}`,
      [orgId, ...prefixes, Math.min(Math.max(limit, 1), 500)],
    );
    return res.rows.map((row) => ({ ...row, created_at: pgTimestampToRfc3339(row.created_at) }));
  }
}
