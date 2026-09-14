//! Public OpenAI-compatible chat completions endpoint (spec §10.6, M6 task 2):
//! `POST /openai/v1/chat/completions` with `gk_…` API-key auth. No chat
//! persistence; usage is attributed to the key's org/user.

use crate::http::api_keys::ApiKeyUser;
use crate::state::AppState;
use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use guild_core::provider::{ModelProvider, ProviderChunk, ProviderRequest};
use guild_core::usage::UsageEvent;
use protocol::api::{Message, ToolCall, ToolSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/openai/v1/chat/completions",
        axum::routing::post(chat_completions),
    )
}

#[derive(Deserialize)]
struct OpenAiChatRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    tools: Option<Vec<ToolSpec>>,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    role: String,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAiToolCall>>,
    #[serde(default)]
    tool_call_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiToolCall {
    id: String,
    #[serde(default = "default_tool_type")]
    #[allow(dead_code)]
    r#type: String,
    function: OpenAiFunction,
}

fn default_tool_type() -> String {
    "function".into()
}

#[derive(Deserialize)]
struct OpenAiFunction {
    name: String,
    #[serde(default)]
    arguments: Value,
}

/// Flattens string-or-parts content into plain text.
fn content_to_text(content: &Option<Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn to_internal_messages(msgs: &[OpenAiMessage]) -> (Option<String>, Vec<Message>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for m in msgs {
        match m.role.as_str() {
            "system" | "developer" => system_parts.push(content_to_text(&m.content)),
            "user" | "assistant" => out.push(Message {
                role: m.role.clone(),
                content: content_to_text(&m.content),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: m.tool_calls.as_ref().map(|calls| {
                    calls
                        .iter()
                        .map(|c| ToolCall {
                            id: c.id.clone(),
                            name: c.function.name.clone(),
                            arguments: c.function.arguments.clone(),
                        })
                        .collect()
                }),
                tool_call_id: None,
                reasoning: None,
            }),
            "tool" => out.push(Message::tool_result(
                m.tool_call_id.clone().unwrap_or_default(),
                content_to_text(&m.content),
            )),
            other => out.push(Message {
                role: other.to_string(),
                content: content_to_text(&m.content),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: m.tool_call_id.clone(),
                reasoning: None,
            }),
        }
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    (system, out)
}

fn to_openai_tool_calls(calls: &[ToolCall]) -> Value {
    Value::Array(
        calls
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": {
                        "name": c.name,
                        "arguments": serde_json::to_string(&c.arguments).unwrap_or_default(),
                    },
                })
            })
            .collect(),
    )
}

/// OpenAI-style error body (this endpoint's error contract).
fn openai_error(
    status: axum::http::StatusCode,
    err_type: &str,
    message: impl Into<String>,
) -> axum::response::Response {
    (
        status,
        Json(json!({"error": {"message": message.into(), "type": err_type}})),
    )
        .into_response()
}

async fn chat_completions(
    State(state): State<AppState>,
    key: ApiKeyUser,
    Json(req): Json<OpenAiChatRequest>,
) -> Result<axum::response::Response, axum::response::Response> {
    let org_id = key.0.org_id;
    let user_id = key.0.created_by;
    let session_id = key.0.id;

    let store = state.store().await.map_err(|e| {
        openai_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            e.message.clone(),
        )
    })?;
    let master = state.config.master_key().map_err(|e| {
        openai_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            e.to_string(),
        )
    })?;
    let route = store
        .gateway()
        .resolve_route(org_id, &req.model, &master)
        .await
        .map_err(|e| {
            let status = if e.message.contains("no route") {
                axum::http::StatusCode::NOT_FOUND
            } else {
                axum::http::StatusCode::BAD_GATEWAY
            };
            openai_error(status, "invalid_request_error", e.message.clone())
        })?;

    crate::http::gateway::enforce_quota(&state, org_id, &req.model, &route)
        .await
        .map_err(|e| {
            let status = if e.code == "quota_exceeded" {
                axum::http::StatusCode::TOO_MANY_REQUESTS
            } else {
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            };
            openai_error(status, "quota_exceeded", e.message.clone())
        })?;

    let (system, messages) = to_internal_messages(&req.messages);
    let provider: Arc<dyn ModelProvider> = guild_core::provider::for_protocol(&route.protocol)
        .ok_or_else(|| {
            openai_error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                format!("unknown protocol {}", route.protocol),
            )
        })?;
    let preq = ProviderRequest {
        model: &req.model,
        system: system.as_deref(),
        messages: &messages,
        api_key: &route.api_key,
        base_url: &route.base_url,
        tools: req.tools.as_deref(),
        max_tokens: route.max_output_tokens.unwrap_or(0).max(0) as u32,
    };
    let prov_stream = provider.chat_stream(preq).await.map_err(|e| {
        openai_error(
            axum::http::StatusCode::BAD_GATEWAY,
            "provider_error",
            e.to_string(),
        )
    })?;

    let completion_id = format!("chatcmpl-{}", Uuid::now_v7());
    let model = req.model.clone();
    let provider_name = route.provider.clone();
    let price_in = route.price_in;
    let price_out = route.price_out;
    let usage = state.usage().await.map_err(|e| {
        openai_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            e.message.clone(),
        )
    })?;

    if req.stream {
        let out = stream_chunks(
            prov_stream,
            usage,
            org_id,
            user_id,
            session_id,
            model,
            provider_name,
            price_in,
            price_out,
            completion_id,
        );
        Ok(Sse::new(out)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let (text, calls, tokens_in, tokens_out, _cost) = accumulate(
            prov_stream,
            usage,
            org_id,
            user_id,
            session_id,
            model.clone(),
            provider_name,
            price_in,
            price_out,
        )
        .await
        .map_err(|e| {
            openai_error(
                axum::http::StatusCode::BAD_GATEWAY,
                "provider_error",
                e.to_string(),
            )
        })?;
        let finish_reason = if calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        };
        let mut message = json!({"role": "assistant", "content": text});
        if !calls.is_empty() {
            message["tool_calls"] = to_openai_tool_calls(&calls);
        }
        Ok(Json(json!({
            "id": completion_id,
            "object": "chat.completion",
            "created": chrono::Utc::now().timestamp(),
            "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
            "usage": {
                "prompt_tokens": tokens_in,
                "completion_tokens": tokens_out,
                "total_tokens": tokens_in + tokens_out,
            },
        }))
        .into_response())
    }
}

