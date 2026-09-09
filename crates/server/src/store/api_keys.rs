//! API keys for the public OpenAI-compatible endpoint (spec §10.6, M6 task 1).
//! Plaintext keys are shown once at creation; only the sha256 hash is stored.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ApiKeyRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub created_by: Uuid,
    pub name: String,
    pub prefix: String,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// What `create` returns: the row plus the one-time plaintext key.
pub struct NewApiKey {
    pub key: ApiKeyRow,
    pub plaintext: String,
}

pub struct ApiKeyStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

pub fn hash_key(plaintext: &str) -> String {
    hex::encode(Sha256::digest(plaintext.as_bytes()))
}

impl<'a> ApiKeyStore<'a> {
    /// Creates a key and returns it in plaintext exactly once.
    pub async fn create(
        &self,
        org_id: Uuid,
        created_by: Uuid,
        name: &str,
    ) -> Result<NewApiKey, ApiError> {
        use rand::RngCore;
        let mut bytes = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let plaintext = format!("gk_{}", hex::encode(bytes));
        let prefix: String = plaintext.chars().take(10).collect();
        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, ApiKeyRow>(
            "INSERT INTO api_keys (id, org_id, created_by, name, prefix, key_hash) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             RETURNING id, org_id, created_by, name, prefix, created_at, revoked_at",
        )
        .bind(id)
        .bind(org_id)
        .bind(created_by)
        .bind(name)
        .bind(&prefix)
        .bind(hash_key(&plaintext))
        .fetch_one(self.pool)
        .await?;
        Ok(NewApiKey {
            key: row,
            plaintext,
        })
    }

    pub async fn list(&self, org_id: Uuid) -> Result<Vec<ApiKeyRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, created_by, name, prefix, created_at, revoked_at \
             FROM api_keys WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn revoke(&self, org_id: Uuid, id: Uuid) -> Result<(), ApiError> {
        let n = sqlx::query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL")
            .bind(id)
            .bind(org_id)
            .execute(self.pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(ApiError::not_found("api key not found"));
        }
        Ok(())
    }

    /// Resolves a bearer token to its key row (None if unknown/revoked).
    pub async fn authenticate(&self, token: &str) -> Result<Option<ApiKeyRow>, ApiError> {
        let row = sqlx::query_as::<_, ApiKeyRow>(
            "SELECT id, org_id, created_by, name, prefix, created_at, revoked_at \
             FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
        )
        .bind(hash_key(token))
        .fetch_optional(self.pool)
        .await?;
        Ok(row)
    }
}
