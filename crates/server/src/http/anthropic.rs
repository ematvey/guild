//! Public Anthropic-compatible Messages endpoint: `POST /anthropic/v1/messages`
//! with `gk_…` key auth (`x-api-key` or `Authorization: Bearer`). Converts
//! the Anthropic request shape (top-level system, content blocks, required
//! `max_tokens`) into the internal message format, resolves the org route
//! for the model (same scoping as in-app chat), and renders provider output
//! back in Anthropic shape — both non-streaming and as Anthropic SSE events
//! (`message_start` / `content_block_delta` / `message_stop`).

use crate::http::error::ApiError;
use crate::http::llm_proxy::{accumulate, dispatch, usage_event, ProxyError};
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use guild_core::provider::ProviderChunk;
use protocol::api::{Message, ToolCall, ToolSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new().route("/anthropic/v1/messages", axum::routing::post(messages))
}

/// Extractor: `gk_…` key auth for the Anthropic surface — same credential
/// store as the OpenAI endpoint, but rejections render in the Anthropic
/// error shape (`x-api-key` or `Authorization: Bearer`).
pub struct AnthropicKey(pub crate::store::api_keys::ApiKeyRow);

pub struct AnthropicAuthError(pub ApiError);

impl axum::response::IntoResponse for AnthropicAuthError {
    fn into_response(self) -> axum::response::Response {
        (
            self.0.status,
            Json(json!({
                "type": "error",
                "error": {"type": "authentication_error", "message": self.0.message},
            })),
        )
            .into_response()
    }
}

impl FromRequestParts<AppState> for AnthropicKey {
    type Rejection = AnthropicAuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .or_else(|| parts.headers.get("x-api-key").and_then(|v| v.to_str().ok()))
            .filter(|t| !t.is_empty())
            .ok_or_else(|| AnthropicAuthError(ApiError::unauthorized("missing api key")))?;
        let row = state
            .store()
            .await
            .map_err(AnthropicAuthError)?
            .api_keys()
            .authenticate(token)
            .await
            .map_err(AnthropicAuthError)?
            .ok_or_else(|| AnthropicAuthError(ApiError::unauthorized("invalid api key")))?;
        Ok(AnthropicKey(row))
    }
}

#[derive(Deserialize)]
struct AnthropicRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    #[serde(default)]
    system: Option<Value>,
    // Anthropic requires max_tokens; the route's max_output_tokens wins when
    // set, otherwise the client value applies.
    #[serde(default)]
    max_tokens: Option<i64>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    tools: Option<Vec<AnthropicTool>>,
    // Accepted for SDK compatibility but not forwarded: the internal
    // ProviderRequest carries only model/system/messages/tools/max_tokens.
    #[serde(default, rename = "temperature")]
    _temperature: Option<f64>,
    #[serde(default, rename = "top_p")]
    _top_p: Option<f64>,
    #[serde(default, rename = "stop_sequences")]
    _stop_sequences: Option<Vec<String>>,
    #[serde(default, rename = "tool_choice")]
    _tool_choice: Option<Value>,
}

#[derive(Deserialize)]
struct AnthropicMessage {
    role: String,
    #[serde(default)]
    content: Value, // string or content-block array
}

#[derive(Deserialize)]
struct AnthropicTool {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    input_schema: Option<Value>,
}

