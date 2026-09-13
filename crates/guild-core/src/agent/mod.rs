//! The agent loop: model → tools → model, approval-gated (spec §3.2).

pub mod policy;

use crate::provider::{ModelProvider, ProviderChunk, ProviderError, ProviderRequest};
use crate::tools::{Approval, ToolFailure, ToolOutcome, ToolRegistry};
use async_trait::async_trait;
use futures::StreamExt;
use policy::ApprovalPolicy;
use protocol::api::{Message, ToolCall, ToolSpec};
use std::path::Path;

#[derive(Clone)]
pub struct AgentConfig {
    /// Hard cap on model turns per `run`.
    pub max_steps: usize,
    pub system_prompt: Option<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_steps: 25,
            system_prompt: None,
        }
    }
}

pub enum ApprovalDecision {
    Approve,
    Deny { reason: String },
}

/// Event sink — the UI-facing surface of the loop.
#[async_trait]
pub trait AgentHooks: Send + Sync {
    async fn on_text(&self, delta: &str);
    /// Chain-of-thought reasoning fragment (may never fire on routes
    /// without reasoning).
    async fn on_reasoning(&self, delta: &str) {
        let _ = delta; // default: ignore
    }
    async fn on_tool_call(&self, call: &ToolCall);
    async fn on_tool_result(&self, call: &ToolCall, outcome: &Result<ToolOutcome, ToolFailure>);
    async fn request_approval(&self, call: &ToolCall) -> ApprovalDecision;
    async fn on_done(&self, summary: &str);
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("model call failed: {0}")]
    Model(#[from] ProviderError),
    #[error("agent stopped after {max} steps without a final answer")]
    MaxSteps { max: usize },
}

/// One model turn: full history in, provider chunk stream out. Implemented
/// over the gateway (client) and directly over providers (tests, server).
#[async_trait]
pub trait ModelTurn: Send + Sync {
    async fn stream_turn(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<
        futures::stream::BoxStream<'static, Result<ProviderChunk, ProviderError>>,
        ProviderError,
    >;
}

/// Adapter: run the loop straight against a ModelProvider (tests, and the
/// server-side runtime later).
pub struct ProviderTurn<'a> {
    pub provider: &'a dyn ModelProvider,
    pub model: &'a str,
    pub system: Option<&'a str>,
    pub base_url: &'a str,
    pub api_key: &'a str,
}

#[async_trait]
impl ModelTurn for ProviderTurn<'_> {
    async fn stream_turn(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<
        futures::stream::BoxStream<'static, Result<ProviderChunk, ProviderError>>,
        ProviderError,
    > {
        self.provider
            .chat_stream(ProviderRequest {
                model: self.model,
                system: self.system,
                messages,
                api_key: self.api_key,
                base_url: self.base_url,
                tools: Some(tools),
                max_tokens: 0,
            })
            .await
    }
}

pub struct AgentResult {
    /// Full replayable history (assistant + tool messages appended).
    pub messages: Vec<Message>,
    pub final_text: String,
    pub steps: usize,
    /// Set when the loop stopped without a final answer.
    pub stopped_at_max_steps: bool,
}

/// Runs the agent loop, appending to `history` in place.
pub async fn run_agent(
    turn: &dyn ModelTurn,
    registry: &ToolRegistry,
    policy: &ApprovalPolicy,
    history: &mut Vec<Message>,
    workdir: &Path,
    hooks: &dyn AgentHooks,
    cfg: &AgentConfig,
) -> Result<AgentResult, AgentError> {
    let specs = registry.specs();
    let mut steps = 0usize;
    loop {
        steps += 1;
        if steps > cfg.max_steps {
            hooks
                .on_done(&format!("stopped after {max} steps", max = cfg.max_steps))
                .await;
            return Ok(AgentResult {
                messages: history.clone(),
                final_text: String::new(),
                steps,
                stopped_at_max_steps: true,
            });
        }
        // one model turn
        let stream = turn.stream_turn(history, &specs).await?;
        let mut text = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();
        let mut pinned = Box::pin(stream);
        while let Some(item) = pinned.next().await {
            match item? {
                ProviderChunk::Text(chunk) => {
                    if !chunk.text_delta.is_empty() {
                        hooks.on_text(&chunk.text_delta).await;
                        text.push_str(&chunk.text_delta);
                    }
                }
                ProviderChunk::ToolCallDone { call } => {
                    hooks.on_tool_call(&call).await;
                    calls.push(call);
                }
                ProviderChunk::ToolCallDelta { .. } => {
                    // fragments are stream-internal; the done event carries
                    // the assembled call
                }
                ProviderChunk::Thinking(chunk) => {
                    if !chunk.text_delta.is_empty() {
                        hooks.on_reasoning(&chunk.text_delta).await;
                    }
                }
            }
        }
        drop(pinned);

        if calls.is_empty() {
            history.push(Message {
                role: "assistant".into(),
                content: text.clone(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: None,
            });
            hooks.on_done(&text).await;
            return Ok(AgentResult {
                messages: history.clone(),
                final_text: text,
                steps,
                stopped_at_max_steps: false,
            });
        }

        history.push(Message {
            role: "assistant".into(),
            content: text,
            images: Vec::new(),
            audio: Vec::new(),
            tool_calls: Some(calls.clone()),
            tool_call_id: None,
            reasoning: None,
        });

        for call in calls {
            let tool_default = registry
                .get(&call.name)
                .map(|t| t.default_policy())
                .unwrap_or(Approval::Ask);
            let decision = match policy.for_tool(&call.name, tool_default) {
                Approval::Allow => ApprovalDecision::Approve,
                Approval::Never => ApprovalDecision::Deny {
                    reason: "disabled by policy".into(),
                },
                Approval::Ask => hooks.request_approval(&call).await,
            };
            let outcome = match decision {
                // The denial reason carries the attribution already
                // ("disabled by policy", the user's reason, an approval
                // timeout) — no extra "denied by user" wrapper on top.
                ApprovalDecision::Deny { reason } => {
                    Err(ToolFailure::Execution(if reason.is_empty() {
                        "denied".into()
                    } else {
                        reason
                    }))
                }
                ApprovalDecision::Approve => {
                    registry
                        .run(&call.name, workdir, call.arguments.clone())
                        .await
                }
            };
            hooks.on_tool_result(&call, &outcome).await;
            let (result_text, result_images) = match outcome {
                Ok(o) => (o.output_for_model, o.images),
                Err(f) => (f.to_string(), Vec::new()),
            };
            history.push(
                Message::tool_result(call.id.clone(), result_text)
                    .with_images(result_images),
            );
        }
    }
}
