//! LLM gateway: streaming chat through the org's provider keys and routes,
//! usage recorded per request (spec §4.2, §4.5). Internal API — Guild
//! clients only in v1.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::identity::UserRow;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::{Json, Router};
use futures::Stream;
use futures::StreamExt;
use guild_core::provider::{ModelProvider, ProviderChunk, ProviderError, ProviderRequest};
use guild_core::usage::UsageEvent;
use protocol::api::{ChatCompletionRequest, StreamEvent, ToolCall};
use std::convert::Infallible;
use std::sync::Arc;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/gateway/models", axum::routing::get(models))
        .route("/api/v1/gateway/chat", axum::routing::post(chat))
        .route("/api/v1/admin/gateway/keys", axum::routing::post(set_key))
        .route(
            "/api/v1/admin/gateway/routes",
            axum::routing::put(set_route),
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

async fn set_key(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let provider = body["provider"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing provider"))?;
    let base_url = body["base_url"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing base_url"))?;
    let key = body["key"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing key"))?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    let store = state.store().await?;
    store
        .gateway()
        .upsert_provider_key(admin.0.org_id, provider, base_url, key, &master)
        .await?;
    Ok(Json(serde_json::json!({})))
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
    let price_in = body["price_in"]
        .as_f64()
        .ok_or_else(|| ApiError::bad_request("missing price_in"))?;
    let price_out = body["price_out"]
        .as_f64()
        .ok_or_else(|| ApiError::bad_request("missing price_out"))?;
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
        )
        .await?;
    Ok(Json(serde_json::json!({})))
}

fn provider_err_to_api(e: ProviderError) -> ApiError {
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

async fn chat(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let store = state.store().await?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    let route = store
        .gateway()
        .resolve_route(user.0.org_id, &req.model, &master)
        .await?;
    // Org scoping: chat must belong to the caller's org.
    store.chats().get_chat(user.0.org_id, req.chat_id).await?;

    // Persist the new user turn (client sends only the new message in v1).
    if let Some(last) = req.messages.last() {
        if last.role == "user" {
            store
                .chats()
                .append_message(
                    req.chat_id,
                    "user",
                    &last.content,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await?;
        }
    }

    let provider: Arc<dyn ModelProvider> = match route.provider.as_str() {
        "openai" => Arc::new(guild_core::provider::OpenAiProvider::new()),
        "anthropic" => Arc::new(guild_core::provider::AnthropicProvider::new()),
        other => return Err(ApiError::internal(format!("unknown provider {other}"))),
    };
    let preq = ProviderRequest {
        model: &req.model,
        system: req.system.as_deref(),
        messages: &req.messages,
        api_key: &route.api_key,
        base_url: &route.base_url,
        tools: req.tools.as_deref(),
    };
    let prov_stream = provider
        .chat_stream(preq)
        .await
        .map_err(provider_err_to_api)?;

    let store = store.clone();
    let usage = state.usage().await?;
    let org_id = user.0.org_id;
    let user_id = user.0.id;
    let team_id: Option<Uuid> = None;
    let chat_id = req.chat_id;
    let model = req.model.clone();
    let provider_name = route.provider.clone();
    let price_in = route.price_in;
    let price_out = route.price_out;

    let out = async_stream::stream! {
        let mut text = String::new();
        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut pinned = Box::pin(prov_stream);
        while let Some(item) = pinned.next().await {
            match item {
                Ok(ProviderChunk::Text(chunk)) => {
                    if !chunk.text_delta.is_empty() {
                        text.push_str(&chunk.text_delta);
                        yield sse_event(StreamEvent::Delta { content: chunk.text_delta.clone() });
                    }
                    if let Some(t) = chunk.tokens_in { tokens_in = t; }
                    if let Some(t) = chunk.tokens_out { tokens_out = t; }
                }
                Ok(ProviderChunk::ToolCallDelta { index, id, name, arguments_delta }) => {
                    yield sse_event(StreamEvent::ToolCallDelta { index, id, name, arguments_delta });
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
        let cost = UsageEvent::cost_usd(tokens_in, tokens_out, price_in, price_out);
        let persisted_calls = if tool_calls.is_empty() { None } else { Some(tool_calls) };
        match store
            .chats()
            .append_message(chat_id, "assistant", &text, persisted_calls, None, Some(tokens_in), Some(tokens_out), Some(cost))
            .await
        {
            Ok(msg) => {
                let ev = UsageEvent {
                    ts: chrono::Utc::now(),
                    org_id, user_id, team_id, session_id: chat_id,
                    model: model.clone(), provider: provider_name.clone(),
                    tokens_in, tokens_out, cost_usd: cost,
                    request_id: Uuid::now_v7(),
                };
                usage.record(ev).await;
                yield sse_event(StreamEvent::Done { message_id: msg.id, cost_usd: cost, tokens_in, tokens_out });
            }
            Err(e) => {
                yield sse_event(StreamEvent::Error { code: "internal".into(), message: e.message });
            }
        }
    };

    Ok(Sse::new(out).keep_alive(KeepAlive::default()))
}
