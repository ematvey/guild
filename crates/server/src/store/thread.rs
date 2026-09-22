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

impl EventRowDb {
    /// Lenient read for log listings: the enum is a closed schema over a
    /// durable log, so an event written by a NEWER server (unknown type)
    /// must not fail the whole chat history. Unparseable payloads are
    /// dropped here with a warning; callers derive everything from the
    /// parseable prefix.
    fn into_event_row_lenient(self) -> Option<ThreadEventRow> {
        match serde_json::from_value::<ThreadEvent>(self.payload.clone()) {
            Ok(event) => Some(ThreadEventRow {
                id: self.id,
                chat_id: self.chat_id,
                seq: self.seq,
                event,
                created_at: self.created_at,
            }),
            Err(e) => {
                tracing::warn!(
                    chat = %self.chat_id,
                    seq = self.seq,
                    "dropping unparsable thread event from the log: {e}"
                );
                None
            }
        }
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
        self.append_event_with_id(chat_id, event, Uuid::now_v7())
            .await
    }

    /// A supplied message identity makes a retried durable append idempotent.
    pub async fn append_event_with_id(
        &self,
        chat_id: Uuid,
        event: &ThreadEvent,
        id: Uuid,
    ) -> Result<ThreadEventRow, ApiError> {
        let payload = serde_json::to_value(event).expect("thread event serializes");
        let event_type = payload["type"]
            .as_str()
            .expect("internally tagged event has a type")
            .to_string();
        let mut transaction = self.pool.begin().await?;
        let row: EventRowDb = sqlx::query_as(
            "INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id \
             WHERE thread_events.chat_id = EXCLUDED.chat_id AND thread_events.payload = EXCLUDED.payload \
             RETURNING id, chat_id, seq, payload, created_at",
        )
        .bind(id)
        .bind(chat_id)
        .bind(event_type)
        .bind(payload)
        .fetch_one(&mut *transaction)
        .await
        .map_err(ApiError::from)?;
        sqlx::query("SELECT pg_notify('guild_thread_committed', $1)")
            .bind(chat_id.to_string())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        row.try_into()
    }

    /// Reserves a watermark in the same order space as durable thread rows.
    pub async fn watermark(&self) -> Result<i64, ApiError> {
        Ok(
            sqlx::query_scalar("SELECT nextval(pg_get_serial_sequence('thread_events', 'seq'))")
                .fetch_one(self.pool)
                .await?,
        )
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
             WHERE c.org_id = $1 AND e.chat_id = $2 ORDER BY e.seq",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)?;
        Ok(rows.into_iter().filter_map(|row| row.into_event_row_lenient()).collect())
    }

    /// Newest page of the chat's event log, keyset-paginated on `seq`
    /// (write order): rows strictly older than `before_seq`, newest first,
    /// returned in ascending order so callers prepend as-is. The extra
    /// limit+1th row becomes `has_more` instead of a payload. `before_seq`
    /// None = start from the newest event (the first page).
    pub async fn list_events_page(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        limit: i64,
        before_seq: Option<i64>,
    ) -> Result<(Vec<ThreadEventRow>, bool), ApiError> {
        let mut rows: Vec<EventRowDb> = sqlx::query_as(
            "SELECT e.id, e.chat_id, e.seq, e.payload, e.created_at \
             FROM thread_events e JOIN chats c ON c.id = e.chat_id \
             WHERE c.org_id = $1 AND e.chat_id = $2 \
               AND ($3::bigint IS NULL OR e.seq < $3) \
             ORDER BY e.seq DESC LIMIT $4",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(before_seq)
        .bind(limit + 1)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        rows.reverse(); // page order: ascending seq, the caller's display order
        let events = rows
            .into_iter()
            .filter_map(|row| row.into_event_row_lenient())
            .collect::<Vec<ThreadEventRow>>();
        Ok((events, has_more))
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
