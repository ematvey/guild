//! Gateway records: org provider keys (encrypted at rest) and model routes
//! (spec §4.2).

use crate::crypto;
use crate::http::error::ApiError;
use uuid::Uuid;

/// (provider, base_url, encrypted key, price in, price out, enabled, quota)
type RouteQueryRow = (String, String, Option<String>, f64, f64, bool, Option<f64>);

/// Resolved route for a model call. Plain data so it can be journaled
/// through Restate run steps.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RouteRow {
    pub provider: String,
    pub base_url: String,
    /// Decrypted org key — never leaves the server.
    pub api_key: String,
    pub price_in: f64,
    pub price_out: f64,
    /// Monthly spend cap in USD; None = unlimited (spec §4.2/§4.5).
    pub quota_monthly_usd: Option<f64>,
}

pub struct GatewayStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> GatewayStore<'a> {
    pub async fn upsert_provider_key(
        &self,
        org_id: Uuid,
        provider: &str,
        base_url: &str,
        plaintext_key: &str,
        master_key: &[u8; 32],
    ) -> anyhow::Result<()> {
        let encrypted = crypto::encrypt_secret(master_key, plaintext_key)?;
        sqlx::query(
            "INSERT INTO provider_keys (id, org_id, provider, base_url, encrypted_key) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (org_id, provider) \
             DO UPDATE SET base_url = EXCLUDED.base_url, encrypted_key = EXCLUDED.encrypted_key",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(provider)
        .bind(base_url)
        .bind(encrypted)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_route(
        &self,
        org_id: Uuid,
        model: &str,
        provider: &str,
        enabled: bool,
        price_in: f64,
        price_out: f64,
        quota_monthly_usd: Option<f64>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO model_routes (org_id, model, provider, enabled, price_per_mtok_in_usd, price_per_mtok_out_usd, quota_monthly_usd) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (org_id, model) \
             DO UPDATE SET provider = EXCLUDED.provider, enabled = EXCLUDED.enabled, \
               price_per_mtok_in_usd = EXCLUDED.price_per_mtok_in_usd, \
               price_per_mtok_out_usd = EXCLUDED.price_per_mtok_out_usd, \
               quota_monthly_usd = EXCLUDED.quota_monthly_usd",
        )
        .bind(org_id)
        .bind(model)
        .bind(provider)
        .bind(enabled)
        .bind(price_in)
        .bind(price_out)
        .bind(quota_monthly_usd)
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

    /// Resolves a model to its provider route with the decrypted org key.
    /// The key never leaves the server (spec §4.2).
    pub async fn resolve_route(
        &self,
        org_id: Uuid,
        model: &str,
        master_key: &[u8; 32],
    ) -> Result<RouteRow, ApiError> {
        let row: Option<RouteQueryRow> = sqlx::query_as(
            "SELECT r.provider, k.base_url, k.encrypted_key, \
                    r.price_per_mtok_in_usd, r.price_per_mtok_out_usd, r.enabled, \
                    r.quota_monthly_usd \
             FROM model_routes r \
             LEFT JOIN provider_keys k ON k.org_id = r.org_id AND k.provider = r.provider \
             WHERE r.org_id = $1 AND r.model = $2",
        )
        .bind(org_id)
        .bind(model)
        .fetch_optional(self.pool)
        .await?;
        let Some((provider, base_url, encrypted, price_in, price_out, enabled, quota)) = row else {
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
        let api_key = crypto::decrypt_secret(master_key, &encrypted)
            .map_err(|e| ApiError::internal(format!("key decrypt failed: {e}")))?;
        Ok(RouteRow {
            provider,
            base_url,
            api_key,
            price_in,
            price_out,
            quota_monthly_usd: quota,
        })
    }
}
