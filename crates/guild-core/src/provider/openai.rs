//! OpenAI-shaped wire protocol: `POST {base}/v1/chat/completions` with
//! `stream: true`. Covers OpenAI and every OpenAI-compatible provider.

use super::{ChatChunk, ModelProvider, ProviderError, ProviderRequest};
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::stream::BoxStream;
use futures::StreamExt;

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
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
        serde_json::json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        })
    }

    fn parse_frame(data: &str) -> Option<ChatChunk> {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return None;
        }
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

#[async_trait]
impl ModelProvider for OpenAiProvider {
    fn name(&self) -> &'static str {
        "openai"
    }

    async fn chat_stream(
        &self,
        req: ProviderRequest<'_>,
    ) -> Result<BoxStream<'static, Result<ChatChunk, ProviderError>>, ProviderError> {
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
}
