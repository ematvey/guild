//! Internal worker API (Bearer `GUILD_INTERNAL_TOKEN`) and webhook ingress
//! (spec §4.6). The internal surface never exposes provider keys.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::routines::UpdatePatch;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use guild_core::provider::{ModelProvider, ProviderChunk, ProviderRequest};
use guild_core::usage::UsageEvent;
use protocol::api::{Message, StreamEvent, ToolCall, ToolSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use uuid::Uuid;

pub fn routines_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/routines", axum::routing::post(create).get(list))
        .route(
            "/api/v1/routines/{id}",
            axum::routing::get(get_one).patch(update).delete(delete_one),
        )
        .route("/api/v1/routines/{id}/runs", axum::routing::get(list_runs))
        .route("/api/v1/hooks/{org_id}/{slug}", axum::routing::post(hook))
}

pub fn internal_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/internal/routines/{id}",
            axum::routing::get(internal_routine),
        )
        .route(
            "/api/v1/internal/runs",
            axum::routing::post(internal_run_record),
        )
        .route(
            "/api/v1/internal/runs/finish",
            axum::routing::post(internal_finish_run),
        )
        .route(
            "/api/v1/internal/completion",
            axum::routing::post(internal_completion),
        )
        .route(
            "/api/v1/internal/storage",
            axum::routing::post(internal_storage),
        )
}

// ---------- user-facing routine CRUD ----------

async fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    // Enabled routines mint provider spend on the org's routes: only an
    // admin may create or re-enable one (disabled creation stays member-level).
    if user.0.role != "admin" {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let slug = body["slug"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing slug"))?;
    let name = body["name"].as_str().unwrap_or(slug);
    let trigger_kind = body["trigger_kind"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing trigger_kind"))?;
    if !matches!(trigger_kind, "webhook" | "interval") {
        return Err(ApiError::bad_request(
            "trigger_kind must be webhook or interval",
        ));
    }
    if trigger_kind == "interval"
        && body["trigger_config"]["interval_secs"]
            .as_u64()
            .is_none_or(|n| n < 5)
    {
        return Err(ApiError::bad_request(
            "interval trigger needs trigger_config.interval_secs >= 5",
        ));
    }
    let prompt = body["prompt"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing prompt"))?;
    let model = body["model"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing model"))?;
    let enabled = body["enabled"].as_bool().unwrap_or(true);
    if enabled {
        require_admin(&user).await?;
    }
    let allowed_tools = if body["allowed_tools"].is_null() {
        json!(["http_call", "storage_put"])
    } else {
        body["allowed_tools"].clone()
    };
    let webhook_token = new_hook_token();
    let store = state.store().await?;
    let routine = store
        .routines()
        .create(
            user.0.org_id,
            user.0.id,
            slug,
            name,
            trigger_kind,
            if body["trigger_config"].is_null() {
                json!({})
            } else {
                body["trigger_config"].clone()
            },
            prompt,
            model,
            allowed_tools,
            &webhook_token,
            enabled,
        )
        .await?;
    // a newly created enabled interval routine starts its chain immediately
    if routine.enabled && routine.trigger_kind == "interval" {
        let _ = dispatch_routine_schedules(&state, Some(routine.id)).await;
    }
    let mut value = serde_json::to_value(&routine).expect("routine serializes");
    // The plaintext webhook token is shown once, at creation; only its hash
    // is stored.
    if routine.trigger_kind == "webhook" {
        value["webhook_token"] = json!(webhook_token);
    }
    Ok(Json(value))
}

pub fn new_hook_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("hook_{}", hex::encode(b))
}

async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let routines = store.routines().list(user.0.org_id).await?;
    Ok(Json(json!({ "routines": routines })))
}

async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let routine = store.routines().get(user.0.org_id, id).await?;
    Ok(Json(
        serde_json::to_value(&routine).expect("routine serializes"),
    ))
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let patch = UpdatePatch {
        prompt: body["prompt"].as_str().map(String::from),
        model: body["model"].as_str().map(String::from),
        enabled: body["enabled"].as_bool(),
        trigger_config: if body["trigger_config"].is_null() {
            None
        } else {
            Some(body["trigger_config"].clone())
        },
    };
    // Re-enabling is the same spend channel as enabled creation: admin only.
    if patch.enabled == Some(true) {
        require_admin(&user).await?;
    }
    let store = state.store().await?;
    let (routine, new_schedule) = store
        .routines()
        .update(user.0.org_id, id, &patch, user.0.role == "admin")
        .await?;
    // re-enabling an interval routine restarts its tick loop
    if new_schedule {
        let _ = dispatch_routine_schedules(&state, Some(routine.id)).await;
    }
    Ok(Json(
        serde_json::to_value(&routine).expect("routine serializes"),
    ))
}

async fn delete_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    store.routines().delete(user.0.org_id, id).await?;
    Ok(Json(json!({})))
}

async fn list_runs(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    store.routines().get(user.0.org_id, id).await?; // 404 when foreign
    let runs = store.routines().list_runs(user.0.org_id, id).await?;
    Ok(Json(json!({ "runs": runs })))
}

