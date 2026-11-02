// Admin-configured integration plugins: config rows per org, and
// AES-256-GCM encrypted per-integration secrets that never leave the store
// in plaintext except through resolve.

import { ApiError } from "../errors.js";
import { decryptSecret, encryptSecret, maskSecretLen } from "../crypto.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";
import { withTransaction, type PlatformPool, type PoolClient } from "../db.js";
import { jsonbText } from "../domain/text.js";

/** An integration row, fields in wire order. */
export interface IntegrationRow {
  id: string;
  org_id: string;
  name: string;
  config: unknown;
  enabled: boolean;
}

/** SecretRow (name, updated_at, masked) as the admin secrets listing. */
export interface SecretRow {
  name: string;
  updated_at: string;
  masked: string;
}

function row(r: Record<string, unknown>): IntegrationRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    name: r.name as string,
    config: r.config,
    enabled: r.enabled === true,
  };
}

export class IntegrationStore {
  constructor(readonly pool: PlatformPool) {}

  /** Idempotent upsert: replaces config and enabled flag; the per-tool
   *  curation map (`config.tools`) is preserved from the existing row —
   *  the PUT tools endpoint is its only writer. Returns the row's stable
   *  id. */
  async upsert(
    orgId: string,
    name: string,
    config: unknown,
    enabled: boolean,
    db: PlatformPool | PoolClient = this.pool,
  ): Promise<string> {
    const res = await db.query(
      "INSERT INTO integrations (org_id, name, config, enabled) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (org_id, name) " +
        "DO UPDATE SET config = jsonb_set($3, '{tools}', " +
        "COALESCE(integrations.config->'tools', '{}'::jsonb), true), " +
        "enabled = $4, updated_at = now() " +
        "RETURNING id",
      [orgId, name, jsonbText(config), enabled],
    );
    return res.rows[0]!.id as string;
  }

  /** Saves an integration's settings and its submitted secrets in one
   *  transaction: a failure part-way leaves neither. */
  async saveWithSecrets(
    secrets: IntegrationSecretStore,
    orgId: string,
    name: string,
    config: unknown,
    enabled: boolean,
    submitted: Iterable<[string, string]>,
    masterKey: Buffer,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      for (const [secretName, plaintext] of submitted) {
        await secrets.upsert(orgId, name, secretName, plaintext, masterKey, client);
      }
      await this.upsert(orgId, name, config, enabled, client);
    });
  }

  /** Sets one tool's per-tool curation (`enabled`, `approval`) under a row
   *  lock: the read-modify-write of `config.tools` runs in one transaction —
   *  two concurrent PUTs (or a racing settings save) must never drop each
   *  other's curation entry. Entries for not-currently-declared tools are
   *  allowed — they are how a preset survives a bundle republish. Returns
   *  the integration row's name (for the caller's org audit event). */
  async curateTool(orgId: string, id: string, tool: string, enabled: boolean, approval: string): Promise<string> {
    return withTransaction(this.pool, async (client) => {
      const rowRes = await client.query(
        "SELECT config, name FROM integrations WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [orgId, id],
      );
      const stored = rowRes.rows[0];
      if (stored === undefined) throw ApiError.notFound("unknown integration");
      const name = stored.name as string;
      const config =
        stored.config !== null && typeof stored.config === "object" && !Array.isArray(stored.config)
          ? { ...(stored.config as Record<string, unknown>) }
          : {};
      const tools =
        config["tools"] !== null && typeof config["tools"] === "object" && !Array.isArray(config["tools"])
          ? { ...(config["tools"] as Record<string, unknown>) }
          : {};
      tools[tool] = { enabled, approval };
      config["tools"] = tools;
      await client.query("UPDATE integrations SET config = $2, updated_at = now() WHERE org_id = $1 AND id = $3", [
        orgId,
        jsonbText(config),
        id,
      ]);
      return name;
    });
  }

  async get(orgId: string, id: string): Promise<IntegrationRow | null> {
    const res = await this.pool.query(
      "SELECT id, org_id, name, config, enabled FROM integrations WHERE org_id = $1 AND id = $2",
      [orgId, id],
    );
    return res.rows[0] === undefined ? null : row(res.rows[0]);
  }

  async getByName(orgId: string, name: string): Promise<IntegrationRow | null> {
    const res = await this.pool.query(
      "SELECT id, org_id, name, config, enabled FROM integrations WHERE org_id = $1 AND name = $2",
      [orgId, name],
    );
    return res.rows[0] === undefined ? null : row(res.rows[0]);
  }

  async list(orgId: string): Promise<IntegrationRow[]> {
    const res = await this.pool.query(
      "SELECT id, org_id, name, config, enabled FROM integrations WHERE org_id = $1 ORDER BY name",
      [orgId],
    );
    return res.rows.map((r: Record<string, unknown>) => row(r));
  }

  /** Enabled rows only, in name order — the plugin resolver's input. */
  async listEnabled(orgId: string): Promise<IntegrationRow[]> {
    const res = await this.pool.query(
      "SELECT id, org_id, name, config, enabled FROM integrations WHERE org_id = $1 AND enabled ORDER BY name",
      [orgId],
    );
    return res.rows.map((r: Record<string, unknown>) => row(r));
  }

  /** Removes one integration by id — the config row AND its stored
   *  secrets, transactionally (secrets are keyed by slug with no FK, so a
   *  re-added integration with the same slug must not silently revive the
   *  old credentials). */
  async delete(orgId: string, id: string): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const nameRes = await client.query("SELECT name FROM integrations WHERE org_id = $1 AND id = $2", [orgId, id]);
      const name = nameRes.rows[0]?.name as string | undefined;
      if (name !== undefined) {
        await client.query("DELETE FROM integrations WHERE org_id = $1 AND id = $2", [orgId, id]);
        await client.query("DELETE FROM integration_secrets WHERE org_id = $1 AND integration = $2", [orgId, name]);
      }
    });
  }
}

