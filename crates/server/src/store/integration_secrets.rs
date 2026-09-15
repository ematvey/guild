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
    /// Write-time preview (one bullet per stored character, capped);
    /// values themselves are never listed. Empty for rows written before
    /// the column existed — the first listing after this change backfills it.
    pub masked: String,
}

/// Preview shown to admins: one bullet per stored character (capped) —
/// length only, never any part of the value.
fn mask_secret(value: &str) -> String {
    crate::crypto::mask_secret_len(value.chars().count())
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
    /// Idempotent upsert: replaces the encrypted value and the preview.
    pub async fn upsert(
        &self,
        org_id: Uuid,
        integration: &str,
        name: &str,
        plaintext: &str,
        master_key: &[u8; 32],
    ) -> Result<(), ApiError> {
        let encrypted = crypto::encrypt_secret(master_key, plaintext).map_err(ApiError::from)?;
        sqlx::query(
            "INSERT INTO integration_secrets (org_id, integration, name, secret_enc, masked) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (org_id, integration, name) \
             DO UPDATE SET secret_enc = $4, masked = $5, updated_at = now()",
        )
        .bind(org_id)
        .bind(integration)
        .bind(name)
        .bind(encrypted)
        .bind(mask_secret(plaintext))
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

    /// Stored secret names only (no decryption, no preview) — the enable
    /// gate checks these against the manifest's declared names.
    pub async fn names(&self, org_id: Uuid, integration: &str) -> Result<Vec<String>, ApiError> {
        Ok(sqlx::query_scalar(
            "SELECT name FROM integration_secrets \
             WHERE org_id = $1 AND integration = $2 ORDER BY name",
        )
        .bind(org_id)
        .bind(integration)
        .fetch_all(self.pool)
        .await?)
    }

    /// Names, timestamps and masked previews — values never appear in
    /// listings. Rows written before the current preview format (empty
    /// masked, or the legacy last-4 shape) get their preview recomputed
    /// here: the value is decrypted server-side (the same trust boundary
    /// as `resolve`) and re-masked, never returned.
    pub async fn list(
        &self,
        org_id: Uuid,
        integration: &str,
        master_key: &[u8; 32],
    ) -> Result<Vec<SecretRow>, ApiError> {
        let mut rows: Vec<SecretRow> = sqlx::query_as(
            "SELECT name, updated_at, masked FROM integration_secrets \
             WHERE org_id = $1 AND integration = $2 ORDER BY name",
        )
        .bind(org_id)
        .bind(integration)
        .fetch_all(self.pool)
        .await?;
        for row in &mut rows {
            if row.masked.is_empty() || row.masked.chars().any(|c| c != '•') {
                let plaintext = self
                    .resolve(org_id, integration, &[row.name.clone()], master_key)
                    .await
                    .map_err(|e| match e {
                        ResolveError::Api(api) => api,
                        ResolveError::MissingSecrets(_) => {
                            ApiError::internal("secret vanished between list and resolve")
                        }
                    })?;
                let masked = mask_secret(&plaintext[0].1);
                sqlx::query(
                    "UPDATE integration_secrets SET masked = $3 \
                     WHERE org_id = $1 AND integration = $2 AND name = $4",
                )
                .bind(org_id)
                .bind(integration)
                .bind(&masked)
                .bind(&row.name)
                .execute(self.pool)
                .await?;
                row.masked = masked;
            }
        }
        Ok(rows)
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
    pub async fn delete_all(&self, org_id: Uuid, integration: &str) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM integration_secrets WHERE org_id = $1 AND integration = $2")
            .bind(org_id)
            .bind(integration)
            .execute(self.pool)
            .await?;
        Ok(())
    }
}
