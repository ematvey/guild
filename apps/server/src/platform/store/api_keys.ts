// API keys for the public OpenAI-compatible endpoint. Plaintext keys are
// shown once at creation; only
// the sha256 hash is stored.

import { randomBytes } from "node:crypto";
import { sha256Hex } from "../crypto.js";
import { ApiError } from "../errors.js";
import { uuidv7 } from "../time.js";
import type { PlatformPool } from "../db.js";

export interface ApiKeyRow {
  id: string;
  org_id: string;
  created_by: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
  /** Owner when the key was minted by a user from their own settings;
   *  NULL for admin-minted org keys. */
  user_id: string | null;
}

/** Row plus the creator's current auth generation (authentication requires
 *  it to still match — a password reset supersedes minted credentials). */
interface ApiKeyDbRow extends ApiKeyRow {
  auth_generation: number;
}

const KEY_COLUMNS =
  "id, org_id, created_by, name, prefix, " +
  "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, " +
  "to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS revoked_at, " +
  "user_id";

export function hashKey(plaintext: string): string {
  return sha256Hex(plaintext);
}

/** What create returns: the row plus the one-time plaintext key. */
export interface NewApiKey {
  key: ApiKeyRow;
  plaintext: string;
}

export class ApiKeyStore {
  constructor(readonly pool: PlatformPool) {}

  /** Creates a key and returns it in plaintext exactly once. `generation`
   *  is the minting session's auth generation (null: the creator's current
   *  one); the key is stamped with it, the INSERT refuses a superseded
   *  generation, and authentication requires the creator's current
   *  generation to still match. */
  async create(
    orgId: string,
    createdBy: string,
    name: string,
    userId: string | null,
    generation: number | null,
  ): Promise<NewApiKey> {
    const plaintext = `gk_${randomBytes(24).toString("hex")}`;
    const prefix = plaintext.slice(0, 10);
    const id = uuidv7();
    const res = await this.pool.query<ApiKeyRow>(
      "INSERT INTO api_keys (id, org_id, created_by, name, prefix, key_hash, user_id, auth_generation) " +
        "SELECT $1, $2, $3, $4, $5, $6, $7, u.auth_generation FROM users u " +
        "WHERE u.id = $3 AND u.auth_generation = COALESCE($8, u.auth_generation) " +
        `RETURNING ${KEY_COLUMNS}`,
      [id, orgId, createdBy, name, prefix, hashKey(plaintext), userId, generation],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.unauthorized("invalid or expired session");
    return { key: row, plaintext };
  }

  async list(orgId: string): Promise<ApiKeyRow[]> {
    const res = await this.pool.query<ApiKeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return res.rows;
  }

  /** Keys owned by one user (the settings-level view). */
  async listForUser(userId: string): Promise<ApiKeyRow[]> {
    const res = await this.pool.query<ApiKeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return res.rows;
  }

  async revoke(orgId: string, id: string): Promise<void> {
    const res = await this.pool.query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL",
      [id, orgId],
    );
    if (res.rowCount === 0) throw ApiError.notFound("api key not found");
  }

  /** Revokes a key the user owns (no org filter — the owner id is the
   *  authority here). */
  async revokeOwned(userId: string, id: string): Promise<void> {
    const res = await this.pool.query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [id, userId],
    );
    if (res.rowCount === 0) throw ApiError.notFound("api key not found");
  }

  /** Resolves a bearer token to its key row (null if unknown, revoked, or
   *  minted at an auth generation the creator's password reset superseded). */
  async authenticate(token: string): Promise<ApiKeyRow | null> {
    const res = await this.pool.query<ApiKeyDbRow>(
      `SELECT k.id, k.org_id, k.created_by, k.name, k.prefix, k.created_at, k.revoked_at, k.user_id, k.auth_generation
       FROM api_keys k JOIN users u ON u.id = k.created_by
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND k.auth_generation = u.auth_generation`,
      [hashKey(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    return row;
  }
}