/// Anthropic request → internal (system, messages). Mirrors the llm/gateway
/// proxy's `anthropicToOpenAI`: top-level system, text/image/tool_result
/// blocks in user turns, text/tool_use blocks in assistant turns.
fn to_internal(req: &AnthropicRequest) -> (Option<String>, Vec<Message>) {
    let system = req.system.as_ref().map(|s| match s {
        Value::String(t) => t.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    });

    let mut out = Vec::new();
    for m in &req.messages {
        let role = m.role.as_str();
        if let Value::String(text) = &m.content {
            out.push(Message {
                role: role.to_string(),
                content: text.clone(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: None,
            });
            continue;
        }
        let blocks = m.content.as_array().cloned().unwrap_or_default();
        if role == "assistant" {
            let mut text = String::new();
            let mut calls: Vec<ToolCall> = Vec::new();
            for b in &blocks {
                match b["type"].as_str() {
                    Some("text") => text.push_str(b["text"].as_str().unwrap_or_default()),
                    Some("tool_use") => calls.push(ToolCall {
                        id: b["id"].as_str().unwrap_or("").to_string(),
                        name: b["name"].as_str().unwrap_or("").to_string(),
                        arguments: b["input"].clone(),
                    }),
                    _ => {}
                }
            }
            out.push(Message {
                role: "assistant".into(),
                content: text,
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: (!calls.is_empty()).then_some(calls),
                tool_call_id: None,
                reasoning: None,
            });
        } else {
            // user turns: text + image parts inline, tool_result blocks
            // become separate tool messages after the turn.
            let mut text = String::new();
            let mut images = Vec::new();
            for b in &blocks {
                match b["type"].as_str() {
                    Some("text") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(b["text"].as_str().unwrap_or_default());
                    }
                    Some("image") if b["source"]["type"] == "base64" => {
                        images.push(format!(
                            "data:{};base64,{}",
                            b["source"]["media_type"].as_str().unwrap_or("image/png"),
                            b["source"]["data"].as_str().unwrap_or_default()
                        ));
                    }
                    _ => {}
                }
            }
            if !text.is_empty() || !images.is_empty() {
                out.push(Message {
                    role: "user".into(),
                    content: text,
                    images,
                    audio: Vec::new(),
                    tool_calls: None,
                    tool_call_id: None,
                    reasoning: None,
                });
            }
            for b in &blocks {
                if b["type"] == "tool_result" {
                    let content = match &b["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(parts) => parts
                            .iter()
                            .filter_map(|p| p["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    out.push(Message::tool_result(
                        b["tool_use_id"].as_str().unwrap_or_default(),
                        content,
                    ));
                }
            }
        }
    }
    (system, out)
}

fn to_tool_specs(tools: &[AnthropicTool]) -> Vec<ToolSpec> {
    tools
        .iter()
        .map(|t| ToolSpec {
            name: t.name.clone(),
            description: t.description.clone().unwrap_or_default(),
            parameters: t
                .input_schema
                .clone()
                .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            kind: protocol::api::ToolKind::Generic,
        })
        .collect()
}

fn content_blocks(text: &str, calls: &[ToolCall]) -> Value {
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(json!({"type": "text", "text": text}));
    }
    for c in calls {
        blocks.push(json!({
            "type": "tool_use",
            "id": c.id,
            "name": c.name,
            "input": c.arguments,
        }));
    }
    if blocks.is_empty() {
        blocks.push(json!({"type": "text", "text": ""}));
    }
    Value::Array(blocks)
}

fn anthropic_error(status: StatusCode, e: &ProxyError) -> axum::response::Response {
    (
        status,
        Json(json!({
            "type": "error",
            "error": {"type": e.anthropic_type(), "message": e.0.message},
        })),
    )
        .into_response()
}

async fn messages(
    State(state): State<AppState>,
    key: AnthropicKey,
    Json(req): Json<AnthropicRequest>,
) -> Result<axum::response::Response, axum::response::Response> {
    let org_id = key.0.org_id;
    let user_id = key.0.user_id.unwrap_or(key.0.created_by);
    let session_id = key.0.id;

    let (system, internal) = to_internal(&req);
    let tools = req.tools.as_ref().map(|t| to_tool_specs(t));

    let call = dispatch(
        &state,
        org_id,
        &req.model,
        system,
        internal,
        tools,
        req.max_tokens,
    )
    .await
    .map_err(|e| anthropic_error(e.status(), &e))?;

    let usage = call.usage.clone();
    let model = call.model.clone();
    let provider = call.provider.clone();
    let (price_in, price_out) = (call.price_in, call.price_out);

    if req.stream {
        let out = stream_events(call, org_id, user_id, session_id);
        Ok(Sse::new(out)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let (text, calls, tokens_in, tokens_out) = accumulate(call.stream).await.map_err(|e| {
            anthropic_error(
                StatusCode::BAD_GATEWAY,
                &ProxyError(ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "provider_error",
                    e.to_string(),
                )),
            )
        })?;
        usage
            .record(usage_event(
                org_id, user_id, session_id, &model, &provider, price_in, price_out, tokens_in,
                tokens_out,
            ))
            .await;
        let stop = if calls.is_empty() {
            "end_turn"
        } else {
            "tool_use"
        };
        Ok(Json(json!({
            "id": format!("msg_{}", Uuid::now_v7()),
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content_blocks(&text, &calls),
            "stop_reason": stop,
            "stop_sequence": null,
            "usage": {"input_tokens": tokens_in, "output_tokens": tokens_out},
        }))
        .into_response())
    }
}

