//! Org events API (spec §4.6/§4.8): recent list + SSE stream fanned out via
//! Postgres LISTEN/NOTIFY.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::{Json, Router};
use futures::Stream;
use serde_json::{json, Value};
use std::convert::Infallible;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/events", axum::routing::get(list))
        .route("/api/v1/events/stream", axum::routing::get(stream))
}

async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let events = store.events().list(user.0.org_id, 200).await?;
    Ok(Json(json!({ "events": events })))
}

async fn stream(
    State(state): State<AppState>,
    user: AuthUser,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let org = user.0.org_id;
    // App-level presence: this connection is held for the app's lifetime
    // and is the liveness signal for client-tool termination detection.
    // The guard lives inside the body generator, so dropping the response
    // (client disconnect) releases it.
    let presence = q
        .get("client_id")
        .map(|cid| state.presence_acquire(cid));
    let store = state.store().await?;
    let listener = sqlx::postgres::PgListener::connect_with(store.pool())
        .await
        .map_err(|e| ApiError::internal(format!("event subscribe failed: {e}")))?;
    let mut listener = listener;
    listener
        .listen(crate::store::events::NOTIFY_CHANNEL)
        .await
        .map_err(|e| ApiError::internal(format!("event subscribe failed: {e}")))?;
    let out = async_stream::stream! {
        // Hold the presence guard for as long as this body lives.
        let _presence = presence;
        loop {
            match listener.recv().await {
                Ok(notification) => {
                    let payload: Value = match serde_json::from_str(notification.payload()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if payload["org_id"].as_str() != Some(&org.to_string()) {
                        continue;
                    }
                    let Some(event_id) = payload["event_id"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                        continue;
                    };
                    let row = store.events().get(org, event_id).await;
                    match row {
                        Ok(Some(event)) => {
                            let body = serde_json::to_string(&event).unwrap_or_default();
                            yield Ok(SseEvent::default().event("org_event").data(body));
                        }
                        Ok(None) => continue,
                        Err(e) => {
                            yield Ok(SseEvent::default().event("error").data(
                                json!({"message": e.message}).to_string(),
                            ));
                            break;
                        }
                    }
                }
                Err(e) => {
                    yield Ok(SseEvent::default().event("error").data(
                        json!({"message": e.to_string()}).to_string(),
                    ));
                    break;
                }
            }
        }
    };
    Ok(Sse::new(out).keep_alive(KeepAlive::default()))
}
