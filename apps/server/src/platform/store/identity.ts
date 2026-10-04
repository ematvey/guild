// Orgs, users (managed + OIDC accounts), sessions — the TypeScript port of
// crates/server/src/store/identity.rs over the existing platform tables.
// Column meanings are verbatim from crates/server/migrations/*.sql.

import { randomToken, sha256Hex, verifyPassword, hashPassword } from "../crypto.js";
import { ApiError } from "../http/error.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, uuidv7 } from "../time.js";
import { EventStore } from "./events.js";

/** UserListRow (crates/server/src/store/identity.rs declaration order) —
 *  the admin user list and team-member lists share this shape. */
export interface UserListRow {
  id: string;
  email: string;
  role: string;
  identity_type: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  identity_type: string;
  display_name: string | null;
  avatar_url: string | null;
  /** The auth generation of the session this row was validated through
   *  (undefined for rows read any other way). Credentials minted by the
   *  request are stamped with it. */
  session_generation?: number;
}

const USER_COLUMNS =
  "id, org_id, email, role, identity_type, display_name, avatar_url";

interface UserAuthGenDbRow extends UserRow {
  password_hash: string;
  auth_generation: number;
}

export class IdentityStore {
  constructor(readonly pool: PlatformPool) {}

  /** Creates the first org + admin user. No-op if the email already has a
   *  user (reconnect flow); refuses new emails once users exist. The
   *  check-and-insert runs under an advisory lock inside one transaction:
   *  two concurrent bootstraps must not both pass the "no users yet" check. */
  async ensureBootstrapAdmin(email: string, password: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('guild:bootstrap'))");
      const existing = await client.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
        [email],
      );
      if (existing.rows.length > 0) {
        await client.query("COMMIT");
        return existing.rows[0]!.id;
      }
      const count = await client.query<{ count: number }>("SELECT COUNT(*) AS count FROM users");
      if (count.rows[0]!.count !== 0) {
        throw new Error("org already has users");
      }
      if ([...password].length < 8) {
        throw new Error("password must be at least 8 characters");
      }
      const orgId = uuidv7();
      const userId = uuidv7();
      const hash = await hashPassword(password);
      await client.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [orgId, "org"]);
      await client.query(
        "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) " +
          "VALUES ($1, $2, $3, $4, 'admin', 'managed')",
        [userId, orgId, email, hash],
      );
      await client.query("COMMIT");
      return userId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Finds an existing user by email within an org (any identity type). */
  async findByEmail(orgId: string, email: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE org_id = $1 AND email = $2`,
      [orgId, email],
    );
    return res.rows[0] ?? null;
  }

  /** Email lookup across orgs (bootstrap/single-org flows). */
  async findByEmailAny(email: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
      [email],
    );
    return res.rows[0] ?? null;
  }

  async getUser(id: string): Promise<UserRow> {
    const res = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    if (res.rows.length === 0) throw ApiError.notFound("no such user");
    return res.rows[0]!;
  }

  /** The user's approval policy (crates/server/src/store/identity.rs
   *  approval): "no such user" (404) is distinct from "user with NULL
   *  policy" — the latter is the normal server-default case. */
  async approval(userId: string): Promise<unknown> {
    const res = await this.pool.query<{ approval: unknown }>(
      "SELECT approval FROM users WHERE id = $1",
      [userId],
    );
    if (res.rows.length === 0) throw ApiError.notFound("no such user");
    return res.rows[0]!.approval;
  }

  /** Stores (or with null, clears) the user's approval policy. */
  async setApproval(userId: string, approval: unknown): Promise<void> {
    await this.pool.query(
      "UPDATE users SET approval = $2 WHERE id = $1",
      [userId, approval],
    );
  }

  /** Creates a managed user (admin console): email + password + role. A
   *  duplicate email is a 409; the org event "member.joined" is
   *  best-effort. */
  async createUserManaged(orgId: string, email: string, password: string, role: string): Promise<UserRow> {
    const hash = await hashPassword(password);
    try {
      const res = await this.pool.query<UserRow>(
        `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
         VALUES ($1, $2, $3, $4, $5, 'managed')
         RETURNING ${USER_COLUMNS}`,
        [uuidv7(), orgId, email, hash, role],
      );
      const user = res.rows[0]!;
      // org event: member joined; best-effort
      try {
        await new EventStore(this.pool).emit(orgId, "member.joined", { email, user_id: user.id });
      } catch {
        // best-effort
      }
      return user;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("email_taken", "a user with this email already exists");
      }
      throw error;
    }
  }

  /** Provisions an OIDC user (random unusable password, member role). */
  async createOidcUser(
    orgId: string,
    email: string,
    displayName: string | null,
    avatarUrl: string | null,
  ): Promise<UserRow> {
    const unusable = randomToken().slice(0, 48);
    const hash = await hashPassword(unusable);
    const res = await this.pool.query<UserRow>(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type, display_name, avatar_url)
       VALUES ($1, $2, $3, $4, 'member', 'oidc', $5, $6)
       RETURNING ${USER_COLUMNS}`,
      [uuidv7(), orgId, email, hash, displayName, avatarUrl],
    );
    return res.rows[0]!;
  }

  /** Refreshes the OIDC-synced profile (name, avatar) after a login whose
   *  IdP claims differ from what is stored. */
  async updateOidcProfile(
    userId: string,
    displayName: string | null,
    avatarUrl: string | null,
  ): Promise<void> {
    await this.pool.query("UPDATE users SET display_name = $2, avatar_url = $3 WHERE id = $1", [
      userId,
      displayName,
      avatarUrl,
    ]);
  }

  /** Password authentication. Returns the user's auth generation, which the
   *  session issuance must stamp: a reset that commits after this validation
   *  bumps the generation, so any session created from this stale validation
   *  never validates. */
  async authenticateWithGeneration(email: string, password: string): Promise<[UserRow, number]> {
    const res = await this.pool.query<UserAuthGenDbRow>(
      `SELECT ${USER_COLUMNS}, password_hash, auth_generation FROM users WHERE email = $1`,
      [email],
    );
    const row = res.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new ApiError(401, "invalid_credentials", "invalid email or password");
    }
    const { password_hash: _ph, auth_generation: _ag, ...user } = row;
    return [user, row.auth_generation];
  }

  /** Session creation stamping the user's CURRENT auth generation. */
  async createSession(userId: string): Promise<[string, string]> {
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, auth_generation)
       VALUES ($1, $2, $3, (SELECT auth_generation FROM users WHERE id = $2))`,
      [sha256Hex(token), userId, new Date(Date.now() + 30 * 24 * 3600 * 1000)],
    );
    return [uuidv7(), token];
  }

  /** Session issuance from a credential validated EARLIER (password
   *  verification or pairing-code redemption): the session stamps the
   *  generation captured at validation, so a password reset that committed
   *  in between leaves this session unable to validate. */
  async createSessionForCredential(userId: string, authGeneration: number): Promise<[string, string]> {
    const token = randomToken();
    await this.pool.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at, auth_generation) VALUES ($1, $2, $3, $4)",
      [sha256Hex(token), userId, new Date(Date.now() + 30 * 24 * 3600 * 1000), authGeneration],
    );
    return [uuidv7(), token];
  }

  async validateSession(token: string): Promise<UserRow> {
    const res = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS}, s.auth_generation AS session_generation
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND s.auth_generation = u.auth_generation`,
      [sha256Hex(token)],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.unauthorized("invalid or expired session");
    return row;
  }

  /** Refresh only a still-valid session whose auth generation matches the
   *  user's (a reset makes the session dead, not refreshable). Revocation
   *  and expiry are final. */
  async refreshSession(token: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE sessions s SET expires_at = now() + interval '30 days'
       FROM users u
       WHERE s.user_id = u.id AND s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > now() AND s.auth_generation = u.auth_generation`,
      [sha256Hex(token)],
    );
    if (res.rowCount === 0) throw ApiError.unauthorized("invalid or expired session");
  }

  async revokeSession(token: string): Promise<void> {
    await this.pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [
      sha256Hex(token),
    ]);
  }

  /** The (session_hash, expires_at) a live bearer token maps to — the ws
   *  ticket mints this identity (crates/server/src/store/identity.rs
   *  session_grant). Only a still-valid session resolves. */
  async sessionGrant(token: string): Promise<[string, Date]> {
    const hash = sha256Hex(token);
    return [hash, await this.sessionExpiry(hash)];
  }

  /** The expiry of a still-valid session row by token hash; invalid/expired
   *  or generation-superseded rows are unauthorized. */
  async sessionExpiry(hash: string): Promise<Date> {
    const res = await this.pool.query<{ expires_at: Date }>(
      `SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND s.auth_generation = u.auth_generation`,
      [hash],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.unauthorized("invalid or expired session");
    return new Date(row.expires_at);
  }

  /** Admin user list (UserListRow: id, email, role, identity_type,
   *  created_at). */
  async listUsers(orgId: string): Promise<UserListRow[]> {
    const res = await this.pool.query(
      "SELECT id, email, role, identity_type, " +
      "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at " +
      "FROM users WHERE org_id = $1 ORDER BY created_at",
      [orgId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      email: r.email as string,
      role: r.role as string,
      identity_type: r.identity_type as string,
      created_at: pgTimestampToRfc3339(r.created_at as string),
    }));
  }

  /** Updates a managed user (role change and/or password reset); omitted
   *  fields stay unchanged. The user must belong to the org. A password
   *  reset revokes the user's sessions, pairing tokens, and api keys — the
   *  old credentials must not keep working. Demoting the org's last admin
   *  is a 409. */
  async updateUser(
    orgId: string,
    userId: string,
    role: string | null,
    password: string | null,
  ): Promise<UserListRow> {
    const hash = password === null ? null : await hashPassword(password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // All admin removals serialize on the same org row, including deletes.
      await client.query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE", [orgId]);
      const targetRes = await client.query("SELECT role FROM users WHERE id = $1 AND org_id = $2", [userId, orgId]);
      const targetRole = (targetRes.rows[0]?.role as string | undefined) ?? null;
      if (targetRole === "admin" && role !== null && role !== "admin") {
        const othersRes = await client.query(
          "SELECT count(*) FROM users WHERE org_id = $1 AND role = 'admin' AND id <> $2",
          [orgId, userId],
        );
        if (Number(othersRes.rows[0].count) === 0) {
          throw ApiError.conflict("last_admin", "cannot demote the last admin");
        }
      }
      const res = await client.query(
        "UPDATE users SET role = COALESCE($2::text, role), " +
        "password_hash = COALESCE($3::text, password_hash), " +
        "auth_generation = CASE WHEN $3::text IS NOT NULL THEN auth_generation + 1 ELSE auth_generation END " +
        "WHERE id = $1 AND org_id = $4 " +
        "RETURNING id, email, role, identity_type, " +
        "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at",
        [userId, role, hash, orgId],
      );
      if (res.rows.length === 0) throw ApiError.notFound("no such user");
      if (password !== null) {
        await client.query("DELETE FROM pairing_tokens WHERE user_id = $1 AND used_at IS NULL", [userId]);
        await client.query(
          "UPDATE api_keys SET revoked_at = now() WHERE (user_id = $1 OR created_by = $1) AND revoked_at IS NULL",
          [userId],
        );
        await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [userId]);
      }
      await client.query("COMMIT");
      const r = res.rows[0] as Record<string, unknown>;
      return {
        id: r.id as string,
        email: r.email as string,
        role: r.role as string,
        identity_type: r.identity_type as string,
        created_at: pgTimestampToRfc3339(r.created_at as string),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Deletes a user inside one transaction; refuses to remove the org's
   *  last admin. The org lock serializes all removals and demotions. */
  async deleteUser(orgId: string, userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE", [orgId]);
      const targetRes = await client.query(
        "SELECT role FROM users WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [orgId, userId],
      );
      const role = targetRes.rows[0]?.role as string | undefined;
      if (role === undefined) throw ApiError.notFound("no such user");
      const deleted =
        role === "admin"
          ? (
              await client.query(
                "DELETE FROM users WHERE id = $1 AND (role <> 'admin' OR " +
                "(SELECT COUNT(*) FROM users WHERE org_id = $2 AND role = 'admin' AND id <> $1) > 0)",
                [userId, orgId],
              )
            ).rowCount ?? 0
          : (await client.query("DELETE FROM users WHERE id = $1", [userId])).rowCount ?? 0;
      if (deleted === 0) {
        throw ApiError.conflict("last_admin", "cannot delete the last admin");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
