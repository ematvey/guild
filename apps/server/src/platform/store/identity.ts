// Orgs, users (managed + OIDC accounts), sessions — the TypeScript port of
// crates/server/src/store/identity.rs over the existing platform tables.
// Column meanings are verbatim from crates/server/migrations/*.sql.

import { randomToken, sha256Hex, verifyPassword, hashPassword } from "../crypto.js";
import { ApiError } from "../http/error.js";
import type { PlatformPool } from "../db.js";
import { uuidv7 } from "../time.js";

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
}
