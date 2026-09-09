//! Agent sessions: gateway-backed model turns + approval plumbing
//! (spec §3.2).

use crate::cloud::{CloudClient, CloudError};
use async_trait::async_trait;
use futures::StreamExt;
use guild_core::agent::{
    policy::ApprovalPolicy, AgentConfig, AgentHooks, ApprovalDecision, ModelTurn,
};
use guild_core::provider::{ProviderChunk, ProviderError};
use protocol::api::{Message, StreamEvent, ToolCall, ToolSpec};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// Model turns through the org gateway (the only model path for clients).
pub struct GatewayTurn {
    pub cloud: CloudClient,
    pub chat_id: Uuid,
    pub model: String,
    pub system: Option<String>,
}

#[async_trait]
impl ModelTurn for GatewayTurn {
    async fn stream_turn(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<
        futures::stream::BoxStream<'static, Result<ProviderChunk, ProviderError>>,
        ProviderError,
    > {
        let events = self
            .cloud
            .stream_completion(protocol::api::ChatCompletionRequest {
                chat_id: self.chat_id,
                model: self.model.clone(),
                messages: messages.to_vec(),
                tools: if tools.is_empty() {
                    None
                } else {
                    Some(tools.to_vec())
                },
                system: self.system.clone(),
            })
            .await
            .map_err(map_cloud)?;
        let stream = events.filter_map(|ev| async move {
            match ev {
                Ok(StreamEvent::Delta { content }) => {
                    Some(Ok(ProviderChunk::Text(guild_core::provider::ChatChunk {
                        text_delta: content,
                        tokens_in: None,
                        tokens_out: None,
                    })))
                }
                Ok(StreamEvent::ToolCallDelta {
                    index,
                    id,
                    name,
                    arguments_delta,
                }) => Some(Ok(ProviderChunk::ToolCallDelta {
                    index,
                    id,
                    name,
                    arguments_delta,
                })),
                Ok(StreamEvent::ToolCallDone { call }) => {
                    Some(Ok(ProviderChunk::ToolCallDone { call }))
                }
                // usage + history persistence happen server-side
                Ok(StreamEvent::Done { .. }) => None,
                Ok(StreamEvent::Error { code, message }) => {
                    Some(Err(ProviderError::Upstream(format!("[{code}] {message}"))))
                }
                Err(e) => Some(Err(ProviderError::Stream(e.to_string()))),
            }
        });
        Ok(stream.boxed())
    }
}

fn map_cloud(e: CloudError) -> ProviderError {
    match e {
        CloudError::Unauthorized => ProviderError::Auth,
        other => ProviderError::Upstream(other.to_string()),
    }
}

/// Pending approvals keyed by request id.
pub type PendingApprovals = Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>;

/// Hooks that push protocol events, pause for approvals, and sync tool
/// results to the durable server record immediately (correct ordering).
pub struct SessionHooks {
    pub events: mpsc::UnboundedSender<Value>,
    pub pending: PendingApprovals,
    pub cloud: Option<CloudClient>,
    pub chat_id: Option<Uuid>,
}

impl SessionHooks {
    fn send(&self, event: &str, payload: serde_json::Value) {
        let ev = protocol::rpc::Event::new(event, payload);
        let _ = self
            .events
            .send(serde_json::to_value(ev).expect("event serializes"));
    }
}

#[async_trait]
impl AgentHooks for SessionHooks {
    async fn on_text(&self, delta: &str) {
        self.send("agent.text", serde_json::json!({ "content": delta }));
    }

    async fn on_tool_call(&self, call: &ToolCall) {
        self.send(
            "agent.tool_call",
            serde_json::json!({ "id": call.id, "name": call.name, "arguments": call.arguments }),
        );
    }

    async fn on_tool_result(
        &self,
        call: &ToolCall,
        outcome: &Result<guild_core::tools::ToolOutcome, guild_core::tools::ToolFailure>,
    ) {
        let payload = match outcome {
            Ok(o) => serde_json::json!({
                "id": call.id, "name": call.name,
                "summary": o.ui_summary, "diff": o.diff,
                "output": o.output_for_model,
            }),
            Err(e) => {
                serde_json::json!({ "id": call.id, "name": call.name, "error": e.to_string() })
            }
        };
        self.send("agent.tool_result", payload);
        // durable record, right away: keeps server ordering correct
        if let (Some(cloud), Some(chat_id)) = (&self.cloud, self.chat_id) {
            let content = match outcome {
                Ok(o) => o.output_for_model.clone(),
                Err(e) => e.to_string(),
            };
            let _ = cloud
                .append_tool_message(chat_id, &Message::tool_result(call.id.clone(), content))
                .await;
        }
    }

    async fn request_approval(&self, call: &ToolCall) -> ApprovalDecision {
        let request_id = Uuid::now_v7().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id.clone(), tx);
        self.send(
            "agent.approval_request",
            serde_json::json!({ "request_id": request_id, "tool": call.name, "arguments": call.arguments }),
        );
        match rx.await {
            Ok(decision) => decision,
            Err(_) => ApprovalDecision::Deny {
                reason: "approval channel closed".into(),
            },
        }
    }

    async fn on_done(&self, summary: &str) {
        self.send("agent.done", serde_json::json!({ "summary": summary }));
    }
}

/// Everything a running agent task owns.
pub struct AgentRun {
    pub cloud: CloudClient,
    pub chat_id: Uuid,
    pub project_dir: PathBuf,
    pub model: String,
    pub system: Option<String>,
    pub history: Vec<Message>,
    pub policy: ApprovalPolicy,
    pub events: mpsc::UnboundedSender<Value>,
    pub pending: PendingApprovals,
}

impl AgentRun {
    /// Spawns the loop on the current runtime; emits protocol events.
    /// Returns the updated history when the run finishes.
    pub fn spawn(
        self,
        registry: guild_core::tools::ToolRegistry,
    ) -> tokio::task::JoinHandle<Vec<Message>> {
        tokio::spawn(async move {
            let turn = GatewayTurn {
                cloud: self.cloud.clone(),
                chat_id: self.chat_id,
                model: self.model,
                system: self.system,
            };
            let hooks = SessionHooks {
                events: self.events.clone(),
                pending: self.pending,
                cloud: Some(self.cloud.clone()),
                chat_id: Some(self.chat_id),
            };
            let mut history = self.history;
            if let Err(e) = guild_core::agent::run_agent(
                &turn,
                &registry,
                &self.policy,
                &mut history,
                &self.project_dir,
                &hooks,
                &AgentConfig::default(),
            )
            .await
            {
                // Surface model/policy failures (bad model, no route, …) so
                // the UI unblocks instead of waiting for agent.done forever.
                self.events
                    .send(serde_json::to_value(&protocol::rpc::Event::new(
                        "agent.error",
                        serde_json::json!({ "message": e.to_string() }),
                    ))
                    .unwrap_or(Value::Null));
            }
            history
        })
    }
}
