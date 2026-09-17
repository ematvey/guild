//! HTTP chat commands and provider administration. Completion output and
//! machine tool results travel over WebSocket.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::identity::UserRow;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::{Json, Router};
use guild_core::provider::ProviderError;
use protocol::api::{ChatCompletionRequest, StreamEvent, ThreadEvent};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

/// A server-side generation in flight, detached from any client connection.
/// Broadcasts generation events to command-scoped WebSocket consumers.
/// Text buffers contain only the current, unpersisted assistant step.
pub struct ActiveGeneration {
    pub id: Uuid,
    pub tx: broadcast::Sender<StreamEvent>,
    pub text: Arc<RwLock<String>>,
    /// Reasoning accumulated so far in the in-flight model call, for
    /// catch-up on attach (first `thinking_delta` frame carries the buffer).
    pub thinking: Arc<RwLock<String>>,
    /// Suspended machine calls and the connection responsible for each call.
    pub pending_tools: Arc<std::sync::Mutex<HashMap<String, PendingTool>>>,
}

/// One suspended machine tool call.
pub struct PendingTool {
    pub name: String,
    pub arguments: String,
    /// Bound executor machine; `None` → fall back to the 5-minute timeout
    /// only.
    pub machine_id: Option<String>,
    /// Workspace folder the tool runs in (from the chat's project).
    pub workdir: Option<String>,
    pub connection_id: Option<Uuid>,
    /// Fired when the tool is resolved so the presence watcher stops.
    pub done: Arc<tokio::sync::Notify>,
}

pub(crate) fn pending_tool_exists(state: &AppState, chat_id: Uuid, call_id: &str) -> bool {
    state
        .generations
        .lock()
        .unwrap()
        .get(&chat_id)
        .map(|g| g.pending_tools.lock().unwrap().contains_key(call_id))
        .unwrap_or(false)
}

/// Watches the bound machine's socket liveness while a machine tool is
/// suspended. If the socket stays offline past the grace window, the tool is
/// resolved with an error so the turn continues instead of dead-airing until
/// the 5-minute timeout. All machine tool results funnel through the same durable `complete_tool`
/// handler, so this stays replay-safe; late duplicate completions no-op.
pub(crate) fn spawn_machine_watcher(
    state: &AppState,
    chat_id: Uuid,
    call_id: String,
    tool_name: String,
    machine_id: String,
    machine_label: String,
    done: Arc<tokio::sync::Notify>,
) {
    let state = state.clone();
    let connection = {
        let generations = state.generations.lock().unwrap();
        generations.get(&chat_id).and_then(|g| {
            g.pending_tools
                .lock()
                .unwrap()
                .get(&call_id)
                .and_then(|tool| tool.connection_id)
        })
    };
    let deadline = tokio::time::Instant::now() + crate::worker::restate::CLIENT_TOOL_TIMEOUT;
    tokio::spawn(async move {
        // The grace window covers brief disconnects and reconnects before the
        // tool is declared aborted.
        const GRACE: std::time::Duration = std::time::Duration::from_secs(15);
        let mut gone_since: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                _ = done.notified() => return,
                _ = tokio::time::sleep_until(deadline) => return, // backstop handles it
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
            }
            if !pending_tool_exists(&state, chat_id, &call_id) {
                return; // resolved already
            }
            let current = state.hub.machine_connection(&machine_id);
            if current.is_some() && current != connection {
                reconcile_machine_tools(&state, &machine_id, current.unwrap()).await;
                return;
            }
            if current.is_some() {
                gone_since = None;
                continue;
            }
            let since = *gone_since.get_or_insert_with(tokio::time::Instant::now);
            if since.elapsed() >= GRACE {
                let _ = crate::http::internal::restate_send_one_way(
                    &state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_tool"),
                    serde_json::json!({
                        "call_id": call_id,
                        "content": format!(
                            "client tool {tool_name} aborted: the bound machine '{machine_label}' went offline before executing it",
                        ),
                        "is_error": true,
                    }),
                )
                .await;
                return;
            }
        }
    });
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/gateway/models", axum::routing::get(models))
        .route("/api/v1/gateway/chat", axum::routing::post(chat))
        .route(
            "/api/v1/gateway/chat/{id}/approvals/{call_id}",
            axum::routing::post(approval_decision),
        )
        .route(
            "/api/v1/gateway/chat/{id}/compact",
            axum::routing::post(compact_chat),
        )
        .route(
            "/api/v1/admin/gateway/providers",
            axum::routing::get(list_providers).post(create_provider),
        )
        .route(
            "/api/v1/admin/gateway/providers/{slug}",
            axum::routing::put(update_provider).delete(delete_provider),
        )
        .route(
            "/api/v1/admin/gateway/routes/{model}",
            axum::routing::delete(delete_route),
        )
        .route(
            "/api/v1/admin/gateway/routes",
            axum::routing::get(list_routes).put(set_route),
        )
}

