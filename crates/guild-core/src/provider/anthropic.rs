//! Anthropic-shaped wire protocol: `POST {base}/v1/messages` with
//! `x-api-key` + `anthropic-version` headers and `stream: true`.

use super::{ChatChunk, ModelProvider, ProviderError, ProviderRequest};
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::stream::BoxStream;
use futures::StreamExt;
use protocol::api::Message;

/// Anthropic requires an explicit cap on every request.
const DEFAULT_MAX_TOKENS: u32 = 4096;

pub struct AnthropicProvider;

impl AnthropicProvider {
    pub fn new() -> Self {
        Self
    }

    fn body(req: &ProviderRequest<'_>) -> serde_json::Value {
        let messages: Vec<serde_json::Value> = req
            .messages
            .iter()
            .map(|m: &Message| serde_json::json!({"role": m.role, "content": m.content}))
            .collect();
        let mut body = serde_json::json!({
            "model": req.model,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "messages": messages,
            "stream": true,
        });
        if let Some(system) = req.system {
            body["system"] = serde_json::Value::String(system.to_string());
        }
        body
    }

    /// Parses one SSE data frame into zero or one chunk.
    fn parse_frame(data: &str) -> Option<ChatChunk> {
        let v: serde_json::Value = serde_json::from_str(data.trim()).ok()?;
        let mut chunk = ChatChunk::default();
        match v["type"].as_str()? {
            "message_start" => {
                chunk.tokens_in = v["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .map(|n| n as u32);
            }
            "content_block_delta" => {
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

#[async_trait]
impl ModelProvider for AnthropicProvider {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    async fn chat_stream(
        &self,
        req: ProviderRequest<'_>,
    ) -> Result<BoxStream<'static, Result<ChatChunk, ProviderError>>, ProviderError> {
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
        let stream = resp
            .bytes_stream()
            .eventsource()
            .filter_map(|ev| async move {
                match ev {
                    Ok(ev) => Self::parse_frame(&ev.data).map(Ok),
                    Err(e) => Some(Err(ProviderError::Stream(e.to_string()))),
                }
            })
            .boxed();
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
