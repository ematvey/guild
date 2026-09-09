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
