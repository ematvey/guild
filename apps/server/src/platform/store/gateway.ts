// Gateway records: org provider keys (encrypted at rest) and model routes.

import { decryptSecret, encryptSecret } from "../crypto.js";
import { ApiError } from "../errors.js";
import { uuidv7 } from "../time.js";
import { withTransaction, type PlatformPool } from "../db.js";

/** Resolved route for a model call. */
export interface RouteRow {
  provider: string;
  /** Wire protocol the provider speaks ("openai" | "anthropic") — selects
   *  the provider implementation. A JOIN miss falls back to the slug (the
   *  pre-0040 layout, where slugs were protocols). */
  protocol: string;
  baseUrl: string;
  /** Decrypted org key — never leaves the server. */
  apiKey: string;
  priceIn: number;
  priceOut: number;
  /** Monthly spend cap in USD; null = unlimited (spec §4.2/§4.5). */
  quotaMonthlyUsd: number | null;
  /** Model produces chain-of-thought reasoning (reasoning_content). */
  reasoning: boolean;
  /** Native input modalities (migration 0025): subset of {image, audio,
   *  video}; empty = text-only. */
  modalities: string[];
  /** Model context window in tokens (migration 0024); null = unset. */
  contextWindow: number | null;
  /** Max output tokens per model call (migration 0035); null = provider
   *  default. */
  maxOutputTokens: number | null;
  /** Sampling temperature (migration 0072); null = provider default (the
   *  model's generation_config). Applied when the client does not send its
   *  own temperature. */
  temperature: number | null;
}

/** Admin-facing route row: everything except the decrypted key (serde
 *  field names match the Rust AdminRouteRow). */
export interface AdminRouteRow {
  model: string;
  /** Display name shown to chat users; empty = use the model id. */
  alias: string;
  provider: string;
  enabled: boolean;
  price_per_mtok_in_usd: number;
  price_per_mtok_out_usd: number;
  quota_monthly_usd: number | null;
  reasoning: boolean;
  context_window: number | null;
  max_output_tokens: number | null;
  temperature: number | null;
  modalities: string[];
}

/** Admin-facing provider row: metadata + a length-only bullet preview of
 *  the stored key, never the secret. */
export interface ProviderRow {
  provider: string;
  name: string;
  protocol: string;
  base_url: string;
  /** One bullet per stored key character (capped); null when the key
   *  cannot be decrypted for preview (e.g. master key rotated). */
  key_masked: string | null;
}

/** Wire protocols Guild can speak. A provider picks one; its name is
 *  free-form. */
export const PROTOCOLS = ["openai", "anthropic"];

/** Derives the stable slug routes reference from a provider's display
 *  name. */
export function providerSlug(name: string): string {
  const slug = [...name.toLowerCase()]
    .map((c) => (/[a-z0-9]/.test(c) ? c : "-"))
    .join("");
  const parts = slug.split("-").filter((s) => s !== "");
  return parts.length === 0 ? "provider" : parts.join("-");
}

export class GatewayStore {
  constructor(readonly pool: PlatformPool) {}

  /** Creates a provider row; an existing row with the same (org, slug) is
   *  fully replaced (legacy upsert semantics). Callers wanting a strict
   *  create check existence first (the admin API 409s on duplicates). */
  async createProvider(
    orgId: string,
    slug: string,
    name: string,
    protocol: string,
    baseUrl: string,
    plaintextKey: string,
    masterKey: Buffer,
  ): Promise<void> {
    const encrypted = encryptSecret(masterKey, plaintextKey);
    await this.pool.query(
      "INSERT INTO provider_keys (id, org_id, provider, name, protocol, base_url, encrypted_key) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7) " +
        "ON CONFLICT (org_id, provider) " +
        "DO UPDATE SET name = EXCLUDED.name, protocol = EXCLUDED.protocol, " +
        "base_url = EXCLUDED.base_url, encrypted_key = EXCLUDED.encrypted_key",
      [uuidv7(), orgId, slug, name, protocol, baseUrl, encrypted],
    );
  }

  /** Updates a provider's metadata; the key is replaced only when
   *  `plaintextKey` is non-null (blank field = keep current). */
  async updateProvider(
    orgId: string,
    slug: string,
    name: string,
    protocol: string,
    baseUrl: string,
    plaintextKey: string | null,
    masterKey: Buffer,
  ): Promise<boolean> {
    let res = await this.pool.query(
      "UPDATE provider_keys SET name = $3, protocol = $4, base_url = $5 WHERE org_id = $1 AND provider = $2",
      [orgId, slug, name, protocol, baseUrl],
    );
    if (plaintextKey !== null) {
      const encrypted = encryptSecret(masterKey, plaintextKey);
      res = await this.pool.query(
        "UPDATE provider_keys SET encrypted_key = $3 WHERE org_id = $1 AND provider = $2",
        [orgId, slug, encrypted],
      );
    }
    return (res.rowCount ?? 0) > 0;
  }

