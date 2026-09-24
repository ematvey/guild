//! Anthropic-shaped wire protocol: `POST {base}/v1/messages` with
//! `x-api-key` + `anthropic-version` headers and `stream: true`.

use super::{ChatChunk, ModelProvider, ProviderChunk, ProviderError, ProviderRequest};
use async_stream::stream;
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::stream::BoxStream;
use futures::StreamExt;
use protocol::api::{ToolCall, ToolSpec};

/// Anthropic requires an explicit cap on every request.
const DEFAULT_MAX_TOKENS: u32 = 4096;

pub struct AnthropicProvider;

/// Splits `data:<media_type>;base64,<data>` into (media_type, data).
fn parse_data_uri(uri: &str) -> Option<(&str, &str)> {
    let rest = uri.strip_prefix("data:")?;
    let semi = rest.find(";base64,")?;
    let media_type = &rest[..semi];
    let data = &rest[semi + ";base64,".len()..];
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((media_type, data))
}

impl AnthropicProvider {
    pub fn new() -> Self {
        Self
    }

    fn body(req: &ProviderRequest<'_>) -> serde_json::Value {
        // Anthropic conversation shape: assistant tool_use blocks and tool
        // results as user "tool_result" blocks.
        let mut messages: Vec<serde_json::Value> = Vec::new();
        for m in req.messages {
            if m.role == "tool" {
                // Anthropic tool_result: plain string when text-only; image
                // parts ride as content blocks (text + base64 images).
                let content: serde_json::Value = if m.images.is_empty() {
                    serde_json::Value::String(m.content.clone())
                } else {
                    let mut blocks: Vec<serde_json::Value> = Vec::new();
                    if !m.content.is_empty() {
                        blocks.push(serde_json::json!({"type": "text", "text": m.content}));
                    }
                    for uri in &m.images {
                        if let Some((media_type, data)) = parse_data_uri(uri) {
                            blocks.push(serde_json::json!({
                                "type": "image",
                                "source": {"type": "base64", "media_type": media_type, "data": data},
                            }));
                        }
                    }
                    serde_json::Value::Array(blocks)
                };
                let result = serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": content,
                });
                if let Some(last) = messages.last_mut() {
                    if last["role"] == "user" && last["content"].is_array() {
                        last["content"].as_array_mut().unwrap().push(result);
                        continue;
                    }
                }
                messages.push(serde_json::json!({"role": "user", "content": [result]}));
                continue;
            }
            if m.role == "assistant" {
                // Reasoning replay: Anthropic requires thinking blocks to be
                // echoed back with their original signature; replaying them
                // as plain text is wrong, so reasoning is deliberately left
                // unreplayed for anthropic routes (kept in the thread log,
                // never dropped there) — see design §B.1.
                let Some(calls) = &m.tool_calls else {
                    // An empty completion or an interrupted reasoning-only
                    // turn persists no content; Anthropic rejects empty
                    // assistant content.
                    if m.content.trim().is_empty() {
                        continue;
                    }
                    messages.push(serde_json::json!({"role": m.role, "content": m.content}));
                    continue;
                };
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !m.content.trim().is_empty() {
                    blocks.push(serde_json::json!({"type": "text", "text": m.content}));
                }
                for c in calls {
                    // A tool_use block truncated by max_tokens persists
                    // partial JSON (a non-object value); the wire requires
                    // an object, so anything else goes as an empty input.
                    let input = if c.arguments.is_object() {
                        c.arguments.clone()
                    } else {
                        serde_json::json!({})
                    };
                    blocks.push(serde_json::json!({
                        "type": "tool_use", "id": c.id, "name": c.name, "input": input,
                    }));
                }
                messages.push(serde_json::json!({"role": "assistant", "content": blocks}));
                continue;
            }
            // Multimodal user turns: image blocks (base64 source parsed
            // from the data URI); Anthropic has no audio input — audio
            // parts are skipped on this route shape.
            if m.has_media() {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !m.content.trim().is_empty() {
                    blocks.push(serde_json::json!({"type": "text", "text": m.content}));
                }
                for uri in &m.images {
                    if let Some((media_type, data)) = parse_data_uri(uri) {
                        blocks.push(serde_json::json!({
                            "type": "image",
                            "source": {"type": "base64", "media_type": media_type, "data": data},
                        }));
                    }
                }
                messages.push(serde_json::json!({"role": m.role, "content": blocks}));
                continue;
            }
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
        let mut body = serde_json::json!({
            "model": req.model,
            "max_tokens": if req.max_tokens > 0 {
                req.max_tokens
            } else {
                DEFAULT_MAX_TOKENS
            },
            "messages": messages,
            "stream": true,
        });
        if let Some(system) = req.system {
            body["system"] = serde_json::Value::String(system.to_string());
        }
        if let Some(tools) = req.tools {
            body["tools"] = serde_json::Value::Array(
                tools
                    .iter()
                    .map(|t: &ToolSpec| {
                        serde_json::json!({
                            "name": t.name, "description": t.description, "input_schema": t.parameters,
                        })
                    })
                    .collect(),
            );
        }
        body
    }

    /// Parses one SSE data frame into a text or thinking chunk (tool assembly
    /// happens in the stream loop below).
    fn parse_frame(data: &str) -> Option<ProviderChunk> {
        let v: serde_json::Value = serde_json::from_str(data.trim()).ok()?;
        let mut chunk = ChatChunk::default();
        match v["type"].as_str()? {
            "message_start" => {
                chunk.tokens_in = v["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .map(|n| n as u32);
            }
            "content_block_delta" if v["delta"]["type"].as_str() == Some("thinking_delta") => {
                chunk.text_delta = v["delta"]["thinking"].as_str().unwrap_or("").to_string();
            }
            "content_block_delta" if v["delta"]["type"].as_str() == Some("text_delta") => {
                chunk.text_delta = v["delta"]["text"].as_str().unwrap_or("").to_string();
            }
            "message_delta" => {
                chunk.tokens_out = v["usage"]["output_tokens"].as_u64().map(|n| n as u32);
            }
            _ => return None,
        }
        if chunk.text_delta.is_empty() && chunk.tokens_in.is_none() && chunk.tokens_out.is_none() {
            None
        } else if v["type"].as_str() == Some("content_block_delta")
            && v["delta"]["type"].as_str() == Some("thinking_delta")
        {
            Some(ProviderChunk::Thinking(chunk))
        } else {
            Some(ProviderChunk::Text(chunk))
        }
    }
}