// ---------- webhook ingress ----------

/// Fire-and-forget forward to Restate ingress (`/send` suffix = one-way).
/// Returns the accepted invocation id (used for stuck-invocation cleanup).
pub(crate) async fn restate_send_one_way(
    state: &AppState,
    service: &str,
    path: &str,
    body: Value,
) -> Result<String, ApiError> {
    let url = format!(
        "{}/{service}/{path}/send",
        state.config.restate_url.trim_end_matches('/')
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("restate ingress unreachable: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::internal(format!(
            "restate ingress rejected: {status} {text}"
        )));
    }
    let invocation_id = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["invocationId"].as_str().map(String::from))
        .unwrap_or_default();
    Ok(invocation_id)
}

/// Deliver committed schedule starters. Ingress errors leave them pending;
/// a successful starter claim survives both lost replies and key expiration.
pub async fn dispatch_routine_schedules(
    state: &AppState,
    routine: Option<Uuid>,
) -> Result<(), ApiError> {
    let store = state.store().await?;
    for start in store.routines().pending_schedules(routine).await? {
        let result: Result<(), ApiError> = async {
            let response = reqwest::Client::new()
                .post(format!(
                    "{}/RoutineRunner/{}/start_schedule/send",
                    state.config.restate_url.trim_end_matches('/'),
                    start.routine_id
                ))
                .header(
                    "Idempotency-Key",
                    format!("routine-schedule:{}", start.generation),
                )
                .timeout(std::time::Duration::from_secs(5))
                .json(&json!({"generation":start.generation}))
                .send()
                .await
                .map_err(|error| {
                    ApiError::internal(format!("schedule ingress unavailable: {error}"))
                })?;
            if !response.status().is_success() {
                return Err(ApiError::internal("schedule delivery rejected by ingress"));
            }
            let ack: Value = response.json().await.map_err(|error| {
                ApiError::internal(format!("invalid schedule acknowledgement: {error}"))
            })?;
            let invocation = ack["invocationId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ApiError::internal("schedule acknowledgement has no invocationId")
                })?;
            store
                .routines()
                .schedule_dispatched(start.generation, invocation)
                .await
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(generation=%start.generation, "routine schedule delivery pending: {error:?}");
        }
    }
    Ok(())
}

async fn hook(
    State(state): State<AppState>,
    Path((org_id, slug)): Path<(Uuid, String)>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    let token = headers
        .get("x-guild-hook-token")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("missing hook token"))?;
    let store = state.store().await?;
    let routine = store.routines().get_by_slug(org_id, &slug).await?;
    // Constant-time comparison of the presented token's hash against the
    // stored one — the plaintext never exists server-side beyond this call.
    use sha2::{Digest, Sha256};
    use subtle::ConstantTimeEq;
    let presented = hex::encode(Sha256::digest(token.as_bytes()));
    if !bool::from(
        routine
            .webhook_token_hash
            .as_bytes()
            .ct_eq(presented.as_bytes()),
    ) {
        return Err(ApiError::unauthorized("bad hook token"));
    }
    if !routine.enabled {
        return Err(ApiError::conflict(
            "routine_disabled",
            "this routine is disabled",
        ));
    }
    let payload: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    restate_send_one_way(
        &state,
        "RoutineRunner",
        &format!("{}/handle_webhook", routine.id),
        payload,
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(json!({"accepted": true}))))
}

// ---------- internal (worker) API ----------

async fn require_internal_token(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(), ApiError> {
    let Some(expected) = &state.config.internal_token else {
        return Err(ApiError::forbidden());
    };
    let got = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("missing internal token"))?;
    // Constant-time: the bearer gates the worker-facing internal API.
    use subtle::ConstantTimeEq;
    if !bool::from(got.as_bytes().ct_eq(expected.as_bytes())) {
        return Err(ApiError::unauthorized("bad internal token"));
    }
    Ok(())
}

async fn internal_routine(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_internal_token(&state, &headers).await?;
    let store = state.store().await?;
    let routine = store.routines().get_for_internal(id).await?;
    Ok(Json(
        serde_json::to_value(&routine).expect("routine serializes"),
    ))
}

async fn internal_run_record(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_internal_token(&state, &headers).await?;
    let store = state.store().await?;
    let routine_id: Uuid = body["routine_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing routine_id"))?;
    store.routines().get_for_internal(routine_id).await?;
    let trigger = body["trigger"].as_str().unwrap_or("manual");
    let (run_id, _started) = store.routines().start_run(routine_id, trigger).await?;
    Ok(Json(json!({ "run_id": run_id })))
}

/// Internal completion: like the gateway but attributed to (org, user) from
/// the body, and without chat persistence.
#[derive(Deserialize)]
struct InternalCompletionRequest {
    org_id: Uuid,
    user_id: Uuid,
    model: String,
    #[serde(default)]
    system: Option<String>,
    messages: Vec<Message>,
    #[serde(default)]
    tools: Option<Vec<ToolSpec>>,
}

