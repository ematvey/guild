//! Thread event log (spec docs/plans/2026-09-12-thread-events-design.md §A):
//! the append-only event table is the durable source of truth for a chat;
//! model-facing history and client rendering are derivations.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use protocol::api::ThreadEvent;
use serde::Serialize;
use uuid::Uuid;

/// One persisted thread event, as returned to clients (`GET /thread`).
#[derive(Debug, Clone, Serialize)]
pub struct ThreadEventRow {
    pub id: Uuid,
    pub chat_id: Uuid,
    /// Global write order from the BIGSERIAL column.
    pub seq: i64,
    pub event: ThreadEvent,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct EventRowDb {
    id: Uuid,
    chat_id: Uuid,
    seq: i64,
    payload: serde_json::Value,
    created_at: DateTime<Utc>,
}

impl TryFrom<EventRowDb> for ThreadEventRow {
    type Error = ApiError;

    fn try_from(r: EventRowDb) -> Result<Self, ApiError> {
        let event: ThreadEvent = serde_json::from_value(r.payload)
            .map_err(|e| ApiError::internal(format!("corrupt thread event payload: {e}")))?;
        Ok(ThreadEventRow {
            id: r.id,
            chat_id: r.chat_id,
            seq: r.seq,
            event,
            created_at: r.created_at,
        })
    }
}

pub struct ThreadStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> ThreadStore<'a> {
    /// Appends one event: uuid v7 id generated here, `seq` from the BIGSERIAL
    /// column (global write order). Returns the full row.
    pub async fn append_event(
        &self,
        chat_id: Uuid,
        event: &ThreadEvent,
    ) -> Result<ThreadEventRow, ApiError> {
        let payload = serde_json::to_value(event).expect("thread event serializes");
        let event_type = payload["type"]
            .as_str()
            .expect("internally tagged event has a type")
            .to_string();
        let row: EventRowDb = sqlx::query_as(
            "INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, $3, $4) \
             RETURNING id, chat_id, seq, payload, created_at",
        )
        .bind(Uuid::now_v7())
        .bind(chat_id)
        .bind(event_type)
        .bind(payload)
        .fetch_one(self.pool)
        .await
        .map_err(ApiError::from)?;
        row.try_into()
    }

    /// Lists a chat's events, org-scoped via the chats join, ordered by
    /// `id` (uuid v7 = append order within a chat).
    pub async fn list_events(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
    ) -> Result<Vec<ThreadEventRow>, ApiError> {
        let rows: Vec<EventRowDb> = sqlx::query_as(
            "SELECT e.id, e.chat_id, e.seq, e.payload, e.created_at \
             FROM thread_events e JOIN chats c ON c.id = e.chat_id \
             WHERE c.org_id = $1 AND e.chat_id = $2 ORDER BY e.id",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    /// Highest `turn` value in the chat's log (0 when the log is empty).
    /// Used to place engine-side appends into the latest turn.
    pub async fn latest_turn(&self, chat_id: Uuid) -> Result<u32, ApiError> {
        let v: Option<i32> = sqlx::query_scalar(
            "SELECT max((payload->>'turn')::int) FROM thread_events WHERE chat_id = $1",
        )
        .bind(chat_id)
        .fetch_one(self.pool)
        .await
        .map_err(ApiError::from)?;
        Ok(v.unwrap_or(0).max(0) as u32)
    }
}
