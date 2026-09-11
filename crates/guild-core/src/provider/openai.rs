//! OpenAI-shaped wire protocol: `POST {base}/v1/chat/completions` with
//! `stream: true`. Covers OpenAI and every OpenAI-compatible provider.

use super::{ChatChunk, ModelProvider, ProviderChunk, ProviderError, ProviderRequest};
use async_stream::stream;
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::stream::BoxStream;
use futures::StreamExt;
use protocol::api::{ToolCall, ToolSpec};

pub struct OpenAiProvider;

impl OpenAiProvider {
    pub fn new() -> Self {
        Self
    }

    fn body(req: &ProviderRequest<'_>) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();
        if let Some(system) = req.system {
            messages.push(serde_json::json!({"role": "system", "content": system}));
        }
        for m in req.messages {
            // Multimodal user turns: text plus image/audio content parts
            // (OpenAI contract: image_url with data URIs, input_audio with
            // base64+format). Text-only messages keep the plain string form.
            let content: serde_json::Value = if m.has_media() {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(serde_json::json!({"type": "text", "text": m.content}));
                }
                for uri in &m.images {
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": {"url": uri},
                    }));
                }
                for a in &m.audio {
                    parts.push(serde_json::json!({
                        "type": "input_audio",
                        "input_audio": {"data": a.data, "format": a.format},
                    }));
                }
                serde_json::Value::Array(parts)
            } else {
                serde_json::Value::String(m.content.clone())
            };
            let mut mv = serde_json::json!({"role": m.role, "content": content});
            if let Some(calls) = &m.tool_calls {
                mv["tool_calls"] = serde_json::Value::Array(
                    calls
                        .iter()
                        .map(|c: &ToolCall| {
                            serde_json::json!({
                                "id": c.id, "type": "function",
                                "function": {"name": c.name, "arguments": c.arguments.to_string()},
                            })
                        })
                        .collect(),
                );
            }
            if let Some(cid) = &m.tool_call_id {
                mv["tool_call_id"] = serde_json::Value::String(cid.clone());
            }
            // dsh rule: reasoning is resent on EVERY reasoning-carrying turn,
            // never dropped from context (design §B.1).
            if let Some(reasoning) = m.reasoning.as_deref().filter(|r| !r.is_empty()) {
                mv["reasoning_content"] = serde_json::Value::String(reasoning.to_string());
            }
            messages.push(mv);
        }
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if let Some(tools) = req.tools {
            body["tools"] = serde_json::Value::Array(
                tools
                    .iter()
                    .map(|t: &ToolSpec| {
                        serde_json::json!({
                            "type": "function",
                            "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
                        })
                    })
                    .collect(),
            );
        }
        body
    }

    /// Parses one SSE data frame into a text or thinking chunk (tool
    /// assembly happens in the stream loop below). Empty deltas are skipped.
    fn parse_frame(data: &str) -> Option<ProviderChunk> {
        let v: serde_json::Value = serde_json::from_str(data).ok()?;
        let mut chunk = ChatChunk::default();
        if let Some(choice) = v["choices"].get(0) {
            chunk.text_delta = choice["delta"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
        }
        if let Some(usage) = v.get("usage") {
            chunk.tokens_in = usage["prompt_tokens"].as_u64().map(|n| n as u32);
            chunk.tokens_out = usage["completion_tokens"].as_u64().map(|n| n as u32);
        }
        // DeepSeek-style chain-of-thought arrives in its own frames under
        // `delta.reasoning_content`; a frame carrying reasoning is yielded as
        // a Thinking chunk (design §B.1).
        if let Some(choice) = v["choices"].get(0) {
            if let Some(reasoning) = choice["delta"]["reasoning_content"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                let think = ChatChunk {
                    text_delta: reasoning.to_string(),
                    tokens_in: chunk.tokens_in,
                    tokens_out: chunk.tokens_out,
                };
                return Some(ProviderChunk::Thinking(think));
            }
        }
        if chunk.text_delta.is_empty() && chunk.tokens_in.is_none() && chunk.tokens_out.is_none() {
            None
        } else {
            Some(ProviderChunk::Text(chunk))
        }
    }
}

impl Default for OpenAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Accumulated partial tool calls from the stream.
#[derive(Clone, Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

