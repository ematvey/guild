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
    /// Owner when the key was minted by a user from their own settings;
    /// NULL for admin-minted org keys.
    pub user_id: Option<Uuid>,
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
    /// Creates a key and returns it in plaintext exactly once. `generation`
    /// is the minting session's auth generation (`None`: the creator's
    /// current one); the key is stamped with it, the INSERT refuses a
    /// superseded generation, and authentication requires the creator's
    /// current generation to still match.
    pub async fn create(
        &self,
        org_id: Uuid,
        created_by: Uuid,
        name: &str,
        user_id: Option<Uuid>,
        generation: Option<i64>,
    ) -> Result<NewApiKey, ApiError> {
        use rand::RngCore;
        let mut bytes = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let plaintext = format!("gk_{}", hex::encode(bytes));
        let prefix: String = plaintext.chars().take(10).collect();
        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, ApiKeyRow>(
            "INSERT INTO api_keys (id, org_id, created_by, name, prefix, key_hash, user_id, auth_generation) \
             SELECT $1, $2, $3, $4, $5, $6, $7, u.auth_generation FROM users u \
             WHERE u.id = $3 AND u.auth_generation = COALESCE($8, u.auth_generation) \
             RETURNING id, org_id, created_by, name, prefix, created_at, revoked_at, user_id",
        )
        .bind(id)
        .bind(org_id)
        .bind(created_by)
        .bind(name)
        .bind(&prefix)
        .bind(hash_key(&plaintext))
        .bind(user_id)
        .bind(generation)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired session"))?;
        Ok(NewApiKey {
            key: row,
            plaintext,
        })
    }

    pub async fn list(&self, org_id: Uuid) -> Result<Vec<ApiKeyRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, created_by, name, prefix, created_at, revoked_at, user_id \
             FROM api_keys WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Keys owned by one user (the settings-level view).
    pub async fn list_for_user(&self, user_id: Uuid) -> Result<Vec<ApiKeyRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, created_by, name, prefix, created_at, revoked_at, user_id \
             FROM api_keys WHERE user_id = $1 ORDER BY created_at",
        )
        .bind(user_id)
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

    /// Revokes a key the user owns (no org filter — the owner id is the
    /// authority here).
    pub async fn revoke_owned(&self, user_id: Uuid, id: Uuid) -> Result<(), ApiError> {
        let n = sqlx::query(
            "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        )
        .bind(id)
        .bind(user_id)
        .execute(self.pool)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(ApiError::not_found("api key not found"));
        }
        Ok(())
    }

    /// Resolves a bearer token to its key row (None if unknown, revoked, or
    /// minted at an auth generation the creator's password reset superseded).
    pub async fn authenticate(&self, token: &str) -> Result<Option<ApiKeyRow>, ApiError> {
        let row = sqlx::query_as::<_, ApiKeyRow>(
            "SELECT k.id, k.org_id, k.created_by, k.name, k.prefix, k.created_at, k.revoked_at, k.user_id \
             FROM api_keys k JOIN users u ON u.id = k.created_by \
             WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND k.auth_generation = u.auth_generation",
        )
        .bind(hash_key(token))
        .fetch_optional(self.pool)
        .await?;
        Ok(row)
    }
}