/// Extractor: bearer-auth user that must be an org admin.
pub struct AdminUser(pub UserRow);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        if user.0.role != "admin" {
            return Err(ApiError::forbidden());
        }
        Ok(AdminUser(user.0))
    }
}

async fn models(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let list = store.gateway().list_models(user.0.org_id).await?;
    Ok(Json(serde_json::json!({ "models": list })))
}

/// Wire protocols Guild can speak. A provider picks one; its name is free-form.
const PROTOCOLS: [&str; 2] = ["openai", "anthropic"];

/// Why an orphaned approval call never executed: its turn ended before the
/// card was answered (server restart, crash, or a turn that died mid-wait).
const APPROVAL_EXPIRED_REASON: &str = "expired — no turn was waiting for this approval";

/// One-way forward of an approval decision to the ChatRunner's
/// `complete_approval` awakeable resolver.
async fn forward_approval_decision(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    approved: bool,
    reason: Option<String>,
) -> Result<String, ApiError> {
    crate::http::internal::restate_send_one_way(
        state,
        "ChatRunner",
        &format!("{chat_id}/complete_approval"),
        serde_json::to_value(crate::worker::restate::ApprovalReq {
            call_id: call_id.to_string(),
            approved,
            reason,
        })
        .expect("approval request serializes"),
    )
    .await
}

/// Derives the stable slug routes reference from a provider's display name.
fn provider_slug(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "provider".to_string()
    } else {
        slug
    }
}

async fn list_routes(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let rows = store.gateway().list_routes(admin.0.org_id).await?;
    Ok(Json(serde_json::json!({ "routes": rows })))
}

/// Provider rows for the admin settings (metadata only, never the secret).
async fn list_providers(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    let providers = store
        .gateway()
        .list_providers(admin.0.org_id, &master)
        .await?;
    Ok(Json(json!({ "providers": providers })))
}

