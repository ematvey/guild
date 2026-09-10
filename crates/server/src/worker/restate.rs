//! Restate bindings for the integrations runtime (spec §4.6). `RoutineRunner`
//! is a virtual object keyed by routine id: webhook payloads and ticks enter
//! here; every nondeterministic step is journaled with `ctx.run` so Restate
//! replays results on retry instead of re-running side effects.
//!
//! The journaled sequence is written once as macros and expanded per concrete
//! context type (`ObjectContext` / `SharedObjectContext`) — generic helpers
//! over the SDK context traits trip rustc's async-fn-in-trait Send inference
//! (rust-lang/rust#100013).

use std::sync::Arc;
use std::time::Duration;

use crate::http::error::ApiError;
use crate::http::gateway::{clear_pending_tool, enforce_quota, ensure_generation, note_pending_tool};
use crate::integrations;
use crate::state::AppState;
use crate::store::integrations::IntegrationRow;
use crate::worker::executor::{tool_registry, Completion, RoutineConfig, RoutineExecutor};
use crate::worker::run::MAX_STEPS;
use futures::StreamExt;
use tokio::sync::broadcast;
use guild_core::provider::{ModelProvider, ProviderChunk, ProviderRequest};
use guild_core::usage::UsageEvent;
use protocol::api::{Message, MessageRow, StreamEvent, ToolCall, ToolExecutor, ToolSpec};
use restate_sdk::errors::HandlerError;
use restate_sdk::service::IntoServiceDefinition;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

/// Virtual object: key = routine id (string form).
pub struct RoutineRunner {
    pub state: AppState,
}

impl RoutineRunner {
    fn executor(&self) -> RoutineExecutor {
        RoutineExecutor {
            api_base: self.state.config.api_url.trim_end_matches('/').to_string(),
            internal_token: self
                .state
                .config
                .internal_token
                .clone()
                .expect("worker role requires GUILD_INTERNAL_TOKEN"),
            allow_http_tool: std::env::var("GUILD_WORKER_ALLOW_HTTP")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false),
        }
    }
}

/// Journaled config load; a disabled routine is a terminal error (stops the
/// interval chain instead of retrying forever).
macro_rules! journaled_load_config {
    ($ctx:expr, $exec:expr, $routine_id:expr) => {{
        let exec2 = ($exec).clone();
        $ctx.run(move || {
            let exec = exec2.clone();
            async move {
                let cfg = exec.load_config($routine_id).await?;
                if !cfg.enabled {
                    return Err(TerminalError::new("routine disabled").into());
                }
                Ok(Json(cfg))
            }
        })
        .await?
        .into_inner()
    }};
}

/// Journaled run body: open the run record, run the ReAct loop with per-step
/// journaling, close the record. Yields `HandlerResult<()>`.
macro_rules! journaled_run_body {
    ($ctx:expr, $exec:expr, $cfg:expr, $trigger:expr, $input:expr) => {{
        let exec: RoutineExecutor = ($exec).clone();
        let cfg: RoutineConfig = ($cfg).clone();
        let trigger: &'static str = $trigger;
        let input: Value = $input;

        // Journaled: open the run record.
        let exec2 = exec.clone();
        let run_id: Uuid = $ctx
            .run(move || {
                let exec = exec2.clone();
                async move {
                    let run_id = exec.start_run(cfg.id, trigger).await?;
                    Ok(Json(run_id))
                }
            })
            .await?
            .into_inner();

        let allowed: Vec<String> =
            serde_json::from_value(cfg.allowed_tools.clone()).unwrap_or_default();
        let registry: Arc<guild_core::tools::ToolRegistry> =
            Arc::new(tool_registry(&exec, cfg.org_id, &allowed));
        let specs = registry.specs();
        let user_id = cfg.created_by.unwrap_or(cfg.org_id);

        let opening = if trigger == "webhook" && !input.is_null() {
            format!(
                "Webhook fired with payload:\n{}",
                serde_json::to_string_pretty(&input)?
            )
        } else {
            "Scheduled run: check your sources and report.".to_string()
        };
        let mut messages = vec![Message::user(opening)];
        let mut completion: Option<Completion> = None;

        for _step in 0..MAX_STEPS {
            // Journaled: one model call.
            let exec2 = exec.clone();
            let msgs = messages.clone();
            let specs2 = specs.clone();
            let model = cfg.model.clone();
            let system = Some(cfg.prompt.clone());
            let org = cfg.org_id;
            let c: Completion = $ctx
                .run(move || {
                    let exec = exec2.clone();
                    let messages = msgs.clone();
                    let specs = specs2.clone();
                    async move {
                        let c = exec
                            .completion(org, user_id, &model, system, messages, specs)
                            .await?;
                        Ok(Json(c))
                    }
                })
                .await?
                .into_inner();

            if c.tool_calls.is_empty() {
                completion = Some(c);
                break;
            }
            messages.push(Message {
                role: "assistant".into(),
                content: c.text.clone(),
                tool_calls: Some(c.tool_calls.clone()),
                tool_call_id: None,
            });
            for call in c.tool_calls {
                // Journaled: one tool execution; failures become tool results.
                let registry2 = registry.clone();
                let call_name = call.name.clone();
                let call_id = call.id.clone();
                let args = call.arguments.clone();
                let content: String = $ctx
                    .run(move || {
                        let registry = registry2.clone();
                        let name = call_name.clone();
                        let args = args.clone();
                        async move {
                            let result = registry.run(&name, std::path::Path::new("/"), args).await;
                            let content = match result {
                                Ok(out) => out.output_for_model,
                                Err(e) => format!("tool {name} failed: {e}"),
                            };
                            Ok(Json(content))
                        }
                    })
                    .await?
                    .into_inner();
                messages.push(Message::tool_result(&call_id, &content));
            }
        }

        let summary = match completion {
            Some(c) => c.text,
            None => {
                let msg = format!("routine hit the {MAX_STEPS}-step limit without a final answer");
                finish_run_journaled!($ctx, exec, run_id, "failed", Some(msg.clone()), None);
                return Err(TerminalError::new(msg).into());
            }
        };

        finish_run_journaled!($ctx, exec, run_id, "succeeded", None, Some(summary));
        Ok(())
    }};
}

