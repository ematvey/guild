//! Server-side execution backend: workspace agent sessions (spec §10.6, M6
//! task 3). The agent loop runs in-process with guild-core tools scoped to a
//! per-org workspace directory; history persists in `chats`/`messages`.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::{Json, Router};
use futures::Stream;
use futures::StreamExt;
use guild_core::agent::policy::ApprovalPolicy;
use guild_core::agent::{
    run_agent, AgentConfig, AgentHooks, ApprovalDecision, ModelTurn, ProviderTurn,
};
use guild_core::provider::{ProviderChunk, ProviderError};
use guild_core::tools::{ToolFailure, ToolOutcome, ToolRegistry};
use protocol::api::{Message, ToolCall, ToolSpec};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/agents/sessions",
            axum::routing::post(create_session).get(list_sessions),
        )
        .route(
            "/api/v1/agents/sessions/{id}",
            axum::routing::get(session_history),
        )
        .route(
            "/api/v1/agents/sessions/{id}/turns",
            axum::routing::post(run_turn),
        )
}

fn workspace_root(state: &AppState, org_id: Uuid) -> PathBuf {
    std::path::Path::new(&state.config.data_dir)
        .join("workspaces")
        .join(org_id.to_string())
}

pub fn workspace_dir(state: &AppState, org_id: Uuid, workspace_name: &str) -> PathBuf {
    workspace_root(state, org_id).join(workspace_name)
}

async fn create_session(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body["workspace_name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing workspace_name"))?;
    let store = state.store().await?;
    let chat = store
        .chats()
        .create_chat(user.0.org_id, user.0.id, Some(name))
        .await?;
    let session = store
        .agent_sessions()
        .create(user.0.org_id, user.0.id, chat.id, name)
        .await?;
    let dir = workspace_dir(&state, user.0.org_id, name);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::internal(format!("workspace dir create failed: {e}")))?;
    Ok(Json(
        serde_json::to_value(&session).expect("session serializes"),
    ))
}

async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let sessions = store
        .agent_sessions()
        .list(user.0.org_id, user.0.id)
        .await?;
    Ok(Json(json!({ "sessions": sessions })))
}

async fn session_history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let session = store.agent_sessions().get(user.0.org_id, id).await?;
    let rows = store
        .chats()
        .list_messages(user.0.org_id, session.chat_id)
        .await?;
    Ok(Json(json!({ "messages": rows })))
}

// ---------- turn execution ----------

#[derive(Clone)]
struct TurnFrame {
    event: &'static str,
    payload: Value,
}

struct SseHooks {
    tx: mpsc::Sender<TurnFrame>,
}

impl SseHooks {
    async fn send(&self, event: &'static str, payload: Value) {
        let _ = self.tx.send(TurnFrame { event, payload }).await;
    }
}

#[async_trait::async_trait]
impl AgentHooks for SseHooks {
    async fn on_text(&self, delta: &str) {
        self.send("delta", json!({ "content": delta })).await;
    }

    async fn on_tool_call(&self, call: &ToolCall) {
        self.send(
            "tool_call",
            json!({"id": call.id, "name": call.name, "arguments": call.arguments}),
        )
        .await;
    }

    async fn on_tool_result(&self, call: &ToolCall, outcome: &Result<ToolOutcome, ToolFailure>) {
        let payload = match outcome {
            Ok(o) => json!({"id": call.id, "name": call.name, "ok": true, "summary": o.ui_summary}),
            Err(e) => {
                json!({"id": call.id, "name": call.name, "ok": false, "error": e.to_string()})
            }
        };
        self.send("tool_result", payload).await;
    }

    async fn request_approval(&self, _call: &ToolCall) -> ApprovalDecision {
        // Server sessions are pre-approved by policy; Never-gated tools are
        // rejected by the policy layer before this is reached.
        ApprovalDecision::Approve
    }

    async fn on_done(&self, summary: &str) {
        self.send("done", json!({ "summary": summary })).await;
    }
}

/// Wraps `ProviderTurn` to accumulate token usage across turns (M6: usage
/// events are per request; one agent run emits one aggregated event).
struct TurnWithUsage<'a> {
    inner: ProviderTurn<'a>,
    tokens_in: Arc<std::sync::atomic::AtomicU32>,
    tokens_out: Arc<std::sync::atomic::AtomicU32>,
}

#[async_trait::async_trait]
impl ModelTurn for TurnWithUsage<'_> {
    async fn stream_turn(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<
        futures::stream::BoxStream<'static, Result<ProviderChunk, ProviderError>>,
        ProviderError,
    > {
        use std::sync::atomic::Ordering;
        let stream = self.inner.stream_turn(messages, tools).await?;
        let ti = self.tokens_in.clone();
        let to = self.tokens_out.clone();
        Ok(stream
            .map(move |item| {
                if let Ok(ProviderChunk::Text(t)) = &item {
                    if let Some(n) = t.tokens_in {
                        ti.fetch_add(n, Ordering::SeqCst);
                    }
                    if let Some(n) = t.tokens_out {
                        to.fetch_add(n, Ordering::SeqCst);
                    }
                }
                item
            })
            .boxed())
    }
}

