//! User-facing chat routes (spec §4.3). The gateway endpoint writes messages
//! too; these routes let clients create chats and read history.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::{Chat, CreateChatRequest};
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/chats", axum::routing::post(create).get(list))
        .route(
            "/api/v1/chats/{id}/messages",
            axum::routing::get(messages).post(append),
        )
        .route("/api/v1/chats/{id}/thread", axum::routing::get(thread))
        .route(
            "/api/v1/chats/{id}/machine",
            axum::routing::post(set_machine),
        )
        .route("/api/v1/machines", axum::routing::get(machines))
        .route(
            "/api/v1/machines/heartbeat",
            axum::routing::post(heartbeat),
        )
}

/// Executor heartbeat: desktop apps refresh their machine's liveness every
/// few seconds; liveness = heartbeats fresher than `EXECUTOR_TTL_SECS`.
async fn heartbeat(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let machine_id = req["machine_id"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing machine_id"))?;
    let ok = state.executor_touch(machine_id, user.0.id);
    Ok(Json(json!({ "ok": ok })))
}

/// Lists the calling user's connected machine executors.
async fn machines(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let list: Vec<Value> = state
        .machines_of_user(user.0.id)
        .into_iter()
        .map(|(id, name)| json!({ "machine_id": id, "name": name }))
        .collect();
    Ok(Json(json!({ "machines": list })))
}

/// Binds (or with empty machine_id, unbinds) a chat to an executor machine.
async fn set_machine(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Chat>, ApiError> {
    let machine_id = req["machine_id"].as_str().filter(|s| !s.is_empty());
    let label = req["machine_label"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // Trust the label only for a machine this user currently has connected;
    // otherwise keep whatever label is already stored.
    let label = match machine_id {
        Some(mid) => Some(
            state
                .machine_label(mid)
                .unwrap_or_else(|| label.unwrap_or_else(|| mid.to_string())),
        ),
        None => None,
    };
    let chat = state
        .store()
        .await?
        .chats()
        .set_machine(user.0.org_id, chat_id, machine_id, label.as_deref())
        .await?;
    Ok(Json(chat.into()))
}

impl From<crate::store::chats::ChatRow> for Chat {
    fn from(c: crate::store::chats::ChatRow) -> Self {
        Self {
            id: c.id,
            org_id: c.org_id,
            user_id: c.user_id,
            title: c.title,
            created_at: c.created_at,
            machine_id: c.machine_id,
            machine_label: c.machine_label,
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
    // Desktop apps auto-bind their own machine at creation so machine tools
    // work from the first turn.
    let chat = match req.machine_id.as_deref() {
        Some(mid) if !mid.is_empty() => {
            let label = state.machine_label(mid).unwrap_or_else(|| mid.to_string());
            store
                .chats()
                .set_machine(user.0.org_id, chat.id, Some(mid), Some(&label))
                .await?
        }
        _ => chat,
    };
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

/// Appends a client-produced message (tool results, retries). The assistant
/// role is server-owned via the gateway and rejected here.
async fn append(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.chats().get_chat(user.0.org_id, chat_id).await?;
    let role = req["role"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing role"))?;
    if !matches!(role, "user" | "tool" | "system") {
        return Err(ApiError::bad_request("role must be user, tool, or system"));
    }
    let content = req["content"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing content"))?;
    let tool_call_id = req["tool_call_id"].as_str().map(String::from);
    if role == "tool" && tool_call_id.is_none() {
        return Err(ApiError::bad_request("tool messages need tool_call_id"));
    }
    store
        .chats()
        .append_message(chat_id, role, content, None, tool_call_id, None, None, None)
        .await?;
    Ok(Json(serde_json::json!({})))
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

/// The chat's full thread event log (spec §E): the durable source of truth
/// the client renders from. Org-scoped like messages; 404 for foreign chats.
async fn thread(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.chats().get_chat(user.0.org_id, chat_id).await?;
    let events = store.thread().list_events(user.0.org_id, chat_id).await?;
    Ok(Json(serde_json::json!({ "events": events })))
}
