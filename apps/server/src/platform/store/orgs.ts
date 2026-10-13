// Organization settings: the workspace's display name and logo (crates/
// server/src/store/orgs.rs). The logo bytes live in object storage under
// `orgs/{org_id}/logo.{ext}`; the row carries the serving URL.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";

export interface OrgSettings {
  name: string;
  logo_url: string | null;
}

export class OrgStore {
  constructor(readonly pool: PlatformPool) {}

  async get(orgId: string): Promise<OrgSettings> {
    const res = await this.pool.query<{ name: string; logo_url: string | null }>(
      "SELECT name, logo_url FROM orgs WHERE id = $1",
      [orgId],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("organization not found");
    return { name: row.name, logo_url: row.logo_url };
  }

  async setName(orgId: string, name: string): Promise<void> {
    await this.pool.query("UPDATE orgs SET name = $2 WHERE id = $1", [orgId, name]);
  }

  async setLogoUrl(orgId: string, url: string | null): Promise<void> {
    await this.pool.query("UPDATE orgs SET logo_url = $2 WHERE id = $1", [orgId, url]);
  }
}
