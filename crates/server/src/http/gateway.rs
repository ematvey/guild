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

/// Queued send while a turn generates: commit the user turn to the thread
/// log right away (the open feed republishes on the commit notification),
/// so the running turn flushes it at its exit. Document attachments inline
/// here — the continuation turn derives its model history from this event
/// instead of a payload turn text, and image/audio parts ride later via the
/// event's chips.
async fn queue_user_turn(
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    user_message: &str,
    attachment_ids: &[Uuid],
    user_message_id: Option<Uuid>,
    modalities: &[String],
) -> Result<(), ApiError> {
    let store = state.store().await?;
    let rows: Vec<(Uuid, String, String, i64)> = store
        .attachments()
        .list(org_id, chat_id)
        .await?
        .into_iter()
        .map(|r| (r.id, r.filename, r.content_type, r.size_bytes))
        .collect();
    let media = crate::worker::restate::load_media_map(state, org_id, chat_id, &[], attachment_ids)
        .await?;
    let (chips, inline) = crate::worker::restate::build_turn_text(
        attachment_ids,
        &media,
        &rows,
        modalities,
    );
    let content = match (!user_message.is_empty(), !inline.is_empty()) {
        (true, true) => format!("{user_message}\n\n{inline}"),
        (true, false) => user_message.to_string(),
        (false, true) => inline,
        (false, false) => String::new(),
    };
    store
        .thread()
        .append_event_with_id(
            chat_id,
            &ThreadEvent::UserMessage {
                content,
                attachments: chips,
            },
            user_message_id.unwrap_or_else(Uuid::now_v7),
        )
        .await?;
    Ok(())
}

/// Stops the chat's in-flight turn. The ChatRunner observes the flag inside
/// journaled steps: the streaming model call truncates, the delivered prefix
/// persists as an interrupted assistant event, and the turn ends — no
/// continuation unless user turns were queued meanwhile. Org-scoped: 404 for
/// foreign chats, 409 when nothing is generating.
async fn stop_chat(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let Some(cancel) = generation_cancel(&state, chat_id) else {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "not_generating",
            "no generation is running for this chat",
        ));
    };
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(Json(json!({ "stopped": true })))
}

/// One server-side generation in flight, detached from any client connection.
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
    /// Set by the stop endpoint (and by steered sends): the ChatRunner checks
    /// it inside journaled steps, so an interrupted turn's shape stays
    /// replay-deterministic. Volatile by design — a process crash mid-turn
    /// forgets the request; the user can stop again.
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

impl ActiveGeneration {
    fn new(
        tx: broadcast::Sender<StreamEvent>,
        text: Arc<RwLock<String>>,
        thinking: Arc<RwLock<String>>,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            tx,
            text,
            thinking,
            pending_tools: Arc::new(std::sync::Mutex::new(HashMap::new())),
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

/// The cancel flag of a chat's active generation, if one is running. The
/// stop endpoint and steered sends set it; the ChatRunner observes it inside
/// journaled steps.
pub(crate) fn generation_cancel(
    state: &AppState,
    chat_id: Uuid,
) -> Option<Arc<std::sync::atomic::AtomicBool>> {
    state
        .generations
        .lock()
        .unwrap()
        .get(&chat_id)
        .map(|g| g.cancel.clone())
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

/// Watches the chat's cancel flag while a client tool is suspended. A stop
/// resolves the tool immediately with an interrupt notice, so the turn
/// resumes and ends at the next journaled cancel check instead of waiting
/// out the executor or the 5-minute timeout. Same durable `complete_tool`
/// funnel as every other resolution; late client results no-op.
pub(crate) fn spawn_stop_watcher(
    state: &AppState,
    chat_id: Uuid,
    call_id: String,
    done: Arc<tokio::sync::Notify>,
) {
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = done.notified() => return,
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            }
            if !pending_tool_exists(&state, chat_id, &call_id) {
                return; // resolved already
            }
            let Some(cancel) = generation_cancel(&state, chat_id) else {
                return; // generation gone; the turn cannot resume anyway
            };
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = crate::http::internal::restate_send_one_way(
                    &state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_tool"),
                    serde_json::json!({
                        "call_id": call_id,
                        "content": "turn interrupted before the tool result arrived",
                        "is_error": true,
                    }),
                )
                .await;
                return;
            }
        }
    });
}