/// Journaled finish of the run record.
macro_rules! finish_run_journaled {
    ($ctx:expr, $exec:expr, $run_id:expr, $status:expr, $error:expr, $summary:expr) => {{
        let exec2 = $exec.clone();
        let error: Option<String> = $error;
        let summary: Option<String> = $summary;
        $ctx.run(move || {
            let exec = exec2.clone();
            async move {
                exec.finish_run($run_id, $status, summary.as_deref(), error.as_deref())
                    .await?;
                Ok(Json(()))
            }
        })
        .await?;
    }};
}

#[object]
impl RoutineRunner {
    /// Webhook trigger: the API forwarded a one-way send here.
    #[handler]
    async fn handle_webhook(
        &self,
        ctx: SharedObjectContext<'_>,
        payload: Json<Value>,
    ) -> HandlerResult<()> {
        let routine_id: Uuid = ctx.key().parse().map_err(anyhow::Error::msg)?;
        let exec = self.executor();
        let cfg = journaled_load_config!(ctx, exec, routine_id);
        journaled_run_body!(ctx, exec, cfg, "webhook", payload.into_inner())
    }

    /// Interval trigger: check enabled, reschedule ourselves, then run.
    /// The enabled check happens first so a disabled routine ends its chain.
    #[handler]
    async fn tick(&self, ctx: ObjectContext<'_>, interval_secs: Json<u64>) -> HandlerResult<()> {
        let interval = interval_secs.into_inner().max(1);
        let routine_id: Uuid = ctx.key().parse().map_err(anyhow::Error::msg)?;
        let exec = self.executor();
        let cfg = journaled_load_config!(ctx, exec, routine_id); // terminal when disabled → chain ends
        ctx.object_client::<RoutineRunnerClient>(ctx.key())
            .tick(Json(interval))
            .send_after(Duration::from_secs(interval));
        journaled_run_body!(ctx, exec, cfg, "interval", json!({}))
    }
}

// ---------- durable chat generation ----------

/// Request for one chat generation turn. History is loaded from Postgres
/// inside the workflow (journaled), so the payload stays minimal.
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatRunPayload {
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub chat_id: Uuid,
    pub model: String,
    /// Whether the originating client can execute machine tools; when false
    /// they are not declared to the model at all (web clients cannot run
    /// them, and an unanswered client-tool call suspends the turn for the
    /// full 5-minute timeout).
    #[serde(default)]
    pub client_tools: bool,
    /// Stable identity of the originating app instance (presence key for
    /// client-tool termination detection); `None` → timeout-only fallback.
    #[serde(default)]
    pub client_id: Option<String>,
    /// Workspace directory the client executes machine tools in; included
    /// in the system prompt when present.
    #[serde(default)]
    pub project_dir: Option<String>,
    /// The chat's bound executor machine (machine tools run ONLY there).
    #[serde(default)]
    pub machine_id: Option<String>,
    /// Human-readable label of the bound machine.
    #[serde(default)]
    pub machine_label: Option<String>,
    /// The originating desktop app's machine, for auto-binding chats that
    /// were sent from a desktop without an explicit binding.
    #[serde(default)]
    pub origin_machine_id: Option<String>,
}

