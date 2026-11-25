// Per-org and server-wide key/value settings: migration-free settings —
// the admin-configured assistant prompts and release-channel approvals.

import { traitNames } from "@guild/integration-sdk";
import type { PlatformPool, PoolClient } from "../db.js";
import { notifyOrgIdentity } from "./orgs.js";

/** Org KV key holding configured Trait providers by instance slug. */
export const TRAIT_BINDINGS_KEY = "integration_trait_bindings";

export function parseTraitBindings(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const known = new Set(traitNames());
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => known.has(entry[0]) && typeof entry[1] === "string" && entry[1] !== "",
      ),
    );
  } catch {
    return {};
  }
}

export async function lockTraitBindings(client: PoolClient, orgId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${TRAIT_BINDINGS_KEY}:${orgId}`]);
}

/** Org KV key holding the admin-configured assistant persona prompt. */
export const ASSISTANT_PROMPT_KEY = "assistant_system_prompt";
/** Org KV key holding the admin-configured "Approve for me" policy prompt. */
export const APPROVAL_POLICY_PROMPT_KEY = "assistant_approval_policy_prompt";
/** Org KV key holding the admin-controlled telemetry switch. Absent = on;
 *  "0" = off. Clients never choose this themselves. */
export const TELEMETRY_ENABLED_KEY = "telemetry_enabled";
/** Org KV key holding the admin's remote-image policy for agent content. */
export const REMOTE_IMAGES_KEY = "remote_images";

/** How clients treat a remote (http/https) image in agent content: load it
 *  at once, behind a click, or never. Attachments and inline images are
 *  not remote and always load. */
export type RemoteImagesPolicy = "auto" | "click" | "never";
export const REMOTE_IMAGES_POLICIES: readonly RemoteImagesPolicy[] = ["auto", "click", "never"];

export class OrgKvStore {
  constructor(readonly pool: PlatformPool) {}

  async get(orgId: string, key: string, db: PlatformPool | PoolClient = this.pool): Promise<string | null> {
    const res = await db.query("SELECT value FROM org_kv WHERE org_id = $1 AND key = $2", [orgId, key]);
    return (res.rows[0]?.value as string | undefined) ?? null;
  }

  async put(orgId: string, key: string, value: string, db: PlatformPool | PoolClient = this.pool): Promise<void> {
    await db.query(
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

  /** The org's remote-image policy. Absent means `auto`. */
  async remoteImages(orgId: string): Promise<RemoteImagesPolicy> {
    const value = await this.get(orgId, REMOTE_IMAGES_KEY);
    return REMOTE_IMAGES_POLICIES.includes(value as RemoteImagesPolicy) ? (value as RemoteImagesPolicy) : "auto";
  }

  /** Admin write of the remote-image policy; repaints every member socket. */
  async setRemoteImages(orgId: string, policy: RemoteImagesPolicy): Promise<void> {
    await this.put(orgId, REMOTE_IMAGES_KEY, policy);
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
