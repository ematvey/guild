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
use protocol::api::{ChatCompletionRequest, ThreadEvent};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

// The HTTP quota callers (workspace agents, openai-compatible endpoint)
// keep the gateway path; the implementation lives with the turn
// derivations in worker::turn.
pub use crate::worker::turn::enforce_quota;

/// Build the immutable accepted user echo with attachment metadata/content.
/// The command store commits this event together with its delivery outbox.
async fn prepare_user_event(
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    user_message: &str,
    attachment_ids: &[Uuid],
    modalities: &[String],
) -> Result<ThreadEvent, ApiError> {
    let store = state.store().await?;
    let rows: Vec<(Uuid, String, String, i64)> = store
        .attachments()
        .list(org_id, chat_id)
        .await?
        .into_iter()
        .map(|r| (r.id, r.filename, r.content_type, r.size_bytes))
        .collect();
    let media =
        crate::worker::turn::load_media_map(state, org_id, chat_id, &[], attachment_ids).await?;
    let (chips, inline) =
        crate::worker::turn::build_turn_text(attachment_ids, &media, &rows, modalities);
    let content = match (!user_message.is_empty(), !inline.is_empty()) {
        (true, true) => format!("{user_message}\n\n{inline}"),
        (true, false) => user_message.to_string(),
        (false, true) => inline,
        (false, false) => String::new(),
    };
    Ok(ThreadEvent::UserMessage {
        content,
        attachments: chips,
    })
}

/// Stops the chat's in-flight turn. The ChatRunner observes the flag inside
/// journaled steps: the streaming model call truncates, the delivered prefix
/// persists as an interrupted assistant event, and the turn ends — no
/// continuation unless user turns were queued meanwhile. Org-scoped: 404 for
/// foreign chats. Always reports `stopped` — with no registry entry it falls
/// back to killing the recorded invocation (and clears a stale generating
/// flag, self-healing the spinner).
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
    abort_generation(&state, chat_id).await;
    Ok(Json(json!({ "stopped": true })))
}

/// Ends a chat's in-flight generation: the graceful cancel flag when the
/// in-memory registry still tracks the turn (the ChatRunner observes it
/// inside journaled steps and the epilogue settles the turn normally), a
/// hard kill of the recorded Restate invocation otherwise — registry entry
/// lost (worker restart, replay pending) or a stale spinner with nothing
/// running. Stop and archive both go through here: both must be
/// guaranteed to end the run.
pub(crate) async fn abort_generation(state: &AppState, chat_id: Uuid) {
    if let Some(cancel) = generation_cancel(state, chat_id) {
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        return;
    }
    if let Ok(store) = state.store().await {
        let _ = store.turn_commands().cancel_waiting_head(chat_id).await;
    }
    crate::worker::restate::kill_recorded_chat_generation(state, chat_id).await;
}