/// Final result of the journaled completion step.
#[derive(Serialize, Deserialize, Clone)]
struct CompletionOut {
    text: String,
    tool_calls: Vec<ToolCall>,
    tokens_in: u32,
    tokens_out: u32,
}

fn api_err(e: ApiError) -> anyhow::Error {
    anyhow::anyhow!(e.message)
}

/// Business failures (no route, disabled model, missing key) must stop the
/// invocation instead of retrying forever; only infrastructure errors are
/// transient.
fn api_terminal(e: ApiError) -> HandlerError {
    if matches!(
        e.status,
        axum::http::StatusCode::NOT_FOUND | axum::http::StatusCode::CONFLICT
    ) {
        HandlerError::from(TerminalError::new(e.message))
    } else {
        HandlerError::from(anyhow::anyhow!(e.message))
    }
}

/// Virtual object: key = chat id (string form). One generation at a time per
/// chat — Restate serializes handler invocations per object key.
pub struct ChatRunner {
    pub state: AppState,
}

/// Client-side tool result as delivered back through the awakeable.
#[derive(Serialize, Deserialize, Clone)]
struct ToolResultPayload {
    content: String,
    is_error: bool,
}

/// Body of the `complete_tool` handler.
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolResultReq {
    pub call_id: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// How many model/tool round-trips one turn may take.
const CHAT_MAX_STEPS: usize = 25;
/// How long the loop waits for a client to execute a client-side tool.
pub(crate) const CLIENT_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn client_tool_names() -> &'static [&'static str] {
    &["read", "bash", "edit", "write"]
}

fn state_key(call_id: &str) -> String {
    format!("pending_tool:{call_id}")
}

/// Server-owned system prompt (the client never sends one). Without it small
/// models fall back to generic web-assistant behavior even with the full tool
/// surface declared — they need the role, the workspace, and when to use
/// which tool class spelled out.
fn build_system_prompt(
    client_tools: bool,
    has_web_search: bool,
    project_dir: Option<&str>,
) -> String {
    let mut s = String::from(
        "You are a coding agent assisting the user with their software project. \
         Answer concisely and act on the project when asked.",
    );
    if client_tools {
        s.push_str(
            " You have tools that operate on the user's workspace (read, bash, \
             edit, write, glob, grep): inspect the workspace with them BEFORE \
             answering anything that could be about the user's project or files.",
        );
    }
    if has_web_search {
        s.push_str(
            " Use web_search only for general or current-events knowledge, \
             never as a substitute for looking at the workspace.",
        );
    }
    if let Some(dir) = project_dir {
        s.push_str(&format!(" The workspace directory is {dir}."));
    }
    s
}

/// Journaled usage recording (called when a turn ends with usage numbers).
macro_rules! record_usage {
    ($ctx:expr, $state:expr, $req:expr, $completion:expr, $route:expr) => {{
        let st = $state.clone();
        let org = $req.org_id;
        let user_id = $req.user_id;
        let chat_id = $req.chat_id;
        let model = $req.model.clone();
        let provider_name = $route.provider.clone();
        let (price_in, price_out) = ($route.price_in, $route.price_out);
        let c = $completion.clone();
        $ctx.run(move || {
            let state = st.clone();
            let c = c.clone();
            let model = model.clone();
            let provider_name = provider_name.clone();
            async move {
                let usage = state.usage().await.map_err(api_err)?;
                usage
                    .record(UsageEvent {
                        ts: chrono::Utc::now(),
                        org_id: org,
                        user_id,
                        team_id: None,
                        session_id: chat_id,
                        model,
                        provider: provider_name,
                        tokens_in: c.tokens_in,
                        tokens_out: c.tokens_out,
                        cost_usd: UsageEvent::cost_usd(
                            c.tokens_in,
                            c.tokens_out,
                            price_in,
                            price_out,
                        ),
                        request_id: Uuid::now_v7(),
                    })
                    .await;
                Ok(Json(()))
            }
        })
        .await?;
    }};
}

/// Journaled cleanup of the chat's recorded invocation id.
macro_rules! clear_chatgen_kv {
    ($ctx:expr, $state:expr, $chat_id:expr) => {{
        let st = $state.clone();
        let chat_id = $chat_id;
        $ctx.run(move || {
            let state = st.clone();
            async move {
                if let Ok(store) = state.store().await {
                    let _ = store.kv().delete(&format!("chatgen_inv:{chat_id}")).await;
                }
                Ok(Json(()))
            }
        })
        .await?;
    }};
}

