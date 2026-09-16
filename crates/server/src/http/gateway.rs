//! LLM gateway: streaming chat through the org's provider keys and routes,
//! usage recorded per request (spec §4.2, §4.5). Internal API — Guild
//! clients only in v1.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::identity::UserRow;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::{Json, Router};
use futures::Stream;
use futures::StreamExt;
use guild_core::provider::ProviderError;
use protocol::api::{ChatCompletionRequest, StreamEvent, ThreadEvent};
use serde_json::json;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

/// A server-side generation in flight, detached from any client connection.
/// Broadcasts stream events to any number of attached SSE clients; the text
/// buffer lets late subscribers catch up without missing or duplicating
/// deltas.
pub struct ActiveGeneration {
    pub tx: broadcast::Sender<StreamEvent>,
    pub text: Arc<RwLock<String>>,
    /// Reasoning accumulated so far in the in-flight model call, for
    /// catch-up on attach (first `thinking_delta` frame carries the buffer).
    pub thinking: Arc<RwLock<String>>,
    /// Client tool calls currently suspended by the workflow, for replay to
    /// clients that attach after the ToolStarted event was broadcast.
    pub pending_tools: Arc<std::sync::Mutex<HashMap<String, PendingTool>>>,
}

/// One suspended machine tool call.
pub struct PendingTool {
    pub name: String,
    pub arguments: String,
    /// Bound executor machine; `None` → fall back to the 5-minute timeout
    /// only.
    pub machine_id: Option<String>,
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

/// Watches the bound machine's liveness while a machine tool is suspended.
/// Liveness is heartbeat-based (see `ExecutorHandle`): if heartbeats stop
/// and stay stale past the grace window, the tool is resolved with an error
/// so the turn continues instead of dead-airing until the 5-minute timeout.
/// All machine tool results funnel through the same durable `complete_tool`
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
    let deadline = tokio::time::Instant::now() + crate::worker::restate::CLIENT_TOOL_TIMEOUT;
    tokio::spawn(async move {
        // Heartbeat TTL is short (15s); the grace window on top covers blips
        // and reconnects before the tool is declared aborted.
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
            if state.machine_connected(&machine_id) {
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
            "/api/v1/gateway/chat/{id}/stream",
            axum::routing::get(attach_stream),
        )
        .route(
            "/api/v1/gateway/chat/{id}/tools/{call_id}/result",
            axum::routing::post(tool_result),
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

fn sse_event(ev: StreamEvent) -> Result<SseEvent, Infallible> {
    let json = serde_json::to_string(&ev).expect("stream event serializes");
    Ok(SseEvent::default().data(json))
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
) -> Arc<tokio::sync::Notify> {
    let done = Arc::new(tokio::sync::Notify::new());
    let gens = state.generations.lock().unwrap();
    if let Some(g) = gens.get(&chat_id) {
        g.pending_tools.lock().unwrap().insert(
            call_id.to_string(),
            PendingTool {
                name: name.to_string(),
                arguments: args.to_string(),
                machine_id: machine_id.map(str::to_string),
                done: done.clone(),
            },
        );
    }
    done
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
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
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
    let (tx, _text_buf, _thinking_buf) = try_begin_generation(&state, req.chat_id)?;

    // Fire-and-forget invocation via the Restate ingress; the workflow runs
    // detached, so this HTTP request ending (or the client disconnecting)
    // never cancels the generation.
    let user_message = req
        .messages
        .last()
        .filter(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let payload = serde_json::json!({
        "org_id": user.0.org_id,
        "user_id": user.0.id,
        "chat_id": req.chat_id,
        "model": req.model,
        "user_message": user_message,
        "client_tools": req.client_tools,
        "attachment_ids": req.attachment_ids,
        "project_dir": req.project_dir,
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

    let out = forward_sse(tx.subscribe());
    Ok(Sse::new(out).keep_alive(KeepAlive::default()))
}

/// SSE body that forwards broadcast events until the generation ends. The
/// generation itself is unaffected when this body is dropped.
fn forward_sse(
    mut rx: broadcast::Receiver<StreamEvent>,
) -> impl Stream<Item = Result<SseEvent, Infallible>> {
    async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let ended = matches!(ev, StreamEvent::Done { .. } | StreamEvent::Error { .. });
                    yield sse_event(ev);
                    if ended {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

/// Attaches an SSE client to an in-flight generation: catch-up delta with the
/// text accumulated so far, then live events. An idle chat (no generation
/// running) gets a 200 SSE body that ends immediately.
/// Delivers a client-side tool result to the waiting ChatRunner workflow.
/// Late results (after the workflow timed the call out) are ignored there.
async fn tool_result(
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
    let content = req["content"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing content"))?;
    let is_error = req["is_error"].as_bool().unwrap_or(false);
    let meta = req.get("meta").cloned().filter(|v| !v.is_null());
    crate::http::internal::restate_send_one_way(
        &state,
        "ChatRunner",
        &format!("{chat_id}/complete_tool"),
        serde_json::json!({ "call_id": call_id, "content": content, "is_error": is_error, "meta": meta }),
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
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
    if let Some((r_approved, r_reason, r_expired)) = events.iter().rev().find_map(|ev| {
        match &ev.event {
            ThreadEvent::ApprovalDecision {
                call_id: c,
                approved,
                reason,
                expired,
            } if c == &call_id => Some((*approved, reason.clone(), *expired)),
            _ => None,
        }
    }) {
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
    let _ = forward_approval_decision(&state, chat_id, &call_id, false, Some(APPROVAL_EXPIRED_REASON.into())).await;
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

async fn attach_stream(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<axum::response::Response, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let gen = state
        .generations
        .lock()
        .unwrap()
        .get(&chat_id)
        .map(|g| (g.tx.clone(), g.text.clone(), g.thinking.clone()));
    let Some((tx, text, thinking)) = gen else {
        // Nothing in flight: clients attach speculatively on every thread
        // open, so reply 200 instead of 404 — no console error noise. Yield
        // a single Idle frame so the client can tell "nothing running" apart
        // from a stream that dropped mid-generation.
        let idle = async_stream::stream! {
            yield sse_event(StreamEvent::Idle);
        };
        return Ok(Sse::new(idle)
            .keep_alive(KeepAlive::default())
            .into_response());
    };
    // Subscribe and snapshot under the read guard: the generation task takes
    // the write guard before broadcasting, so the snapshot and the live
    // stream cannot overlap or gap.
    let (snap, think_snap, rx) = {
        let t = text.read().await;
        let th = thinking.read().await;
        (t.clone(), th.clone(), tx.subscribe())
    };
    // Design §E: unresolved approval requests (a request event with no later
    // ApprovalDecision — and no later tool result — for the same call_id)
    // replay as ApprovalRequested frames so a late-attaching client still
    // sees the pending card.
    let events = store.thread().list_events(user.0.org_id, chat_id).await?;
    let mut decided: std::collections::HashSet<&str> = Default::default();
    for ev in &events {
        match &ev.event {
            ThreadEvent::ApprovalDecision { call_id, .. }
            | ThreadEvent::ToolResult { call_id, .. } => {
                decided.insert(call_id.as_str());
            }
            _ => {}
        }
    }
    let approvals: Vec<(String, String, String)> = events
        .iter()
        .filter_map(|ev| match &ev.event {
            ThreadEvent::ApprovalRequest {
                call_id,
                name,
                arguments,
            } if !decided.contains(call_id.as_str()) => {
                Some((call_id.clone(), name.clone(), arguments.clone()))
            }
            _ => None,
        })
        .collect();
    // Replay suspended client tool calls so late attachers can execute them.
    let pending: Vec<(String, String, String)> = state
        .generations
        .lock()
        .unwrap()
        .get(&chat_id)
        .map(|g| {
            g.pending_tools
                .lock()
                .unwrap()
                .iter()
                .map(|(id, t)| (id.clone(), t.name.clone(), t.arguments.clone()))
                .collect()
        })
        .unwrap_or_default();
    let out = async_stream::stream! {
        if !snap.is_empty() {
            yield sse_event(StreamEvent::Delta { content: snap });
        }
        // Spec §B.5: the first thinking_delta frame after attach carries the
        // full accumulated reasoning buffer, not a delta.
        if !think_snap.is_empty() {
            yield sse_event(StreamEvent::ThinkingDelta { content: think_snap });
        }
        for (call_id, name, arguments) in pending {
            yield sse_event(StreamEvent::ToolStarted {
                call_id,
                name,
                arguments,
                executor: protocol::api::ToolExecutor::Client,
                kind: None,
            });
        }
        for (call_id, name, arguments) in approvals {
            yield sse_event(StreamEvent::ApprovalRequested {
                call_id,
                name,
                arguments,
            });
        }
        // forward the live tail
        let mut pinned = Box::pin(forward_sse(rx));
        while let Some(item) = pinned.next().await {
            yield item;
        }
    };
    Ok(Sse::new(out)
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

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