#[async_trait]
impl ModelProvider for OpenAiProvider {
    fn name(&self) -> &'static str {
        "openai"
    }

    async fn chat_stream(
        &self,
        req: ProviderRequest<'_>,
    ) -> Result<BoxStream<'static, Result<ProviderChunk, ProviderError>>, ProviderError> {
        let url = format!("{}/v1/chat/completions", req.base_url.trim_end_matches('/'));
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth(req.api_key)
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
            let mut partials: Vec<PartialCall> = Vec::new();
            let mut finish_tool_calls = false;
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
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                    continue;
                };
                if let Some(chunk) = Self::parse_frame(&data) {
                    yield Ok(chunk);
                }
                let choice = &v["choices"][0];
                if let Some(tcs) = choice["delta"]["tool_calls"].as_array() {
                    for tc in tcs {
                        let idx = tc["index"].as_u64().unwrap_or(0) as u32;
                        while partials.len() <= idx as usize {
                            partials.push(PartialCall::default());
                        }
                        let p = &mut partials[idx as usize];
                        if let Some(id) = tc["id"].as_str() {
                            p.id = id.to_string();
                        }
                        if let Some(name) = tc["function"]["name"].as_str() {
                            p.name = name.to_string();
                        }
                        if let Some(args) = tc["function"]["arguments"].as_str() {
                            p.arguments.push_str(args);
                        }
                        yield Ok(ProviderChunk::ToolCallDelta {
                            index: idx,
                            id: tc["id"].as_str().map(String::from),
                            name: tc["function"]["name"].as_str().map(String::from),
                            arguments_delta: tc["function"]["arguments"].as_str().unwrap_or("").to_string(),
                        });
                    }
                }
                if choice["finish_reason"].as_str() == Some("tool_calls") {
                    finish_tool_calls = true;
                }
            }
            if finish_tool_calls {
                for (idx, p) in partials.into_iter().enumerate() {
                    let arguments = if p.arguments.trim().is_empty() {
                        serde_json::Value::Object(serde_json::Map::new())
                    } else {
                        serde_json::from_str(&p.arguments)
                            .unwrap_or(serde_json::Value::String(p.arguments.clone()))
                    };
                    yield Ok(ProviderChunk::ToolCallDone {
                        call: ToolCall { id: p.id, name: p.name, arguments },
                    });
                    let _ = idx;
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
        let c = OpenAiProvider::parse_frame(r#"{"choices":[{"delta":{"content":"Hel"}}]}"#)
            .unwrap();
        let ProviderChunk::Text(c) = c else {
            panic!("expected text chunk");
        };
        assert_eq!(c.text_delta, "Hel");
    }

    #[test]
    fn parse_thinking_delta_frame() {
        let c = OpenAiProvider::parse_frame(
            r#"{"choices":[{"delta":{"reasoning_content":"let me think"}}]}"#,
        )
        .unwrap();
        let ProviderChunk::Thinking(c) = c else {
            panic!("expected thinking chunk");
        };
        assert_eq!(c.text_delta, "let me think");
        assert!(c.tokens_in.is_none() && c.tokens_out.is_none());
    }

    #[test]
    fn empty_reasoning_delta_is_skipped() {
        assert!(OpenAiProvider::parse_frame(
            r#"{"choices":[{"delta":{"reasoning_content":""}}]}"#
        )
        .is_none());
    }

    #[test]
    fn parse_usage_frame() {
        let c = OpenAiProvider::parse_frame(
            r#"{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
        )
        .unwrap();
        let ProviderChunk::Text(c) = c else {
            panic!("expected text chunk");
        };
        assert!(c.text_delta.is_empty());
        assert_eq!(c.tokens_in, Some(3));
        assert_eq!(c.tokens_out, Some(2));
    }

    #[test]
    fn done_frame_is_none() {
        assert!(OpenAiProvider::parse_frame("[DONE]").is_none());
    }

    #[test]
    fn body_includes_tools_and_tool_messages() {
        let msgs = vec![
            Message::user("hi"),
            Message {
                role: "assistant".into(),
                content: String::new(),
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
        let tools = vec![ToolSpec {
            name: "read_file".into(),
            description: "read".into(),
            parameters: serde_json::json!({"type": "object"}),
        }];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: Some(&tools),
        };
        let body = OpenAiProvider::body(&req);
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        let tc = &body["messages"][1]["tool_calls"][0];
        assert_eq!(tc["id"], "c1");
        assert_eq!(tc["function"]["arguments"], r#"{"path":"a"}"#);
        assert_eq!(body["messages"][2]["tool_call_id"], "c1");
    }

    #[test]
    fn body_serializes_assistant_reasoning_as_reasoning_content() {
        let msgs = vec![
            Message::user("hi"),
            Message {
                role: "assistant".into(),
                content: "answer".into(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: Some("chain of thought".into()),
            },
        ];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: None,
        };
        let body = OpenAiProvider::body(&req);
        assert_eq!(body["messages"][1]["reasoning_content"], "chain of thought");
        assert_eq!(body["messages"][1]["content"], "answer");
        // user messages never carry the field
        assert!(body["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn empty_reasoning_is_omitted() {
        let msgs = vec![Message {
            role: "assistant".into(),
            content: String::new(),
            images: Vec::new(),
            audio: Vec::new(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: Some(String::new()),
        }];
        let req = ProviderRequest {
            model: "m",
            system: None,
            messages: &msgs,
            api_key: "k",
            base_url: "http://x",
            tools: None,
        };
        let body = OpenAiProvider::body(&req);
        assert!(body["messages"][0].get("reasoning_content").is_none());
    }
}