#[allow(clippy::too_many_arguments)]
fn stream_chunks(
    prov_stream: futures::stream::BoxStream<
        'static,
        Result<ProviderChunk, guild_core::provider::ProviderError>,
    >,
    usage: Arc<crate::usage::UsageSink>,
    org_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
    model: String,
    provider_name: String,
    price_in: f64,
    price_out: f64,
    completion_id: String,
) -> impl Stream<Item = Result<SseEvent, Infallible>> + Send {
    async_stream::stream! {
        let created = chrono::Utc::now().timestamp();
        let chunk = |delta: Value, finish: Option<&str>| {
            json!({
                "id": completion_id.clone(),
                "object": "chat.completion.chunk",
                "created": created,
                "model": model.clone(),
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            })
        };
        yield Ok(SseEvent::default().data(
            chunk(json!({"role": "assistant"}), None).to_string(),
        ));

        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;
        let mut calls: Vec<ToolCall> = Vec::new();
        let mut pinned = Box::pin(prov_stream);
        while let Some(item) = pinned.next().await {
            match item {
                Ok(ProviderChunk::Text(t)) => {
                    if !t.text_delta.is_empty() {
                        yield Ok(SseEvent::default().data(chunk(json!({"content": t.text_delta}), None).to_string()));
                    }
                    if let Some(n) = t.tokens_in { tokens_in = n; }
                    if let Some(n) = t.tokens_out { tokens_out = n; }
                }
                Ok(ProviderChunk::ToolCallDelta { .. }) => {
                    // fragments are folded into the Done frame by the adapter layer
                }
                Ok(ProviderChunk::Thinking(t)) => {
                    if !t.text_delta.is_empty() {
                        yield Ok(SseEvent::default().data(chunk(
                            json!({"reasoning_content": t.text_delta}),
                            None,
                        ).to_string()));
                    }
                }
                Ok(ProviderChunk::ToolCallDone { call }) => {
                    yield Ok(SseEvent::default().data(chunk(
                        json!({"tool_calls": [{"index": calls.len(), "id": call.id, "type": "function",
                            "function": {"name": call.name, "arguments": serde_json::to_string(&call.arguments).unwrap_or_default()}}]}),
                        None,
                    ).to_string()));
                    calls.push(call);
                }
                Err(e) => {
                    yield Ok(SseEvent::default().data(
                        json!({"error": {"message": e.to_string(), "type": "provider_error"}}).to_string(),
                    ));
                    return;
                }
            }
        }

        let finish = if calls.is_empty() { "stop" } else { "tool_calls" };
        yield Ok(SseEvent::default().data(chunk(json!({}), Some(finish)).to_string()));
        yield Ok(SseEvent::default().data("[DONE]"));

        let cost = UsageEvent::cost_usd(tokens_in, tokens_out, price_in, price_out);
        usage.record(UsageEvent {
            ts: chrono::Utc::now(),
            org_id, user_id, team_id: None, session_id,
            model, provider: provider_name,
            tokens_in, tokens_out, cost_usd: cost,
            request_id: Uuid::now_v7(),
        }).await;
    }
}

type Accumulated = (String, Vec<ToolCall>, u32, u32, f64);

#[allow(clippy::too_many_arguments)]
async fn accumulate(
    prov_stream: futures::stream::BoxStream<
        'static,
        Result<ProviderChunk, guild_core::provider::ProviderError>,
    >,
    usage: Arc<crate::usage::UsageSink>,
    org_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
    model: String,
    provider_name: String,
    price_in: f64,
    price_out: f64,
) -> anyhow::Result<Accumulated> {
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut tokens_in = 0u32;
    let mut tokens_out = 0u32;
    let mut pinned = Box::pin(prov_stream);
    while let Some(item) = pinned.next().await {
        match item? {
            ProviderChunk::Text(t) => {
                text.push_str(&t.text_delta);
                if let Some(n) = t.tokens_in {
                    tokens_in = n;
                }
                if let Some(n) = t.tokens_out {
                    tokens_out = n;
                }
            }
            ProviderChunk::ToolCallDelta { .. } => {}
            ProviderChunk::Thinking(_) => {
                // accumulate() feeds non-interactive consumers; reasoning is
                // display-only here
            }
            ProviderChunk::ToolCallDone { call } => calls.push(call),
        }
    }
    let cost = UsageEvent::cost_usd(tokens_in, tokens_out, price_in, price_out);
    usage
        .record(UsageEvent {
            ts: chrono::Utc::now(),
            org_id,
            user_id,
            team_id: None,
            session_id,
            model,
            provider: provider_name,
            tokens_in,
            tokens_out,
            cost_usd: cost,
            request_id: Uuid::now_v7(),
        })
        .await;
    Ok((text, calls, tokens_in, tokens_out, cost))
}
