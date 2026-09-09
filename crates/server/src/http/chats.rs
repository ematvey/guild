//! User-facing chat routes (spec §4.3). The gateway endpoint writes messages
//! too; these routes let clients create chats and read history.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::{Chat, CreateChatRequest};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/chats", axum::routing::post(create).get(list))
        .route("/api/v1/chats/{id}/messages", axum::routing::get(messages))
}

impl From<crate::store::chats::ChatRow> for Chat {
    fn from(c: crate::store::chats::ChatRow) -> Self {
        Self {
            id: c.id,
            org_id: c.org_id,
            user_id: c.user_id,
            title: c.title,
            created_at: c.created_at,
        }
    }
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateChatRequest>,
) -> Result<Json<Chat>, ApiError> {
    let store = state.store().await?;
    let chat = store
        .chats()
        .create_chat(user.0.org_id, user.0.id, req.title.as_deref())
        .await?;
    Ok(Json(chat.into()))
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let chats = store.chats().list_chats(user.0.org_id, user.0.id).await?;
    let chats: Vec<Chat> = chats.into_iter().map(Into::into).collect();
    Ok(Json(serde_json::json!({ "chats": chats })))
}

async fn messages(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    // 404 for chats outside the caller's org, not an empty list.
    store.chats().get_chat(user.0.org_id, chat_id).await?;
    let msgs = store.chats().list_messages(user.0.org_id, chat_id).await?;
    Ok(Json(serde_json::json!({ "messages": msgs })))
}
