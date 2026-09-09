//! Chat attachments (spec §4.3/§5): bytes in object storage, metadata in
//! Postgres, org-scoped reads.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct AttachmentRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub chat_id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub created_at: DateTime<Utc>,
}

pub struct AttachmentStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

/// Only safe path segments for object keys.
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

impl<'a> AttachmentStore<'a> {
    pub async fn create(
        &self,
        id: Uuid,
        org_id: Uuid,
        chat_id: Uuid,
        filename: &str,
        content_type: &str,
        size_bytes: i64,
        object_key: &str,
    ) -> Result<AttachmentRow, ApiError> {
        sqlx::query_as(
            "INSERT INTO attachments (id, org_id, chat_id, filename, content_type, size_bytes, object_key) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING id, org_id, chat_id, filename, content_type, size_bytes, created_at",
        )
        .bind(id)
        .bind(org_id)
        .bind(chat_id)
        .bind(filename)
        .bind(content_type)
        .bind(size_bytes)
        .bind(object_key)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn list(&self, org_id: Uuid, chat_id: Uuid) -> Result<Vec<AttachmentRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, chat_id, filename, content_type, size_bytes, created_at \
             FROM attachments WHERE org_id = $1 AND chat_id = $2 ORDER BY created_at",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn get(&self, org_id: Uuid, id: Uuid) -> Result<AttachmentRow, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, chat_id, filename, content_type, size_bytes, created_at \
             FROM attachments WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::not_found("no such attachment"))
    }
}
