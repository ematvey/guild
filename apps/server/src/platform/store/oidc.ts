// OIDC SSO storage: one config per org (the client secret is encrypted at
// rest with the master key) and one link per user — the refresh token the
// login flow stored, which activity revalidation replays.

import { encryptSecret } from "../crypto.js";
import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { uuidv7 } from "../time.js";

export interface OidcConfigRow {
  org_id: string;
  issuer: string;
  client_id: string;
  encrypted_client_secret: string;
}

/** The user's link to the IdP: the refresh token the login flow stored and
 *  the endpoint that replays it. */
export interface OidcIdentityRow {
  user_id: string;
  token_endpoint: string;
  encrypted_refresh_token: string;
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

  // ---------- per-user links ----------

  /** Stores (or rewrites) the user's IdP link and stamps the check as
   *  fresh: the login that just succeeded IS the check. */
  async saveIdentity(userId: string, tokenEndpoint: string, encryptedRefreshToken: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO oidc_identities (user_id, token_endpoint, encrypted_refresh_token, checked_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
       SET token_endpoint = EXCLUDED.token_endpoint,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           checked_at = now()`,
      [userId, tokenEndpoint, encryptedRefreshToken],
    );
  }

  async identity(userId: string): Promise<OidcIdentityRow | null> {
    const res = await this.pool.query<OidcIdentityRow>(
      "SELECT user_id, token_endpoint, encrypted_refresh_token FROM oidc_identities WHERE user_id = $1",
      [userId],
    );
    return res.rows[0] ?? null;
  }

  /** Claims the user's next recheck: true for exactly one caller per
   *  interval, across processes. The claim moves `checked_at` forward, so a
   *  failed recheck waits out the interval instead of hammering the IdP. */
  async claimRecheck(userId: string, intervalSeconds: number): Promise<boolean> {
    const res = await this.pool.query(
      "UPDATE oidc_identities SET checked_at = now() " +
        "WHERE user_id = $1 AND checked_at < now() - make_interval(secs => $2::double precision)",
      [userId, intervalSeconds],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Guild is effectively single-org (bootstrap creates one); the public
   *  status endpoint and login flow use it to resolve the login target. */
  async firstOrgId(): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>("SELECT id FROM orgs ORDER BY created_at LIMIT 1");
    return res.rows[0]?.id ?? null;
  }
}
