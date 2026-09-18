//! Tool artifacts (tool artifacts design): spilled oversized tool results —
//! metadata in Postgres, bytes in object storage, org-scoped reads.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ToolArtifactRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub chat_id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub tool_name: String,
    pub call_id: String,
    pub created_at: DateTime<Utc>,
}

pub struct ToolArtifactStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

/// Object-storage key for a tool artifact (mirrors the attachments layout).
pub fn object_key(org_id: Uuid, id: Uuid, filename: &str) -> String {
    format!("tool_artifacts/{org_id}/{id}/{filename}")
}

/// Deterministic artifact id: uuid v5 over the chat id and the tool call id.
/// The same tool call always resolves to the same artifact row — the core of
/// replay idempotence (worker/spill.rs).
pub fn artifact_uuid(chat_id: Uuid, call_id: &str) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_DNS,
        format!("guild-tool-artifact:{chat_id}:{call_id}").as_bytes(),
    )
}

impl<'a> ToolArtifactStore<'a> {
    /// Inserts one artifact row; if the id already exists (replay of the
    /// same tool call), the insert is a no-op and the existing row is
    /// returned — callers can treat this as create-or-reuse.
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        id: Uuid,
        org_id: Uuid,
        chat_id: Uuid,
        filename: &str,
        content_type: &str,
        size_bytes: i64,
        object_key: &str,
        tool_name: &str,
        call_id: &str,
    ) -> Result<ToolArtifactRow, ApiError> {
        sqlx::query(
            "INSERT INTO tool_artifacts (id, org_id, chat_id, filename, content_type, size_bytes, object_key, tool_name, call_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(org_id)
        .bind(chat_id)
        .bind(filename)
        .bind(content_type)
        .bind(size_bytes)
        .bind(object_key)
        .bind(tool_name)
        .bind(call_id)
        .execute(self.pool)
        .await
        .map_err(ApiError::from)?;
        self.get(org_id, id).await
    }

    pub async fn get(&self, org_id: Uuid, id: Uuid) -> Result<ToolArtifactRow, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, chat_id, filename, content_type, size_bytes, tool_name, call_id, created_at \
             FROM tool_artifacts WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::not_found("no such tool artifact"))
    }

    pub async fn list_for_chat(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
    ) -> Result<Vec<ToolArtifactRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, chat_id, filename, content_type, size_bytes, tool_name, call_id, created_at \
             FROM tool_artifacts WHERE org_id = $1 AND chat_id = $2 ORDER BY created_at, id",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)
    }
}