/// The cancel flag of a chat's active generation, if one is running. The
/// stop endpoint and steered sends set it; the ChatRunner observes it inside
/// journaled steps.
pub(crate) fn generation_cancel(
    state: &AppState,
    chat_id: Uuid,
) -> Option<Arc<std::sync::atomic::AtomicBool>> {
    state.generations.cancel_flag(chat_id)
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

async fn chat(
    State(state): State<AppState>,
    user: AuthUser,
    headers: axum::http::HeaderMap,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.server_workspace.is_some() {
        return Err(ApiError::bad_request(
            "server_workspace is reserved for workspace agent sessions",
        ));
    }
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
    mut req: ChatCompletionRequest,
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

    let command_id = *req.user_message_id.get_or_insert_with(Uuid::now_v7);
    let request = serde_json::to_value(&req).expect("request serializes");
    if let Some(command) = store
        .turn_commands()
        .existing(command_id, user.org_id, user.id, req.chat_id, &request)
        .await?
    {
        // A duplicate delivery must not change the project binding or steer
        // another running command. Pending outbox delivery is safe to retry.
        let _ = dispatch_turn_commands(state, Some(req.chat_id)).await;
        return Ok(Json(command_ack(&command)));
    }

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
            let project = store.projects().get(user.org_id, pid, user.id).await?;
            machine_label = Some(
                project
                    .machine_label
                    .clone()
                    .unwrap_or_else(|| project.machine_id.clone()),
            );
            machine_id = Some(project.machine_id);
            Some(pid)
        }
        None => {
            // The machine is project-derived: a chat bound to a project runs
            // where the project's folder lives, so an edited project's
            // machine applies even when the request omits the project id —
            // pairing the chat's cached machine with the project's fresh
            // folder would execute on the wrong executor.
            match chat.project_id {
                Some(pid) => match store.projects().get(user.org_id, pid, user.id).await {
                    Ok(project) => {
                        machine_label = Some(
                            project
                                .machine_label
                                .clone()
                                .unwrap_or_else(|| project.machine_id.clone()),
                        );
                        machine_id = Some(project.machine_id.clone());
                        if chat.machine_id.as_deref() != Some(project.machine_id.as_str()) {
                            store
                                .chats()
                                .set_machine(
                                    user.org_id,
                                    req.chat_id,
                                    Some(&project.machine_id),
                                    machine_label.as_deref(),
                                )
                                .await?;
                        }
                        Some(pid)
                    }
                    // A caller without project visibility (an admin sending
                    // on another member's chat) keeps the cached binding.
                    Err(_) => chat.project_id,
                },
                None => None,
            }
        }
    };

    let payload = crate::worker::restate::ChatRunPayload {
        user_message_id: Some(command_id),
        org_id: user.org_id,
        user_id: user.id,
        chat_id: req.chat_id,
        model: req.model.clone(),
        user_message: user_message.clone(),
        client_tools: req.client_tools,
        client_id,
        project_id,
        machine_id,
        machine_label,
        origin_machine_id,
        attachment_ids: req.attachment_ids.clone(),
        server_workspace: req.server_workspace.clone(),
        skills_index: req.skills_index.clone(),
        agents_md: req.agents_md.clone(),
    };
    let modalities = match state.config.master_key() {
        Ok(master) => store
            .gateway()
            .resolve_route(user.org_id, &req.model, &master)
            .await
            .map(|r| r.modalities)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let event = prepare_user_event(
        state,
        user.org_id,
        req.chat_id,
        &user_message,
        &req.attachment_ids,
        &modalities,
    )
    .await?;
    let command = store
        .turn_commands()
        .accept(
            command_id,
            user.org_id,
            user.id,
            req.chat_id,
            request,
            serde_json::to_value(&payload).expect("payload serializes"),
            &event,
        )
        .await?;
    if req.send_mode.as_deref() == Some("steer") {
        if let Some(cancel) = generation_cancel(state, req.chat_id) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    // Acceptance is durable even when ingress is temporarily unreachable or
    // its response is lost. The worker's outbox pump retries the same key.
    if let Err(error) = dispatch_turn_commands(state, Some(req.chat_id)).await {
        tracing::warn!(chat=%req.chat_id, "accepted command awaits ingress recovery: {error:?}");
    }
    let command = store
        .turn_commands()
        .existing(
            command.id,
            user.org_id,
            user.id,
            req.chat_id,
            &command.request,
        )
        .await?
        .unwrap_or(command);
    Ok(Json(command_ack(&command)))
}

fn command_ack(command: &crate::store::turn_commands::TurnCommand) -> serde_json::Value {
    json!({"accepted":true, "user_message_id":command.id, "generation_id":command.id, "queued":command.status == "pending",
        "invocation_id":command.invocation_id, "status":command.status})
}

/// Deliver only queue heads. Restate de-duplicates ambiguous HTTP retries;
/// the command's durable invocation claim backstops expired ingress keys.
pub async fn dispatch_turn_commands(state: &AppState, chat: Option<Uuid>) -> Result<(), ApiError> {
    let store = state.store().await?;
    for command in store.turn_commands().pending_heads(chat).await? {
        let Ok(reservation) = state
            .generations
            .try_begin_with_id(command.chat_id, command.id)
        else {
            continue;
        };
        let result: Result<(), ApiError> = async {
            let user = store.identity().get_user(command.user_id).await?;
            crate::http::feed::prepare_generation(state, &AuthUser(user)).await?;
            let url = format!(
                "{}/ChatRunner/{}/generate/send",
                state.config.restate_url.trim_end_matches('/'),
                command.chat_id
            );
            let response = reqwest::Client::new()
                .post(url)
                .header("Idempotency-Key", format!("turn-command:{}", command.id))
                .timeout(std::time::Duration::from_secs(5))
                .json(&command.payload)
                .send()
                .await
                .map_err(|e| ApiError::internal(format!("turn delivery pending: {e}")))?;
            if !response.status().is_success() {
                return Err(ApiError::internal("turn delivery rejected by ingress"));
            }
            let body: serde_json::Value = response
                .json()
                .await
                .map_err(|e| ApiError::internal(format!("invalid ingress acknowledgement: {e}")))?;
            let invocation = body["invocationId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| ApiError::internal("ingress acknowledgement has no invocationId"))?;
            store
                .turn_commands()
                .submitted(command.id, invocation)
                .await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            // An accepted-but-unacknowledged invocation may already stream.
            // Keep that generation attached while its durable claim is live.
            // A failed status read counts as not-running: the release must
            // never be skipped, or the chat's queue wedges until restart
            // (a genuinely running command re-claims via attach_with_id).
            let running = store
                .turn_commands()
                .existing(
                    command.id,
                    command.org_id,
                    command.user_id,
                    command.chat_id,
                    &command.request,
                )
                .await
                .map(|row| row.is_some_and(|row| row.status == "running"))
                .unwrap_or(false);
            if !running {
                state
                    .generations
                    .remove_if_id(command.chat_id, reservation.id);
            }
            tracing::warn!(command=%command.id, "outbox delivery will retry: {error:?}");
        }
    }
    Ok(())
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
///
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

    if state.generations.is_generating(chat_id) {
        // Live turn: the waiting gate journals the decision and broadcasts
        // the resolved frame; the card settles through the stream.
        crate::worker::funnel::forward_approval_decision(
            &state, chat_id, &call_id, approved, reason,
        )
        .await?;
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
    let _ = crate::worker::funnel::forward_approval_decision(
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
        assert!(state.generations.try_begin(chat).is_ok());
        let err = state.generations.try_begin(chat).unwrap_err();
        assert_eq!(err.code, "generation_in_progress");
        assert_eq!(err.status, axum::http::StatusCode::CONFLICT);
        state.generations.remove(chat);
        assert!(state.generations.try_begin(chat).is_ok());
    }
}