  async getProvider(
    orgId: string,
    slug: string,
    masterKey: Buffer,
  ): Promise<ProviderRow | null> {
    const res = await this.pool.query<{
      provider: string;
      name: string;
      protocol: string;
      base_url: string;
      encrypted_key: string;
    }>(
      "SELECT provider, name, protocol, base_url, encrypted_key FROM provider_keys WHERE org_id = $1 AND provider = $2",
      [orgId, slug],
    );
    const row = res.rows[0];
    if (!row) return null;
    return this.toProviderRow(row, masterKey);
  }

  /** Provider rows for the org's admin settings (metadata + key-length
   *  preview, no secrets). */
  async listProviders(orgId: string, masterKey: Buffer): Promise<ProviderRow[]> {
    const res = await this.pool.query<{
      provider: string;
      name: string;
      protocol: string;
      base_url: string;
      encrypted_key: string;
    }>(
      "SELECT provider, name, protocol, base_url, encrypted_key FROM provider_keys WHERE org_id = $1 ORDER BY name, provider",
      [orgId],
    );
    return res.rows.map((row) => this.toProviderRow(row, masterKey));
  }

  /** Removes a provider; routes referencing it stop resolving until a new
   *  provider with the same slug is created. */
  async deleteProvider(orgId: string, slug: string): Promise<void> {
    await this.pool.query("DELETE FROM provider_keys WHERE org_id = $1 AND provider = $2", [orgId, slug]);
  }

  async deleteRoute(orgId: string, model: string): Promise<void> {
    await this.pool.query("DELETE FROM model_routes WHERE org_id = $1 AND model = $2", [orgId, model]);
  }

  /** Enabled routes selectable in chats; the alias is the user-visible
   *  label, empty when the admin has not named the route. */
  async listModels(orgId: string): Promise<{ model: string; alias: string }[]> {
    const res = await this.pool.query<{ model: string; alias: string }>(
      "SELECT model, alias FROM model_routes WHERE org_id = $1 AND enabled ORDER BY model",
      [orgId],
    );
    return res.rows;
  }

  /** The route's display name, or null when the route is gone or unnamed. */
  async aliasOf(orgId: string, model: string): Promise<string | null> {
    const res = await this.pool.query<{ alias: string }>(
      "SELECT alias FROM model_routes WHERE org_id = $1 AND model = $2",
      [orgId, model],
    );
    const alias = res.rows[0]?.alias ?? null;
    return alias === "" ? null : alias;
  }

  /** The model's context window (thread gauge); null when no route or the
   *  column is unset. */
  async contextWindow(orgId: string, model: string): Promise<number | null> {
    const res = await this.pool.query<{ context_window: number | null }>(
      "SELECT context_window FROM model_routes WHERE org_id = $1 AND model = $2",
      [orgId, model],
    );
    return res.rows[0]?.context_window ?? null;
  }

  /** Full route rows for the org's admin settings (no secrets: the
   *  provider key itself is never returned). */
  async listRoutes(orgId: string): Promise<AdminRouteRow[]> {
    const res = await this.pool.query<AdminRouteRow>(
      "SELECT model, alias, provider, enabled, price_per_mtok_in_usd, price_per_mtok_out_usd, " +
        "quota_monthly_usd, reasoning, context_window, max_output_tokens, temperature, modalities " +
        "FROM model_routes WHERE org_id = $1 ORDER BY model",
      [orgId],
    );
    return res.rows;
  }

