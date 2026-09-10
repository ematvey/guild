//! Model provider abstraction — every supported provider conforms to either
//! the OpenAI wire shape or the Anthropic wire shape (spec §4.2).

pub mod anthropic;
pub mod openai;

pub use anthropic::AnthropicProvider;
pub use openai::OpenAiProvider;

use async_trait::async_trait;
use futures::stream::BoxStream;
use protocol::api::{Message, ToolCall, ToolSpec};

/// One streamed piece of an assistant turn.
#[derive(Debug, Clone, Default)]
pub struct ChatChunk {
    pub text_delta: String,
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
}

/// Provider-level stream item: text/usage or tool-call assembly.
#[derive(Debug, Clone)]
pub enum ProviderChunk {
    Text(ChatChunk),
    /// Fragment of the model's chain-of-thought reasoning (e.g. DeepSeek's
    /// `reasoning_content`). Accumulates into the assistant turn's reasoning
    /// block; persisted on the thread and replayed to the model — never
    /// dropped from context.
    Thinking(ChatChunk),
    ToolCallDelta {
        index: u32,
        id: Option<String>,
        name: Option<String>,
        arguments_delta: String,
    },
    ToolCallDone {
        call: ToolCall,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider auth failed (check org key)")]
    Auth,
    #[error("provider rate limited")]
    RateLimited,
    #[error("provider error: {0}")]
    Upstream(String),
    #[error("provider stream failed: {0}")]
    Stream(String),
}

impl ProviderError {
    pub fn from_status(status: u16, body: String) -> Self {
        match status {
            401 | 403 => ProviderError::Auth,
            429 => ProviderError::RateLimited,
            _ => ProviderError::Upstream(format!("status {status}: {body}")),
        }
    }
}

pub struct ProviderRequest<'a> {
    pub model: &'a str,
    pub system: Option<&'a str>,
    pub messages: &'a [Message],
    pub api_key: &'a str,
    pub base_url: &'a str,
    /// Declared tools for agentic turns (None = plain chat).
    pub tools: Option<&'a [ToolSpec]>,
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn chat_stream(
        &self,
        req: ProviderRequest<'_>,
    ) -> Result<BoxStream<'static, Result<ProviderChunk, ProviderError>>, ProviderError>;
}
