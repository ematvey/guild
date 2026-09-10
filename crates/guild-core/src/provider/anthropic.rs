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
                let result = serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.content,
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
                let Some(calls) = &m.tool_calls else {
                    messages.push(serde_json::json!({"role": m.role, "content": m.content}));
                    continue;
                };
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(serde_json::json!({"type": "text", "text": m.content}));
                }
                for c in calls {
                    blocks.push(serde_json::json!({
                        "type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments,
                    }));
                }
                messages.push(serde_json::json!({"role": "assistant", "content": blocks}));
                continue;
            }
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
        let mut body = serde_json::json!({
            "model": req.model,
            "max_tokens": DEFAULT_MAX_TOKENS,
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

    /// Parses one SSE data frame into zero or one text chunk (tool assembly
    /// happens in the stream loop below).
    fn parse_frame(data: &str) -> Option<ChatChunk> {
        let v: serde_json::Value = serde_json::from_str(data.trim()).ok()?;
        let mut chunk = ChatChunk::default();
        match v["type"].as_str()? {
            "message_start" => {
                chunk.tokens_in = v["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .map(|n| n as u32);
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
        } else {
            Some(chunk)
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
        let resp = reqwest::Client::new()
            .post(&url)
            .header("x-api-key", req.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&Self::body(&req))
            .send()
            .await
            .map_err(|e| ProviderError::Stream(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::from_status(status.as_u16(), body));
        }
        let stream = stream! {
            // per-block partial tool calls, keyed by block index
            let mut partials: std::collections::BTreeMap<u32, PartialCall> = Default::default();
            let mut events = resp.bytes_stream().eventsource();
            while let Some(ev) = events.next().await {
                let ev = match ev {
                    Ok(ev) => ev,
                    Err(e) => {
                        yield Err(ProviderError::Stream(e.to_string()));
                        break;
                    }
                };
                let data = ev.data.trim().to_string();
                if data.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                    continue;
                };
                if let Some(chunk) = Self::parse_frame(&data) {
                    yield Ok(ProviderChunk::Text(chunk));
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
        assert_eq!(c.text_delta, "Hel");
    }

    #[test]
    fn parse_message_start_and_delta() {
        let c = AnthropicProvider::parse_frame(
            r#"{"type":"message_start","message":{"usage":{"input_tokens":4}}}"#,
        )
        .unwrap();
        assert_eq!(c.tokens_in, Some(4));
        let c = AnthropicProvider::parse_frame(
            r#"{"type":"message_delta","usage":{"output_tokens":7}}"#,
        )
        .unwrap();
        assert_eq!(c.tokens_out, Some(7));
    }

    #[test]
    fn body_maps_tool_messages_to_anthropic_shape() {
        let msgs = vec![
            Message::user("hi"),
            Message {
                role: "assistant".into(),
                content: String::new(),
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
        };
        let body = AnthropicProvider::body(&req);
        let blocks = &body["messages"][1]["content"];
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["id"], "c1");
        let result = &body["messages"][2]["content"][0];
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["tool_use_id"], "c1");
    }
}