/// Creates a provider: {name, protocol, base_url, key}. The slug routes will
/// reference is derived from the name; duplicates are 409.
async fn create_provider(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing name"))?;
    let protocol = body["protocol"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing protocol"))?;
    if !PROTOCOLS.contains(&protocol) {
        return Err(ApiError::bad_request(format!(
            "unknown protocol {protocol} — expected one of: {}",
            PROTOCOLS.join(", ")
        )));
    }
    let base_url = body["base_url"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing base_url"))?;
    let key = body["key"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing key"))?;
    let slug = provider_slug(name);
    let store = state.store().await?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    if store
        .gateway()
        .get_provider(admin.0.org_id, &slug, &master)
        .await?
        .is_some()
    {
        return Err(ApiError::conflict(
            "already_exists",
            format!("a provider with the name '{name}' already exists"),
        ));
    }
    store
        .gateway()
        .create_provider(
            admin.0.org_id,
            &slug,
            name,
            protocol,
            base_url,
            key,
            &master,
        )
        .await?;
    Ok(Json(json!({ "provider": slug })))
}

/// Updates a provider: {name, protocol, base_url, key?} — a blank key keeps
/// the current one.
async fn update_provider(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(slug): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing name"))?;
    let protocol = body["protocol"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing protocol"))?;
    if !PROTOCOLS.contains(&protocol) {
        return Err(ApiError::bad_request(format!(
            "unknown protocol {protocol} — expected one of: {}",
            PROTOCOLS.join(", ")
        )));
    }
    let base_url = body["base_url"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing base_url"))?;
    let key = body["key"].as_str().filter(|s| !s.is_empty());
    let master = state.config.master_key().map_err(ApiError::from)?;
    let store = state.store().await?;
    let updated = store
        .gateway()
        .update_provider(
            admin.0.org_id,
            &slug,
            name,
            protocol,
            base_url,
            key,
            &master,
        )
        .await?;
    if !updated {
        return Err(ApiError::not_found(format!("no provider {slug}")));
    }
    Ok(Json(json!({})))
}

/// Removes a provider; routes referencing it stop resolving until a new
/// provider with the same slug is created.
async fn delete_provider(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .gateway()
        .delete_provider(admin.0.org_id, &slug)
        .await?;
    Ok(Json(json!({})))
}

/// Removes a model route entirely.
async fn delete_route(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(model): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.gateway().delete_route(admin.0.org_id, &model).await?;
    Ok(Json(json!({})))
}

async fn set_route(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let model = body["model"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing model"))?;
    let provider = body["provider"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing provider"))?;
    let enabled = body["enabled"].as_bool().unwrap_or(true);
    let quota_monthly_usd = body["quota_monthly_usd"].as_f64();
    let reasoning = body["reasoning"].as_bool().unwrap_or(false);
    let context_window = body["context_window"].as_i64();
    let max_output_tokens = body["max_output_tokens"].as_i64();
    let price_in = body["price_in"]
        .as_f64()
        .ok_or_else(|| ApiError::bad_request("missing price_in"))?;
    let price_out = body["price_out"]
        .as_f64()
        .ok_or_else(|| ApiError::bad_request("missing price_out"))?;
    // Native input modalities: subset of {image, audio, video}.
    let modalities: Vec<String> = body["modalities"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter(|m| matches!(*m, "image" | "audio" | "video"))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let store = state.store().await?;
    store
        .gateway()
        .upsert_route(
            admin.0.org_id,
            model,
            provider,
            enabled,
            price_in,
            price_out,
            quota_monthly_usd,
            reasoning,
            context_window,
            max_output_tokens,
            &modalities,
        )
        .await?;
    Ok(Json(serde_json::json!({})))
}

/// Route quota enforcement (spec §4.5): reject when month-to-date spend for
/// (org, model) has reached the route's monthly cap.
pub async fn enforce_quota(
    state: &AppState,
    org_id: Uuid,
    model: &str,
    route: &crate::store::gateway::RouteRow,
) -> Result<(), ApiError> {
    let Some(quota) = route.quota_monthly_usd else {
        return Ok(());
    };
    let spent = state
        .usage()
        .await?
        .month_spend(org_id, model)
        .await
        .map_err(|e| ApiError::internal(format!("quota check failed: {e}")))?;
    if spent >= quota {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "quota_exceeded",
            format!("monthly quota for this model reached ({spent:.2} >= {quota:.2} USD)"),
        ));
    }
    Ok(())
}

pub fn provider_err_to_api(e: ProviderError) -> ApiError {
    match e {
        ProviderError::Auth => ApiError::new(
            axum::http::StatusCode::UNAUTHORIZED,
            "provider_auth",
            e.to_string(),
        ),
        ProviderError::RateLimited => ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "provider_rate_limited",
            e.to_string(),
        ),
        _ => ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "provider_upstream",
            e.to_string(),
        ),
    }
}

/// Registry entry for the chat's in-flight generation, creating it if absent.
/// Used by the API (placeholder before invocation) and by the Restate worker
/// (the generation task broadcasts deltas through it). Both roles share one
/// process in this deployment; with split roles, live deltas only reach
/// clients attached on the worker's process — catch-up after completion is
/// unaffected since Postgres is the record system.
/// Registers a suspended client tool call for late-attaching clients and
/// returns the watcher's completion signal.
pub(crate) fn note_pending_tool(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    name: &str,
    args: &str,
    machine_id: Option<&str>,
    workdir: Option<&str>,
) -> Arc<tokio::sync::Notify> {
    let done = Arc::new(tokio::sync::Notify::new());
    let holder = machine_id.and_then(|id| state.hub.machine_holder(id));
    let gens = state.generations.lock().unwrap();
    if let Some(g) = gens.get(&chat_id) {
        g.pending_tools.lock().unwrap().insert(
            call_id.to_string(),
            PendingTool {
                name: name.to_string(),
                arguments: args.to_string(),
                machine_id: machine_id.map(str::to_string),
                workdir: workdir.map(str::to_string),
                connection_id: holder.as_ref().map(|m| m.conn_id),
                done: done.clone(),
            },
        );
    }
    done
}

/// Dispatches once inside the worker's journaled operation. The returned
/// connection identity is replayed, not the side effect itself.
pub(crate) async fn dispatch_pending_tool(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    dispatch_id: &str,
) -> Result<Option<Uuid>, ApiError> {
    let tool = {
        let gens = state.generations.lock().unwrap();
        gens.get(&chat_id).and_then(|g| {
            g.pending_tools.lock().unwrap().get(call_id).map(|t| {
                (
                    t.connection_id,
                    t.machine_id.clone(),
                    t.name.clone(),
                    t.arguments.clone(),
                    t.workdir.clone(),
                )
            })
        })
    };
    let Some((connection, machine, name, arguments, workdir)) = tool else {
        return Ok(None);
    };
    let store = state.store().await?;
    let key = format!("tool_dispatch:{chat_id}:{dispatch_id}");
    if !store
        .kv()
        .claim(
            &key,
            &connection.map(|id| id.to_string()).unwrap_or_default(),
        )
        .await?
    {
        let recorded = store.kv().get(&key).await?.and_then(|id| id.parse().ok());
        crate::http::internal::restate_send_one_way(state, "ChatRunner", &format!("{chat_id}/complete_tool"),
            json!({"call_id": call_id, "content": "Dispatch was already reserved; execution outcome is unknown. Check effects before retrying.", "is_error": true})).await?;
        return Ok(recorded);
    }
    let holder = machine
        .as_deref()
        .and_then(|id| state.hub.machine_holder(id));
    if let Some(holder) = holder.filter(|h| Some(h.conn_id) == connection) {
        if holder
            .sink
            .try_send(protocol::ws::WsServerMsg::ToolDispatch {
                chat_id,
                call_id: call_id.into(),
                name,
                arguments,
                workdir,
            })
            .is_ok()
        {
            return Ok(Some(holder.conn_id));
        }
    }
    crate::http::internal::restate_send_one_way(state, "ChatRunner", &format!("{chat_id}/complete_tool"),
        json!({"call_id": call_id, "content": "Machine is offline; tool was not dispatched", "is_error": true})).await?;
    Ok(connection)
}

pub(crate) fn restore_dispatch_connection(
    state: &AppState,
    chat: Uuid,
    call: &str,
    connection: Option<Uuid>,
) {
    let generations = state.generations.lock().unwrap();
    if let Some(generation) = generations.get(&chat) {
        if let Some(tool) = generation.pending_tools.lock().unwrap().get_mut(call) {
            tool.connection_id = connection;
        }
    }
}

/// A connection change makes the execution outcome unknown. Fail through the
/// durable resolver; never replay a possibly side-effecting call on a new link.
pub(crate) async fn reconcile_machine_tools(state: &AppState, machine: &str, connection: Uuid) {
    let pending: Vec<_> = {
        let generations = state.generations.lock().unwrap();
        generations
            .iter()
            .flat_map(|(chat, generation)| {
                generation
                    .pending_tools
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|(call, tool)| {
                        (tool.machine_id.as_deref() == Some(machine)
                            && tool.connection_id != Some(connection))
                        .then(|| (*chat, call.clone()))
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    };
    for (chat, call) in pending {
        let _ = crate::http::internal::restate_send_one_way(state, "ChatRunner", &format!("{chat}/complete_tool"),
            json!({"call_id": call, "content": "Machine connection changed; execution outcome is unknown. Do not retry this action without checking its effects.", "is_error": true})).await;
    }
}

/// Removes a suspended client tool call (completed or timed out).
pub(crate) fn clear_pending_tool(state: &AppState, chat_id: Uuid, call_id: &str) {
    let gens = state.generations.lock().unwrap();
    if let Some(g) = gens.get(&chat_id) {
        if let Some(t) = g.pending_tools.lock().unwrap().remove(call_id) {
            // notify_one stores a permit even if the watcher is between
            // iterations, so it cannot miss this signal.
            t.done.notify_one();
        }
    }
}

/// Commits an assistant step and retires its replay buffers as one view change.
pub(crate) async fn persist_assistant_step(
    state: &AppState,
    chat: Uuid,
    event: &ThreadEvent,
) -> Result<crate::store::thread::ThreadEventRow, ApiError> {
    let (_, text, thinking) = ensure_generation(state, chat);
    let mut text = text.write().await;
    let mut thinking = thinking.write().await;
    let row = state
        .store()
        .await?
        .thread()
        .append_event(chat, event)
        .await?;
    text.clear();
    thinking.clear();
    Ok(row)
}

pub(crate) fn ensure_generation(
    state: &AppState,
    chat_id: Uuid,
) -> (
    broadcast::Sender<StreamEvent>,
    Arc<RwLock<String>>,
    Arc<RwLock<String>>,
) {
    let mut gens = state.generations.lock().unwrap();
    if let Some(g) = gens.get(&chat_id) {
        return (g.tx.clone(), g.text.clone(), g.thinking.clone());
    }
    let (tx, _) = broadcast::channel::<StreamEvent>(1024);
    let gen = ActiveGeneration {
        id: Uuid::now_v7(),
        tx: tx.clone(),
        text: Arc::new(RwLock::new(String::new())),
        thinking: Arc::new(RwLock::new(String::new())),
        pending_tools: Arc::new(std::sync::Mutex::new(HashMap::new())),
    };
    gens.insert(chat_id, gen);
    let g = gens.get(&chat_id).unwrap();
    (g.tx.clone(), g.text.clone(), g.thinking.clone())
}

/// Atomic check+insert: returns the generation's stream parts or 409 when a
/// generation is already running for the chat. One lock acquisition covers
/// both the check and the insert, so two concurrent sends cannot both start
/// a ChatRunner invocation. The restate worker and test support use
/// `ensure_generation` directly — they re-attach to a running generation
/// instead of reserving a new one.
pub(crate) fn try_begin_generation(
    state: &AppState,
    chat_id: Uuid,
) -> Result<
    (
        broadcast::Sender<StreamEvent>,
        Arc<RwLock<String>>,
        Arc<RwLock<String>>,
    ),
    ApiError,
> {
    let mut gens = state.generations.lock().unwrap();
    if gens.contains_key(&chat_id) {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "generation_in_progress",
            "a generation is already running for this chat — wait for it to finish",
        ));
    }
    let (tx, _) = broadcast::channel::<StreamEvent>(1024);
    let gen = ActiveGeneration {
        id: Uuid::now_v7(),
        tx: tx.clone(),
        text: Arc::new(RwLock::new(String::new())),
        thinking: Arc::new(RwLock::new(String::new())),
        pending_tools: Arc::new(std::sync::Mutex::new(HashMap::new())),
    };
    gens.insert(chat_id, gen);
    let g = gens.get(&chat_id).unwrap();
    Ok((g.tx.clone(), g.text.clone(), g.thinking.clone()))
}

async fn chat(
    State(state): State<AppState>,
    user: AuthUser,
    headers: axum::http::HeaderMap,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    // Org scoping: chat must belong to the caller's org. Route resolution,
    // quota, history, completion, persistence and usage all happen inside the
    // durable Restate workflow (ChatRunner::generate) — see worker/restate.rs.
    let chat = store
        .chats()
        .get_chat(user.0.org_id, req.chat_id, &user.0)
        .await?;

    // One generation per chat at a time — reserved atomically (check+insert
    // under one lock), so a rejected send leaves nothing behind and two
    // concurrent sends cannot both invoke. The user turn itself is persisted
    // by the ChatRunner workflow (journaled), never here — attach/replay
    // stays consistent with the event log (spec §B.4).
    let (_tx, _text_buf, _thinking_buf) = try_begin_generation(&state, req.chat_id)?;
    if let Err(error) = crate::http::feed::prepare_generation(&state, &user).await {
        state.generations.lock().unwrap().remove(&req.chat_id);
        return Err(error);
    }

    let generation_id = state
        .generations
        .lock()
        .unwrap()
        .get(&req.chat_id)
        .unwrap()
        .id;

    // Fire-and-forget invocation via the Restate ingress; the workflow runs
    // detached, so this HTTP request ending (or the client disconnecting)
    // never cancels the generation.
    let user_message = req
        .messages
        .last()
        .filter(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    // Effective project: the request's binding wins (validated against the
    // caller — an arbitrary id would leak another member's workspace); the
    // chat's persisted binding applies when the request omits one.
    let project_id = match req.project_id {
        Some(pid) => {
            store
                .projects()
                .get(user.0.org_id, pid, &user.0)
                .await?;
            Some(pid)
        }
        None => chat.project_id,
    };
    let payload = serde_json::json!({
        "org_id": user.0.org_id,
        "user_id": user.0.id,
        "chat_id": req.chat_id,
        "model": req.model,
        "user_message": user_message,
        "user_message_id": req.user_message_id,
        "client_tools": req.client_tools,
        "attachment_ids": req.attachment_ids,
        "project_id": project_id,
        "skills_index": req.skills_index,
        "client_id": headers
            .get("x-guild-client-id")
            .and_then(|v| v.to_str().ok()),
        "machine_id": chat.machine_id,
        "machine_label": chat.machine_label,
        "origin_machine_id": headers
            .get("x-guild-machine-id")
            .and_then(|v| v.to_str().ok()),
    });
    let invoke = crate::http::internal::restate_send_one_way(
        &state,
        "ChatRunner",
        &format!("{}/generate", req.chat_id),
        payload,
    )
    .await;
    let invocation_id = match invoke {
        Ok(id) => id,
        Err(e) => {
            // Invocation failed — free the chat instead of leaving a stuck lock.
            state.generations.lock().unwrap().remove(&req.chat_id);
            return Err(e);
        }
    };
    // Remember the invocation for stuck-generation cleanup across deploys
    // (see the worker's startup sweep): the record stamps the workflow
    // schema version, so the sweep can tell a replayable invocation from
    // one a deploy stranded.
    let _ = store
        .kv()
        .put(
            &format!("chatgen_inv:{}", req.chat_id),
            &format!(
                "{}:{}",
                crate::worker::restate::workflow_schema_version(),
                invocation_id
            ),
        )
        .await;

    Ok(Json(
        json!({ "accepted": true, "invocation_id": invocation_id, "generation_id": generation_id }),
    ))
}

/// Delivers an approval decision (phase 2, design §D). Every decision path
/// settles the caller's card observably:
///
/// - a recorded decision (any earlier answer, or a timeout auto-deny) is
///   echoed back verbatim — late clicks are idempotent;
/// - a live turn forwards the decision to the ChatRunner's `complete_approval`
///   awakeable, and the `ApprovalResolved` frame settles every client;
/// - an orphaned call (no recorded decision, no live turn — the turn ended
///   before the card was answered) journals an `expired` decision so replay
///   and attach never resurrect the card as pending, and still forwards to
///   the ChatRunner: after a restart the gate can be suspended in Restate
///   while the in-memory generation registry is empty, and that forward lets
///   it accept the decision.
/// Org-scoped: 404 for foreign chats.
async fn approval_decision(
    State(state): State<AppState>,
    user: AuthUser,
    Path((chat_id, call_id)): Path<(Uuid, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let approved = req["approved"]
        .as_bool()
        .ok_or_else(|| ApiError::bad_request("missing approved"))?;
    let reason = req
        .get("reason")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // Recorded decision: echo it; the ChatRunner is not contacted.
    let events = store.thread().list_events(user.0.org_id, chat_id).await?;
    if let Some((r_approved, r_reason, r_expired)) =
        events.iter().rev().find_map(|ev| match &ev.event {
            ThreadEvent::ApprovalDecision {
                call_id: c,
                approved,
                reason,
                expired,
            } if c == &call_id => Some((*approved, reason.clone(), *expired)),
            _ => None,
        })
    {
        return Ok(Json(json!({
            "ok": true,
            "settled": true,
            "approved": r_approved,
            "reason": r_reason,
            "expired": r_expired,
        })));
    }

    if state.generations.lock().unwrap().contains_key(&chat_id) {
        // Live turn: the waiting gate journals the decision and broadcasts
        // the resolved frame; the card settles through the stream.
        forward_approval_decision(&state, chat_id, &call_id, approved, reason).await?;
        return Ok(Json(json!({ "ok": true, "settled": false })));
    }
    // Orphaned call: the turn is gone, the decision can never execute.
    // Journal the expired marker (chats-side append, like chats.rs) so a
    // reload shows the settled card instead of a pending one, then still
    // forward — a gate suspended in Restate after a restart accepts it.
    store
        .thread()
        .append_event(
            chat_id,
            &ThreadEvent::ApprovalDecision {
                call_id: call_id.clone(),
                approved: false,
                reason: Some(APPROVAL_EXPIRED_REASON.into()),
                expired: true,
            },
        )
        .await?;
    let _ = forward_approval_decision(
        &state,
        chat_id,
        &call_id,
        false,
        Some(APPROVAL_EXPIRED_REASON.into()),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "settled": true,
        "approved": false,
        "reason": APPROVAL_EXPIRED_REASON,
        "expired": true,
    })))
}

/// Kicks off a thread compaction (phase 3, design §D): one-way send to the
/// ChatRunner's `compact` handler — fire-and-forget like generate, no
/// generation lock is taken here (the handler rejects if a generation is
/// somehow in flight). The client polls GET /thread for the resulting
/// `Compaction` event. Org-scoped: 404 for foreign chats.
async fn compact_chat(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    crate::http::internal::restate_send_one_way(
        &state,
        "ChatRunner",
        &format!("{chat_id}/compact"),
        serde_json::to_value(crate::worker::restate::CompactReq {
            org_id: user.0.org_id,
            chat_id,
        })
        .expect("compact request serializes"),
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn dispatch_reservation_survives_process_state_loss_without_reexecution() {
        let (fixture, ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let chat = Uuid::now_v7();
        let original = Uuid::now_v7();
        let (sink, mut output) = crate::http::ws::socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: original,
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        ensure_generation(&fixture.state, chat);
        note_pending_tool(
            &fixture.state,
            chat,
            "call",
            "execute",
            "{}",
            Some("machine"),
            None,
        );
        assert_eq!(
            dispatch_pending_tool(&fixture.state, chat, "call", "durable-awakeable")
                .await
                .unwrap(),
            Some(original)
        );
        assert!(matches!(
            output.try_recv().unwrap(),
            crate::http::ws::SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch { .. })
        ));
        let restarted =
            AppState::with_store(Arc::new(fixture.store()), (*fixture.state.config).clone());
        let (sink, mut replacement_output) = crate::http::ws::socket_channel();
        restarted
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: Uuid::now_v7(),
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        ensure_generation(&restarted, chat);
        note_pending_tool(&restarted, chat, "call", "execute", "{}", Some("machine"), None);
        assert_eq!(
            dispatch_pending_tool(&restarted, chat, "call", "durable-awakeable")
                .await
                .unwrap(),
            Some(original)
        );
        assert!(replacement_output.try_recv().is_err());
        assert!(ingress
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, body)| body["is_error"] == true));
    }

    /// The dispatch frame carries the workspace folder: the executor runs
    /// the tool there (the volatile per-chat dir map is gone).
    #[tokio::test]
    async fn dispatch_carries_workdir_from_project_folder() {
        let (fixture, _ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let chat = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let (sink, mut output) = crate::http::ws::socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: conn,
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        ensure_generation(&fixture.state, chat);
        note_pending_tool(
            &fixture.state,
            chat,
            "call",
            "execute",
            "{}",
            Some("machine"),
            Some(r"\\wsl.localhost\Ubuntu-22.04\home\u\repo"),
        );
        dispatch_pending_tool(&fixture.state, chat, "call", "durable-awakeable")
            .await
            .unwrap();
        match output.try_recv().unwrap() {
            crate::http::ws::SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch {
                workdir,
                ..
            }) => {
                assert_eq!(
                    workdir.as_deref(),
                    Some(r"\\wsl.localhost\Ubuntu-22.04\home\u\repo")
                );
            }
            other => panic!("expected ToolDispatch, got {other:?}"),
        }
    }

    /// The reservation is atomic: the second concurrent send hits 409 while
    /// the first holds the slot, and the slot frees cleanly.
    #[test]
    fn try_begin_generation_is_atomic() {
        let state = crate::state::AppState::from_config(Config::test_config());
        let chat = Uuid::now_v7();
        assert!(try_begin_generation(&state, chat).is_ok());
        let err = try_begin_generation(&state, chat).unwrap_err();
        assert_eq!(err.code, "generation_in_progress");
        assert_eq!(err.status, axum::http::StatusCode::CONFLICT);
        state.generations.lock().unwrap().remove(&chat);
        assert!(try_begin_generation(&state, chat).is_ok());
    }
}
