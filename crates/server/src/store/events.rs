//! Org event log + emission (spec §4.6/§4.8). Emitters insert the record and
//! NOTIFY the `guild_events` channel; SSE subscribers receive the fan-out.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

pub const NOTIFY_CHANNEL: &str = "guild_events";

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct EventRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

pub struct EventStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> EventStore<'a> {
    /// Records an event and notifies subscribers in one transaction.
    pub async fn emit(
        &self,
        org_id: Uuid,
        kind: &str,
        payload: Value,
    ) -> Result<EventRow, ApiError> {
        let id = Uuid::now_v7();
        let mut tx = self.pool.begin().await?;
        let row: EventRow = sqlx::query_as(
            "INSERT INTO events (id, org_id, kind, payload) VALUES ($1, $2, $3, $4) \
             RETURNING id, org_id, kind, payload, created_at",
        )
        .bind(id)
        .bind(org_id)
        .bind(kind)
        .bind(payload)
        .fetch_one(&mut *tx)
        .await?;
        let notify_payload = json!({"org_id": org_id, "event_id": id, "kind": kind}).to_string();
        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(NOTIFY_CHANNEL)
            .bind(notify_payload)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(row)
    }

    pub async fn list(&self, org_id: Uuid, limit: i64) -> Result<Vec<EventRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, kind, payload, created_at FROM events \
             WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2",
        )
        .bind(org_id)
        .bind(limit.clamp(1, 500))
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn get(&self, org_id: Uuid, id: Uuid) -> Result<Option<EventRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, kind, payload, created_at FROM events \
             WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(Into::into)
    }
}

/// Ephemeral per-chat status frames (thread-list spinner/unread):
/// NOTIFY-only — the org event log stays meaningful, per-turn status would
/// flood it. The events stream forwards matching frames to the owning
/// user's connections.
pub const CHAT_STATUS_CHANNEL: &str = "guild_chat_status";

/// Notifies one chat-status frame. Caller-visible fields only (org, owner,
/// chat, flag) — other members' streams filter it out by user_id.
pub async fn notify_chat_status(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Uuid,
    chat_id: Uuid,
    generating: bool,
) -> Result<(), ApiError> {
    let payload = serde_json::json!({
        "org_id": org_id,
        "user_id": user_id,
        "chat_id": chat_id,
        "generating": generating,
    })
    .to_string();
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(CHAT_STATUS_CHANNEL)
        .bind(payload)
        .execute(pool)
        .await?;
    Ok(())
}
