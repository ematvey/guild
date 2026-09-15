//! Attachment endpoints (spec §4.3/§5): upload bytes into object storage and
//! reference them from a chat.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    let uploads = Router::new()
        .route(
            "/api/v1/chats/{chat_id}/attachments",
            axum::routing::post(upload),
        )
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024));
    Router::new()
        .merge(uploads)
        .route(
            "/api/v1/chats/{chat_id}/attachments",
            axum::routing::get(list_for_chat),
        )
        .route("/api/v1/attachments/{id}", axum::routing::get(download))
}

async fn upload(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let filename = q
        .get("filename")
        .and_then(|f| crate::store::attachments::safe_filename(f))
        .ok_or_else(|| ApiError::bad_request("bad filename"))?;
    let content_type = q
        .get("content_type")
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".into());
    let store = state.store().await?;
    // chat must belong to the caller's org
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let id = Uuid::now_v7();
    let key = crate::store::attachments::object_key(user.0.org_id, id, &filename);
    state
        .objects()
        .await?
        .put(&key, body.to_vec())
        .await
        .map_err(|e| ApiError::internal(format!("object store write failed: {e}")))?;
    let row = store
        .attachments()
        .create(
            id,
            user.0.org_id,
            chat_id,
            &filename,
            &content_type,
            body.len() as i64,
            &key,
        )
        .await?;
    Ok(Json(
        serde_json::to_value(&row).expect("attachment serializes"),
    ))
}

async fn list_for_chat(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let rows = store.attachments().list(user.0.org_id, chat_id).await?;
    Ok(Json(json!({ "attachments": rows })))
}

async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.store().await?;
    let row = store.attachments().get(user.0.org_id, id).await?;
    // The attachment rides a chat, so the chat's owner predicate applies:
    // org scoping alone would let a member pull another member's uploads.
    store
        .chats()
        .get_chat(user.0.org_id, row.chat_id, &user.0)
        .await?;
    let key = crate::store::attachments::object_key(row.org_id, row.id, &row.filename);
    let bytes = state
        .objects()
        .await?
        .get(&key)
        .await
        .map_err(|e| ApiError::internal(format!("object store read failed: {e}")))?;
    Ok((
        [
            (CONTENT_TYPE, row.content_type.clone()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", row.filename),
            ),
        ],
        bytes,
    ))
}
