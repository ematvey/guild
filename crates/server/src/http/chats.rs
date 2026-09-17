//! User-facing chat routes (spec §4.3). The gateway endpoint feeds the
//! ChatRunner workflow; these routes let clients create chats and read the
//! thread event log.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::{Chat, CreateChatRequest, MachineInfo, ThreadEvent};
use protocol::ws::WsServerMsg;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/chats", axum::routing::post(create).get(list))
        .route(
            "/api/v1/chats/{id}/thread",
            axum::routing::get(thread).post(append_thread_event),
        )
        .route(
            "/api/v1/chats/{id}/project",
            axum::routing::post(set_project),
        )
        .route(
            "/api/v1/chats/{id}/machine",
            axum::routing::post(set_machine),
        )
        .route(
            "/api/v1/chats/{id}/approval",
            axum::routing::get(get_chat_approval).post(set_chat_approval),
        )
        .route(
            "/api/v1/chats/{id}/read",
            axum::routing::post(mark_chat_read),
        )
        .route("/api/v1/machines", axum::routing::get(machines))
}

/// The chat's approval-mode override (the composer's per-chat policy).
/// Shape: `{"default": "ask"|"allow"|"never"}` or `{"default": null}` —
/// null/absent clears the override so the account-level policy applies.
async fn get_chat_approval(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    tracing::info!(chat = %chat_id, "get_chat_approval entered");
    let store = state.store().await?;
    tracing::info!("get_chat_approval store ready");
    let approval = store
        .chats()
        .approval(user.0.org_id, user.0.id, chat_id)
        .await?;
    Ok(Json(
        json!({ "default": approval.and_then(|v| v["default"].as_str().map(str::to_string)) }),
    ))
}

async fn set_chat_approval(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mode = req["default"].as_str();
    let policy = match mode {
        None | Some("default") => None,
        Some(m @ ("ask" | "approve_for_me" | "full_access")) => Some(json!({ "default": m })),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "unknown approval mode {other} — expected ask, approve_for_me, full_access, or default"
            )));
        }
    };
    let store = state.store().await?;
    store
        .chats()
        .set_approval(user.0.org_id, user.0.id, chat_id, policy.as_ref())
        .await?;
    Ok(Json(json!({ "default": mode.filter(|m| *m != "default") })))
}

/// Lists the calling user's machines: every durable registry row plus the
/// hub's live socket flag, connected machines first, then by last seen.
async fn machines(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let rows = store
        .machines()
        .list_for_user(user.0.org_id, user.0.id)
        .await?;
    let mut list: Vec<MachineInfo> = rows
        .into_iter()
        .map(|row| MachineInfo {
            connected: state.hub.machine_online(&row.machine_id),
            name: row
                .label
                .clone()
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| row.machine_id.clone()),
            machine_id: row.machine_id,
            os: row.os,
            os_version: row.os_version,
            app_version: row.app_version,
            last_ip: row.last_ip,
            first_connected_at: row.first_connected_at,
            last_connected_at: row.last_connected_at,
            last_seen_at: row.last_seen_at,
        })
        .collect();
    list.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then(b.last_seen_at.cmp(&a.last_seen_at))
    });
    Ok(Json(json!({ "machines": list })))
}

/// Marks the chat read for the caller (thread-list dot): the read marker
/// moves to the newest thread event. Org-scoped; 404 for foreign chats.
async fn mark_chat_read(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .mark_read(user.0.org_id, chat_id, &user.0)
        .await?;
    Ok(Json(json!({ "ok": true })))
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
        if !state.machine_bindable(mid, user.0.id, user.0.org_id).await {
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
    let _chat = state
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
            generating: c.generating,
            unread: false,
            project_id: c.project_id,
            project_name: None,
            project_machine_label: None,
            machine_online: false,
        }
    }
}