#[object]
impl ChatRunner {
    /// One chat turn as a durable ReAct loop: resolve route → load history →
    /// { model call → (server tools executed here; client tools suspend on an
    /// awakeable until the client posts a result) → persist } until a final
    /// answer. Every model call, tool execution and persistence is its own
    /// journaled step, so a crash resumes instead of redoing completed work.
    #[handler]
    async fn generate(
        &self,
        ctx: ObjectContext<'_>,
        req: Json<ChatRunPayload>,
    ) -> HandlerResult<()> {
        let req = req.into_inner();
        let state = self.state.clone();

        // Journaled: resolve the model route (and enforce quota).
        let st = state.clone();
        let org = req.org_id;
        let model = req.model.clone();
        let route = ctx
            .run(move || {
                let state = st.clone();
                let model = model.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let master = state.config.master_key()?;
                    let route = store
                        .gateway()
                        .resolve_route(org, &model, &master)
                        .await
                        .map_err(api_terminal)?;
                    enforce_quota(&state, org, &model, &route)
                        .await
                        .map_err(api_terminal)?;
                    Ok(Json(route))
                }
            })
            .await?
            .into_inner();

        // Journaled: load the thread history from Postgres (the user turn was
        // persisted by the API before invocation).
        let st = state.clone();
        let org = req.org_id;
        let chat_id = req.chat_id;
        let history: Vec<MessageRow> = ctx
            .run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let msgs = store
                        .chats()
                        .list_messages(org, chat_id)
                        .await
                        .map_err(api_err)?;
                    Ok(Json(msgs))
                }
            })
            .await?
            .into_inner();
        let mut messages: Vec<Message> = history
            .into_iter()
            .map(|m| Message {
                role: m.role,
                content: m.content,
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
            })
            .collect();

        // Journaled: resolve this org's enabled integrations (admin-configured
        // server-side tools, e.g. web_search).
        let st = state.clone();
        let org = req.org_id;
        let integration_rows: Vec<IntegrationRow> = ctx
            .run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let rows = store.integrations().list_enabled(org).await.map_err(api_err)?;
                    Ok(Json(rows))
                }
            })
            .await?
            .into_inner();
        let server_tools = integrations::resolve_server_tools(&integration_rows)?;
        let mut tool_specs: Vec<ToolSpec> = server_tools.iter().map(|t| t.spec.clone()).collect();
        let has_web_search = server_tools.iter().any(|t| t.spec.name == "web_search");
        if req.client_tools || req.machine_id.is_some() {
            tool_specs.extend(protocol::api::client_tool_specs());
        }
        let system = build_system_prompt(req.client_tools, has_web_search, req.project_dir.as_deref());

        let (tx, text_buf) = ensure_generation(&state, req.chat_id);

        // Returns Ok(true) when the turn ended with a final answer, Ok(false)
        // when the step limit was exhausted without one.
        let turn: HandlerResult<bool> = async {
        let state = state.clone();
        for step in 1..=CHAT_MAX_STEPS {
            // Journaled: one model call with the full tool surface.
            let st = state.clone();
            let route2 = route.clone();
            let model2 = req.model.clone();
            let msgs = messages.clone();
            let specs = tool_specs.clone();
            let system2 = system.clone();
            let chat_id = req.chat_id;
            let tx_loop = tx.clone();
            let buf_loop = text_buf.clone();
            let completion: CompletionOut = ctx
                .run(move || {
                    let state = st.clone();
                    let route = route2.clone();
                    let model = model2.clone();
                    let tx = tx_loop.clone();
                    let text_buf = buf_loop.clone();
                    async move {
                        let provider: Arc<dyn ModelProvider> = match route.provider.as_str() {
                            "openai" => Arc::new(guild_core::provider::OpenAiProvider::new()),
                            "anthropic" => {
                                Arc::new(guild_core::provider::AnthropicProvider::new())
                            }
                            other => {
                                return Err(TerminalError::new(format!("unknown provider {other}"))
                                    .into())
                            }
                        };
                        let preq = ProviderRequest {
                            model: &model,
                            system: Some(system2.as_str()),
                            messages: &msgs,
                            api_key: &route.api_key,
                            base_url: &route.base_url,
                            tools: Some(&specs),
                        };
                        let stream = provider.chat_stream(preq).await.map_err(|e| {
                            let _ = tx.send(StreamEvent::Error {
                                code: "provider".into(),
                                message: e.to_string(),
                            });
                            // Remove the broadcast entry or the chat keeps a
                            // zombie generation: attach streams would hang
                            // forever with the caret blinking on a dead thread.
                            state.generations.lock().unwrap().remove(&chat_id);
                            HandlerError::from(TerminalError::new(format!("provider error: {e}")))
                        })?;
                        *text_buf.write().await = String::new(); // reset per model call
                        let mut text = String::new();
                        let mut tokens_in = 0u32;
                        let mut tokens_out = 0u32;
                        let mut tool_calls: Vec<ToolCall> = Vec::new();
                        let mut pinned = Box::pin(stream);
                        while let Some(item) = pinned.next().await {
                            match item {
                                Ok(ProviderChunk::Text(chunk)) => {
                                    if !chunk.text_delta.is_empty() {
                                        text.push_str(&chunk.text_delta);
                                        *text_buf.write().await = text.clone();
                                        let _ = tx.send(StreamEvent::Delta {
                                            content: chunk.text_delta.clone(),
                                        });
                                    }
                                    if let Some(t) = chunk.tokens_in {
                                        tokens_in = t;
                                    }
                                    if let Some(t) = chunk.tokens_out {
                                        tokens_out = t;
                                    }
                                }
                                Ok(ProviderChunk::ToolCallDelta {
                                    index,
                                    id,
                                    name,
                                    arguments_delta,
                                }) => {
                                    let _ = tx.send(StreamEvent::ToolCallDelta {
                                        index,
                                        id,
                                        name,
                                        arguments_delta,
                                    });
                                }
                                Ok(ProviderChunk::ToolCallDone { call }) => {
                                    tool_calls.push(call.clone());
                                    let _ = tx.send(StreamEvent::ToolCallDone { call });
                                }
                                Err(e) => {
                                    let _ = tx.send(StreamEvent::Error {
                                        code: "provider".into(),
                                        message: e.to_string(),
                                    });
                                    // same zombie-generation cleanup as above
                                    state.generations.lock().unwrap().remove(&chat_id);
                                    return Err(TerminalError::new(format!("provider error: {e}"))
                                        .into());
                                }
                            }
                        }
                        Ok(Json(CompletionOut {
                            text,
                            tool_calls,
                            tokens_in,
                            tokens_out,
                        }))
                    }
                })
                .await?
                .into_inner();

            let is_final = completion.tool_calls.is_empty();

            // Journaled: persist the assistant message (with any tool calls).
            let st = state.clone();
            let chat_id = req.chat_id;
            let completion2 = completion.clone();
            let msg_id: Uuid = ctx
                .run(move || {
                    let state = st.clone();
                    let c = completion2.clone();
                    async move {
                        let store = state.store().await.map_err(api_err)?;
                        let persisted_calls = if c.tool_calls.is_empty() { None } else { Some(c.tool_calls) };
                        let msg = store
                            .chats()
                            .append_message(
                                chat_id,
                                "assistant",
                                &c.text,
                                persisted_calls,
                                None,
                                Some(c.tokens_in),
                                Some(c.tokens_out),
                                Some(UsageEvent::cost_usd(
                                    c.tokens_in,
                                    c.tokens_out,
                                    route.price_in,
                                    route.price_out,
                                )),
                            )
                            .await
                            .map_err(api_err)?;
                        Ok(Json(msg.id))
                    }
                })
                .await?
                .into_inner();

            if is_final {
                // Journaled: record usage, then finish.
                record_usage!(ctx, state, req, completion, route);
                let _ = tx.send(StreamEvent::Done {
                    message_id: msg_id,
                    cost_usd: UsageEvent::cost_usd(
                        completion.tokens_in,
                        completion.tokens_out,
                        route.price_in,
                        route.price_out,
                    ),
                    tokens_in: completion.tokens_in,
                    tokens_out: completion.tokens_out,
                });
                clear_chatgen_kv!(ctx, state, req.chat_id);
                state.generations.lock().unwrap().remove(&req.chat_id);
                return Ok(true);
            }

            messages.push(Message {
                role: "assistant".into(),
                content: completion.text.clone(),
                tool_calls: Some(completion.tool_calls.clone()),
                tool_call_id: None,
            });

            // Execute each requested tool call in order.
            for (idx, call) in completion.tool_calls.iter().enumerate() {
                let is_client_tool = client_tool_names().contains(&call.name.as_str());
                let content = if is_client_tool {
                    client_tool_step(
                        &ctx,
                        &state,
                        &tx,
                        req.org_id,
                        req.chat_id,
                        &call,
                        format!("{step}.{idx}"),
                        req.machine_id.clone(),
                        req.machine_label.clone(),
                        req.origin_machine_id.clone(),
                    )
                    .await?
                } else {
                    server_tool_step(
                        &ctx,
                        &state,
                        &tx,
                        &call,
                        &server_tools,
                        format!("{step}.{idx}"),
                    )
                    .await?
                };

                // Journaled: persist the tool result.
                let st = state.clone();
                let chat_id = req.chat_id;
                let call_id = call.id.clone();
                let content2 = content.clone();
                ctx.run(move || {
                    let state = st.clone();
                    let content = content2.clone();
                    async move {
                        let store = state.store().await.map_err(api_err)?;
                        store
                            .chats()
                            .append_message(
                                chat_id,
                                "tool",
                                &content,
                                None,
                                Some(call_id),
                                None,
                                None,
                                None,
                            )
                            .await
                            .map_err(api_err)?;
                        Ok(Json(()))
                    }
                })
                .await?;

                messages.push(Message {
                    role: "tool".into(),
                    content,
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                });
            }
        }
        Ok(false)
        }
        .await;
        // Uniform failure path: notify clients and free the chat (registry +
        // recorded invocation) so a failed turn never jams the thread.
        let final_sent = match turn {
            Ok(sent) => sent,
            Err(e) => {
                let _ = tx.send(StreamEvent::Error {
                    code: "turn_failed".into(),
                    message: "the turn failed; see server logs".into(),
                });
                state.generations.lock().unwrap().remove(&req.chat_id);
                if let Ok(store) = state.store().await {
                    let _ = store.kv().delete(&format!("chatgen_inv:{}", req.chat_id)).await;
                }
                return Err(e);
            }
        };
        if final_sent {
            // Registry and recorded invocation were already cleared on the
            // final-answer path.
            return Ok(());
        }

        // Step limit reached: tell the model-facing history and the client.
        let st = state.clone();
        let chat_id = req.chat_id;
        let note = format!(
            "Turn stopped after {CHAT_MAX_STEPS} model/tool rounds without a final answer."
        );
        let msg_id: Uuid = ctx
            .run(move || {
                let state = st.clone();
                let note = note.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let msg = store
                        .chats()
                        .append_message(chat_id, "assistant", &note, None, None, None, None, None)
                        .await
                        .map_err(api_err)?;
                    Ok(Json(msg.id))
                }
            })
            .await?
            .into_inner();
        let _ = tx.send(StreamEvent::Done {
            message_id: msg_id,
            cost_usd: 0.0,
            tokens_in: 0,
            tokens_out: 0,
        });
        clear_chatgen_kv!(ctx, state, req.chat_id);
        state.generations.lock().unwrap().remove(&req.chat_id);
        Ok(())
    }

    /// Delivers a client-side tool result to the waiting generate loop.
    /// Shared handler: runs while `generate` is in flight. Late results
    /// (after the timeout cleared the pending entry) are ignored.
    #[handler]
    async fn complete_tool(
        &self,
        ctx: SharedObjectContext<'_>,
        req: Json<ToolResultReq>,
    ) -> HandlerResult<()> {
        let req = req.into_inner();
        let key = state_key(&req.call_id);
        let pending: Option<String> = ctx.get(key.as_str()).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let Some(awakeable_id) = pending else {
            return Ok(()); // nobody is waiting (timed out or not a client tool)
        };
        ctx.resolve_awakeable(
            &awakeable_id,
            Json(ToolResultPayload {
                content: req.content.clone(),
                is_error: req.is_error,
            }),
        );
        Ok(())
    }
}