type SseItem = Result<SseEvent, Infallible>;

/// ProviderChunk stream → Anthropic SSE event sequence. Blocks open/close
/// exactly once; text, thinking and tool_use alternate freely (mirrors the
/// llm/gateway proxy's `createAnthropicStream`, fed by internal chunks
/// instead of OpenAI SSE).
fn stream_events(
    call: crate::http::llm_proxy::RoutedCall,
    org_id: uuid::Uuid,
    user_id: uuid::Uuid,
    session_id: uuid::Uuid,
) -> impl Stream<Item = SseItem> + Send {
    async_stream::stream! {
        let msg_id = format!("msg_{}", Uuid::now_v7());
        let model = call.model.clone();
        let send = |event: &str, data: &Value| -> SseItem {
            Ok(SseEvent::default()
                .event(event)
                .data(data.to_string()))
        };
        // Created before the first yield: a drop at any suspension point —
        // including the very first frame — records the running counts.
        let guard = crate::http::llm_proxy::StreamUsageGuard::new(
            call.usage.clone(),
            org_id,
            user_id,
            session_id,
            call.model.clone(),
            call.provider.clone(),
            call.price_in,
            call.price_out,
        );
        let counters = guard.counters();

        yield send(
            "message_start",
            &json!({
                "type": "message_start",
                "message": {
                    "id": msg_id, "type": "message", "role": "assistant", "model": model,
                    "content": [], "stop_reason": null, "stop_sequence": null,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                },
            }),
        );

        let mut next_block: i64 = -1;
        let mut current_block: Option<i64> = None;
        let mut current_type: Option<&'static str> = None;
        let mut tool_blocks: std::collections::HashMap<u32, i64> = std::collections::HashMap::new();
        let mut pending_stops: Vec<i64> = Vec::new();
        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;

        macro_rules! close_current {
            () => {
                if let Some(idx) = current_block.take() {
                    pending_stops.retain(|&i| i != idx);
                    yield send("content_block_stop", &json!({
                        "type": "content_block_stop", "index": idx,
                    }));
                }
            };
        }
        macro_rules! open_block {
            ($content_block:expr, $ty:expr) => {{
                close_current!();
                next_block += 1;
                let idx = next_block;
                yield send("content_block_start", &json!({
                    "type": "content_block_start", "index": idx,
                    "content_block": $content_block,
                }));
                pending_stops.push(idx);
                current_block = Some(idx);
                current_type = Some($ty);
                idx
            }};
        }

        let mut pinned = Box::pin(call.stream);
        while let Some(item) = pinned.next().await {
            match item {
                Ok(ProviderChunk::Text(t)) => {
                    if !t.text_delta.is_empty() {
                        if current_type != Some("text") {
                            open_block!(json!({"type": "text", "text": ""}), "text");
                        }
                        yield send("content_block_delta", &json!({
                            "type": "content_block_delta", "index": current_block.unwrap(),
                            "delta": {"type": "text_delta", "text": t.text_delta},
                        }));
                    }
                    if let Some(n) = t.tokens_in { tokens_in = n; }
                    if let Some(n) = t.tokens_out { tokens_out = n; }
                    counters.set(t.tokens_in, t.tokens_out);
                }
                Ok(ProviderChunk::Thinking(t)) => {
                    if !t.text_delta.is_empty() {
                        if current_type != Some("thinking") {
                            open_block!(json!({"type": "thinking", "thinking": ""}), "thinking");
                        }
                        yield send("content_block_delta", &json!({
                            "type": "content_block_delta", "index": current_block.unwrap(),
                            "delta": {"type": "thinking_delta", "thinking": t.text_delta},
                        }));
                    }
                }
                Ok(ProviderChunk::ToolCallDelta { index, id, name, arguments_delta }) => {
                    let block = match tool_blocks.get(&index) {
                        Some(&b) => b,
                        None => {
                            let b = open_block!(
                                json!({
                                    "type": "tool_use",
                                    "id": id.clone().unwrap_or_else(|| format!("toolu_{}", Uuid::now_v7())),
                                    "name": name.clone().unwrap_or_default(),
                                    "input": {},
                                }),
                                "tool_use"
                            );
                            tool_blocks.insert(index, b);
                            b
                        }
                    };
                    if !arguments_delta.is_empty() {
                        yield send("content_block_delta", &json!({
                            "type": "content_block_delta", "index": block,
                            "delta": {"type": "input_json_delta", "partial_json": arguments_delta},
                        }));
                    }
                }
                Ok(ProviderChunk::ToolCallDone { call: tc }) => {
                    // A call whose fragments never streamed (folded at the
                    // adapter layer): emit the whole tool block at once and
                    // close it. When fragments did stream, the block is
                    // already open and the Done frame adds nothing.
                    if tool_blocks.is_empty() {
                        let b = open_block!(
                            json!({
                                "type": "tool_use",
                                "id": tc.id,
                                "name": tc.name,
                                "input": {},
                            }),
                            "tool_use"
                        );
                        yield send("content_block_delta", &json!({
                            "type": "content_block_delta", "index": b,
                            "delta": {"type": "input_json_delta",
                                "partial_json": serde_json::to_string(&tc.arguments).unwrap_or_default()},
                        }));
                        close_current!();
                    }
                }
                Err(e) => {
                    yield send("error", &json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": e.to_string()},
                    }));
                    return;
                }
            }
        }

        close_current!();
        for idx in pending_stops.iter() {
            yield send("content_block_stop", &json!({
                "type": "content_block_stop", "index": idx,
            }));
        }
        let stop_reason = if tool_blocks.is_empty() { "end_turn" } else { "tool_use" };
        yield send("message_delta", &json!({
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": null},
            "usage": {"output_tokens": tokens_out, "input_tokens": tokens_in},
        }));
        yield send("message_stop", &json!({"type": "message_stop"}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> AnthropicRequest {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn system_string_and_blocks_land_as_system() {
        let (system, msgs) = to_internal(&parse(json!({
            "model": "m",
            "system": "be terse",
            "messages": [{"role": "user", "content": "hi"}],
        })));
        assert_eq!(system.as_deref(), Some("be terse"));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "hi");

        let (system, _) = to_internal(&parse(json!({
            "model": "m",
            "system": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}],
            "messages": [{"role": "user", "content": "hi"}],
        })));
        assert_eq!(system.as_deref(), Some("a\nb"));
    }

    #[test]
    fn user_blocks_split_into_text_images_and_tool_results() {
        let (_, msgs) = to_internal(&parse(json!({
            "model": "m",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image", "source": {"type": "base64",
                        "media_type": "image/png", "data": "AAAA"}},
                    {"type": "tool_result", "tool_use_id": "call_x",
                     "content": [{"type": "text", "text": "snow"}]}
                ]}
            ],
        })));
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "look");
        assert_eq!(msgs[0].images, vec!["data:image/png;base64,AAAA"]);
        assert_eq!(msgs[1].role, "tool");
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("call_x"));
        assert_eq!(msgs[1].content, "snow");
    }

    #[test]
    fn assistant_tool_use_becomes_tool_calls() {
        let (_, msgs) = to_internal(&parse(json!({
            "model": "m",
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "text", "text": "checking"},
                    {"type": "tool_use", "id": "call_x", "name": "get_weather",
                     "input": {"city": "oslo"}}
                ]}
            ],
        })));
        assert_eq!(msgs.len(), 1);
        let calls = msgs[0].tool_calls.as_ref().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_x");
        assert_eq!(calls[0].name, "get_weather");
        assert_eq!(calls[0].arguments, json!({"city": "oslo"}));
        assert_eq!(msgs[0].content, "checking");
    }

    #[test]
    fn anthropic_tools_map_to_internal_specs() {
        let req = parse(json!({
            "model": "m",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{"name": "get_weather", "description": "w",
                       "input_schema": {"type": "object", "properties": {}}}],
        }));
        let specs = to_tool_specs(req.tools.as_ref().unwrap());
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "get_weather");
        assert_eq!(specs[0].description, "w");
        assert_eq!(specs[0].parameters["type"], "object");
    }
}
