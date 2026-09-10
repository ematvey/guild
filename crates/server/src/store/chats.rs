//! Org-scoped chats (spec §4.3). Message history moved to the thread event
//! log (spec §A): `store::thread` owns persistence, this store owns chat rows.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChatRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Bound executor machine (machine tools run only there).
    pub machine_id: Option<String>,
    pub machine_label: Option<String>,
}

pub struct ChatStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> ChatStore<'a> {
    pub async fn create_chat(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        title: Option<&str>,
    ) -> Result<ChatRow, ApiError> {
        let id = Uuid::now_v7();
        sqlx::query_as::<_, ChatRow>(
            "INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, $4) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(title)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn list_chats(&self, org_id: Uuid, user_id: Uuid) -> Result<Vec<ChatRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, user_id, title, created_at, machine_id, machine_label FROM chats \
             WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC",
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn get_chat(&self, org_id: Uuid, chat_id: Uuid) -> Result<ChatRow, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, user_id, title, created_at, machine_id, machine_label FROM chats WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))
    }

    /// Binds (or unbinds, with `None`s) a chat to an executor machine.
    pub async fn set_machine(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        machine_id: Option<&str>,
        machine_label: Option<&str>,
    ) -> Result<ChatRow, ApiError> {
        sqlx::query_as(
            "UPDATE chats SET machine_id = $3, machine_label = $4 \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(machine_id)
        .bind(machine_label)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }
}
