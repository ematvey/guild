//! Encrypted per-integration secrets (spec §4). One row per
//! (org, integration, name); values are AES-256-GCM with the master key and
//! never leave the store in plaintext except through `resolve`.

use crate::crypto;
use crate::http::error::ApiError;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct SecretRow {
    pub name: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Resolve failure: an internal store error, or the declared names that have
/// no stored secret (the enable gate turns this into a 409 `missing_secrets`).
#[derive(Debug)]
pub enum ResolveError {
    Api(ApiError),
    MissingSecrets(Vec<String>),
}

impl From<ApiError> for ResolveError {
    fn from(e: ApiError) -> Self {
        ResolveError::Api(e)
    }
}

impl From<sqlx::Error> for ResolveError {
    fn from(e: sqlx::Error) -> Self {
        ResolveError::Api(e.into())
    }
}

impl From<anyhow::Error> for ResolveError {
    fn from(e: anyhow::Error) -> Self {
        ResolveError::Api(e.into())
    }
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::Api(e) => write!(f, "{e:?}"),
            ResolveError::MissingSecrets(names) => write!(f, "missing secrets: {names:?}"),
        }
    }
}

impl std::error::Error for ResolveError {}

pub struct IntegrationSecretStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> IntegrationSecretStore<'a> {
    /// Idempotent upsert: replaces the encrypted value.
    pub async fn upsert(
        &self,
        org_id: Uuid,
        integration: &str,
        name: &str,
        plaintext: &str,
        master_key: &[u8; 32],
    ) -> Result<(), ApiError> {
        let encrypted =
            crypto::encrypt_secret(master_key, plaintext).map_err(ApiError::from)?;
        sqlx::query(
            "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (org_id, integration, name) \
             DO UPDATE SET secret_enc = $4, updated_at = now()",
        )
        .bind(org_id)
        .bind(integration)
        .bind(name)
        .bind(encrypted)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(
        &self,
        org_id: Uuid,
        integration: &str,
        name: &str,
    ) -> Result<(), ApiError> {
        sqlx::query(
            "DELETE FROM integration_secrets \
             WHERE org_id = $1 AND integration = $2 AND name = $3",
        )
        .bind(org_id)
        .bind(integration)
        .bind(name)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// Names + timestamps only — values never appear in listings.
    pub async fn list(
        &self,
        org_id: Uuid,
        integration: &str,
    ) -> Result<Vec<SecretRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT name, updated_at FROM integration_secrets \
             WHERE org_id = $1 AND integration = $2 ORDER BY name",
        )
        .bind(org_id)
        .bind(integration)
        .fetch_all(self.pool)
        .await?)
    }

    /// Decrypts the requested names. Errors with MissingSecrets when any
    /// declared name has no stored secret.
    pub async fn resolve(
        &self,
        org_id: Uuid,
        integration: &str,
        names: &[String],
        master_key: &[u8; 32],
    ) -> Result<Vec<(String, String)>, ResolveError> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, secret_enc FROM integration_secrets \
             WHERE org_id = $1 AND integration = $2",
        )
        .bind(org_id)
        .bind(integration)
        .fetch_all(self.pool)
        .await?;
        let missing: Vec<String> = names
            .iter()
            .filter(|n| !rows.iter().any(|(name, _)| name == *n))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(ResolveError::MissingSecrets(missing));
        }
        let mut out = Vec::new();
        for name in names {
            let enc = rows
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, enc)| enc)
                .expect("declared name present");
            let plaintext = crypto::decrypt_secret(master_key, enc).map_err(ResolveError::from)?;
            out.push((name.clone(), plaintext));
        }
        Ok(out)
    }

    /// Deletes every secret of one integration (admin integration delete).
    pub async fn delete_all(
        &self,
        org_id: Uuid,
        integration: &str,
    ) -> Result<(), ApiError> {
        sqlx::query(
            "DELETE FROM integration_secrets WHERE org_id = $1 AND integration = $2",
        )
        .bind(org_id)
        .bind(integration)
        .execute(self.pool)
        .await?;
        Ok(())
    }
}
