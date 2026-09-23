//! User-facing chat routes (spec §4.3). The gateway endpoint feeds the
//! ChatRunner workflow; these routes let clients create chats and read the
//! thread event log.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::{Chat, CreateChatRequest, MachineInfo, ThreadEvent, UpdateChatRequest};
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
            "/api/v1/chats/{id}/approval",
            axum::routing::get(get_chat_approval).post(set_chat_approval),
        )
        .route(
            "/api/v1/chats/{id}/read",
            axum::routing::post(mark_chat_read),
        )
        .route("/api/v1/chats/{id}", axum::routing::patch(update_chat))
        .route("/api/v1/machines", axum::routing::get(machines))
        .route(
            "/api/v1/machines/{id}/fs",
            axum::routing::post(machine_fs_request),
        )
}

/// Control-plane request to a machine's executor socket, owner-scoped:
/// read-only filesystem ops the desktop UI drives directly (folder browse
/// for remote projects). `op`: `fs_list` (payload `{path}`), `fs_home`.
async fn machine_fs_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(machine_id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let owned = store
        .machines()
        .list_for_user(user.0.org_id, user.0.id)
        .await?
        .iter()
        .any(|m| m.machine_id == machine_id.to_string());
    if !owned {
        return Err(ApiError::not_found("no such machine"));
    }
    let op = req["op"].as_str().unwrap_or_default().to_owned();
    let payload = req.get("payload").cloned().unwrap_or(Value::Null);
    if !matches!(op.as_str(), "fs_list" | "fs_home") {
        return Err(ApiError::bad_request("unknown op"));
    }
    let result = state
        .hub
        .machine_request(
            &machine_id.to_string(),
            user.0.org_id,
            &op,
            payload,
            std::time::Duration::from_secs(10),
        )
        .await;
    match result {
        Ok(payload) => Ok(Json(json!({ "ok": true, "result": payload }))),
        Err(e) => Err(ApiError::internal(match e {
            crate::http::hub::MachineRequestError::Offline => "machine offline".to_owned(),
            crate::http::hub::MachineRequestError::SendFailed => "machine unreachable".to_owned(),
            crate::http::hub::MachineRequestError::TimedOut => "machine did not answer".to_owned(),
            crate::http::hub::MachineRequestError::Rejected(error) => error,
        })),
    }
}

/// Renames and/or archives the chat. Only present fields change; archived
/// chats drop out of the list (GET /api/v1/chats) but direct links still
/// resolve.
async fn update_chat(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<UpdateChatRequest>,
) -> Result<Json<Chat>, ApiError> {
    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let store = state.store().await?;
    let row = store
        .chats()
        .update_chat(user.0.org_id, chat_id, &user.0, title, req.archived)
        .await?;
    if req.archived == Some(true) {
        // Archiving is an escape hatch: it must also end any in-flight
        // generation, or an archived chat keeps spinning where the user can
        // no longer reach it (the sidebar never lists archived chats).
        crate::http::gateway::abort_generation(&state, chat_id).await;
    }
    Ok(Json(Chat::from(row)))
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
    // The project must exist and belong to the caller — an arbitrary id would
    // bind a chat to someone else's workspace.
    let project = match req.project_id {
        Some(project_id) => Some(
            store
                .projects()
                .get(user.0.org_id, project_id, user.0.id)
                .await?,
        ),
        None => None,
    };
    // Machine binding is project-derived: the chat runs where its project's
    // folder lives, so the bound project's machine is the only authority (the
    // project's label comes from the machines registry). A chat with no
    // project stays fully unbound — its tools run in the sandbox executor.
    // INSERT sets project and machine atomically.
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
    Ok(Json(chat.into()))
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    axum::extract::Query(q): axum::extract::Query<ListChatsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Same hub-aware rows as the socket's thread list: the connection dot
    // must not flip gray on an HTTP refresh. `?archived=1` lists the
    // archived chats instead (the sidebar's Archived section).
    let chats = if matches!(q.archived.as_deref(), Some("1" | "true")) {
        crate::http::feed::thread_list_archived(&state, user.0.org_id, user.0.id).await?
    } else {
        crate::http::feed::thread_list(&state, user.0.org_id, user.0.id).await?
    };
    Ok(Json(serde_json::json!({ "chats": chats })))
}

#[derive(serde::Deserialize)]
struct ListChatsQuery {
    /// `1`/`true` — list archived chats instead of the active sidebar.
    archived: Option<String>,
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
            Some(store.projects().get(user.0.org_id, id, user.0.id).await?)
        }
        _ => None,
    };
    let project_id = project.as_ref().map(|p| p.id);
    // Machine binding is project-derived: the chat's machine follows the
    // project's (the project's label comes from the machines registry) in
    // the same UPDATE as the binding; unbinding the project clears it — a
    // machine-bound chat with no project is not a valid state.
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
                .map(|(id, label)| (id.as_str(), label.as_str())),
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
