//! Per-org key/value store (migration-free org settings, e.g. the
//! admin-configured assistant system prompt). Org-scoped mirror of
//! `server_kv` (see `kv.rs`).

use crate::http::error::ApiError;
use uuid::Uuid;

pub struct OrgKvStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> OrgKvStore<'a> {
    pub async fn get(&self, org_id: Uuid, key: &str) -> Result<Option<String>, ApiError> {
        sqlx::query_scalar("SELECT value FROM org_kv WHERE org_id = $1 AND key = $2")
            .bind(org_id)
            .bind(key)
            .fetch_optional(self.pool)
            .await
            .map_err(Into::into)
    }

    pub async fn put(&self, org_id: Uuid, key: &str, value: &str) -> Result<(), ApiError> {
        sqlx::query(
            "INSERT INTO org_kv (org_id, key, value) VALUES ($1, $2, $3) \
             ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value",
        )
        .bind(org_id)
        .bind(key)
        .bind(value)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, org_id: Uuid, key: &str) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM org_kv WHERE org_id = $1 AND key = $2")
            .bind(org_id)
            .bind(key)
            .execute(self.pool)
            .await?;
        Ok(())
    }
}