/// One machine-tool call: resolve the bound executor machine (fail fast when
/// unbound/offline), notify attached clients, durably wait for the machine's
/// result (bounded), report completion. Returns the tool content for the
/// model-facing history.
async fn client_tool_step(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    org_id: Uuid,
    chat_id: Uuid,
    call: &ToolCall,
    _seq: String,
    machine_id: Option<String>,
    machine_label: Option<String>,
    origin_machine_id: Option<String>,
) -> HandlerResult<String> {
    // Resolve the executor machine. Journaled ctx.run snapshots: the result
    // replays deterministically even if the in-memory registry changes
    // between execution and replay (e.g. worker restart).
    let bound: Option<(String, String)> = ctx
        .run({
            let state = state.clone();
            move || {
                let state = state.clone();
                async move {
                    if let Some(mid) = machine_id {
                        let label = machine_label.unwrap_or_else(|| {
                            state.machine_label(&mid).unwrap_or_else(|| mid.clone())
                        });
                        Ok(Json(Some((mid, label))))
                    } else if let Some(omid) = origin_machine_id {
                        // Auto-bind chats sent from a desktop to that
                        // desktop's machine (idempotent persist).
                        if state.machine_connected(&omid) {
                            let label = state
                                .machine_label(&omid)
                                .unwrap_or_else(|| omid.clone());
                            if let Ok(store) = state.store().await {
                                let _ = store
                                    .chats()
                                    .set_machine(org_id, chat_id, Some(&omid), Some(&label))
                                    .await;
                            }
                            Ok(Json(Some((omid, label))))
                        } else {
                            Ok(Json(None))
                        }
                    } else {
                        Ok(Json(None))
                    }
                }
            }
        })
        .await?
        .into_inner();
    let Some((mid, mlabel)) = bound else {
        return Ok(
            "client tool not executed: this chat is not bound to a machine — bind it in the chat settings, or send the message from the Guild desktop app on the target machine"
                .to_string(),
        );
    };
    // Fail fast when the bound machine is offline (journaled snapshot).
    let online: bool = ctx
        .run({
            let state = state.clone();
            let mid = mid.clone();
            move || {
                let state = state.clone();
                let mid = mid.clone();
                async move { Ok(Json(state.machine_connected(&mid))) }
            }
        })
        .await?
        .into_inner();
    if !online {
        return Ok(format!(
            "client tool not executed: the bound machine '{mlabel}' is offline — start the Guild desktop app on it, then ask again"
        ));
    }

    // Journaled awakeable: stable id across replays.
    let (awakeable_id, promise) = ctx.awakeable::<Json<ToolResultPayload>>();
    ctx.set(&state_key(&call.id), awakeable_id.clone());
    // Journaled: notify attached clients that this call must run client-side.
    let args_json = serde_json::to_string(&call.arguments)
        .unwrap_or_else(|_| "{}".to_string());
    let done = note_pending_tool(
        state,
        chat_id,
        &call.id,
        &call.name,
        &args_json,
        Some(&mid),
    );
    // Termination detection: if the bound machine disappears (executor
    // connection gone, app-lifetime — not per-thread streams), resolve the
    // tool with an error after a grace window instead of dead-airing for
    // the full timeout. Spawned outside the journaled sections on purpose:
    // a worker restart replays this handler and re-spawns the watcher.
    crate::http::gateway::spawn_machine_watcher(
        state,
        chat_id,
        call.id.clone(),
        call.name.clone(),
        mid,
        mlabel,
        done,
    );
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name = call.name.clone();
    let args2 = args_json.clone();
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name.clone();
        let args = args2.clone();
        async move {
            let _ = tx.send(StreamEvent::ToolStarted {
                call_id,
                name,
                arguments: args,
                executor: ToolExecutor::Client,
            });
            Ok(Json(()))
        }
    })
    .await?;

    // Durable timeout: schedule a journaled delayed completion instead of
    // racing futures — a dropped ctx.sleep blocks replay until the timer
    // fires, while send_after lives in Restate's timer service and never
    // gates this workflow's journal. The delayed complete_tool targets the
    // shared handler, so it runs while `generate` is suspended; when the
    // client result arrived first, complete_tool is a no-op (state cleared).
    ctx.object_client::<ChatRunnerClient>(&chat_id.to_string())
        .complete_tool(Json(ToolResultReq {
            call_id: call.id.clone(),
            content: format!(
                "client tool {} ({}) timed out after 5 minutes: no client result arrived",
                call.name, call.id
            ),
            is_error: true,
        }))
        .send_after(CLIENT_TOOL_TIMEOUT);

    let payload: ToolResultPayload = match promise.await {
        Ok(Json(p)) => p,
        Err(t) => ToolResultPayload {
            content: format!("client tool failed: {t}"),
            is_error: true,
        },
    };

    ctx.clear(&state_key(&call.id));
    clear_pending_tool(state, chat_id, &call.id);

    // Journaled: report completion to attached clients.
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name = call.name.clone();
    let content2 = payload.content.clone();
    let is_error = payload.is_error;
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name.clone();
        let content = content2.clone();
        async move {
            let _ = tx.send(StreamEvent::ToolCompleted {
                call_id,
                name,
                content,
                is_error,
            });
            Ok(Json(()))
        }
    })
    .await?;

    Ok(payload.content)
}

