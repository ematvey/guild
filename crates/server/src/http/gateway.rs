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
    let media = crate::worker::turn::load_media_map(state, org_id, chat_id, &[], attachment_ids)
        .await?;
    let (chips, inline) = crate::worker::turn::build_turn_text(
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
                        Some((&project.machine_id, label.as_str())),
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
    if state.generations.is_generating(req.chat_id) {
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
        if state.generations.is_generating(req.chat_id) {
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
    state.generations.try_begin(req.chat_id)?;
    if let Err(error) = crate::http::feed::prepare_generation(state, &crate::http::auth::AuthUser(user.clone())).await {
        state.generations.remove(req.chat_id);
        return Err(error);
    }

    let generation_id = state.generations.handle(req.chat_id).unwrap().id;

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
            state.generations.remove(req.chat_id);
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

    if state.generations.is_generating(chat_id) {
        // Live turn: the waiting gate journals the decision and broadcasts
        // the resolved frame; the card settles through the stream.
        crate::worker::funnel::forward_approval_decision(&state, chat_id, &call_id, approved, reason).await?;
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
