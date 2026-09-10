//! Tiny server-wide key/value store (migrations-free settings, e.g. the
//! auto-generated release signing seed).

use crate::http::error::ApiError;

pub struct KvStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> KvStore<'a> {
    pub async fn get(&self, key: &str) -> Result<Option<String>, ApiError> {
        sqlx::query_scalar("SELECT value FROM server_kv WHERE key = $1")
            .bind(key)
            .fetch_optional(self.pool)
            .await
            .map_err(Into::into)
    }

    /// All entries whose key starts with `prefix`.
    pub async fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT key, value FROM server_kv WHERE key LIKE $1 || '%' ORDER BY key",
        )
        .bind(prefix)
        .fetch_all(self.pool)
        .await?)
    }

    pub async fn delete(&self, key: &str) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM server_kv WHERE key = $1")
            .bind(key)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    pub async fn put(&self, key: &str, value: &str) -> Result<(), ApiError> {
        sqlx::query(
            "INSERT INTO server_kv (key, value) VALUES ($1, $2) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        )
        .bind(key)
        .bind(value)
        .execute(self.pool)
        .await?;
        Ok(())
    }
}