/// One server-side tool call: notify clients, execute the integration plugin
/// (journaled), report completion. Returns the tool content for the model.
async fn server_tool_step(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    call: &ToolCall,
    server_tools: &[integrations::ServerTool],
    _seq: String,
) -> HandlerResult<String> {
    // Journaled: notify attached clients.
    let args_json = serde_json::to_string(&call.arguments)
        .unwrap_or_else(|_| "{}".to_string());
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name = call.name.clone();
    let args2 = args_json.clone();
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name.clone();
        let args = args2.clone();
        async move {
            let _ = tx.send(StreamEvent::ToolStarted {
                call_id,
                name,
                arguments: args,
                executor: ToolExecutor::Server,
            });
            Ok(Json(()))
        }
    })
    .await?;

    // Journaled: execute the integration tool.
    let tools = server_tools.to_owned();
    let call2 = call.clone();
    let (content, is_error) = ctx
        .run(move || {
            let tools = tools.clone();
            let call = call2.clone();
            async move {
                let Some(tool) = tools.iter().find(|t| t.spec.name == call.name) else {
                    return Ok(Json((
                        format!("unknown server tool {}", call.name),
                        true,
                    )));
                };
                let out = tool
                    .integration
                    .execute(&tool.config, &call.name, call.arguments.clone())
                    .await;
                Ok(Json(match out {
                    Ok(content) => (content, false),
                    Err(e) => (format!("web tool failed: {e}"), true),
                }))
            }
        })
        .await?
        .into_inner();

    // Journaled: report completion to attached clients.
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name = call.name.clone();
    let content2 = content.clone();
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name.clone();
        let content = content2.clone();
        async move {
            let _ = tx.send(StreamEvent::ToolCompleted {
                call_id,
                name,
                content,
                is_error,
            });
            Ok(Json(()))
        }
    })
    .await?;
    let _ = state;
    Ok(content)
}

