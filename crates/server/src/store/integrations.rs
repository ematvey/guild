//! Admin-configured integration plugins (org-scoped server-side tools).
//! Configured explicitly by an org admin; an integration contributes tools to
//! the chat loop only while it is enabled. Every configured integration is a
//! db row with a stable id; the connector slug stays unique per org.

use crate::http::error::ApiError;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize, serde::Deserialize)]
pub struct IntegrationRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub config: serde_json::Value,
    pub enabled: bool,
}

pub struct IntegrationStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> IntegrationStore<'a> {
    /// Idempotent upsert: replaces config and enabled flag; returns the
    /// row's stable id (inserts generate one, conflicts keep the existing).
    pub async fn upsert(
        &self,
        org_id: Uuid,
        name: &str,
        config: &serde_json::Value,
        enabled: bool,
    ) -> Result<Uuid, ApiError> {
        let (id,): (Uuid,) = sqlx::query_as(
            "INSERT INTO integrations (org_id, name, config, enabled) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (org_id, name) \
             DO UPDATE SET config = $3, enabled = $4, updated_at = now() \
             RETURNING id",
        )
        .bind(org_id)
        .bind(name)
        .bind(config)
        .bind(enabled)
        .fetch_one(self.pool)
        .await?;
        Ok(id)
    }

    /// Fetches one configured integration by id.
    pub async fn get(&self, org_id: Uuid, id: Uuid) -> Result<Option<IntegrationRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT id, org_id, name, config, enabled FROM integrations \
             WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(self.pool)
        .await?)
    }

    /// Replaces config and enabled flag of one integration by id. Returns
    /// whether a row matched — a false result means the integration is gone.
    pub async fn update(
        &self,
        org_id: Uuid,
        id: Uuid,
        config: &serde_json::Value,
        enabled: bool,
    ) -> Result<bool, ApiError> {
        let res = sqlx::query(
            "UPDATE integrations SET config = $3, enabled = $4, updated_at = now() \
             WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .bind(config)
        .bind(enabled)
        .execute(self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Removes one integration by id — the config row AND its stored
    /// secrets, transactionally. Secrets live keyed by slug with no FK, so
    /// deleting only the row would let a re-added integration with the same
    /// slug silently revive the old credentials.
    pub async fn delete(&self, org_id: Uuid, id: Uuid) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await?;
        let name: Option<String> =
            sqlx::query_scalar("SELECT name FROM integrations WHERE org_id = $1 AND id = $2")
                .bind(org_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(name) = name else {
            return Ok(()); // nothing to delete
        };
        sqlx::query("DELETE FROM integrations WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM integration_secrets WHERE org_id = $1 AND integration = $2")
            .bind(org_id)
            .bind(&name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list(&self, org_id: Uuid) -> Result<Vec<IntegrationRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT id, org_id, name, config, enabled FROM integrations \
             WHERE org_id = $1 ORDER BY name",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?)
    }

    /// Enabled integrations only — the set the chat loop resolves tools from.
    pub async fn list_enabled(&self, org_id: Uuid) -> Result<Vec<IntegrationRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT id, org_id, name, config, enabled FROM integrations \
             WHERE org_id = $1 AND enabled ORDER BY name",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await?)
    }
}
