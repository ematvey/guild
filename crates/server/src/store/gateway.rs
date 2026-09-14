//! Gateway records: org provider keys (encrypted at rest) and model routes
//! (spec §4.2).

use crate::crypto;
use crate::http::error::ApiError;
use uuid::Uuid;

/// (provider, protocol, base_url, encrypted key, price in, price out,
/// enabled, quota, reasoning flag, context window, max output tokens)
type RouteQueryRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    f64,
    f64,
    bool,
    Option<f64>,
    bool,
    Option<i64>,
    Option<i64>,
    Vec<String>,
);

/// Resolved route for a model call. Plain data so it can be journaled
/// through Restate run steps.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RouteRow {
    pub provider: String,
    /// Wire protocol the provider speaks ("openai" | "anthropic") — selects
    /// the provider implementation. Defaults for journals written before
    /// providers carried a protocol (0040).
    #[serde(default = "default_protocol")]
    pub protocol: String,
    pub base_url: String,
    /// Decrypted org key — never leaves the server.
    pub api_key: String,
    pub price_in: f64,
    pub price_out: f64,
    /// Monthly spend cap in USD; None = unlimited (spec §4.2/§4.5).
    pub quota_monthly_usd: Option<f64>,
    /// Route metadata: model produces chain-of-thought reasoning
    /// (reasoning_content) — design §B.3.
    pub reasoning: bool,
    /// Native input modalities (migration 0025): subset of {image, audio,
    /// video}; empty = text-only.
    pub modalities: Vec<String>,
    /// Model context window in tokens (migration 0024); None = unset —
    /// callers fall back to their own default (thread readout: 128000).
    pub context_window: Option<i64>,
    /// Max output tokens per model call (migration 0035); None = provider
    /// default. Anthropic requires an explicit max_tokens — this is the
    /// route-configurable knob.
    pub max_output_tokens: Option<i64>,
}

/// Route metadata without the decrypted key — safe to journal in durable
/// workflow storage, where step outputs persist. The secret is re-resolved
/// inside each provider-call step instead of traveling through the journal.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RouteMeta {
    pub provider: String,
    /// Wire protocol (see RouteRow); defaults for pre-0040 journals.
    #[serde(default = "default_protocol")]
    pub protocol: String,
    pub base_url: String,
    pub price_in: f64,
    pub price_out: f64,
    pub quota_monthly_usd: Option<f64>,
    pub reasoning: bool,
    pub modalities: Vec<String>,
    pub context_window: Option<i64>,
}

fn default_protocol() -> String {
    "openai".to_string()
}

impl RouteRow {
    pub fn meta(&self) -> RouteMeta {
        RouteMeta {
            provider: self.provider.clone(),
            protocol: self.protocol.clone(),
            base_url: self.base_url.clone(),
            price_in: self.price_in,
            price_out: self.price_out,
            quota_monthly_usd: self.quota_monthly_usd,
            reasoning: self.reasoning,
            modalities: self.modalities.clone(),
            context_window: self.context_window,
        }
    }
}

/// Admin-facing route row: everything except the decrypted key (derive:
/// Serialize for the admin settings GET).
#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct AdminRouteRow {
    pub model: String,
    pub provider: String,
    pub enabled: bool,
    pub price_per_mtok_in_usd: f64,
    pub price_per_mtok_out_usd: f64,
    pub quota_monthly_usd: Option<f64>,
    pub reasoning: bool,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub modalities: Vec<String>,
}

/// Admin-facing provider row: metadata only, never the secret.
#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ProviderRow {
    /// Stable slug model routes reference.
    pub provider: String,
    /// Display name — an org's label for the endpoint ("openai" is a
    /// protocol, not a name).
    pub name: String,
    /// Wire protocol ("openai" | "anthropic").
    pub protocol: String,
    pub base_url: String,
}

