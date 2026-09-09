//! Server-side agent sessions over workspace directories (M6 task 3).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct AgentSessionRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub chat_id: Uuid,
    pub workspace_name: String,
    pub created_at: DateTime<Utc>,
}

pub struct AgentSessionStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

/// Only safe filesystem names for workspace dirs.
pub fn valid_workspace_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl<'a> AgentSessionStore<'a> {
    pub async fn create(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        chat_id: Uuid,
        workspace_name: &str,
    ) -> Result<AgentSessionRow, ApiError> {
        if !valid_workspace_name(workspace_name) {
            return Err(ApiError::bad_request(
                "workspace_name must be 1-64 chars of [a-zA-Z0-9-_]",
            ));
        }
        let id = Uuid::now_v7();
        match sqlx::query_as::<_, AgentSessionRow>(
            "INSERT INTO agent_sessions (id, org_id, user_id, chat_id, workspace_name) \
             VALUES ($1, $2, $3, $4, $5) \
             RETURNING id, org_id, user_id, chat_id, workspace_name, created_at",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(chat_id)
        .bind(workspace_name)
        .fetch_one(self.pool)
        .await
        {
            Ok(row) => Ok(row),
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => Err(ApiError::conflict(
                "workspace_taken",
                "a session with this workspace name already exists",
            )),
            Err(e) => Err(ApiError::from(e)),
        }
    }

    pub async fn list(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<AgentSessionRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, user_id, chat_id, workspace_name, created_at \
             FROM agent_sessions WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC",
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn get(&self, org_id: Uuid, id: Uuid) -> Result<AgentSessionRow, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, user_id, chat_id, workspace_name, created_at \
             FROM agent_sessions WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::not_found("no such session"))
    }
}
