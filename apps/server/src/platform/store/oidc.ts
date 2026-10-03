// OIDC SSO configuration storage (crates/server/src/store/oidc.rs): one
// config per org; the client secret is encrypted at rest with the master
// key.

import { encryptSecret } from "../crypto.js";
import { ApiError } from "../http/error.js";
import type { PlatformPool } from "../db.js";
import { uuidv7 } from "../time.js";

export interface OidcConfigRow {
  org_id: string;
  issuer: string;
  client_id: string;
  encrypted_client_secret: string;
}

export class OidcStore {
  constructor(readonly pool: PlatformPool) {}

  /** Upserts the org's OIDC config. `clientSecret = null` keeps the stored
   *  encrypted secret (the edit form's "leave blank to keep"). */
  async upsert(
    orgId: string,
    issuer: string,
    clientId: string,
    clientSecret: string | null,
    masterKey: Buffer,
  ): Promise<void> {
    let encrypted: string;
    if (clientSecret !== null) {
      encrypted = encryptSecret(masterKey, clientSecret);
    } else {
      const existing = await this.get(orgId);
      if (!existing) {
        throw ApiError.badRequest("missing client_secret (no stored secret to keep)");
      }
      encrypted = existing.encrypted_client_secret;
    }
    await this.pool.query(
      `INSERT INTO oidc_configs (id, org_id, issuer, client_id, encrypted_client_secret)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE
       SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret`,
      [uuidv7(), orgId, issuer, clientId, encrypted],
    );
  }

  async get(orgId: string): Promise<OidcConfigRow | null> {
    const res = await this.pool.query<OidcConfigRow>(
      "SELECT org_id, issuer, client_id, encrypted_client_secret FROM oidc_configs WHERE org_id = $1",
      [orgId],
    );
    return res.rows[0] ?? null;
  }

  async remove(orgId: string): Promise<void> {
    await this.pool.query("DELETE FROM oidc_configs WHERE org_id = $1", [orgId]);
  }

  /** Guild is effectively single-org (bootstrap creates one); the public
   *  status endpoint and login flow use it to resolve the login target. */
  async firstOrgId(): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      "SELECT id FROM orgs ORDER BY created_at LIMIT 1",
    );
    return res.rows[0]?.id ?? null;
  }
}