impl Default for AnthropicProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

#[async_trait]
impl ModelProvider for AnthropicProvider {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    async fn chat_stream(
        &self,
        req: ProviderRequest<'_>,
    ) -> Result<BoxStream<'static, Result<ProviderChunk, ProviderError>>, ProviderError> {
        let url = format!("{}/v1/messages", req.base_url.trim_end_matches('/'));
        // Every phase bounded: TCP connect (15 s), response headers (60 s),
        // per-read idle (120 s — applies to the streamed body too). Without
        // these a provider that accepts the connection and then stalls pins
        // the caller's turn forever: the consumption loop can only observe
        // cancellation once it holds a stream, and nothing else watches.
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(15))
                .read_timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| ProviderError::Stream(e.to_string()))?
                .post(&url)
                .header("x-api-key", req.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&Self::body(&req))
                .send(),
        )
        .await
        .map_err(|_| ProviderError::Stream("provider did not respond within 60s".into()))?
        .map_err(|e| ProviderError::Stream(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::from_status(status.as_u16(), body));
        }
        let stream = stream! {
            // per-block partial tool calls, keyed by block index
            let mut partials: std::collections::BTreeMap<u32, PartialCall> = Default::default();
            let mut completed = false;
            let mut events = resp.bytes_stream().eventsource();
            while let Some(ev) = events.next().await {
                let ev = match ev {
                    Ok(ev) => ev,
                    Err(e) => {
                        yield Err(ProviderError::Stream(e.to_string()));
                        return;
                    }
                };
                let data = ev.data.trim().to_string();
                if data.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                    continue;
                };
                if v["type"].as_str() == Some("error") {
                    // Mid-stream error frame (overloaded, rate limit, ...):
                    // surface it instead of silently ending the turn.
                    let etype = v["error"]["type"].as_str().unwrap_or("error");
                    let msg = v["error"]["message"]
                        .as_str()
                        .unwrap_or("upstream error");
                    yield Err(ProviderError::Upstream(format!("{etype}: {msg}")));
                    return;
                }
                if v["type"].as_str() == Some("message_stop") {
                    completed = true;
                    break;
                }
                if let Some(chunk) = Self::parse_frame(&data) {
                    yield Ok(chunk);
                }
                let ty = v["type"].as_str().unwrap_or("");
                let idx = v["index"].as_u64().unwrap_or(0) as u32;
                match ty {
                    "content_block_start" if v["content_block"]["type"] == "tool_use" => {
                        let id = v["content_block"]["id"].as_str().unwrap_or("").to_string();
                        let name = v["content_block"]["name"].as_str().unwrap_or("").to_string();
                        partials.insert(idx, PartialCall { id: id.clone(), name: name.clone(), arguments: String::new() });
                        yield Ok(ProviderChunk::ToolCallDelta {
                            index: idx,
                            id: Some(id),
                            name: Some(name),
                            arguments_delta: String::new(),
                        });
                    }
                    "content_block_delta" if v["delta"]["type"].as_str() == Some("input_json_delta") => {
                        let delta = v["delta"]["partial_json"].as_str().unwrap_or("").to_string();
                        if let Some(p) = partials.get_mut(&idx) {
                            p.arguments.push_str(&delta);
                        }
                        yield Ok(ProviderChunk::ToolCallDelta {
                            index: idx,
                            id: None,
                            name: None,
                            arguments_delta: delta,
                        });
                    }
                    "content_block_stop" => {
                        if let Some(p) = partials.remove(&idx) {
                            let arguments = if p.arguments.trim().is_empty() {
                                serde_json::Value::Object(serde_json::Map::new())
                            } else {
                                serde_json::from_str(&p.arguments)
                                    .unwrap_or(serde_json::Value::String(p.arguments.clone()))
                            };
                            yield Ok(ProviderChunk::ToolCallDone {
                                call: ToolCall { id: p.id, name: p.name, arguments },
                            });
                        }
                    }
                    _ => {}
                }
            }
            if !completed {
                yield Err(ProviderError::Stream("provider stream ended before message_stop".into()));
            }
        };
        Ok(stream.boxed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::api::Message;

    #[test]
    fn parse_delta_frame() {
        let c = AnthropicProvider::parse_frame(
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}"#,
        )
        .unwrap();
        let ProviderChunk::Text(c) = c else {
            panic!("expected text chunk");
        };
        assert_eq!(c.text_delta, "Hel");
    }

    #[test]
    fn parse_thinking_delta_frame() {
        let c = AnthropicProvider::parse_frame(
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"pondering"}}"#,
        )
        .unwrap();
        let ProviderChunk::Thinking(c) = c else {
            panic!("expected thinking chunk");
        };
        assert_eq!(c.text_delta, "pondering");
        // empty thinking deltas are skipped
        assert!(AnthropicProvider::parse_frame(
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":""}}"#
        )
        .is_none());
    }

    #[test]
    fn parse_message_start_and_delta() {
        let c = AnthropicProvider::parse_frame(
            r#"{"type":"message_start","message":{"usage":{"input_tokens":4}}}"#,
        )
        .unwrap();
        let ProviderChunk::Text(c) = c else {
            panic!("expected text chunk");
        };
        assert_eq!(c.tokens_in, Some(4));
        let c = AnthropicProvider::parse_frame(
            r#"{"type":"message_delta","usage":{"output_tokens":7}}"#,
        )
        .unwrap();
        let ProviderChunk::Text(c) = c else {
            panic!("expected text chunk");
        };
        assert_eq!(c.tokens_out, Some(7));
    }

    #[test]
    fn body_maps_tool_messages_to_anthropic_shape() {
        let msgs = vec![
            Message::user("hi"),
            Message {
                role: "assistant".into(),
                content: " \n\t".into(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: Some(vec![ToolCall {
                    id: "c1".into(),
                    name: "read_file".into(),
                    arguments: serde_json::json!({"path": "a"}),
                }]),
                tool_call_id: None,
                reasoning: None,
            },
            Message::tool_result("c1", "contents"),
        ];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: None,
            max_tokens: 0,
        };
        let body = AnthropicProvider::body(&req);
        let blocks = &body["messages"][1]["content"];
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["id"], "c1");
        let result = &body["messages"][2]["content"][0];
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["tool_use_id"], "c1");
        assert_eq!(result["content"], "contents");
    }

    #[test]
    fn tool_result_images_become_content_blocks() {
        let msgs = vec![Message::tool_result("c1", "[image attached]")
            .with_images(vec!["data:image/png;base64,QUJD".into()])];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: None,
            max_tokens: 0,
        };
        let body = AnthropicProvider::body(&req);
        let result = &body["messages"][0]["content"][0];
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["content"][0]["type"], "text");
        let image = &result["content"][1];
        assert_eq!(image["type"], "image");
        assert_eq!(image["source"]["media_type"], "image/png");
        assert_eq!(image["source"]["data"], "QUJD");
    }

    #[test]
    fn non_object_tool_use_input_goes_as_empty_object() {
        let msgs = vec![
            Message::user("hi"),
            Message {
                role: "assistant".into(),
                content: String::new(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: Some(vec![ToolCall {
                    id: "c1".into(),
                    name: "f".into(),
                    arguments: serde_json::Value::String(r#"{"path":"#.into()),
                }]),
                tool_call_id: None,
                reasoning: None,
            },
            Message::tool_result("c1", "ok"),
        ];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: None,
            max_tokens: 0,
        };
        let body = AnthropicProvider::body(&req);
        let block = &body["messages"][1]["content"][0];
        assert_eq!(block["type"], "tool_use");
        assert_eq!(block["input"], serde_json::json!({}));
    }

    #[test]
    fn whitespace_assistant_turns_are_skipped() {
        let msgs = vec![
            Message::user("hi"),
            Message {
                role: "assistant".into(),
                content: " \n\t".into(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: Some("interrupted".into()),
            },
            Message::user("again"),
        ];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: None,
            max_tokens: 0,
        };
        let body = AnthropicProvider::body(&req);
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "again");
    }
}
