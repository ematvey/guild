//! Org-scoped chats and messages (spec §4.3).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use protocol::api::MessageRow;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChatRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct MessageRowDb {
    id: Uuid,
    chat_id: Uuid,
    role: String,
    content: String,
    tokens_in: Option<i32>,
    tokens_out: Option<i32>,
    cost_usd: Option<f64>,
    created_at: DateTime<Utc>,
}

impl From<MessageRowDb> for MessageRow {
    fn from(m: MessageRowDb) -> Self {
        Self {
            id: m.id,
            chat_id: m.chat_id,
            role: m.role,
            content: m.content,
            tokens_in: m.tokens_in,
            tokens_out: m.tokens_out,
            cost_usd: m.cost_usd,
            created_at: m.created_at,
        }
    }
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
             RETURNING id, org_id, user_id, title, created_at",
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
            "SELECT id, org_id, user_id, title, created_at FROM chats \
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
            "SELECT id, org_id, user_id, title, created_at FROM chats WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))
    }

    pub async fn append_message(
        &self,
        chat_id: Uuid,
        role: &str,
        content: &str,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        cost_usd: Option<f64>,
    ) -> Result<MessageRow, ApiError> {
        let id = Uuid::now_v7();
        sqlx::query_as::<_, MessageRowDb>(
            "INSERT INTO messages (id, chat_id, role, content, tokens_in, tokens_out, cost_usd) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING id, chat_id, role, content, tokens_in, tokens_out, cost_usd, created_at",
        )
        .bind(id)
        .bind(chat_id)
        .bind(role)
        .bind(content)
        .bind(tokens_in.map(|t| t as i32))
        .bind(tokens_out.map(|t| t as i32))
        .bind(cost_usd)
        .fetch_one(self.pool)
        .await
        .map(MessageRow::from)
        .map_err(Into::into)
    }

    pub async fn list_messages(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
    ) -> Result<Vec<MessageRow>, ApiError> {
        let rows: Vec<MessageRowDb> = sqlx::query_as(
            "SELECT m.id, m.chat_id, m.role, m.content, m.tokens_in, m.tokens_out, m.cost_usd, m.created_at \
             FROM messages m JOIN chats c ON c.id = m.chat_id \
             WHERE c.org_id = $1 AND m.chat_id = $2 ORDER BY m.created_at, m.id",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}