/// Watches the chat's cancel flag while an approval decision is pending. A
/// stop resolves the gate as denied so the turn resumes and ends at the
/// next journaled cancel check instead of waiting out the user or the
/// auto-deny timer. Duplicate resolutions against an already-resolved
/// awakeable are dropped by Restate; the loser no-ops.
pub(crate) fn spawn_stop_approval_watcher(state: &AppState, chat_id: Uuid, call_id: String) {
    let state = state.clone();
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + crate::worker::restate::APPROVAL_TIMEOUT;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return,
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            }
            let Some(cancel) = generation_cancel(&state, chat_id) else {
                return; // generation gone; the turn cannot resume anyway
            };
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = crate::http::internal::restate_send_one_way(
                    &state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_approval"),
                    serde_json::json!({
                        "call_id": call_id,
                        "approved": false,
                        "reason": "turn interrupted",
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
            "/api/v1/gateway/chat/{id}/stop",
            axum::routing::post(stop_chat),
        )
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
    let gen = ActiveGeneration::new(
        tx.clone(),
        Arc::new(RwLock::new(String::new())),
        Arc::new(RwLock::new(String::new())),
    );
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
    let gen = ActiveGeneration::new(
        tx.clone(),
        Arc::new(RwLock::new(String::new())),
        Arc::new(RwLock::new(String::new())),
    );
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
    submit_turn(
        &state,
        &user.0,
        req,
        headers
            .get("x-guild-client-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
        headers
            .get("x-guild-machine-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
    )
    .await
}

/// The turn-submission core shared by every caller of the durable workflow
/// (the chat gateway with its headers; the workspace-agent batch backend
/// with none — spec 2026-09-18 unification §4 phase 4). Validates the chat,
/// aligns an explicit project binding, queues or invokes ChatRunner::generate.
pub(crate) async fn submit_turn(
    state: &AppState,
    user: &crate::store::identity::UserRow,
    req: ChatCompletionRequest,
    client_id: Option<String>,
    origin_machine_id: Option<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    // Org scoping: chat must belong to the caller's org. Route resolution,
    // quota, history, completion, persistence and usage all happen inside the
    // durable Restate workflow (ChatRunner::generate) — see worker/restate.rs.
    let chat = store
        .chats()
        .get_chat(user.org_id, req.chat_id, user)
        .await?;

    let user_message = req
        .messages
        .last()
        .filter(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    // Effective project: the request's binding wins (validated against the
    // caller — an arbitrary id would leak another member's workspace); the
    // chat's persisted binding applies when the request omits one. An
    // explicit request chose the project, so the chat's machine aligns to
    // the project's when they differ (persisted) — a chat must run where
    // its workspace folder lives.
    let mut machine_id = chat.machine_id.clone();
    let mut machine_label = chat.machine_label.clone();
    let project_id = match req.project_id {
        Some(pid) => {
            let project = store.projects().get(user.org_id, pid, user).await?;
            let label = project
                .machine_label
                .clone()
                .unwrap_or_else(|| project.machine_id.clone());
            if chat.project_id != Some(pid) {
                // An explicit request chose the project: persist the binding
                // and the machine together, so a later request that omits
                // project_id cannot run the old folder on the new machine.
                let aligned = store
                    .chats()
                    .set_project(
                        user.org_id,
                        req.chat_id,
                        user,
                        Some(pid),
                        Some((&project.machine_id, Some(&label))),
                    )
                    .await?;
                machine_id = aligned.machine_id;
                machine_label = aligned.machine_label;
            } else if Some(&project.machine_id) != chat.machine_id.as_ref() {
                store
                    .chats()
                    .set_machine(
                        user.org_id,
                        req.chat_id,
                        Some(&project.machine_id),
                        Some(&label),
                    )
                    .await?;
                machine_id = Some(project.machine_id.clone());
                machine_label = Some(label);
            }
            Some(pid)
        }
        None => chat.project_id,
    };

    // Turn already generating: the message queues by default — the user turn
    // commits to the thread log now (the open feed republishes on the commit
    // notification) and the running turn flushes it at its exit. "steer"
    // additionally requests the running turn's interruption, so the queued
    // message runs immediately after the interrupted prefix. When the turn
    // finishes while we are here (entry vanished after the commit), the code
    // falls through and the queued event starts the turn right away.
    let mut queued = false;
    if state.generations.lock().unwrap().contains_key(&req.chat_id) {
        // The route's modalities shape the attachment notes; the continuation
        // re-resolves the route anyway, so a failure here degrades to notes.
        let modalities = match state.config.master_key() {
            Ok(master) => store
                .gateway()
                .resolve_route(user.org_id, &req.model, &master)
                .await
                .map(|r| r.modalities)
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        queue_user_turn(
            &state,
            user.org_id,
            req.chat_id,
            &user_message,
            &req.attachment_ids,
            req.user_message_id,
            &modalities,
        )
        .await?;
        // The turn's continuation parameters ride a kv record the flushing
        // turn reads (model, client tools, machine/project binding — the
        // queued request's choices, not the in-flight turn's).
        let opts = crate::worker::restate::ChatRunPayload {
            user_message_id: None,
            org_id: user.org_id,
            user_id: user.id,
            chat_id: req.chat_id,
            model: req.model.clone(),
            client_tools: req.client_tools,
            client_id: client_id.clone(),
            project_id,
            machine_id: machine_id.clone(),
            machine_label: machine_label.clone(),
            origin_machine_id: origin_machine_id.clone(),
            user_message: String::new(),
            attachment_ids: Vec::new(),
            server_workspace: req.server_workspace.clone(),
            skills_index: req.skills_index.clone(),
            agents_md: req.agents_md.clone(),
        };
        store
            .kv()
            .put(
                &format!("chat_queue:{}", req.chat_id),
                &serde_json::to_string(&opts).unwrap_or_default(),
            )
            .await?;
        if state.generations.lock().unwrap().contains_key(&req.chat_id) {
            if req.send_mode.as_deref() == Some("steer") {
                if let Some(cancel) = generation_cancel(&state, req.chat_id) {
                    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
            return Ok(Json(
                json!({ "accepted": true, "queued": true }),
            ));
        }
        queued = true;
    }

    // One generation per chat at a time — reserved atomically (check+insert
    // under one lock), so a rejected send leaves nothing behind and two
    // concurrent sends cannot both invoke. The user turn itself is persisted
    // by the ChatRunner workflow (journaled), never here — attach/replay
    // stays consistent with the event log (spec §B.4). The queue fall-through
    // is the exception: the event is already committed, so the payload's
    // turn text stays empty and the workflow relies on the log.
    let (_tx, _text_buf, _thinking_buf) = try_begin_generation(&state, req.chat_id)?;
    if let Err(error) = crate::http::feed::prepare_generation(state, &crate::http::auth::AuthUser(user.clone())).await {
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
    let effective_message = if queued { String::new() } else { user_message };
    let effective_attachments = if queued { Vec::new() } else { req.attachment_ids.clone() };
    let payload = serde_json::json!({
        "org_id": user.org_id,
        "user_id": user.id,
        "chat_id": req.chat_id,
        "model": req.model,
        "user_message": effective_message,
        "user_message_id": req.user_message_id,
        "client_tools": req.client_tools,
        "attachment_ids": effective_attachments,
        "project_id": project_id,
        "server_workspace": req.server_workspace,
        "skills_index": req.skills_index,
        "agents_md": req.agents_md,
        "client_id": client_id,
        "machine_id": machine_id,
        "machine_label": machine_label,
        "origin_machine_id": origin_machine_id,
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

    /// The dispatch workdir comes from the journaled project resolution: a
    /// chat bound to a project carries the project's folder (the resolver
    /// the ChatRunner's turn start journals, not a hand-set workdir).
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn dispatch_workdir_follows_the_journaled_project_resolution() {
        let (fixture, _ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let store = fixture.store();
        let user_id = store
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let user = store.identity().get_user(user_id).await.unwrap();
        let project = store
            .projects()
            .create(
                user.org_id,
                user.id,
                "repo",
                r"\\wsl.localhost\Ubuntu-22.04\home\u\repo",
                "machine",
            )
            .await
            .unwrap();
        let chat_row = store
            .chats()
            .create_chat(user.org_id, user.id, Some("t"), Some(project.id))
            .await
            .unwrap();
        let conn = Uuid::now_v7();
        let (sink, mut output) = crate::http::ws::socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: conn,
                    user_id: user.id,
                    org_id: user.org_id,
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        // The journaled resolution (what the ChatRunner runs at turn start).
        let workspace = crate::worker::restate::resolve_workspace(
            &fixture.state,
            user.org_id,
            chat_row.project_id,
        )
        .await
        .unwrap()
        .expect("bound project resolves");
        assert_eq!(workspace.folder, project.folder);
        ensure_generation(&fixture.state, chat_row.id);
        note_pending_tool(
            &fixture.state,
            chat_row.id,
            "call",
            "execute",
            "{}",
            Some("machine"),
            Some(&workspace.folder),
        );
        dispatch_pending_tool(&fixture.state, chat_row.id, "call", "durable-awakeable")
            .await
            .unwrap();
        match output.try_recv().unwrap() {
            crate::http::ws::SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch {
                workdir,
                ..
            }) => assert_eq!(workdir.as_deref(), Some(project.folder.as_str())),
            other => panic!("expected ToolDispatch, got {other:?}"),
        }
    }

    /// A request without `project_id` uses the chat's persisted binding:
    /// the ChatRunner payload carries it, and the journaled resolution
    /// yields the project's folder (the rule every stale/deep-link client
    /// relies on — the request never re-sends a stale sidebar row).
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn gateway_request_without_project_id_falls_back_to_the_persisted_binding() {
        let (fixture, ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let store = fixture.store();
        let user_id = store
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let user = store.identity().get_user(user_id).await.unwrap();
        let project = store
            .projects()
            .create(user.org_id, user.id, "repo", r"C:\code\repo", "machine")
            .await
            .unwrap();
        let chat_row = store
            .chats()
            .create_chat(user.org_id, user.id, Some("t"), Some(project.id))
            .await
            .unwrap();
        let req = ChatCompletionRequest {
            server_workspace: None,
            send_mode: None,
            user_message_id: None,
            chat_id: chat_row.id,
            model: "gpt-test".into(),
            messages: vec![protocol::api::Message {
                role: "user".into(),
                content: "hi".into(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: None,
            }],
            tools: None,
            system: None,
            client_tools: false,
            project_id: None,
            attachment_ids: Vec::new(),
            skills_index: None,
            agents_md: None,
        };
        let res = chat(
            State(fixture.state.clone()),
            AuthUser(user.clone()),
            axum::http::HeaderMap::new(),
            Json(req),
        )
        .await
        .unwrap();
        assert_eq!(res.0["accepted"], json!(true));
        let gen = ingress
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(path, _)| path.contains("/generate"))
            .expect("ChatRunner invocation captured")
            .1
            .clone();
        assert_eq!(gen["project_id"], json!(project.id));
        // The workspace the turn resolves from the persisted binding:
        let workspace = crate::worker::restate::resolve_workspace(
            &fixture.state,
            user.org_id,
            gen["project_id"].as_str().map(|s| s.parse().unwrap()),
        )
        .await
        .unwrap()
        .expect("persisted project resolves");
        assert_eq!(workspace.folder, project.folder);
    }

    /// A request with `project_id` whose machine differs from the chat's
    /// persisted machine aligns the chat to the project's machine (the
    /// request explicitly chose the project) and dispatches there.
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn gateway_request_with_project_id_aligns_the_chats_machine() {
        let (fixture, ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let store = fixture.store();
        let user_id = store
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let user = store.identity().get_user(user_id).await.unwrap();
        let project = store
            .projects()
            .create(user.org_id, user.id, "repo", r"C:\code\repo", "mB")
            .await
            .unwrap();
        let chat_row = store
            .chats()
            .create_chat(user.org_id, user.id, Some("t"), None)
            .await
            .unwrap();
        store
            .chats()
            .set_machine(user.org_id, chat_row.id, Some("mA"), Some("Machine A"))
            .await
            .unwrap();
        let req = ChatCompletionRequest {
            server_workspace: None,
            send_mode: None,
            user_message_id: None,
            chat_id: chat_row.id,
            model: "gpt-test".into(),
            messages: vec![protocol::api::Message {
                role: "user".into(),
                content: "hi".into(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: None,
            }],
            tools: None,
            system: None,
            client_tools: false,
            project_id: Some(project.id),
            attachment_ids: Vec::new(),
            skills_index: None,
            agents_md: None,
        };
        let res = chat(
            State(fixture.state.clone()),
            AuthUser(user.clone()),
            axum::http::HeaderMap::new(),
            Json(req),
        )
        .await
        .unwrap();
        assert_eq!(res.0["accepted"], json!(true));
        // The chat's persisted machine now follows the project's.
        let aligned = store
            .chats()
            .get_chat(user.org_id, chat_row.id, &user)
            .await
            .unwrap();
        assert_eq!(aligned.machine_id.as_deref(), Some("mB"));
        // The turn dispatches on the aligned machine with the project bound.
        let gen = ingress
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(path, _)| path.contains("/generate"))
            .expect("ChatRunner invocation captured")
            .1
            .clone();
        assert_eq!(gen["project_id"], json!(project.id));
        assert_eq!(gen["machine_id"], json!("mB"));
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