  /** Creates or updates a route. When `originalModel` differs from
   *  `model`, the existing route row is renamed in place (its id keys the
   *  route, so a retyped id must move the row, not create a second one).
   *  Both paths run in one transaction, so the uniqueness checks are the
   *  indexes: a duplicate id or display name is a 409, never a lost race. */
  async upsertRoute(
    orgId: string,
    originalModel: string,
    model: string,
    alias: string,
    provider: string,
    enabled: boolean,
    priceIn: number,
    priceOut: number,
    quotaMonthlyUsd: number | null,
    reasoning: boolean,
    contextWindow: number | null,
    maxOutputTokens: number | null,
    temperature: number | null,
    modalities: string[],
  ): Promise<void> {
    try {
      await withTransaction(this.pool, async (client) => {
        if (originalModel !== model) {
          const res = await client.query(
            "UPDATE model_routes SET model = $3, alias = $4, provider = $5, enabled = $6, " +
              "price_per_mtok_in_usd = $7, price_per_mtok_out_usd = $8, quota_monthly_usd = $9, " +
              "reasoning = $10, context_window = $11, max_output_tokens = $12, temperature = $13, " +
              "modalities = $14 WHERE org_id = $1 AND model = $2",
            [orgId, originalModel, model, alias, provider, enabled, priceIn, priceOut, quotaMonthlyUsd, reasoning, contextWindow, maxOutputTokens, temperature, modalities],
          );
          if ((res.rowCount ?? 0) === 0) throw ApiError.notFound(`no route for model ${originalModel}`);
        } else {
          await client.query(
            "INSERT INTO model_routes (org_id, model, alias, provider, enabled, price_per_mtok_in_usd, price_per_mtok_out_usd, " +
              "quota_monthly_usd, reasoning, context_window, max_output_tokens, temperature, modalities) " +
              "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) " +
              "ON CONFLICT (org_id, model) " +
              "DO UPDATE SET alias = EXCLUDED.alias, provider = EXCLUDED.provider, enabled = EXCLUDED.enabled, " +
              "price_per_mtok_in_usd = EXCLUDED.price_per_mtok_in_usd, " +
              "price_per_mtok_out_usd = EXCLUDED.price_per_mtok_out_usd, " +
              "quota_monthly_usd = EXCLUDED.quota_monthly_usd, reasoning = EXCLUDED.reasoning, " +
              "context_window = EXCLUDED.context_window, max_output_tokens = EXCLUDED.max_output_tokens, " +
              "temperature = EXCLUDED.temperature, modalities = EXCLUDED.modalities",
            [orgId, model, alias, provider, enabled, priceIn, priceOut, quotaMonthlyUsd, reasoning, contextWindow, maxOutputTokens, temperature, modalities],
          );
        }
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        throw ApiError.conflict(
          "already_exists",
          (error as { constraint?: string }).constraint === "model_routes_org_alias_idx"
            ? `a route named '${alias}' already exists`
            : `a route for '${model}' already exists`,
        );
      }
      throw error;
    }
  }

  /** Resolves a model to its provider route with the decrypted org key.
   *  The key never leaves the server (spec §4.2). */
  async resolveRoute(orgId: string, model: string, masterKey: Buffer): Promise<RouteRow> {
    const res = await this.pool.query<{
      provider: string;
      protocol: string | null;
      base_url: string | null;
      encrypted_key: string | null;
      price_per_mtok_in_usd: number;
      price_per_mtok_out_usd: number;
      enabled: boolean;
      quota_monthly_usd: number | null;
      reasoning: boolean;
      context_window: number | null;
      max_output_tokens: number | null;
      temperature: number | null;
      modalities: string[];
    }>(
      "SELECT r.provider, k.protocol, k.base_url, k.encrypted_key, " +
        "r.price_per_mtok_in_usd, r.price_per_mtok_out_usd, r.enabled, " +
        "r.quota_monthly_usd, r.reasoning, r.context_window, " +
        "r.max_output_tokens, r.temperature, r.modalities " +
        "FROM model_routes r " +
        "LEFT JOIN provider_keys k ON k.org_id = r.org_id AND k.provider = r.provider " +
        "WHERE r.org_id = $1 AND r.model = $2",
      [orgId, model],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound(`no route for model ${model}`);
    if (!row.enabled) {
      throw ApiError.conflict("model_disabled", `model ${model} is disabled`);
    }
    if (row.encrypted_key === null) {
      throw ApiError.conflict("key_missing", `no provider key for ${row.provider}`);
    }
    // No provider row (deleted after the route was made): the route cannot
    // resolve — same failure shape as a missing key.
    if (row.base_url === null) {
      throw ApiError.conflict("key_missing", `no provider row for ${row.provider}`);
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(masterKey, row.encrypted_key);
    } catch (error) {
      throw ApiError.internal(`key decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A route whose provider row is gone still names a protocol — a JOIN
    // miss falls back to treating the slug as the protocol (the pre-0040
    // layout, where slugs were protocols).
    const protocol = row.protocol ?? row.provider;
    return {
      provider: row.provider,
      protocol,
      baseUrl: row.base_url,
      apiKey,
      priceIn: row.price_per_mtok_in_usd,
      priceOut: row.price_per_mtok_out_usd,
      quotaMonthlyUsd: row.quota_monthly_usd,
      reasoning: row.reasoning,
      modalities: row.modalities ?? [],
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      temperature: row.temperature,
    };
  }

  private toProviderRow(
    row: { provider: string; name: string; protocol: string; base_url: string; encrypted_key: string },
    masterKey: Buffer,
  ): ProviderRow {
    let keyMasked: string | null = null;
    try {
      keyMasked = maskSecretLen(decryptSecret(masterKey, row.encrypted_key).length);
    } catch {
      keyMasked = null;
    }
    return {
      provider: row.provider,
      name: row.name,
      protocol: row.protocol,
      base_url: row.base_url,
      key_masked: keyMasked,
    };
  }
}

/** One bullet per stored character, capped so very long secrets don't blow
 *  out the placeholder line. */
function maskSecretLen(len: number): string {
  return "•".repeat(Math.min(Math.max(len, 1), 48));
}
