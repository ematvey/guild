// Per-user key/value settings — the user-scoped mirror of org_kv. Holds
// per-user preferences that need no migration per key (the chat view mode).

import type { PlatformPool } from "../db.js";

export class UserKvStore {
  constructor(readonly pool: PlatformPool) {}

  async get(userId: string, key: string): Promise<string | null> {
    const res = await this.pool.query("SELECT value FROM user_kv WHERE user_id = $1 AND key = $2", [userId, key]);
    return (res.rows[0]?.value as string | undefined) ?? null;
  }

  async put(userId: string, key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO user_kv (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value",
      [userId, key, value],
    );
  }

  async delete(userId: string, key: string): Promise<void> {
    await this.pool.query("DELETE FROM user_kv WHERE user_id = $1 AND key = $2", [userId, key]);
  }
}
