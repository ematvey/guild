//! Agent sessions: gateway-backed model turns + approval plumbing
//! (spec §3.2).

use crate::cloud::{CloudClient, CloudError};
use async_trait::async_trait;
use futures::StreamExt;
use guild_core::agent::{
    policy::ApprovalPolicy, AgentConfig, AgentHooks, ApprovalDecision, ModelTurn,
};
use guild_core::provider::{ProviderChunk, ProviderError};
use guild_core::tools::artifacts::ArtifactIndex;
use protocol::api::{Message, StreamEvent, ToolCall, ToolSpec};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// How long an approval request waits for a UI decision before auto-denying
/// (mirrors the server-side approval gate).
const APPROVAL_WAIT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
use tokio::sync::oneshot;
use uuid::Uuid;

/// Prefetch context for spilled tool results: as server tool results with
/// artifact pointers arrive on the live stream, their files materialize in
/// the background under the project workdir.
#[derive(Clone)]
pub struct TurnArtifacts {
    pub cloud: CloudClient,
    pub workdir: PathBuf,
    pub index: Arc<ArtifactIndex>,
}

/// Model turns through the org gateway (the only model path for clients).
pub struct GatewayTurn {
    pub cloud: CloudClient,
    pub chat_id: Uuid,
    pub model: String,
    pub system: Option<String>,
    pub project_dir: Option<String>,
    /// Client-discovered skills index; appended to the server-owned system
    /// prompt (additive channel — the client never sends a system prompt).
    pub skills_index: Option<String>,
    /// Client-discovered AGENTS.md instructions (global config-dir file +
    /// the project chain, Codex semantics); rendered server-side with the
    /// user-instructions markers.
    pub agents_md: Option<String>,
    /// Artifact prefetch hooks; absent → the stream is consumed without
    /// materialization side effects.
    pub artifacts: Option<TurnArtifacts>,
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
                send_mode: None,
                user_message_id: None,
                chat_id: self.chat_id,
                model: self.model.clone(),
                messages: messages.to_vec(),
                tools: if tools.is_empty() {
                    None
                } else {
                    Some(tools.to_vec())
                },
                system: self.system.clone(),
                // Local engine sessions carry no project id yet: the server
                // builds the workspace sentence only from a bound project.
                // Wiring agent.start sessions to projects is future work.
                project_id: None,
                skills_index: self.skills_index.clone(),
                agents_md: self.agents_md.clone(),
                // the desktop app executes machine tools client-side
                client_tools: true,
                attachment_ids: Vec::new(),
            })
            .await
            .map_err(map_cloud)?;
        // Arc + per-item clone: the 'static stream cannot borrow locals.
        let artifacts = self.artifacts.clone().map(Arc::new);
        let stream = events.filter_map(move |ev| {
            let artifacts = artifacts.clone();
            async move {
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
                Ok(StreamEvent::ThinkingDelta { content }) => Some(Ok(ProviderChunk::Thinking(
                    guild_core::provider::ChatChunk {
                        text_delta: content,
                        tokens_in: None,
                        tokens_out: None,
                    },
                ))),
                // usage + history persistence happen server-side
                Ok(StreamEvent::Done { .. }) => None,
                // Tool lifecycle notifications are for interactive clients.
                Ok(StreamEvent::ToolStarted { .. }) => None,
                Ok(StreamEvent::ToolCompleted { ref content, .. }) => {
                    // A server-side tool finished: its pointer text names the
                    // spilled artifact path. Materialize in the background so
                    // the model's read finds the file already local.
                    if let Some(ta) = artifacts.as_deref() {
                        crate::artifacts::spawn_prefetch_on_content(
                            ta.cloud.clone(),
                            ta.index.clone(),
                            ta.workdir.clone(),
                            content,
                        );
                    }
                    None
                }
                // attach-endpoint only; never on the completion stream
                Ok(StreamEvent::Idle) => None,
                // Approval lifecycle frames are for interactive clients.
                Ok(StreamEvent::ApprovalRequested { .. })
                | Ok(StreamEvent::ApprovalResolved { .. }) => None,
                Ok(StreamEvent::Error { code, message }) => {
                    Some(Err(ProviderError::Upstream(format!("[{code}] {message}"))))
                }
                Err(e) => Some(Err(ProviderError::Stream(e.to_string()))),
            }
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
    pub events: tokio::sync::broadcast::Sender<Value>,
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
        // Durable record, right away: keeps server ordering correct. A
        // failed sync diverges the server-side event log from the local
        // history — resume derivation would then replay a turn missing this
        // result — so the error is logged, never silently dropped.
        if let (Some(cloud), Some(chat_id)) = (&self.cloud, self.chat_id) {
            let (content, is_error, meta) = match outcome {
                Ok(o) => (o.output_for_model.clone(), false, o.meta.clone()),
                Err(e) => (e.to_string(), true, None),
            };
            if let Err(e) = cloud
                .append_tool_message(chat_id, call, &content, is_error, meta)
                .await
            {
                crate::dtrace::dtrace(&format!(
                    "tool-result sync failed (chat {chat_id}, call {}): {e}",
                    call.id
                ));
            }
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
        match tokio::time::timeout(APPROVAL_WAIT, rx).await {
            Ok(Ok(decision)) => decision,
            // Sender dropped (session closed) or the wait timed out — deny so
            // the turn proceeds instead of hanging forever on a silent client,
            // and remove the dead entry: only `agent.approve` removes entries
            // otherwise, so a timed-out request would linger in the map (and a
            // late approve would resolve against the dropped receiver).
            Ok(Err(_)) => {
                self.pending.lock().unwrap().remove(&request_id);
                ApprovalDecision::Deny {
                    reason: "approval channel closed".into(),
                }
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&request_id);
                ApprovalDecision::Deny {
                    reason: "no approval decision within 5 minutes".into(),
                }
            }
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
    /// Client-rendered skills index for the server-owned prompt.
    pub skills_index: Option<String>,
    /// Client-assembled AGENTS.md instructions (Codex semantics).
    pub agents_md: Option<String>,
    pub history: Vec<Message>,
    pub policy: ApprovalPolicy,
    pub events: tokio::sync::broadcast::Sender<Value>,
    pub pending: PendingApprovals,
    /// Live-stream artifact prefetch hooks (tool artifacts).
    pub artifacts: Option<TurnArtifacts>,
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
                project_dir: Some(self.project_dir.to_string_lossy().into_owned()),
                skills_index: self.skills_index,
                agents_md: self.agents_md,
                artifacts: self.artifacts,
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
                let err_frame = protocol::rpc::Event::new(
                    "agent.error",
                    serde_json::json!({ "message": e.to_string() }),
                );
                let _ = self
                    .events
                    .send(serde_json::to_value(err_frame).unwrap_or(Value::Null));
            }
            history
        })
    }
}