export class IntegrationSecretStore {
  constructor(readonly pool: PlatformPool) {}

  /** Idempotent upsert: replaces the encrypted value and the preview. */
  async upsert(
    orgId: string,
    integration: string,
    name: string,
    plaintext: string,
    masterKey: Buffer,
    db: PlatformPool | PoolClient = this.pool,
  ): Promise<void> {
    const encrypted = encryptSecret(masterKey, plaintext);
    await db.query(
      "INSERT INTO integration_secrets (org_id, integration, name, secret_enc, masked) " +
        "VALUES ($1, $2, $3, $4, $5) " +
        "ON CONFLICT (org_id, integration, name) " +
        "DO UPDATE SET secret_enc = $4, masked = $5, updated_at = now()",
      [orgId, integration, name, encrypted, maskSecretLen([...plaintext].length)],
    );
  }

  /** Stored secret names only (no decryption). */
  async names(orgId: string, integration: string): Promise<string[]> {
    const res = await this.pool.query(
      "SELECT name FROM integration_secrets WHERE org_id = $1 AND integration = $2 ORDER BY name",
      [orgId, integration],
    );
    return res.rows.map((r: { name: string }) => r.name);
  }

  /** Names, timestamps and masked previews — values never appear in
   *  listings. Rows written before the current preview format (empty
   *  masked, or the legacy last-4 shape) get their preview recomputed
   *  here: the value is decrypted server-side and re-masked, never
   *  returned. */
  async list(orgId: string, integration: string, masterKey: Buffer): Promise<SecretRow[]> {
    const res = await this.pool.query(
      "SELECT name, " +
        utcText("updated_at") +
        " AS updated_at, masked " +
        "FROM integration_secrets WHERE org_id = $1 AND integration = $2 ORDER BY name",
      [orgId, integration],
    );
    const rows = res.rows.map((r: Record<string, unknown>) => ({
      name: r.name as string,
      updated_at: r.updated_at as string,
      masked: r.masked as string,
    }));
    for (const r of rows) {
      if (r.masked === "" || [...r.masked].some((c) => c !== "•")) {
        const resolved = await this.resolve(orgId, integration, [r.name], masterKey);
        const masked = maskSecretLen([...resolved[0]![1]].length);
        await this.pool.query(
          "UPDATE integration_secrets SET masked = $3 WHERE org_id = $1 AND integration = $2 AND name = $4",
          [orgId, integration, masked, r.name],
        );
        r.masked = masked;
      }
    }
    return rows.map((r) => ({ ...r, updated_at: pgTimestampToRfc3339(r.updated_at) }));
  }

  /** Decrypts the requested names (returned in the requested order).
   *  Throws 409 `missing_secrets` when any declared name has no stored
   *  secret. */
  async resolve(orgId: string, integration: string, names: string[], masterKey: Buffer): Promise<[string, string][]> {
    const res = await this.pool.query(
      "SELECT name, secret_enc FROM integration_secrets WHERE org_id = $1 AND integration = $2",
      [orgId, integration],
    );
    const stored = res.rows as { name: string; secret_enc: string }[];
    const missing = names.filter((n) => !stored.some((s) => s.name === n));
    if (missing.length > 0) {
      throw ApiError.conflict("missing_secrets", `missing secrets: ${missing.join(", ")}`);
    }
    return names.map((name) => {
      const enc = stored.find((s) => s.name === name)!.secret_enc;
      return [name, decryptSecret(masterKey, enc)];
    });
  }
}