/// Register this worker's endpoint with the Restate admin API (retry until
/// accepted or already registered).
pub async fn register_with_restate(admin_url: &str, advertised_url: &str) -> anyhow::Result<()> {
    let url = format!("{}/deployments", admin_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    for _ in 0..150 {
        // force=true: re-discover services even when the deployment URI is
        // already registered, so newly bound services (e.g. ChatRunner) are
        // picked up on redeploy instead of silently keeping the old set.
        let resp = client
            .post(&url)
            .json(&json!({"uri": advertised_url, "force": true}))
            .send()
            .await?;
        if resp.status().is_success() {
            return Ok(());
        }
        tracing::warn!(
            "restate endpoint registration got {}; retrying",
            resp.status()
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    anyhow::bail!("could not register worker endpoint with restate at {url}")
}

/// Fingerprint of the workflow code. Turns dispatched by an older fingerprint
/// cannot replay safely after a deploy (journal mismatch) — the startup sweep
/// purges them so their chats do not stay jammed.
fn workflow_schema_version() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    include_str!("restate.rs").hash(&mut h);
    format!("{:x}", h.finish())
}

/// Purges in-flight chat generations dispatched by a different workflow
/// version. They cannot replay after the deploy and would jam their chat
/// (virtual objects serialize per key) until the inactivity timeout.
async fn purge_stale_chat_generations(state: &AppState) {
    let Ok(store) = state.store().await else { return };
    let current = workflow_schema_version();
    let Ok(entries) = store.kv().list_prefix("chatgen_inv:").await else { return };
    for (key, value) in entries {
        let _ = store.kv().delete(&key).await;
        let (ver, inv) = match value.split_once(':') {
            Some(pair) => pair,
            None => continue,
        };
        if ver == current || inv.is_empty() {
            continue; // same code — replays fine after a crash restart
        }
        let url = format!(
            "{}/invocations/{}?mode=kill",
            state.config.restate_admin_url.trim_end_matches('/'),
            inv
        );
        // Graceful cancel cannot reach an invocation stuck in journal-mismatch
        // backoff (RT0016); a hard kill is the only reliable way to free the
        // chat key.
        match reqwest::Client::new().delete(&url).send().await {
            Ok(resp) => tracing::info!("killed stale chat generation {inv} (deploy changed): {}", resp.status()),
            Err(e) => tracing::warn!("kill of stale chat generation {inv} failed: {e}"),
        }
    }
}


/// Spawn the Restate endpoint server for the worker role.
pub async fn spawn_worker(state: AppState) -> anyhow::Result<()> {
    if state.config.internal_token.is_none() {
        anyhow::bail!("worker role requires GUILD_INTERNAL_TOKEN");
    }
    let bind = state
        .config
        .worker_bind
        .parse()
        .map_err(|e| anyhow::anyhow!("bad GUILD_WORKER_BIND: {e}"))?;
    let admin = state.config.restate_admin_url.clone();
    let advertised = state.config.worker_advertised_url.clone();
    // In-flight turns dispatched by an older workflow version cannot replay
    // after this deploy and would jam their chats — purge them first.
    purge_stale_chat_generations(&state).await;
    // Listen first: Restate probes the advertised URI during registration.
    let server = tokio::spawn(async move {
        // One journaled completion can legitimately run for minutes without
        // emitting a Restate command; the default inactivity timeout would
        // abort such runs mid-generation (same reason Acme overrides it).
        let chat_options = ServiceOptions::new()
            .inactivity_timeout(Duration::from_secs(10 * 60))
            .abort_timeout(Duration::from_secs(60));
        HttpServer::new(
            Endpoint::builder()
                .bind(RoutineRunner { state: state.clone() })
                .bind(
                    ChatRunner { state }
                        .into_service_definition()
                        .options(chat_options),
                )
                .build(),
        )
        .listen_and_serve(bind)
        .await;
    });
    register_with_restate(&admin, &advertised).await?;
    server.await?;
    Ok(())
}
