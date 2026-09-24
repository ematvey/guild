//! Public OpenAI-compatible chat completions endpoint (spec §10.6, M6 task 2):
//! `POST /openai/v1/chat/completions` with `gk_…` API-key auth. No chat
//! persistence; usage is attributed to the key's org/user.

use crate::http::api_keys::ApiKeyUser;
use crate::http::error::ApiError;
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
    /// The model's chain-of-thought on replayed assistant turns (DeepSeek
    /// convention, also exposed on this endpoint's output). Replay keeps it
    /// — reasoning is never dropped from context.
    #[serde(default)]
    reasoning_content: Option<String>,
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

/// One message's content after decoding the wire parts.
struct DecodedContent {
    text: String,
    images: Vec<String>,
    audio: Vec<protocol::api::MessageAudio>,
}

/// Decodes string-or-parts content. Image (`image_url`) and audio
/// (`input_audio`) parts become the internal media fields on user turns;
/// any other part type is rejected explicitly instead of silently dropped.
fn decode_content(role: &str, content: &Option<Value>) -> Result<DecodedContent, ApiError> {
    let mut out = DecodedContent {
        text: String::new(),
        images: Vec::new(),
        audio: Vec::new(),
    };
    match content {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => out.text = s.clone(),
        Some(Value::Array(parts)) => {
            let mut texts: Vec<&str> = Vec::new();
            for part in parts {
                match part["type"].as_str().unwrap_or_default() {
                    "text" => {
                        texts.push(part["text"].as_str().ok_or_else(|| {
                            ApiError::bad_request("text content part is missing its text")
                        })?);
                    }
                    "image_url" if role == "user" => {
                        let url = part["image_url"]["url"]
                            .as_str()
                            .or_else(|| part["image_url"].as_str())
                            .ok_or_else(|| {
                                ApiError::bad_request("image_url content part is missing its url")
                            })?;
                        out.images.push(url.to_string());
                    }
                    "input_audio" if role == "user" => {
                        let data = part["input_audio"]["data"].as_str().ok_or_else(|| {
                            ApiError::bad_request("input_audio content part is missing its data")
                        })?;
                        let format = part["input_audio"]["format"].as_str().ok_or_else(|| {
                            ApiError::bad_request("input_audio content part is missing its format")
                        })?;
                        out.audio.push(protocol::api::MessageAudio {
                            data: data.to_string(),
                            format: format.to_string(),
                        });
                    }
                    other => {
                        return Err(ApiError::bad_request(format!(
                            "unsupported content part type: {other}"
                        )));
                    }
                }
            }
            out.text = texts.join("\n");
        }
        Some(_) => {
            return Err(ApiError::bad_request(
                "message content must be a string or an array of parts",
            ));
        }
    }
    Ok(out)
}

fn to_internal_messages(
    msgs: &[OpenAiMessage],
) -> Result<(Option<String>, Vec<Message>), ApiError> {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for m in msgs {
        let decoded = decode_content(&m.role, &m.content)?;
        match m.role.as_str() {
            "system" | "developer" => system_parts.push(decoded.text),
            "user" | "assistant" => out.push(Message {
                role: m.role.clone(),
                content: decoded.text,
                images: decoded.images,
                audio: decoded.audio,
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
                reasoning: m.reasoning_content.clone().filter(|r| !r.is_empty()),
            }),
            "tool" => out.push(Message::tool_result(
                m.tool_call_id.clone().unwrap_or_default(),
                decoded.text,
            )),
            other => out.push(Message {
                role: other.to_string(),
                content: decoded.text,
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
    Ok((system, out))
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

/// Renders the provider's canonical finish reason (or the shape-derived
/// fallback) — `length`/`content_filter` terminations must reach the client
/// as what they are, not as a normal stop.
fn gateway_finish_reason(reported: Option<&str>, has_calls: bool) -> &'static str {
    match reported {
        Some("tool_calls") | Some("function_call") => "tool_calls",
        Some("length") => "length",
        Some("content_filter") => "content_filter",
        Some("stop") => "stop",
        // Unknown reason or none reported: fall back to the shape-derived
        // verdict (today's behavior).
        _ => {
            if has_calls {
                "tool_calls"
            } else {
                "stop"
            }
        }
    }
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
                        "arguments": match &c.arguments {
                            // A raw (unparseable upstream) argument buffer is
                            // preserved verbatim — re-encoding it as a JSON
                            // string literal would hand the client a quoted
                            // string instead of the original bytes.
                            Value::String(raw) => raw.clone(),
                            value => serde_json::to_string(value).unwrap_or_default(),
                        },
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
    let (system, messages) = to_internal_messages(&req.messages).map_err(|e| {
        openai_error(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_request_error",
            e.message.clone(),
        )
    })?;
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
        let acc = accumulate(prov_stream, guard.counters())
            .await
            .map_err(|e| {
                openai_error(
                    axum::http::StatusCode::BAD_GATEWAY,
                    "provider_error",
                    e.to_string(),
                )
            })?;
        guard.record_sync().await;
        let finish_reason =
            gateway_finish_reason(acc.finish_reason.as_deref(), !acc.calls.is_empty());
        let mut message = json!({"role": "assistant", "content": acc.text});
        if !acc.calls.is_empty() {
            message["tool_calls"] = to_openai_tool_calls(&acc.calls);
        }
        if !acc.reasoning.is_empty() {
            message["reasoning_content"] = Value::String(acc.reasoning);
        }
        Ok(Json(json!({
            "id": completion_id,
            "object": "chat.completion",
            "created": chrono::Utc::now().timestamp(),
            "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
            "usage": {
                "prompt_tokens": acc.tokens_in,
                "completion_tokens": acc.tokens_out,
                "total_tokens": acc.tokens_in + acc.tokens_out,
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
        let mut finish_reason: Option<String> = None;
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
                            "function": {"name": call.name, "arguments": match &call.arguments {
                                // Raw argument buffers go out verbatim (see
                                // to_openai_tool_calls — no double encoding).
                                Value::String(raw) => raw.clone(),
                                value => serde_json::to_string(value).unwrap_or_default(),
                            }}}]}),
                        None,
                    ).to_string()));
                    calls.push(call);
                }
                Ok(ProviderChunk::Finished { reason }) => {
                    finish_reason = Some(reason);
                }
                Err(e) => {
                    yield Ok(SseEvent::default().data(
                        json!({"error": {"message": e.to_string(), "type": "provider_error"}}).to_string(),
                    ));
                    return;
                }
            }
        }

        let finish = gateway_finish_reason(finish_reason.as_deref(), !calls.is_empty());
        guard.record_sync().await;
        yield Ok(SseEvent::default().data(chunk(json!({}), Some(finish)).to_string()));
        yield Ok(SseEvent::default().data("[DONE]"));
    }
}
