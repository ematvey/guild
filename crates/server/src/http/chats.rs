//! User-facing chat routes (spec §4.3). The gateway endpoint feeds the
//! ChatRunner workflow; these routes let clients create chats and read the
//! thread event log.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::{Chat, CreateChatRequest, ThreadEvent};
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/chats", axum::routing::post(create).get(list))
        .route("/api/v1/chats/{id}/thread", axum::routing::get(thread).post(append_thread_event))
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
/// Registers an unknown machine (upsert), so a reconnecting app re-joins
/// by heartbeat alone without waiting for a fresh stream connect.
async fn heartbeat(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let machine_id = req["machine_id"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing machine_id"))?;
    let name = req["machine_name"].as_str().unwrap_or("");
    let ok = state.executor_touch(machine_id, user.0.id, user.0.org_id, name);
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
/// The chat must belong to the caller (admin bypass), and the machine must
/// be registered to the caller or their org — an arbitrary machine_id string
/// would let a chat dispatch tools on someone else's desktop.
async fn set_machine(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Chat>, ApiError> {
    let machine_id = req["machine_id"].as_str().filter(|s| !s.is_empty());
    if let Some(mid) = machine_id {
        if !state.machine_bindable(mid, user.0.id, user.0.org_id) {
            return Err(ApiError::bad_request("unknown machine"));
        }
    }
    let label = req["machine_label"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // Trust the label only for a machine this user currently has connected;
    // otherwise keep whatever label is already stored.
    let label = machine_id.map(|mid| {
        state
            .machine_label(mid)
            .unwrap_or_else(|| label.unwrap_or_else(|| mid.to_string()))
    });
    let chat = state
        .store()
        .await?
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let chat = state
        .store()
        .await?
        .chats()
        .set_machine(user.0.org_id, chat_id, machine_id, label.as_deref())
        .await?;
    Ok(Json(chat.into()))
}

/// Per-user approval policy lives at /api/v1/me/approval (auth.rs) — see
/// migration 0026: tool trust is user-scoped, not per-chat.
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
    // work from the first turn; the machine must be registered to this user
    // or org, same as the bind endpoint.
    let chat = match req.machine_id.as_deref() {
        Some(mid) if !mid.is_empty() => {
            if !state.machine_bindable(mid, user.0.id, user.0.org_id) {
                return Err(ApiError::bad_request("unknown machine"));
            }
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

/// The chat's full thread event log (spec §E): the durable source of truth
/// the client renders from. Org-scoped; 404 for foreign chats.
async fn thread(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.chats().get_chat(user.0.org_id, chat_id, &user.0).await?;
    let events = store.thread().list_events(user.0.org_id, chat_id).await?;
    // Context-usage snapshot for the gauge (dsh-style filling gauge): tokens
    // in of the LATEST assistant turn vs. the model route's context window.
    // No turns yet → model null, 0 tokens. No route or NULL window → the
    // 128000 fallback (matches the model-facing default).
    const DEFAULT_CONTEXT_WINDOW: i64 = 128_000;
    let mut tokens: i64 = 0;
    let mut model: Option<String> = None;
    for ev in events.iter().rev() {
        if let ThreadEvent::AssistantMessage { usage, model: m, .. } = &ev.event {
            tokens = i64::from(usage.tokens_in.unwrap_or(0));
            model = Some(m.clone());
            break;
        }
    }
    let max = match &model {
        Some(m) => store
            .gateway()
            .context_window(user.0.org_id, m)
            .await?
            .unwrap_or(DEFAULT_CONTEXT_WINDOW),
        None => DEFAULT_CONTEXT_WINDOW,
    };
    Ok(Json(serde_json::json!({
        "events": events,
        "context": { "tokens": tokens, "max": max, "model": model },
    })))
}

/// Appends one thread event from a client. Used by the desktop engine path
/// (workspace agent sessions run their tool loop locally, so the server never
/// sees their tool executions through the ChatRunner) — engine tool results
/// land here so the event log stays the single record. `turn: 0` means "join
/// the latest turn"; the server assigns the real turn number.
async fn append_thread_event(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(event): Json<ThreadEvent>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.chats().get_chat(user.0.org_id, chat_id, &user.0).await?;
    let event = match event {
        ThreadEvent::ToolResult { turn: 0, step, .. } => {
            let turn = store.thread().latest_turn(chat_id).await?.max(1);
            let mut ev = event;
            if let ThreadEvent::ToolResult { turn: t, .. } = &mut ev {
                *t = turn;
            }
            let _ = step;
            ev
        }
        other => other,
    };
    let row = store.thread().append_event(chat_id, &event).await?;
    Ok(Json(serde_json::json!({
        "id": row.id, "seq": row.seq, "event": row.event, "created_at": row.created_at
    })))
}