async fn internal_finish_run(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_internal_token(&state, &headers).await?;
    let run_id: Uuid = body["run_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing run_id"))?;
    let status = body["status"].as_str().unwrap_or("failed");
    let store = state.store().await?;
    store
        .routines()
        .finish_run(
            run_id,
            status,
            body["summary"].as_str(),
            body["error"].as_str(),
        )
        .await?;
    Ok(Json(json!({})))
}

async fn internal_completion(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<InternalCompletionRequest>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    require_internal_token(&state, &headers).await?;
    let store = state.store().await?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    let route = store
        .gateway()
        .resolve_route(req.org_id, &req.model, &master)
        .await?;
    // The routine completion path is a spend path like any other: the
    // route's monthly quota gates it before the provider stream starts.
    crate::worker::turn::enforce_quota(&state, req.org_id, &req.model, &route).await?;

    let provider: Arc<dyn ModelProvider> = guild_core::provider::for_protocol(&route.protocol)
        .ok_or_else(|| ApiError::internal(format!("unknown protocol {}", route.protocol)))?;
    let preq = ProviderRequest {
        model: &req.model,
        system: req.system.as_deref(),
        messages: &req.messages,
        api_key: &route.api_key,
        base_url: &route.base_url,
        tools: req.tools.as_deref(),
        max_tokens: route.max_output_tokens.unwrap_or(0).max(0) as u32,
    };
    let prov_stream = provider
        .chat_stream(preq)
        .await
        .map_err(crate::http::gateway::provider_err_to_api)?;

    let usage = state.usage().await?;
    let org_id = req.org_id;
    let user_id = req.user_id;
    let model = req.model.clone();
    let provider_name = route.provider.clone();
    let price_in = route.price_in;
    let price_out = route.price_out;

    let out = async_stream::stream! {
        let mut text = String::new();
        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;
        // Usage records at the guard's drop — also on abort and error exits.
        let guard = crate::http::llm_proxy::StreamUsageGuard::new(
            usage,
            org_id,
            user_id,
            Uuid::nil(),
            model.clone(),
            provider_name.clone(),
            price_in,
            price_out,
        );
        let counters = guard.counters();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut pinned = Box::pin(prov_stream);
        while let Some(item) = pinned.next().await {
            counters.observe();
            match item {
                Ok(ProviderChunk::Text(chunk)) => {
                    if !chunk.text_delta.is_empty() {
                        text.push_str(&chunk.text_delta);
                        yield sse_event(StreamEvent::Delta { content: chunk.text_delta.clone() });
                    }
                    if let Some(t) = chunk.tokens_in { tokens_in = t; }
                    if let Some(t) = chunk.tokens_out { tokens_out = t; }
                    counters.set(chunk.tokens_in, chunk.tokens_out);
                }
                Ok(ProviderChunk::ToolCallDelta { index, id, name, arguments_delta }) => {
                    yield sse_event(StreamEvent::ToolCallDelta { index, id, name, arguments_delta });
                }
                Ok(ProviderChunk::Thinking(chunk)) => {
                    if !chunk.text_delta.is_empty() {
                        yield sse_event(StreamEvent::ThinkingDelta { content: chunk.text_delta });
                    }
                }
                Ok(ProviderChunk::ToolCallDone { call }) => {
                    tool_calls.push(call.clone());
                    yield sse_event(StreamEvent::ToolCallDone { call });
                }
                Err(e) => {
                    yield sse_event(StreamEvent::Error { code: "provider".into(), message: e.to_string() });
                    return;
                }
            }
        }
        guard.record_sync().await;
        let cost = UsageEvent::cost_usd(tokens_in, tokens_out, price_in, price_out);
        yield sse_event(StreamEvent::Done {
            message_id: Uuid::now_v7(),
            cost_usd: cost,
            tokens_in,
            tokens_out,
        });
        let _ = &tool_calls; // visible to the caller via the streamed frames
    };

    Ok(Sse::new(out).keep_alive(KeepAlive::default()))
}

fn sse_event(ev: StreamEvent) -> Result<SseEvent, Infallible> {
    Ok(SseEvent::default().data(serde_json::to_string(&ev).expect("stream event serializes")))
}

async fn internal_storage(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    require_internal_token(&state, &headers).await?;
    let org_id: Uuid = q
        .get("org_id")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing org_id"))?;
    let key = q
        .get("key")
        .ok_or_else(|| ApiError::bad_request("missing key"))?;
    // The internal caller writes only inside its org's runs/ prefix: the
    // key charset is pinned so no foreign object key (attachments,
    // registry bundles) can be addressed, and `..` segments are refused.
    if key.is_empty()
        || key.len() > 512
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-'))
        || key.split('/').any(|seg| seg == ".." || seg.is_empty())
    {
        return Err(ApiError::bad_request("bad key"));
    }
    let objects = state.objects().await?;
    objects
        .put(&format!("runs/{org_id}/{key}"), body.to_vec())
        .await
        .map_err(ApiError::from)?;
    Ok(Json(json!({})))
}
