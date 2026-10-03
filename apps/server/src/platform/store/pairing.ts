// One-time pairing tokens for desktop-app enrollment (crates/server/src/
// store/pairing.rs): the webapp issues a short-lived code the desktop app
// redeems for a normal session. Only the sha256 hash of the secret is
// stored; plaintext is shown once at creation.

import { sha256Hex } from "../crypto.js";
import { ApiError } from "../http/error.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, uuidv7 } from "../time.js";

export interface PairingTokenRow {
  id: string;
  org_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface NewPairingToken {
  token: PairingTokenRow;
  /** The one-time plaintext secret — never stored server-side. */
  secret: string;
}

interface PairingTokenDbRow {
  id: string;
  org_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

function toRow(db: PairingTokenDbRow): PairingTokenRow {
  return {
    ...db,
    created_at: pgTimestampToRfc3339(db.created_at),
    expires_at: pgTimestampToRfc3339(db.expires_at),
    used_at: db.used_at === null ? null : pgTimestampToRfc3339(db.used_at),
  };
}

/** Redeemable code format: `g1|<server_url>|<hex secret>`. The server URL is
 *  routing info (not secret) and is kept visible on purpose — the pairing
 *  screen shows the user where they are about to connect. Only the last
 *  segment is the credential; here we extract it from a full code. */
export function secretFromCode(code: string): string | null {
  if (!code.startsWith("g1|")) return null;
  const rest = code.slice("g1|".length);
  const parts = rest.split("|");
  if (parts.length !== 2) return null;
  const [server, secret] = parts as [string, string];
  if (
    server === "" ||
    secret === "" ||
    !/^[0-9a-fA-F]+$/.test(secret)
  ) {
    return null;
  }
  return secret;
}

export class PairingStore {
  constructor(readonly pool: PlatformPool) {}

  /** Creates a one-time token, returning the plaintext secret exactly once.
   *  `generation` is the minting session's auth generation (null: the
   *  user's current one); the token is stamped with it and the INSERT
   *  refuses a generation a reset already superseded. */
  async create(
    orgId: string,
    userId: string,
    ttlMinutes: number,
    generation: number | null,
  ): Promise<NewPairingToken> {
    const secret = randomHex();
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const res = await this.pool.query<PairingTokenDbRow>(
      `INSERT INTO pairing_tokens (id, org_id, user_id, secret_hash, expires_at, auth_generation)
       SELECT $1, $2, $3, $4, $5, u.auth_generation FROM users u
       WHERE u.id = $3 AND u.auth_generation = COALESCE($6, u.auth_generation)
       RETURNING id, org_id, user_id,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
         to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS used_at`,
      [id, orgId, userId, sha256Hex(secret), expiresAt, generation],
    );
    if (res.rows.length === 0) {
      throw ApiError.unauthorized("invalid or expired session");
    }
    return { token: toRow(res.rows[0]!), secret };
  }

  /** Redeems a secret: single-use (used_at must be null) and unexpired.
   *  Returns the owning user id and the token's STAMPED auth generation
   *  (the minting session's) — the session issuance stamps it, so a
   *  password reset that commits after the mint (or between redemption and
   *  issuance) leaves the created session unable to validate. */
  async redeemWithGeneration(secret: string): Promise<[string, string, number]> {
    const res = await this.pool.query<{ org_id: string; user_id: string; auth_generation: number }>(
      `UPDATE pairing_tokens SET used_at = now()
       WHERE secret_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING org_id, user_id, auth_generation`,
      [sha256Hex(secret)],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.unauthorized("invalid or expired pairing code");
    return [row.org_id, row.user_id, row.auth_generation];
  }

  /** Outstanding (unused, unexpired) tokens for a user. */
  async listOutstanding(userId: string): Promise<PairingTokenRow[]> {
    const res = await this.pool.query<PairingTokenDbRow>(
      `SELECT id, org_id, user_id,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
         to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS used_at
       FROM pairing_tokens
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY pairing_tokens.created_at DESC`,
      [userId],
    );
    return res.rows.map(toRow);
  }

  /** Revokes an outstanding token. Owner-only. */
  async revoke(userId: string, id: string): Promise<void> {
    const res = await this.pool.query(
      "DELETE FROM pairing_tokens WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    if (res.rowCount === 0) throw ApiError.notFound("no such pairing token");
  }
}

function randomHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