pub struct GatewayStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> GatewayStore<'a> {
    /// Legacy shape: the slug doubles as display name and protocol. Kept for
    /// test seeding; the admin surface uses `create_provider`/`update_provider`.
    pub async fn upsert_provider_key(
        &self,
        org_id: Uuid,
        provider: &str,
        base_url: &str,
        plaintext_key: &str,
        master_key: &[u8; 32],
    ) -> anyhow::Result<()> {
        self.create_provider(org_id, provider, provider, provider, base_url, plaintext_key, master_key)
            .await
    }

    /// Creates a provider row; an existing row with the same (org, slug) is
    /// fully replaced (legacy upsert semantics). Callers wanting a strict
    /// create check existence first (the admin API 409s on duplicates).
    #[allow(clippy::too_many_arguments)]
    pub async fn create_provider(
        &self,
        org_id: Uuid,
        slug: &str,
        name: &str,
        protocol: &str,
        base_url: &str,
        plaintext_key: &str,
        master_key: &[u8; 32],
    ) -> anyhow::Result<()> {
        let encrypted = crypto::encrypt_secret(master_key, plaintext_key)?;
        sqlx::query(
            "INSERT INTO provider_keys (id, org_id, provider, name, protocol, base_url, encrypted_key) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (org_id, provider) \
             DO UPDATE SET name = EXCLUDED.name, protocol = EXCLUDED.protocol, \
               base_url = EXCLUDED.base_url, encrypted_key = EXCLUDED.encrypted_key",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(slug)
        .bind(name)
        .bind(protocol)
        .bind(base_url)
        .bind(encrypted)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// Updates a provider's metadata; the key is replaced only when
    /// `plaintext_key` is Some (blank field = keep current).
    #[allow(clippy::too_many_arguments)]
    pub async fn update_provider(
        &self,
        org_id: Uuid,
        slug: &str,
        name: &str,
        protocol: &str,
        base_url: &str,
        plaintext_key: Option<&str>,
        master_key: &[u8; 32],
    ) -> anyhow::Result<bool> {
        let mut res = sqlx::query(
            "UPDATE provider_keys SET name = $3, protocol = $4, base_url = $5 \
             WHERE org_id = $1 AND provider = $2",
        )
        .bind(org_id)
        .bind(slug)
        .bind(name)
        .bind(protocol)
        .bind(base_url)
        .execute(self.pool)
        .await?;
        if let Some(key) = plaintext_key {
            let encrypted = crypto::encrypt_secret(master_key, key)?;
            let key_res = sqlx::query(
                "UPDATE provider_keys SET encrypted_key = $3 \
                 WHERE org_id = $1 AND provider = $2",
            )
            .bind(org_id)
            .bind(slug)
            .bind(encrypted)
            .execute(self.pool)
            .await?;
            res = key_res;
        }
        Ok(res.rows_affected() > 0)
    }

    pub async fn get_provider(
        &self,
        org_id: Uuid,
        slug: &str,
    ) -> anyhow::Result<Option<ProviderRow>> {
        let row: Option<ProviderRow> = sqlx::query_as(
            "SELECT provider, name, protocol, base_url FROM provider_keys \
             WHERE org_id = $1 AND provider = $2",
        )
        .bind(org_id)
        .bind(slug)
        .fetch_optional(self.pool)
        .await?;
        Ok(row)
    }

    pub async fn upsert_route(
        &self,
        org_id: Uuid,
        model: &str,
        provider: &str,
        enabled: bool,
        price_in: f64,
        price_out: f64,
        quota_monthly_usd: Option<f64>,
        reasoning: bool,
        context_window: Option<i64>,
        max_output_tokens: Option<i64>,
        modalities: &[String],
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO model_routes (org_id, model, provider, enabled, price_per_mtok_in_usd, price_per_mtok_out_usd, quota_monthly_usd, reasoning, context_window, max_output_tokens, modalities) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
             ON CONFLICT (org_id, model) \
             DO UPDATE SET provider = EXCLUDED.provider, enabled = EXCLUDED.enabled, \
               price_per_mtok_in_usd = EXCLUDED.price_per_mtok_in_usd, \
               price_per_mtok_out_usd = EXCLUDED.price_per_mtok_out_usd, \
               quota_monthly_usd = EXCLUDED.quota_monthly_usd, \
               reasoning = EXCLUDED.reasoning, \
               context_window = EXCLUDED.context_window, \
               max_output_tokens = EXCLUDED.max_output_tokens, \
               modalities = EXCLUDED.modalities",
        )
        .bind(org_id)
        .bind(model)
        .bind(provider)
        .bind(enabled)
        .bind(price_in)
        .bind(price_out)
        .bind(quota_monthly_usd)
        .bind(reasoning)
        .bind(context_window)
        .bind(max_output_tokens)
        .bind(modalities)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// Provider rows for the org's admin settings (no secrets).
    pub async fn list_providers(&self, org_id: Uuid) -> anyhow::Result<Vec<ProviderRow>> {
        let rows: Vec<ProviderRow> = sqlx::query_as(
            "SELECT provider, name, protocol, base_url FROM provider_keys \
             WHERE org_id = $1 ORDER BY name, provider",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?;
        Ok(rows)
    }

    /// Removes a provider; routes referencing it stop resolving until a new
    /// provider with the same slug is created.
    pub async fn delete_provider(&self, org_id: Uuid, slug: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM provider_keys WHERE org_id = $1 AND provider = $2")
            .bind(org_id)
            .bind(slug)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_route(&self, org_id: Uuid, model: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM model_routes WHERE org_id = $1 AND model = $2")
            .bind(org_id)
            .bind(model)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_models(&self, org_id: Uuid) -> anyhow::Result<Vec<String>> {
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT model FROM model_routes WHERE org_id = $1 AND enabled ORDER BY model",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?;
        Ok(rows)
    }

    /// Full route rows for the org's admin settings (no secrets: the
    /// provider key itself is never returned).
    pub async fn list_routes(&self, org_id: Uuid) -> anyhow::Result<Vec<AdminRouteRow>> {
        let rows: Vec<AdminRouteRow> = sqlx::query_as(
            "SELECT model, provider, enabled, price_per_mtok_in_usd, price_per_mtok_out_usd, quota_monthly_usd, reasoning, context_window, max_output_tokens, modalities \
             FROM model_routes WHERE org_id = $1 ORDER BY model",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?;
        Ok(rows)
    }

    /// Resolves a model to its provider route with the decrypted org key.
    /// The key never leaves the server (spec §4.2).
    pub async fn resolve_route(
        &self,
        org_id: Uuid,
        model: &str,
        master_key: &[u8; 32],
    ) -> Result<RouteRow, ApiError> {
        let row: Option<RouteQueryRow> = sqlx::query_as(
            "SELECT r.provider, k.protocol, k.base_url, k.encrypted_key, \
                    r.price_per_mtok_in_usd, r.price_per_mtok_out_usd, r.enabled, \
                    r.quota_monthly_usd, r.reasoning, r.context_window, \
                    r.max_output_tokens, r.modalities \
             FROM model_routes r \
             LEFT JOIN provider_keys k ON k.org_id = r.org_id AND k.provider = r.provider \
             WHERE r.org_id = $1 AND r.model = $2",
        )
        .bind(org_id)
        .bind(model)
        .fetch_optional(self.pool)
        .await?;
        let Some((
            provider,
            protocol,
            base_url,
            encrypted,
            price_in,
            price_out,
            enabled,
            quota,
            reasoning,
            context_window,
            max_output_tokens,
            modalities,
        )) = row
        else {
            return Err(ApiError::not_found(format!("no route for model {model}")));
        };
        if !enabled {
            return Err(ApiError::conflict(
                "model_disabled",
                format!("model {model} is disabled"),
            ));
        }
        let Some(encrypted) = encrypted else {
            return Err(ApiError::conflict(
                "key_missing",
                format!("no provider key for {provider}"),
            ));
        };
        // No provider row (deleted after the route was made): the route
        // cannot resolve — same failure shape as a missing key.
        let Some(base_url) = base_url else {
            return Err(ApiError::conflict(
                "key_missing",
                format!("no provider row for {provider}"),
            ));
        };
        let api_key = crypto::decrypt_secret(master_key, &encrypted)
            .map_err(|e| ApiError::internal(format!("key decrypt failed: {e}")))?;
        // A route whose provider row is gone still names a protocol — a JOIN
        // miss falls back to treating the slug as the protocol (the pre-0040
        // layout, where slugs were protocols).
        let protocol = protocol.unwrap_or_else(|| provider.clone());
        Ok(RouteRow {
            provider,
            protocol,
            base_url,
            api_key,
            price_in,
            price_out,
            quota_monthly_usd: quota,
            reasoning,
            context_window,
            max_output_tokens,
            modalities,
        })
    }

    /// A model's configured context window for the org, or `None` when the
    /// model has no route or the column is unset. Used by the thread readout
    /// (context gauge) — no provider key needed, unlike `resolve_route`.
    pub async fn context_window(
        &self,
        org_id: Uuid,
        model: &str,
    ) -> anyhow::Result<Option<i64>> {
        let v: Option<Option<i64>> = sqlx::query_scalar(
            "SELECT context_window FROM model_routes WHERE org_id = $1 AND model = $2",
        )
        .bind(org_id)
        .bind(model)
        .fetch_optional(self.pool)
        .await?;
        Ok(v.flatten())
    }
}