impl From<crate::store::chats::ChatListRow> for Chat {
    fn from(c: crate::store::chats::ChatListRow) -> Self {
        Self {
            id: c.id,
            org_id: c.org_id,
            user_id: c.user_id,
            title: c.title,
            created_at: c.created_at,
            machine_id: c.machine_id,
            machine_label: c.machine_label,
            generating: c.generating,
            unread: c.unread,
            project_id: c.project_id,
            project_name: c.project_name,
            project_machine_label: c.project_machine_label,
            machine_online: false,
        }
    }
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateChatRequest>,
) -> Result<Json<Chat>, ApiError> {
    let store = state.store().await?;
    // The project must exist and belong to the caller (admin bypass) — an
    // arbitrary id would bind a chat to someone else's workspace.
    let project = match req.project_id {
        Some(project_id) => Some(
            store
                .projects()
                .get(user.0.org_id, project_id, &user.0)
                .await?,
        ),
        None => None,
    };
    // Bind-time machine inheritance: the chat runs where its project's
    // folder lives, so a bound project's machine is the authority (the
    // project's label comes from the machines registry); a per-chat rebind
    // is a later override. INSERT sets project and machine atomically.
    let machine = project.as_ref().map(|p| {
        (
            p.machine_id.clone(),
            p.machine_label
                .clone()
                .unwrap_or_else(|| p.machine_id.clone()),
        )
    });
    let chat = store
        .chats()
        .create_chat_with_machine(
            user.0.org_id,
            user.0.id,
            req.title.as_deref(),
            req.project_id,
            machine.as_ref().map(|(id, _)| id.as_str()),
            machine.as_ref().map(|(_, label)| label.as_str()),
        )
        .await?;
    // Desktop apps auto-bind their own machine at creation when no project
    // chose the machine, so machine tools work from the first turn; the
    // machine must be registered to this user or org, same as the bind
    // endpoint.
    let chat = match (req.machine_id.as_deref(), project) {
        (Some(mid), None) if !mid.is_empty() => {
            if !state.machine_bindable(mid, user.0.id, user.0.org_id).await {
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
    // Same hub-aware rows as the socket's thread list: the connection dot
    // must not flip gray on an HTTP refresh.
    let chats = crate::http::feed::thread_list(&state, user.0.org_id, user.0.id).await?;
    Ok(Json(serde_json::json!({ "chats": chats })))
}

/// Sets (or clears, with null) the chat's project. Owner-scoped; the
/// composer chip binds the chat to a named workspace folder so every device
/// renders the grouping and the runner resolves the folder.
async fn set_project(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Chat>, ApiError> {
    let store = state.store().await?;
    let project = match req.get("project_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => {
            let id: Uuid = s
                .parse()
                .map_err(|_| ApiError::bad_request("bad project_id"))?;
            Some(store.projects().get(user.0.org_id, id, &user.0).await?)
        }
        _ => None,
    };
    let project_id = project.as_ref().map(|p| p.id);
    // Bind-time machine inheritance: the chat's machine follows the
    // project's (the project's label comes from the machines registry) in
    // the same UPDATE as the binding; unbinding keeps the current machine.
    let machine = project.as_ref().map(|p| {
        (
            p.machine_id.clone(),
            p.machine_label
                .clone()
                .unwrap_or_else(|| p.machine_id.clone()),
        )
    });
    let chat = store
        .chats()
        .set_project(
            user.0.org_id,
            chat_id,
            &user.0,
            project_id,
            machine
                .as_ref()
                .map(|(id, label)| (id.as_str(), Some(label.as_str()))),
        )
        .await?;
    // Every device renders the project grouping: push a fresh thread list to
    // the caller's live sockets so the sidebar updates without a reload.
    let broadcast = state
        .feeds
        .lock()
        .unwrap()
        .get(&user.0.id)
        .map(|f| f.broadcast.clone());
    if let Some(broadcast) = broadcast {
        if let Ok(chats) = crate::http::feed::thread_list(&state, user.0.org_id, user.0.id).await {
            let _ = broadcast.send(WsServerMsg::ThreadList { chats });
        }
    }
    Ok(Json(chat.into()))
}

/// The chat's full thread event log (spec §E): the durable source of truth
/// the client renders from. Org-scoped; 404 for foreign chats.
async fn thread(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let events = store.thread().list_events(user.0.org_id, chat_id).await?;
    // Context-usage snapshot for the gauge (dsh-style filling gauge): tokens
    // in of the LATEST assistant turn vs. the model route's context window.
    // No turns yet → model null, 0 tokens. No route or NULL window → the
    // 128000 fallback (matches the model-facing default).
    const DEFAULT_CONTEXT_WINDOW: i64 = 128_000;
    let mut tokens: i64 = 0;
    let mut model: Option<String> = None;
    for ev in events.iter().rev() {
        if let ThreadEvent::AssistantMessage {
            usage, model: m, ..
        } = &ev.event
        {
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
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
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
