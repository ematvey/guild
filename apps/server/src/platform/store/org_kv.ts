// Per-org and server-wide key/value settings: migration-free settings —
// the admin-configured assistant prompts, the auto-generated release
// signing seed.

import type { PlatformPool } from "../db.js";

/** Server-wide KV key holding the auto-generated release signing seed. */
export const SIGNING_SEED_KV = "release_signing_seed";
/** Org KV key holding the admin-configured assistant persona prompt. */
export const ASSISTANT_PROMPT_KEY = "assistant_system_prompt";
/** Org KV key holding the admin-configured "Approve for me" policy prompt. */
export const APPROVAL_POLICY_PROMPT_KEY = "assistant_approval_policy_prompt";

export class OrgKvStore {
  constructor(readonly pool: PlatformPool) {}

  async get(orgId: string, key: string): Promise<string | null> {
    const res = await this.pool.query("SELECT value FROM org_kv WHERE org_id = $1 AND key = $2", [orgId, key]);
    return (res.rows[0]?.value as string | undefined) ?? null;
  }

  async put(orgId: string, key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO org_kv (org_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value",
      [orgId, key, value],
    );
  }

  async delete(orgId: string, key: string): Promise<void> {
    await this.pool.query("DELETE FROM org_kv WHERE org_id = $1 AND key = $2", [orgId, key]);
  }
}

export class KvStore {
  constructor(readonly pool: PlatformPool) {}

  async get(key: string): Promise<string | null> {
    const res = await this.pool.query("SELECT value FROM server_kv WHERE key = $1", [key]);
    return (res.rows[0]?.value as string | undefined) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO server_kv (key, value, updated_at) VALUES ($1, $2, now()) " +
      "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, value],
    );
  }
}
