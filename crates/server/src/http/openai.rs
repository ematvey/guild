//! Public OpenAI-compatible chat completions endpoint (spec §10.6, M6 task 2):
//! `POST /openai/v1/chat/completions` with `gk_…` API-key auth. No chat
//! persistence; usage is attributed to the key's org/user.

use crate::http::api_keys::ApiKeyUser;
use crate::http::llm_proxy::{accumulate, dispatch, StreamUsageGuard};
use crate::state::AppState;
use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use guild_core::provider::ProviderChunk;
use protocol::api::{Message, ToolCall, ToolSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/openai/v1/chat/completions",
            axum::routing::post(chat_completions),
        )
        .route("/openai/v1/models", axum::routing::get(models))
}

async fn models(
    State(state): State<AppState>,
    key: ApiKeyUser,
) -> Result<axum::response::Response, axum::response::Response> {
    let store = state.store().await.map_err(|e| {
        openai_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            e.message.clone(),
        )
    })?;
    let models = store
        .gateway()
        .list_models(key.0.org_id)
        .await
        .map_err(|e| {
            openai_error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                e.to_string(),
            )
        })?;
    Ok(Json(json!({
        "object": "list",
        "data": models
            .into_iter()
            .map(|m| json!({"id": m, "object": "model", "owned_by": "organization_owner"}))
            .collect::<Vec<_>>(),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct OpenAiChatRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    tools: Option<Vec<OpenAiTool>>,
    max_tokens: Option<u32>,
    max_completion_tokens: Option<u32>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OpenAiTool {
    Function { function: OpenAiFunctionSpec },
}

#[derive(Deserialize)]
struct OpenAiFunctionSpec {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "empty_parameters")]
    parameters: Value,
}

fn empty_parameters() -> Value {
    json!({"type": "object", "properties": {}})
}

impl From<OpenAiTool> for ToolSpec {
    fn from(tool: OpenAiTool) -> Self {
        let OpenAiTool::Function { function } = tool;
        Self {
            name: function.name,
            description: function.description,
            parameters: function.parameters,
            kind: Default::default(),
        }
    }
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

/// OpenAI clients send tool-call `arguments` as a JSON-encoded string; the
/// internal Message carries a parsed object (the Anthropic wire requires an
/// object and the OpenAI replay path re-encodes). Unparseable strings stay
/// raw — the provider replay handles non-objects.
fn parse_tool_arguments(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| v.clone()),
        other => other.clone(),
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
                            arguments: parse_tool_arguments(&c.function.arguments),
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
    // Usage belongs to the key's owner when user-minted, else to the admin
    // who created the org key.
    let user_id = key.0.user_id.unwrap_or(key.0.created_by);
    let session_id = key.0.id;

    let limit = req.max_completion_tokens.or(req.max_tokens);
    if limit == Some(0) {
        return Err(openai_error(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "output token limit must be positive",
        ));
    }
    let (system, messages) = to_internal_messages(&req.messages);
    let call = dispatch(
        &state,
        org_id,
        &req.model,
        system,
        messages,
        req.tools
            .map(|tools| tools.into_iter().map(Into::into).collect()),
        limit.map(i64::from),
    )
    .await
    .map_err(|e| openai_error(e.status(), e.openai_type(), e.0.message.clone()))?;

    let usage = call.usage.clone();
    let completion_id = format!("chatcmpl-{}", Uuid::now_v7());
    let model = call.model.clone();
    let provider_name = call.provider.clone();
    let price_in = call.price_in;
    let price_out = call.price_out;
    let prov_stream = call.stream;
    let call_meta = (model.clone(), provider_name.clone(), price_in, price_out);

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
        let guard = StreamUsageGuard::new(
            usage,
            org_id,
            user_id,
            session_id,
            call_meta.0,
            call_meta.1,
            call_meta.2,
            call_meta.3,
        );
        let (text, calls, tokens_in, tokens_out) = accumulate(prov_stream, guard.counters())
            .await
            .map_err(|e| {
                openai_error(
                    axum::http::StatusCode::BAD_GATEWAY,
                    "provider_error",
                    e.to_string(),
                )
            })?;
        guard.record_sync().await;
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
        // Created before the first yield: a drop at any suspension point —
        // including the very first frame — records the running counts.
        let guard = crate::http::llm_proxy::StreamUsageGuard::new(
            usage,
            org_id,
            user_id,
            session_id,
            model.clone(),
            provider_name,
            price_in,
            price_out,
        );
        let counters = guard.counters();
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

        let mut calls: Vec<ToolCall> = Vec::new();
        let mut pinned = Box::pin(prov_stream);
        while let Some(item) = pinned.next().await {
            // Only Ok items count as served frames: an in-stream provider
            // error before any real chunk must not bill a 0-token request.
            if item.is_ok() {
                counters.observe();
            }
            match item {
                Ok(ProviderChunk::Text(t)) => {
                    if !t.text_delta.is_empty() {
                        yield Ok(SseEvent::default().data(chunk(json!({"content": t.text_delta}), None).to_string()));
                    }
                    counters.set(t.tokens_in, t.tokens_out);
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
        guard.record_sync().await;
        yield Ok(SseEvent::default().data(chunk(json!({}), Some(finish)).to_string()));
        yield Ok(SseEvent::default().data("[DONE]"));
    }
}
