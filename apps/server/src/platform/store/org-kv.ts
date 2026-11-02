// Per-org and server-wide key/value settings: migration-free settings —
// the admin-configured assistant prompts, the auto-generated release
// signing seed.

import type { PlatformPool } from "../db.js";
import { notifyOrgIdentity } from "./orgs.js";

/** Server-wide KV key holding the auto-generated release signing seed. */
export const SIGNING_SEED_KV = "release_signing_seed";
/** Org KV key holding the admin-configured assistant persona prompt. */
export const ASSISTANT_PROMPT_KEY = "assistant_system_prompt";
/** Org KV key holding the admin-configured "Approve for me" policy prompt. */
export const APPROVAL_POLICY_PROMPT_KEY = "assistant_approval_policy_prompt";
/** Org KV key holding the admin-controlled telemetry switch. Absent = on;
 *  "0" = off. Clients never choose this themselves. */
export const TELEMETRY_ENABLED_KEY = "telemetry_enabled";

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

  /** The org's telemetry switch. Absent means on: a fresh workspace
   *  collects diagnostics until an admin turns it off. */
  async telemetryEnabled(orgId: string): Promise<boolean> {
    return (await this.get(orgId, TELEMETRY_ENABLED_KEY)) !== "0";
  }

  /** Admin write of the telemetry switch; repaints every member socket so
   *  the clients start or stop collecting without a reload. */
  async setTelemetryEnabled(orgId: string, enabled: boolean): Promise<void> {
    await this.put(orgId, TELEMETRY_ENABLED_KEY, enabled ? "1" : "0");
    await notifyOrgIdentity(this.pool, orgId);
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
