//! Client release artifacts (downloads feature): bytes in object storage,
//! metadata + sha256 in Postgres. Admins upload builds; users download via
//! short-lived signed URLs (spec-style bearer auth also accepted).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ReleaseRow {
    pub id: Uuid,
    pub version: String,
    pub kind: String,
    pub platform: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub signature: String,
    /// Tauri updater (minisign) signature content; empty when not signed for the updater
    pub updater_signature: String,
    pub notes: String,
    pub created_at: DateTime<Utc>,
}

pub struct ReleaseStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

pub const PLATFORMS: &[&str] = &[
    "linux-x86_64",
    "linux-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "windows-x86_64",
];

pub fn valid_platform(p: &str) -> bool {
    PLATFORMS.contains(&p)
}

pub fn safe_filename(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned.len() > 128 || cleaned.starts_with('.') {
        None
    } else {
        Some(cleaned)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

impl<'a> ReleaseStore<'a> {
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        id: Uuid,
        version: &str,
        kind: &str,
        platform: &str,
        filename: &str,
        content_type: &str,
        size_bytes: i64,
        sha256: &str,
        signature: &str,
        updater_signature: &str,
        notes: &str,
        object_key: &str,
    ) -> Result<ReleaseRow, ApiError> {
        match sqlx::query_as::<_, ReleaseRow>(
            "INSERT INTO releases (id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, object_key) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             RETURNING id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, created_at",
        )
        .bind(id)
        .bind(version)
        .bind(kind)
        .bind(platform)
        .bind(filename)
        .bind(content_type)
        .bind(size_bytes)
        .bind(sha256)
        .bind(signature)
        .bind(updater_signature)
        .bind(notes)
        .bind(object_key)
        .fetch_one(self.pool)
        .await
        {
            Ok(r) => Ok(r),
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => Err(ApiError::conflict(
                "release_taken",
                "an artifact with this version/kind/platform/filename already exists",
            )),
            Err(e) => Err(ApiError::from(e)),
        }
    }

    pub async fn list(&self) -> Result<Vec<ReleaseRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, created_at \
             FROM releases ORDER BY created_at DESC",
        )
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn get(&self, id: Uuid) -> Result<ReleaseRow, ApiError> {
        sqlx::query_as(
            "SELECT id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, created_at \
             FROM releases WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::not_found("no such release"))
    }

    pub async fn delete(&self, id: Uuid) -> Result<ReleaseRow, ApiError> {
        sqlx::query_as(
            "DELETE FROM releases WHERE id = $1 \
             RETURNING id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, created_at",
        )
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::not_found("no such release"))
    }
}
