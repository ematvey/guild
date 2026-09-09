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
            let mut mv = serde_json::json!({"role": m.role, "content": m.content});
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

    fn parse_frame(data: &str) -> Option<ChatChunk> {
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
        if chunk.text_delta.is_empty() && chunk.tokens_in.is_none() && chunk.tokens_out.is_none() {
            None
        } else {
            Some(chunk)
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
                    yield Ok(ProviderChunk::Text(chunk));
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
        let c =
            OpenAiProvider::parse_frame(r#"{"choices":[{"delta":{"content":"Hel"}}]}"#).unwrap();
        assert_eq!(c.text_delta, "Hel");
    }

    #[test]
    fn parse_usage_frame() {
        let c = OpenAiProvider::parse_frame(
            r#"{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
        )
        .unwrap();
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
                tool_calls: Some(vec![ToolCall {
                    id: "c1".into(),
                    name: "read_file".into(),
                    arguments: serde_json::json!({"path": "a"}),
                }]),
                tool_call_id: None,
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
}
