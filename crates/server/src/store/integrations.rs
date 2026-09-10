//! Admin-configured integration plugins (org-scoped server-side tools).
//! Configured explicitly by an org admin; an integration contributes tools to
//! the chat loop only while it is enabled.

use crate::http::error::ApiError;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize, serde::Deserialize)]
pub struct IntegrationRow {
    pub org_id: Uuid,
    pub name: String,
    pub config: serde_json::Value,
    pub enabled: bool,
}

pub struct IntegrationStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> IntegrationStore<'a> {
    /// Idempotent upsert: replaces config and enabled flag.
    pub async fn upsert(
        &self,
        org_id: Uuid,
        name: &str,
        config: &serde_json::Value,
        enabled: bool,
    ) -> Result<(), ApiError> {
        sqlx::query(
            "INSERT INTO integrations (org_id, name, config, enabled) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (org_id, name) \
             DO UPDATE SET config = $3, enabled = $4, updated_at = now()",
        )
        .bind(org_id)
        .bind(name)
        .bind(config)
        .bind(enabled)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn list(&self, org_id: Uuid) -> Result<Vec<IntegrationRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT org_id, name, config, enabled FROM integrations \
             WHERE org_id = $1 ORDER BY name",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?)
    }

    /// Enabled integrations only — the set the chat loop resolves tools from.
    pub async fn list_enabled(&self, org_id: Uuid) -> Result<Vec<IntegrationRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT org_id, name, config, enabled FROM integrations \
             WHERE org_id = $1 AND enabled ORDER BY name",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?)
    }
}