async fn run_turn(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let message = body["message"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing message"))?
        .to_string();
    let model = body["model"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing model"))?
        .to_string();

    let store = state.store().await?;
    let session = store.agent_sessions().get(user.0.org_id, id).await?;
    let master = state.config.master_key()?;
    let route = store
        .gateway()
        .resolve_route(user.0.org_id, &model, &master)
        .await?;

    // history so far
    let rows = store
        .chats()
        .list_messages(user.0.org_id, session.chat_id)
        .await?;
    let history: Vec<Message> = rows
        .iter()
        .map(|r| Message {
            role: r.role.clone(),
            content: r.content.clone(),
            tool_calls: r.tool_calls.clone(),
            tool_call_id: r.tool_call_id.clone(),
            reasoning: None,
        })
        .collect();
    store
        .chats()
        .append_message(
            session.chat_id,
            "user",
            &message,
            None,
            None,
            None,
            None,
            None,
        )
        .await?;

    let mut history = history;
    history.push(Message::user(message.clone()));

    let provider: Arc<dyn guild_core::provider::ModelProvider> = match route.provider.as_str() {
        "openai" => Arc::new(guild_core::provider::OpenAiProvider::new()),
        "anthropic" => Arc::new(guild_core::provider::AnthropicProvider::new()),
        other => return Err(ApiError::internal(format!("unknown provider {other}"))),
    };

    // tools scoped to the workspace; shell tools opt-in only
    let mut registry = ToolRegistry::new();
    registry.add(Arc::new(guild_core::tools::fs::ReadFile));
    registry.add(Arc::new(guild_core::tools::fs::WriteFile));
    registry.add(Arc::new(guild_core::tools::fs::EditFile));
    registry.add(Arc::new(guild_core::tools::fs::GlobTool));
    registry.add(Arc::new(guild_core::tools::fs::GrepTool));
    registry.add(Arc::new(guild_core::tools::git::GitTool));
    if state.config.allow_shell_tools {
        registry.add(Arc::new(guild_core::tools::shell::RunCommand));
    }
    let registry = Arc::new(registry);

    let policy = ApprovalPolicy {
        default: Some(guild_core::tools::Approval::Allow),
        overrides: if state.config.allow_shell_tools {
            Default::default()
        } else {
            [(
                "run_command".to_string(),
                guild_core::tools::Approval::Never,
            )]
            .into_iter()
            .collect()
        },
    };

    let (tx, mut rx) = mpsc::channel::<TurnFrame>(64);
    let workdir = workspace_dir(&state, user.0.org_id, &session.workspace_name);
    let chat_id = session.chat_id;
    let store_for_loop = store.clone();
    let usage = state.usage().await?;
    let org_id = user.0.org_id;
    let user_id = user.0.id;
    let price_in = route.price_in;
    let price_out = route.price_out;

    let loop_handle = tokio::spawn(async move {
        use guild_core::usage::UsageEvent;
        use std::sync::atomic::{AtomicU32, Ordering};

        let tokens_in = Arc::new(AtomicU32::new(0));
        let tokens_out = Arc::new(AtomicU32::new(0));
        let turn = TurnWithUsage {
            inner: ProviderTurn {
                provider: provider.as_ref(),
                model: &model,
                system: Some("You are Guild, a coding agent working in an org workspace."),
                base_url: &route.base_url,
                api_key: &route.api_key,
            },
            tokens_in: tokens_in.clone(),
            tokens_out: tokens_out.clone(),
        };
        let (hook_tx, mut hook_rx) = mpsc::channel::<TurnFrame>(64);
        let hooks = SseHooks { tx: hook_tx };
        let before = history.len();
        let result = run_agent(
            &turn,
            &registry,
            &policy,
            &mut history,
            &workdir,
            &hooks,
            &AgentConfig::default(),
        )
        .await;
        drop(hooks);
        while let Some(frame) = hook_rx.recv().await {
            let _ = tx.send(frame).await;
        }

        match result {
            Ok(_res) => {
                // persist the new messages (assistant tool calls + results + final)
                for m in &history[before..] {
                    let _ = store_for_loop
                        .chats()
                        .append_message(
                            chat_id,
                            &m.role,
                            &m.content,
                            m.tool_calls.clone(),
                            m.tool_call_id.clone(),
                            None,
                            None,
                            None,
                        )
                        .await;
                }
                let ti = tokens_in.load(Ordering::SeqCst);
                let to = tokens_out.load(Ordering::SeqCst);
                let cost = UsageEvent::cost_usd(ti, to, price_in, price_out);
                usage
                    .record(UsageEvent {
                        ts: chrono::Utc::now(),
                        org_id,
                        user_id,
                        team_id: None,
                        session_id: chat_id,
                        model: model.clone(),
                        provider: route.provider.clone(),
                        tokens_in: ti,
                        tokens_out: to,
                        cost_usd: cost,
                        request_id: Uuid::now_v7(),
                    })
                    .await;
            }
            Err(e) => {
                let _ = tx
                    .send(TurnFrame {
                        event: "error",
                        payload: json!({"message": e.to_string()}),
                    })
                    .await;
            }
        }
        drop(tx);
    });

    let out = async_stream::stream! {
        while let Some(frame) = rx.recv().await {
            yield Ok(SseEvent::default().event(frame.event).data(frame.payload.to_string()));
        }
        let _ = loop_handle.await;
    };

    Ok(Sse::new(out).keep_alive(KeepAlive::default()))
}
