//! One-time pairing tokens for desktop-app enrollment (shared signed
//! installers can't carry per-org data, so the webapp issues a short-lived
//! code the desktop app redeems for a normal session). Only the sha256
//! hash of the secret is stored; plaintext is shown once at creation.

use crate::http::error::ApiError;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct PairingTokenRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
}

pub struct NewPairingToken {
    pub token: PairingTokenRow,
    /// The one-time plaintext secret — never stored server-side.
    pub secret: String,
}

pub struct PairingStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

pub fn hash_secret(plaintext: &str) -> String {
    hex::encode(Sha256::digest(plaintext.as_bytes()))
}

/// Redeemable code format: `g1|<server_url>|<hex secret>`. The server URL is
/// routing info (not secret) and is kept visible on purpose — the pairing
/// screen shows the user where they are about to connect. Only the last
/// segment is the credential; here we extract it from a full code.
pub fn secret_from_code(code: &str) -> Option<&str> {
    let rest = code.strip_prefix("g1|")?;
    let mut parts = rest.splitn(3, '|');
    let server = parts.next()?;
    let secret = parts.next()?;
    if server.is_empty()
        || secret.is_empty()
        || parts.next().is_some()
        || !secret.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(secret)
}

impl<'a> PairingStore<'a> {
    /// Creates a one-time token, returning the plaintext secret exactly once.
    /// `generation` is the minting session's auth generation (`None`: the
    /// user's current one); the token is stamped with it and the INSERT
    /// refuses a generation a reset already superseded.
    pub async fn create(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        ttl_minutes: i64,
        generation: Option<i64>,
    ) -> Result<NewPairingToken, ApiError> {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let secret = hex::encode(bytes);
        let id = Uuid::now_v7();
        let expires_at = Utc::now() + Duration::minutes(ttl_minutes);
        let row: PairingTokenRow = sqlx::query_as(
            "INSERT INTO pairing_tokens (id, org_id, user_id, secret_hash, expires_at, auth_generation) \
             SELECT $1, $2, $3, $4, $5, u.auth_generation FROM users u \
             WHERE u.id = $3 AND u.auth_generation = COALESCE($6, u.auth_generation) \
             RETURNING id, org_id, user_id, created_at, expires_at, used_at",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(hash_secret(&secret))
        .bind(expires_at)
        .bind(generation)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired session"))?;
        Ok(NewPairingToken { token: row, secret })
    }

    /// Redeems a secret: single-use (used_at must be null) and unexpired.
    /// Returns the owning user id and the token's STAMPED auth generation
    /// (the minting session's) — the session issuance stamps it, so a
    /// password reset that commits after the mint (or between redemption and
    /// issuance) leaves the created session unable to validate.
    pub async fn redeem(&self, secret: &str) -> Result<(Uuid, Uuid), ApiError> {
        self.redeem_with_generation(secret)
            .await
            .map(|r| (r.0, r.1))
    }

    pub async fn redeem_with_generation(
        &self,
        secret: &str,
    ) -> Result<(Uuid, Uuid, i64), ApiError> {
        let row: (Uuid, Uuid, i64) = sqlx::query_as(
            "UPDATE pairing_tokens SET used_at = now() \
             WHERE secret_hash = $1 AND used_at IS NULL AND expires_at > now() \
             RETURNING org_id, user_id, auth_generation",
        )
        .bind(hash_secret(secret))
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired pairing code"))?;
        Ok(row)
    }

    /// Outstanding (unused, unexpired) tokens for a user.
    pub async fn list_outstanding(&self, user_id: Uuid) -> Result<Vec<PairingTokenRow>, ApiError> {
        Ok(sqlx::query_as(
            "SELECT id, org_id, user_id, created_at, expires_at, used_at FROM pairing_tokens \
             WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() \
             ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(self.pool)
        .await?)
    }

    /// Revokes an outstanding token. Owner-only.
    pub async fn revoke(&self, user_id: Uuid, id: Uuid) -> Result<(), ApiError> {
        let res = sqlx::query("DELETE FROM pairing_tokens WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(ApiError::not_found("no such pairing token"));
        }
        Ok(())
    }

    /// Deletes redeemed and expired pairing tokens (enrollment rows are only
    /// needed until redeemed or expired). Returns the number removed.
    pub async fn prune_dead_tokens(&self) -> anyhow::Result<u64> {
        let res = sqlx::query(
            "DELETE FROM pairing_tokens WHERE used_at IS NOT NULL OR expires_at <= now()",
        )
        .execute(self.pool)
        .await?;
        Ok(res.rows_affected())
    }
}
