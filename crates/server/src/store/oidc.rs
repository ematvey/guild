//! OIDC SSO configuration storage (spec §4.1/§5). One config per org; the
//! client secret is encrypted at rest with the org master key.

use crate::crypto;
use crate::http::error::ApiError;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OidcConfigRow {
    pub org_id: Uuid,
    pub issuer: String,
    pub client_id: String,
    pub encrypted_client_secret: String,
}

pub struct OidcStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> OidcStore<'a> {
    /// Upserts the org's OIDC config. `client_secret = None` keeps the
    /// stored encrypted secret (the edit form's "leave blank to keep").
    pub async fn upsert(
        &self,
        org_id: Uuid,
        issuer: &str,
        client_id: &str,
        client_secret: Option<&str>,
        master_key: &[u8; 32],
    ) -> Result<(), ApiError> {
        let encrypted = match client_secret {
            Some(secret) => crypto::encrypt_secret(master_key, secret).map_err(ApiError::from)?,
            None => self
                .get(org_id)
                .await?
                .map(|r| r.encrypted_client_secret)
                .ok_or_else(|| {
                    ApiError::bad_request("missing client_secret (no stored secret to keep)")
                })?,
        };
        sqlx::query(
            "INSERT INTO oidc_configs (id, org_id, issuer, client_id, encrypted_client_secret) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (org_id) DO UPDATE \
             SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, \
                 encrypted_client_secret = EXCLUDED.encrypted_client_secret",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(issuer)
        .bind(client_id)
        .bind(encrypted)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn get(&self, org_id: Uuid) -> Result<Option<OidcConfigRow>, ApiError> {
        sqlx::query_as(
            "SELECT org_id, issuer, client_id, encrypted_client_secret FROM oidc_configs \
             WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_optional(self.pool)
        .await
        .map_err(Into::into)
    }

    pub fn decrypt_secret(
        &self,
        row: &OidcConfigRow,
        master_key: &[u8; 32],
    ) -> Result<String, ApiError> {
        crypto::decrypt_secret(master_key, &row.encrypted_client_secret).map_err(ApiError::from)
    }

    pub async fn delete(&self, org_id: Uuid) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM oidc_configs WHERE org_id = $1")
            .bind(org_id)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    /// Guild is effectively single-org (bootstrap creates one); the public
    /// status endpoint and login flow use it to resolve the login target.
    pub async fn first_org_id(&self) -> Result<Option<Uuid>, ApiError> {
        sqlx::query_scalar("SELECT id FROM orgs ORDER BY created_at LIMIT 1")
            .fetch_optional(self.pool)
            .await
            .map_err(Into::into)
    }
}
