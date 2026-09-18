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
use crate::http::gateway::{clear_pending_tool, enforce_quota, note_pending_tool};
use crate::integrations;
use crate::state::AppState;
use crate::worker::exec_policy_gate;
use crate::worker::executor::{tool_registry, Completion, RoutineConfig, RoutineExecutor};
use crate::worker::overflow::is_context_overflow;
use crate::worker::run::MAX_STEPS;
use futures::StreamExt;
use guild_core::agent::policy::ApprovalPolicy;
use guild_core::provider::{ModelProvider, ProviderChunk, ProviderRequest};
use guild_core::tools::Approval;
use guild_core::usage::UsageEvent;
use protocol::api::{
    Block, Message, MessageAttachment, MessageAudio, StreamEvent, ThreadEvent, ToolCall,
    ToolExecutor, ToolKind, ToolSpec, UsagePayload,
};
use restate_sdk::errors::HandlerError;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use restate_sdk::service::IntoServiceDefinition;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;
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
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: Some(c.tool_calls.clone()),
                tool_call_id: None,
                reasoning: None,
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
    #[serde(default)]
    pub user_message_id: Option<Uuid>,
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
    /// The chat's project (named workspace folder); the folder is resolved
    /// journaled from the projects table and names the workspace in the
    /// system prompt + the tool dispatches.
    #[serde(default)]
    pub project_id: Option<Uuid>,
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
    /// The user turn content. Persisted as a `user_message` thread event by
    /// the journaled generate step (the gateway HTTP handler does NOT write
    /// events — spec §B.4), so attach/replay stays consistent.
    #[serde(default)]
    pub user_message: String,
    /// Context attachments uploaded beforehand (ids validated against this
    /// chat); documents' text is inlined into the turn, image/audio parts
    /// ride on the model-facing Message when the route supports the
    /// modality (spec §4.3).
    #[serde(default)]
    pub attachment_ids: Vec<Uuid>,
    /// Client-discovered local-skills index; appended to the system prompt
    /// after the hard cap (the server stays the enforcement point).
    #[serde(default)]
    pub skills_index: Option<String>,
    /// Client-discovered AGENTS.md instructions (global config-dir file +
    /// project chain, Codex semantics); rendered into the system prompt with
    /// the `# AGENTS.md instructions` markers and the server's hard cap.
    #[serde(default)]
    pub agents_md: Option<String>,
    /// Server-local execution (batch backend, spec 2026-09-18 unification
    /// §4 phase 4): the NAME of the org workspace the server itself
    /// executes tools in — resolved server-side, never a client path.
    #[serde(default)]
    pub server_workspace: Option<String>,
}

/// Final result of the journaled completion step.
#[derive(Serialize, Deserialize, Clone)]
struct CompletionOut {
    text: String,
    tool_calls: Vec<ToolCall>,
    tokens_in: u32,
    tokens_out: u32,
    reasoning: String,
    /// The turn was stopped mid-stream: the text/reasoning carry the
    /// delivered prefix only. Serde default keeps old journals parseable.
    #[serde(default)]
    stopped: bool,
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

/// Terminal failure BEFORE the turn loop: the uniform failure path below the
/// turn never runs, so the chat's generation lock must be released here or
/// the chat stays "generation_in_progress" until a restart.
fn api_terminal_free_chat(state: &AppState, chat_id: Uuid, e: ApiError) -> HandlerError {
    state.generations.remove(chat_id);
    api_terminal(e)
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
    /// Image parts (data URIs) the executing client attached — persisted on
    /// the tool_result event and sent to vision-capable models.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
}

/// Body of the `complete_tool` handler.
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolResultReq {
    pub call_id: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
    /// Widget payload from the executing client, persisted verbatim on the
    /// `tool_result` event (spec §C.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// Image parts (data URIs) read_file attached; sent to models whose
    /// route supports the image modality, dropped otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// Body of the `complete_approval` handler (phase 2 gate): a user decision
/// from any attached client (or the timeout's auto-deny). First answer wins;
/// late answers and replays after cleanup no-op. Sent one-way from the HTTP
/// approvals endpoint; resolves the ChatRunner's `approval:{call_id}`
/// awakeable. Shared with the timeout auto-deny.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ApprovalReq {
    pub call_id: String,
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Body of the `compact` handler (phase 3, design §C): a fire-and-forget
/// compaction request — no user turn, no streaming client. Sent one-way
/// from the HTTP gateway endpoint.
#[derive(Serialize, Deserialize, Clone)]
pub struct CompactReq {
    pub org_id: Uuid,
    pub chat_id: Uuid,
}

/// Compaction prompt (design §C): one non-streaming summarization call over
/// the FULL pre-compaction history; the reply becomes the durable summary.
pub(crate) const COMPACTION_PROMPT: &str = "Summarize this conversation for continuation by a coding agent. Capture: the user's goals and decisions, key facts and artifacts (paths, versions, identifiers), open questions, and the current state / next step. Be factual and compact. Do not answer as if replying to the user.";

/// How many message-bearing events immediately before the compaction event
/// stay in context verbatim (the dsh retained-tail pattern).
pub(crate) const COMPACTION_KEEP_LAST: u32 = 4;

/// Minimum message-bearing messages a history needs before compacting is
/// meaningful (design §C) — a summary of less is a summary of nothing.
pub(crate) const COMPACTION_MIN_MESSAGES: usize = 4;

/// Pure helper: the model of the LATEST `assistant_message` event (design
/// §C — compaction defaults to the model the thread was last run with, so
/// the summarizer is never a surprise provider).
pub(crate) fn latest_assistant_model(events: &[ThreadEvent]) -> Option<String> {
    events.iter().rev().find_map(|ev| match ev {
        ThreadEvent::AssistantMessage { model, .. } => Some(model.clone()),
        _ => None,
    })
}

/// Pure helper: message-bearing entries (user / assistant / tool — anything
/// the model reads as a turn) in a model-facing history.
pub(crate) fn message_bearing_count(history: &[Message]) -> usize {
    history
        .iter()
        .filter(|m| matches!(m.role.as_str(), "user" | "assistant" | "tool"))
        .count()
}

/// Pure core of the too-short rejection (design §C).
pub(crate) fn too_short_to_compact(history: &[Message]) -> bool {
    message_bearing_count(history) < COMPACTION_MIN_MESSAGES
}

/// Tokens held back for the model's reply when auto-compacting (pi's
/// reserveTokens semantics).
pub(crate) const CONTEXT_RESERVE_TOKENS: i64 = 16_384;

/// Auto-compact threshold: compact once per turn when the
/// last known request size crosses the route's window minus the 16k reserve.
pub(crate) fn should_auto_compact(last_tokens: u32, window: i64, compacted: bool) -> bool {
    if compacted {
        return false;
    }
    let threshold = window.saturating_sub(CONTEXT_RESERVE_TOKENS).max(0);
    last_tokens > threshold as u32
}

/// Pure helper: `usage.tokens_in` of the LATEST `assistant_message` event —
/// the last known model-request size (initialized from the latest turn).
pub(crate) fn latest_tokens_in(events: &[ThreadEvent]) -> u32 {
    events
        .iter()
        .rev()
        .find_map(|ev| match ev {
            ThreadEvent::AssistantMessage { usage, .. } => usage.tokens_in,
            _ => None,
        })
        .unwrap_or(0)
}

/// Resolution payload of an approval awakeable — what the suspended turn
/// reads when the decision arrives.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct ApprovalResolution {
    approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Pure dedupe core of `complete_approval`: a present state key (the
/// awakeable id) yields resolve+clear; an absent key (first answer already
/// won, timed out, or nobody waiting) is a no-op. The handler performs the
/// clear itself — virtual-object serialization makes read+clear atomic
/// against other decision deliveries.
fn approval_on_decision(
    pending: Option<String>,
    req: ApprovalReq,
) -> Option<(String, ApprovalResolution)> {
    pending.map(|awakeable_id| {
        (
            awakeable_id,
            ApprovalResolution {
                approved: req.approved,
                reason: req.reason,
            },
        )
    })
}

/// How long the loop waits for a client to execute a client-side tool.
pub(crate) const CLIENT_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// How long the approval gate waits for a user decision before auto-denying.
pub(crate) const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn client_tool_names() -> &'static [&'static str] {
    &["read_file", "execute", "edit_file", "write_file"]
}

fn state_key(call_id: &str) -> String {
    format!("pending_tool:{call_id}")
}

/// K/V state key holding the awakeable id of a pending approval decision.
fn approval_state_key(call_id: &str) -> String {
    format!("approval:{call_id}")
}

/// Server default approval policy for client tools (design §A): read-only
/// tools flow, state-changing tools ask.
fn server_default_policy() -> ApprovalPolicy {
    serde_json::from_value(json!({
        "default": "ask",
        "overrides": { "read_file": "allow" }
    }))
    .expect("server default policy is valid")
}

/// Effective policy for a user: the user's stored policy (migration 0026 —
/// approval is user-scoped, it applies to every chat they run), or the server
/// default when unset or unreadable (the safe direction — default ask).
fn resolve_policy(stored: Option<Value>) -> ApprovalPolicy {
    match stored {
        Some(v) => serde_json::from_value(v).unwrap_or_else(|e| {
            tracing::warn!("unreadable user approval policy, using server default: {e}");
            server_default_policy()
        }),
        None => server_default_policy(),
    }
}

/// Org KV key holding the admin-configured assistant persona prompt
/// (admin API owns the same constant — keep in sync or re-export).
pub const ASSISTANT_PROMPT_KEY: &str = "assistant_system_prompt";

/// Org KV key holding the admin-configured "Approve for me" policy prompt —
/// the instruction the auto-approval judge runs under when a chat's approval
/// mode is `approve_for_me` (admin API owns the same constant).
pub const APPROVAL_POLICY_PROMPT_KEY: &str = "assistant_approval_policy_prompt";

/// Built-in "Approve for me" policy prompt (codex-style: only escalate
/// potentially unsafe actions). Admin-tunable in Assistant settings.
pub const DEFAULT_APPROVAL_POLICY_PROMPT: &str = "You are the safety gate for an AI assistant that runs tools on the user's machine. You are given one proposed tool action as JSON. Decide whether it is safe to run automatically, without asking the user first.\n\nApprove routine, low-risk actions: reading files, ordinary read-only shell commands (ls, dir, cat, git status, git log, ping, date), writing or editing files inside the user's workspace, web searches, and fetching public URLs.\n\nAsk the user when the action is potentially unsafe: destructive or irreversible operations (deleting files or data, force-pushing, dropping or truncating databases, factory resets), anything touching files outside the workspace or system locations, installing or upgrading software, killing processes or services, sending credentials or secrets anywhere, spending money, sending messages or email on the user's behalf, or anything unusual for a coding assistant.\n\nReply with ONLY a JSON object, no other text: {\"approve\": true, \"reason\": \"one short sentence\"} where approve=true means run it silently and approve=false means the user must be asked first.";

/// The workspace reference resolved from the chat's project: folder plus
/// the machine's registry label.
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkspaceRef {
    pub folder: String,
    pub machine_label: Option<String>,
}

/// Pure helper: a WSL UNC folder (`\\wsl.localhost\<distro>\…`, the legacy
/// `\\wsl$\<distro>\…`, either slash direction, case-insensitive, or the
/// `\\?\UNC\` device form Windows canonicalize returns) parses to the
/// distro and the inner Linux path. Any other path is not WSL. Mirrors
/// guild-core's `workspace::parse_wsl` — the same literal must classify the
/// same way here and in the tools.
pub(crate) fn parse_wsl_unc(folder: &str) -> Option<(String, String)> {
    let mut norm = folder.replace('\\', "/");
    // Device-form UNC: treat it as the plain `//` form, case-insensitively.
    // Byte-wise so a multibyte character straddling the slice boundary
    // cannot panic.
    if norm.as_bytes().get(..8).is_some_and(|p| p.eq_ignore_ascii_case(b"//?/unc/")) {
        norm = format!("//{}", &norm[8..]);
    }
    let low = norm.to_ascii_lowercase();
    const P_STD: &str = "//wsl.localhost/";
    const P_LEGACY: &str = "//wsl$/";
    let after = if low.starts_with(P_STD) {
        P_STD.len()
    } else if low.starts_with(P_LEGACY) {
        P_LEGACY.len()
    } else {
        return None;
    };
    let mut parts = norm[after..].split('/').filter(|p| !p.is_empty());
    let distro = parts.next()?;
    let inner = format!("/{}", parts.collect::<Vec<_>>().join("/"));
    Some((distro.to_string(), inner))
}

/// Journaled project resolution: one org-scoped read of the project's
/// folder plus its machine's registry label. The ChatRunner's turn start
/// calls this inside `ctx.run`; tests pin the dispatch workdir through it.
pub(crate) async fn resolve_workspace(
    state: &AppState,
    org_id: Uuid,
    project_id: Option<Uuid>,
) -> Result<Option<WorkspaceRef>, ApiError> {
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let store = state.store().await?;
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT p.folder, m.label \
         FROM projects p \
         LEFT JOIN machines m ON m.machine_id = p.machine_id \
         WHERE p.id = $1 AND p.org_id = $2",
    )
    .bind(project_id)
    .bind(org_id)
    .fetch_optional(store.pool())
    .await?;
    Ok(row.map(|(folder, machine_label)| WorkspaceRef {
        folder,
        machine_label,
    }))
}

/// Pure helper: the system-prompt sentence naming the workspace. A WSL UNC
/// folder is parsed so the model sees the inner Linux path and knows shell
/// commands run inside the distro; a plain folder keeps the plain sentence.
pub(crate) fn workspace_sentence(folder: &str, machine_label: Option<&str>) -> String {
    match parse_wsl_unc(folder) {
        Some((distro, inner)) => {
            let machine = machine_label
                .map(|l| format!(" on machine `{l}`"))
                .unwrap_or_default();
            format!(
                " The workspace is `{inner}` inside WSL distro `{distro}`{machine}; \
                 shell commands run inside that distro."
            )
        }
        None => format!(" The workspace directory is {folder}."),
    }
}

/// Server-owned system prompt (the client never sends one). Without it small
/// models fall back to generic web-assistant behavior even with the full tool
/// surface declared — they need the role, the workspace, and when to use
/// which tool class spelled out. The persona sentence comes from the org's
/// admin-configured prompt when set (via the admin API); the operational
/// instructions below are always appended and are not admin-editable.
fn build_system_prompt(
    org_prompt: Option<&str>,
    client_tools: bool,
    sandbox_tools: bool,
    has_web_search: bool,
    server_workspace: Option<&str>,
    workspace: Option<&WorkspaceRef>,
    integrations_index: &str,
    skills_index: &str,
    agents_md: Option<&str>,
) -> String {
    let persona = match org_prompt {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => {
            "You are a helpful assistant. Answer concisely and help with the \
              user's tasks, including software work when asked."
        }
    };
    let mut s = String::from(persona);
    if server_workspace.is_some() {
        s.push_str(
            " You have tools (read_file, execute, edit_file, write_file) that execute on \
             the Guild server inside your org's private workspace directory. Inspect the \
             workspace with them BEFORE answering anything that could be about \
             the workspace's files.",
        );
    } else if sandbox_tools {
        s.push_str(
            " You have tools (read_file, execute, edit_file, write_file) that execute on \
             the Guild server inside a private per-chat sandbox workspace directory. \
             Inspect it with them BEFORE answering anything that could be about files. \
             Commands may require the user's approval.",
        );
    } else if client_tools {
        s.push_str(
            " You have tools (read_file, execute, edit_file, write_file) that execute on \
             the user's machine via the Guild desktop executor — you never run \
             anything yourself and there is no sandbox on your side. Inspect the \
             workspace with them BEFORE answering anything that could be about \
             the user's project or files. If a tool fails because the machine is \
             offline or unbound, say so plainly — never invent an execution \
             environment.",
        );
    }
    if has_web_search {
        s.push_str(
            " Use web-search tools (kind web_search) only for general or \
             current-events knowledge, never as a substitute for looking at \
             the workspace.",
        );
    }
    // AGENTS.md instructions (Codex semantics): rendered with the same
    // user-instructions markers Codex uses, before the environment context
    // (the workspace sentence). Client-assembled — global config-dir file
    // plus the project chain — but the server caps and owns the framing.
    if let Some(md) = agents_md {
        if !md.trim().is_empty() {
            let capped = cap_chars(md, AGENTS_MD_CAP);
            s.push_str(&format!(
                "\n\n# AGENTS.md instructions{}\n\n<INSTRUCTIONS>\n{}\n</INSTRUCTIONS>",
                workspace
                    .map(|ws| format!(" for {}", ws.folder))
                    .unwrap_or_default(),
                capped,
            ));
        }
    }
    if let Some(ws) = workspace {
        s.push_str(&workspace_sentence(&ws.folder, ws.machine_label.as_deref()));
    }
    if !integrations_index.is_empty() {
        s.push_str(" Enabled integrations (their tools are discovered on demand):");
        for line in integrations_index.lines() {
            s.push_str(&format!("\n- {line}"));
        }
    }
    // Skills index: client-discovered local skills, appended additively and
    // hard-capped here (8k chars — the same budget Codex applies when the
    // context window is unknown). The client never overrides the prompt; a
    // truncated index is preferable to an unbounded one.
    if !skills_index.is_empty() {
        let capped = cap_chars(skills_index, SKILLS_INDEX_CAP);
        s.push('\n');
        s.push_str(&capped);
    }
    s
}

/// Truncates to `cap` chars on a char boundary.
fn cap_chars(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let mut cut = cap;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].to_string()
}

/// Hard cap on the client-supplied skills index appended to the system
/// prompt (chars). Matches the Codex fallback budget.
const SKILLS_INDEX_CAP: usize = 8_000;

/// Hard cap on the client-supplied AGENTS.md instructions (chars). Matches
/// Codex's `project_doc_max_bytes` default — the client applies the same
/// budget at discovery; the server stays the enforcement point.
const AGENTS_MD_CAP: usize = 32 * 1024;

/// Next turn number for a chat: max `turn` across persisted events + 1
/// (spec §B.4 — turn = one client request, step = one model call).
pub fn next_turn(events: &[ThreadEvent]) -> u32 {
    events
        .iter()
        .map(|e| match e {
            ThreadEvent::AssistantMessage { turn, .. } | ThreadEvent::ToolResult { turn, .. } => {
                *turn
            }
            _ => 0,
        })
        .max()
        .unwrap_or(0)
        + 1
}

/// Whether user turns are queued for the next turn: true when the last
/// turn-bearing event (user message, assistant message, tool result) is a
/// user message — i.e. sends that committed while a turn ran and were never
/// answered. The finishing turn's epilogue flushes them.
pub(crate) fn has_queued_user_turn(events: &[ThreadEvent]) -> bool {
    matches!(
        events
            .iter()
            .rev()
            .find(|e| matches!(
                e,
                ThreadEvent::UserMessage { .. }
                    | ThreadEvent::AssistantMessage { .. }
                    | ThreadEvent::ToolResult { .. }
            )),
        Some(ThreadEvent::UserMessage { .. })
    )
}

/// Model-facing history derived from the thread event log (spec §A.4, §B of
/// the compaction design): user → `role:user`; assistant blocks →
/// `role:assistant` with concatenated text blocks, `tool_calls` from the
/// tool_call blocks, and reasoning carried on the message so openai.rs
/// replays it as `reasoning_content` (never dropped, dsh rule); tool_result →
/// `role:tool`. SystemMessage and approval events are log-only — the system
/// prompt rides on the request header, not in message history.
///
/// Compaction checkpoints (design §B): message-bearing events are buffered
/// until a `Compaction` event, which replaces the buffer with a summary
/// user message plus the verbatim tail of the last `keep_last.unwrap_or(4)`
/// buffered messages (older ones are folded into the summary and dropped).
/// Multiple compactions compose — each applies at its position to the
/// segment accumulated since the previous one. Events after the last
/// compaction flow exactly as in the uncompacted derivation.
/// Loaded attachment bytes for the current turn, wire-ready: base64 plus
/// the content type (data URIs and audio parts are derived at use time,
/// gated by the resolved route's modalities). Values are journaled (the
/// run result carries the base64), so map loads must happen inside `run`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct MediaRef {
    pub mime: String,
    pub b64: String,
}

impl MediaRef {
    pub fn decoded(&self) -> Vec<u8> {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(&self.b64)
            .unwrap_or_default()
    }
}

pub type MediaMap = std::collections::HashMap<Uuid, MediaRef>;

/// Attachment modality class from the content type.
pub fn modality_of(content_type: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("image/") {
        "image"
    } else if ct.starts_with("audio/") {
        "audio"
    } else if ct.starts_with("video/") {
        "video"
    } else {
        "document"
    }
}

/// OpenAI `input_audio` accepts wav/mp3 only.
fn audio_format(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some("wav"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        _ => None,
    }
}

/// Model-facing image/audio parts for a turn's attachments, gated by the
/// route's native modalities. Unsupported media stays in the log and in
/// object storage (later: code-execution tooling), never silently deleted —
/// it just does not reach this model.
pub fn media_parts(
    media: &MediaMap,
    atts: &[MessageAttachment],
    modalities: &[String],
) -> (Vec<String>, Vec<MessageAudio>) {
    let mut images = Vec::new();
    let mut audio = Vec::new();
    for a in atts {
        let Some(m) = media.get(&a.id) else { continue };
        let supported = modalities.iter().any(|x| x == &a.modality);
        match a.modality.as_str() {
            "image" if supported => {
                images.push(format!("data:{};base64,{}", m.mime, m.b64));
            }
            "audio" if supported => {
                if let Some(f) = audio_format(&m.mime) {
                    audio.push(MessageAudio {
                        data: m.b64.clone(),
                        format: f.to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    (images, audio)
}

/// Inline cap for one document attachment's textual content (chars) — a
/// single huge file must not blow the context window by itself.
const ATTACHMENT_INLINE_LIMIT: usize = 80_000;

/// Whether a document attachment's content is textual and can be inlined.
fn attachment_is_textual(content_type: &str, filename: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("text/") {
        return true;
    }
    if matches!(
        ct.as_str(),
        "application/json"
            | "application/xml"
            | "application/yaml"
            | "application/x-yaml"
            | "application/javascript"
            | "application/toml"
            | "application/sql"
            | "application/x-sh"
    ) {
        return true;
    }
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "txt"
            | "json"
            | "rs"
            | "py"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "toml"
            | "yaml"
            | "yml"
            | "csv"
            | "tsv"
            | "log"
            | "sh"
            | "bash"
            | "sql"
            | "html"
            | "htm"
            | "css"
            | "xml"
            | "ini"
            | "conf"
            | "env"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "go"
            | "java"
            | "rb"
            | "php"
            | "swift"
            | "kt"
            | "proto"
            | "gradle"
            | "lock"
            | "gitignore"
            | "dockerfile"
            | "makefile"
            | "patch"
            | "diff"
    )
}

/// Builds the arrival-turn user event from the requested attachment ids
/// (in the chat's attachment order): chip metadata plus the text appended
/// to the typed message (inlined document text, or a note for media).
/// The marker `"\n\n[Attachment: "` is the UI's strip boundary — clients
/// render the typed text plus chips, not the wire text.
pub fn build_turn_text(
    requested: &[Uuid],
    media: &MediaMap,
    rows: &[(Uuid, String, String, i64)], // (id, filename, content_type, size)
    modalities: &[String],
) -> (Vec<MessageAttachment>, String) {
    let mut chips = Vec::new();
    let mut blocks = Vec::new();
    for (id, filename, content_type, size) in rows {
        if !requested.contains(id) {
            continue;
        }
        let modality = modality_of(content_type);
        chips.push(MessageAttachment {
            id: *id,
            filename: filename.clone(),
            content_type: content_type.clone(),
            size_bytes: *size,
            modality: modality.to_string(),
        });
        match modality {
            "document" => {
                let mut text = media
                    .get(id)
                    .map(|m| String::from_utf8_lossy(&m.decoded()).into_owned())
                    .unwrap_or_default();
                if text.chars().count() > ATTACHMENT_INLINE_LIMIT {
                    text = text.chars().take(ATTACHMENT_INLINE_LIMIT).collect();
                    text.push_str("\n…[truncated]");
                }
                if attachment_is_textual(content_type, filename) && !text.is_empty() {
                    blocks.push(format!(
                        "[Attachment: {} ({}, {} bytes)]\n{}",
                        filename, content_type, size, text
                    ));
                } else {
                    blocks.push(format!(
                        "[Attachment: {} ({}, {} bytes) — content not inlined]",
                        filename, content_type, size
                    ));
                }
            }
            m => {
                let supported = modalities.iter().any(|x| *x == m);
                let note = if supported {
                    match m {
                        "image" => "shown to the model as an image",
                        "audio" => "provided to the model as audio",
                        _ => "no native modality on this route",
                    }
                } else {
                    "stored; this model does not accept this modality"
                };
                blocks.push(format!(
                    "[Attachment: {} ({}, {} bytes) — {}]",
                    filename, content_type, size, note
                ));
            }
        }
    }
    let text = if blocks.is_empty() {
        String::new()
    } else {
        blocks.join("\n\n")
    };
    (chips, text)
}

/// Journaled-loadable attachment bytes for one chat: every image/audio
/// attachment referenced by `events` (derivation replays them as parts on
/// every subsequent turn) plus every id in `extra_ids` (the arrival turn;
/// documents need their bytes for inlining). Bytes are immutable once
/// uploaded, so the read is replay-deterministic.
pub async fn load_media_map(
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    events: &[ThreadEvent],
    extra_ids: &[Uuid],
) -> Result<MediaMap, ApiError> {
    let mut ids: Vec<Uuid> = Vec::new();
    for ev in events {
        if let ThreadEvent::UserMessage { attachments, .. } = ev {
            for a in attachments {
                if a.modality == "image" || a.modality == "audio" {
                    ids.push(a.id);
                }
            }
        }
    }
    ids.extend(extra_ids.iter().copied());
    if ids.is_empty() {
        return Ok(MediaMap::new());
    }
    let store = state.store().await?;
    let rows = store.attachments().list(org_id, chat_id).await?;
    let objects = state.objects().await?;
    let mut map = MediaMap::new();
    for row in rows {
        if !ids.contains(&row.id) {
            continue;
        }
        let key = crate::store::attachments::object_key(org_id, row.id, &row.filename);
        let Ok(bytes) = objects.get(&key).await else {
            continue;
        };
        use base64::Engine as _;
        map.insert(
            row.id,
            MediaRef {
                mime: row.content_type.clone(),
                b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
        );
    }
    Ok(map)
}

/// Builds the model-facing history from the event log. `media` carries the
/// bytes of image/audio attachments referenced by the events (loaded
/// journaled by the caller); `modalities` gates which parts actually ride
/// on the wire — unsupported media stays a text note.
pub fn build_model_history(
    events: &[ThreadEvent],
    media: &MediaMap,
    modalities: &[String],
) -> Vec<Message> {
    let mut out = Vec::new();
    // Message-bearing Messages since the last compaction (or thread start).
    let mut buffer: Vec<Message> = Vec::new();
    for ev in events {
        match ev {
            ThreadEvent::UserMessage {
                content,
                attachments,
            } => {
                let (images, audio) = media_parts(media, attachments, modalities);
                buffer.push(
                    Message::user(content.clone())
                        .with_images(images)
                        .with_audio(audio),
                );
            }
            ThreadEvent::SystemMessage { .. } => {}
            // Log-only lifecycle records: never part of model-facing history.
            ThreadEvent::ApprovalRequest { .. } | ThreadEvent::ApprovalDecision { .. } => {}
            ThreadEvent::Compaction {
                summary, keep_last, ..
            } => {
                // Summary replaces everything before the compaction; the
                // verbatim tail (last keep_last buffered messages) is
                // re-emitted after it; the rest of the buffer is dropped.
                // tokens_before/model/usage are informational — ignored here.
                out.push(Message::user(format!(
                    "[Conversation summary so far]\n\n{summary}"
                )));
                let keep = usize::try_from(keep_last.unwrap_or(4)).unwrap_or(usize::MAX);
                let tail_start = buffer.len().saturating_sub(keep);
                out.extend(buffer.split_off(tail_start));
                buffer.clear();
            }
            ThreadEvent::AssistantMessage { blocks, .. } => {
                let mut text = String::new();
                let mut reasoning = String::new();
                let mut tool_calls = Vec::new();
                for b in blocks {
                    match b {
                        Block::Text { text: t } => text.push_str(t),
                        Block::Reasoning { text: t } => reasoning.push_str(t),
                        Block::ToolCall {
                            id,
                            name,
                            arguments,
                        } => {
                            // arguments are the raw JSON string as produced by
                            // the model; parse for the wire, fall back to a
                            // JSON string on garbage rather than dropping.
                            let arguments = serde_json::from_str(arguments)
                                .unwrap_or_else(|_| Value::String(arguments.clone()));
                            tool_calls.push(ToolCall {
                                id: id.clone(),
                                name: name.clone(),
                                arguments,
                            });
                        }
                    }
                }
                buffer.push(Message {
                    role: "assistant".into(),
                    content: text,
                    images: Vec::new(),
                    audio: Vec::new(),
                    tool_calls: if tool_calls.is_empty() {
                        None
                    } else {
                        Some(tool_calls)
                    },
                    tool_call_id: None,
                    reasoning: if reasoning.is_empty() {
                        None
                    } else {
                        Some(reasoning)
                    },
                });
            }
            ThreadEvent::ToolResult {
                call_id,
                content,
                images,
                ..
            } => {
                buffer.push(Message::tool_result(call_id, content).with_images(images.clone()));
            }
        }
    }
    // No further compaction: everything buffered flows as today.
    out.extend(buffer);
    out
}

/// Assistant blocks in stream order (spec §B.4): `[reasoning?, text?,
/// tool_call*]`, empty blocks skipped.
fn assistant_blocks(reasoning: &str, text: &str, tool_calls: &[ToolCall]) -> Vec<Block> {
    let mut blocks = Vec::new();
    if !reasoning.is_empty() {
        blocks.push(Block::Reasoning {
            text: reasoning.to_string(),
        });
    }
    if !text.is_empty() {
        blocks.push(Block::Text {
            text: text.to_string(),
        });
    }
    for c in tool_calls {
        blocks.push(Block::ToolCall {
            id: c.id.clone(),
            name: c.name.clone(),
            arguments: serde_json::to_string(&c.arguments).unwrap_or_default(),
        });
    }
    blocks
}

/// Journaled step: flip the chat's generating flag (thread-list spinner).
/// Idempotent — replays re-run it harmlessly; the store no-ops + stays
/// silent when the flag already holds the target value.
macro_rules! set_generating_step {
    ($ctx:expr, $state:expr, $req:expr, $value:expr) => {{
        let st = $state.clone();
        let org = $req.org_id;
        let chat_id = $req.chat_id;
        let value = $value;
        $ctx.run(move || {
            let state = st.clone();
            async move {
                state
                    .store()
                    .await
                    .map_err(api_err)?
                    .chats()
                    .set_generating(org, chat_id, value)
                    .await
                    .map_err(api_err)?;
                Ok(Json(()))
            }
        })
        .await?
        .into_inner();
    }};
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

/// Journaled load of a chat's full thread event log (shared by the turn
/// start, auto-compaction and the compact handler).
macro_rules! journaled_load_events {
    ($ctx:expr, $state:expr, $org:expr, $chat_id:expr) => {{
        let st = ($state).clone();
        let org = ($org);
        let chat_id = ($chat_id);
        ($ctx)
            .run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let rows = store
                        .thread()
                        .list_events(org, chat_id)
                        .await
                        .map_err(api_err)?;
                    Ok(Json(rows.into_iter().map(|r| r.event).collect::<Vec<_>>()))
                }
            })
            .await?
            .into_inner()
    }};
}

/// Shared compaction core: summarizes the model-facing history
/// derived from `events` with one journaled non-streaming model call and
/// appends the durable `Compaction` checkpoint. Used by the explicit
/// `compact` handler AND by the auto-compaction paths inside `generate`
/// (threshold + overflow retry). Caller has already loaded the events.
pub(crate) async fn compact_core(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    events: &[ThreadEvent],
) -> HandlerResult<()> {
    let history = build_model_history(events, &MediaMap::new(), &[]);

    // (b) Too-short threads cannot be compacted meaningfully.
    if too_short_to_compact(&history) {
        return Err(TerminalError::new("thread too short to compact").into());
    }

    // (c) Model selection (journaled, mirrors generate): the thread's
    // latest assistant model; when no assistant event names one, fall
    // back to the org's first enabled route. Route + quota resolved like
    // any turn — on failure nothing is freed (no lock was taken).
    let st = state.clone();
    let chosen = latest_assistant_model(events);
    let (model, route) = ctx
        .run(move || {
            let state = st.clone();
            async move {
                let store = state.store().await.map_err(api_err)?;
                let model = match chosen {
                    Some(m) => m,
                    None => {
                        let models = store.gateway().list_models(org_id).await?;
                        models.into_iter().next().ok_or_else(|| {
                            HandlerError::from(TerminalError::new("no enabled route for this org"))
                        })?
                    }
                };
                let master = state.config.master_key()?;
                let route = store
                    .gateway()
                    .resolve_route(org_id, &model, &master)
                    .await
                    .map_err(api_terminal)?;
                enforce_quota(&state, org_id, &model, &route)
                    .await
                    .map_err(api_terminal)?;
                // Journal the non-secret projection only: Restate persists
                // step outputs, and the decrypted key must not land there.
                Ok(Json((model, route.meta())))
            }
        })
        .await?
        .into_inner();

    // (d) Journaled: ONE non-streaming model call with the compaction
    // prompt — same provider machinery as generate (accumulate the
    // stream), but nothing is broadcast and no buffers/lock exist. The
    // key is resolved here, inside the step, never journaled.
    let st2 = state.clone();
    let model2 = model.clone();
    let msgs = history.clone();
    let (summary, tokens_in, tokens_out) = ctx
        .run(move || {
            let state = st2.clone();
            let model = model2.clone();
            async move {
                let store = state.store().await.map_err(api_err)?;
                let master = state.config.master_key()?;
                let route = store
                    .gateway()
                    .resolve_route(org_id, &model, &master)
                    .await
                    .map_err(|e| {
                        HandlerError::from(TerminalError::new(format!(
                            "route re-resolve failed: {e:?}"
                        )))
                    })?;
                let provider: Arc<dyn ModelProvider> =
                    guild_core::provider::for_protocol(&route.protocol).ok_or_else(|| {
                        TerminalError::new(format!("unknown protocol {}", route.protocol))
                    })?;
                let preq = ProviderRequest {
                    model: &model,
                    system: Some(COMPACTION_PROMPT),
                    messages: &msgs,
                    api_key: &route.api_key,
                    base_url: &route.base_url,
                    tools: None,
                    max_tokens: 0,
                };
                let stream = provider.chat_stream(preq).await.map_err(|e| {
                    HandlerError::from(TerminalError::new(format!("provider error: {e}")))
                })?;
                let mut text = String::new();
                let mut tokens_in = 0u32;
                let mut tokens_out = 0u32;
                let mut pinned = Box::pin(stream);
                while let Some(item) = pinned.next().await {
                    match item {
                        Ok(ProviderChunk::Text(chunk)) => {
                            if !chunk.text_delta.is_empty() {
                                text.push_str(&chunk.text_delta);
                            }
                            if let Some(t) = chunk.tokens_in {
                                tokens_in = t;
                            }
                            if let Some(t) = chunk.tokens_out {
                                tokens_out = t;
                            }
                        }
                        // Reasoning / tool deltas are not wanted in a
                        // summary — skipped, not accumulated.
                        Ok(_) => {}
                        Err(e) => {
                            return Err(TerminalError::new(format!("provider error: {e}")).into())
                        }
                    }
                }
                Ok(Json((text, tokens_in, tokens_out)))
            }
        })
        .await?
        .into_inner();

    // (e)+(f) Journaled: the durable checkpoint — one `Compaction` event
    // with the summarization usage; NOTHING is broadcast (clients poll
    // GET /thread, design §D/F).
    let st = state.clone();
    let model_name = model;
    let summary2 = summary;
    ctx.run(move || {
        let state = st.clone();
        async move {
            let store = state.store().await.map_err(api_err)?;
            let event = ThreadEvent::Compaction {
                summary: summary2,
                tokens_before: Some(tokens_in),
                keep_last: Some(COMPACTION_KEEP_LAST),
                model: Some(model_name),
                usage: Some(UsagePayload {
                    tokens_in: Some(tokens_in),
                    tokens_out: Some(tokens_out),
                    cost_usd: Some(UsageEvent::cost_usd(
                        tokens_in,
                        tokens_out,
                        route.price_in,
                        route.price_out,
                    )),
                }),
            };
            store
                .thread()
                .append_event(chat_id, &event)
                .await
                .map_err(api_err)?;
            Ok(Json(()))
        }
    })
    .await?;
    Ok(())
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
        let chat_id = req.chat_id;
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
                        .map_err(|e| api_terminal_free_chat(&state, chat_id, e))?;
                    enforce_quota(&state, org, &model, &route)
                        .await
                        .map_err(|e| api_terminal_free_chat(&state, chat_id, e))?;
                    // Journal the non-secret projection only: Restate
                    // persists step outputs, and the decrypted key must not
                    // land there. Provider-call steps re-resolve the key.
                    Ok(Json(route.meta()))
                }
            })
            .await?
            .into_inner();

        // Journaled: load the thread event log; the model-facing history and
        // the next turn number are derivations of it (spec §A.4, §B.4).
        let prior_events = journaled_load_events!(ctx, state, req.org_id, req.chat_id);
        // Queued-turn flushes are invoked with an empty payload turn: the
        // user event is already in the log (the gateway commits it at queue
        // time). A flush with nothing queued to run is a duplicate (a queued
        // send raced the finishing turn's own flush and both fired) — end
        // quietly instead of generating an answer with no user turn.
        let queued_flush = req.user_message.is_empty() && req.attachment_ids.is_empty();
        if queued_flush && !has_queued_user_turn(&prior_events) {
            clear_chatgen_kv!(ctx, state, req.chat_id);
            state.generations.remove(req.chat_id);
            set_generating_step!(ctx, state, req, false);
            return Ok(());
        }
        let turn_no = next_turn(&prior_events);
        // Attachment media: a plain read of immutable object bytes (no
        // delete path exists, so replay re-reads identical data). Covers
        // the arrival turn's requested ids plus every prior image/audio
        // attachment — derivation replays media parts on every turn.
        let media_map = load_media_map(
            &state,
            req.org_id,
            req.chat_id,
            &prior_events,
            &req.attachment_ids,
        )
        .await
        .map_err(api_err)?;
        let att_rows: Vec<(Uuid, String, String, i64)> = {
            let store = state.store().await.map_err(api_err)?;
            store
                .attachments()
                .list(req.org_id, req.chat_id)
                .await
                .map_err(api_err)?
                .into_iter()
                .map(|r| (r.id, r.filename, r.content_type, r.size_bytes))
                .collect()
        };
        let (att_chips, inline_text) = build_turn_text(
            &req.attachment_ids,
            &media_map,
            &att_rows,
            &route.modalities,
        );
        let mut messages: Vec<Message> =
            build_model_history(&prior_events, &media_map, &route.modalities);
        // Auto-compact tracking: last known model-request size,
        // initialized from the latest assistant_message usage and updated
        // with each completion's tokens_in; at most one compaction per turn.
        let mut last_context_tokens = latest_tokens_in(&prior_events);
        let mut compacted_this_turn = false;

        // Journaled: resolve this org's enabled plugins — built-in Rust
        // integrations and MCP plugins through one snapshot (tool lists,
        // classes, index lines; no secret values) — plus the caller's
        // identity (email + role for the disclosure filter and the identity
        // envelope). A broken plugin contributes nothing this turn (spec §8).
        let st = state.clone();
        let org = req.org_id;
        let user_id = req.user_id;
        let (plugin_turns, mcp_caller) = ctx
            .run(move || {
                let state = st.clone();
                async move {
                    let turns = integrations::resolve_plugins(&state, org)
                        .await
                        .unwrap_or_default();
                    let store = state.store().await.map_err(api_err)?;
                    let user = store.identity().get_user(user_id).await.map_err(api_err)?;
                    Ok(Json((turns, (user.email, user.role))))
                }
            })
            .await?
            .into_inner();
        let (mcp_caller_email, mcp_caller_role) = mcp_caller;
        let mut tool_specs: Vec<ToolSpec> = Vec::new();
        // Web-search-class tools carry a dedicated prompt instruction; it
        // applies when the caller may actually call one.
        let has_web_search = plugin_turns.iter().any(|turn| {
            turn.allowed_infos(&mcp_caller_role)
                .iter()
                .any(|info| info.spec.kind == ToolKind::WebSearch)
        });
        // Disclosure filter (spec §7): the model never sees tools outside the
        // caller's policy — built-in and MCP tools alike; the auto-tools are
        // Guild-provided (read-class).
        for turn in &plugin_turns {
            tool_specs.extend(turn.allowed_specs(&mcp_caller_role));
            tool_specs.push(ToolSpec {
                name: integrations::namespaced_tool(&turn.slug, "list_tools"),
                description: format!(
                    "List the tools of the {} integration that you may call, with JSON schemas.",
                    turn.slug
                ),
                parameters: serde_json::json!({ "type": "object", "properties": {} }),
                kind: Default::default(),
            });
            tool_specs.push(ToolSpec {
                name: integrations::namespaced_tool(&turn.slug, "guide"),
                description: format!(
                    "Return the usage guide (SKILL.md) for the {} integration.",
                    turn.slug
                ),
                parameters: serde_json::json!({ "type": "object", "properties": {} }),
                kind: Default::default(),
            });
        }

        if req.client_tools || req.machine_id.is_some() || req.server_workspace.is_some() {
            tool_specs.extend(protocol::api::client_tool_specs());
        }
        // Journaled: resolve the chat's project (workspace folder + the
        // machine's registry label) — the approval-join pattern: one SQL
        // read whose result is journaled, so replay stays deterministic
        // even if the row changes later.
        let st = state.clone();
        let org = req.org_id;
        let project_id = req.project_id;
        let workspace: Option<WorkspaceRef> = ctx
            .run(move || {
                let state = st.clone();
                async move {
                    let workspace = resolve_workspace(&state, org, project_id)
                        .await
                        .map_err(api_err)?;
                    Ok(Json(workspace))
                }
            })
            .await?
            .into_inner();
        // Phase 5a (spec 2026-09-18 unification): machine-mediated AGENTS.md
        // fetch. A web chat's caller cannot read files (browser tab), so when
        // no client-assembled chain arrived and the turn runs against a bound
        // project, dispatch ONE read_file for the project's AGENTS.md through
        // the machine channel before the system prompt is built. Cached per
        // project folder (in-memory, TTL-bounded — the machine channel
        // exposes no mtime verb).
        let agents_md: Option<String> =
            if req.agents_md.is_some() || req.server_workspace.is_some() {
                req.agents_md.clone()
            } else {
                fetch_agents_md_via_machine(
                    &ctx,
                    &state,
                    req.chat_id,
                    workspace.clone(),
                    req.machine_id.clone(),
                    turn_no,
                )
                .await?
            };
        let system = {
            // Journaled: resolve the org's admin-configured assistant persona
            // prompt (falls back to the built-in default when unset).
            let st = state.clone();
            let org = req.org_id;
            let org_prompt: Option<String> = ctx
                .run(move || {
                    let state = st.clone();
                    async move {
                        let store = state.store().await.map_err(api_err)?;
                        let p = store
                            .org_kv()
                            .get(org, ASSISTANT_PROMPT_KEY)
                            .await
                            .map_err(api_err)?;
                        Ok(Json(p))
                    }
                })
                .await?
                .into_inner();
            build_system_prompt(
                org_prompt.as_deref(),
                req.client_tools,
                req.client_tools
                    && req.machine_id.is_none()
                    && req.server_workspace.is_none(),
                has_web_search,
                req.server_workspace.as_deref(),
                workspace.as_ref(),
                &plugin_turns
                    .iter()
                    .map(integrations::index_line)
                    .collect::<Vec<_>>()
                    .join("\n"),
                req.skills_index.as_deref().unwrap_or(""),
                agents_md.as_deref(),
            )
        };

        // The user event content is the model-facing turn: typed text plus
        // inlined attachment blocks (the marker is the UI's strip boundary).
        let user_turn_content = match (!req.user_message.is_empty(), !inline_text.is_empty()) {
            (true, true) => format!("{}\n\n{}", req.user_message, inline_text),
            (true, false) => req.user_message.clone(),
            (false, true) => inline_text,
            (false, false) => String::new(),
        };
        // Journaled: append this turn's system + user events (once per turn;
        // the gateway never writes events itself — spec §B.4).
        let st = state.clone();
        let chat_id = req.chat_id;
        let system_ev = ThreadEvent::SystemMessage {
            content: system.clone(),
        };
        let event_content = user_turn_content.clone();
        let ev_chips = att_chips.clone();
        let has_user_event = !event_content.is_empty() || !ev_chips.is_empty();
        let user_message_id = req.user_message_id;
        ctx.run(move || {
            let state = st.clone();
            async move {
                let store = state.store().await.map_err(api_err)?;
                store
                    .thread()
                    .append_event(chat_id, &system_ev)
                    .await
                    .map_err(api_err)?;
                if has_user_event {
                    store
                        .thread()
                        .append_event_with_id(
                            chat_id,
                            &ThreadEvent::UserMessage {
                                content: event_content,
                                attachments: ev_chips,
                            },
                            user_message_id.unwrap_or_else(Uuid::now_v7),
                        )
                        .await
                        .map_err(api_err)?;
                }
                Ok(Json(()))
            }
        })
        .await?;
        // The user turn reaches the model THIS request: history was derived
        // before the append above, so push the turn onto the request messages
        // explicitly (it is already persisted as a user_message event).
        let (turn_images, turn_audio) = media_parts(&media_map, &att_chips, &route.modalities);
        if !user_turn_content.is_empty() || !turn_images.is_empty() || !turn_audio.is_empty() {
            messages.push(
                Message::user(user_turn_content)
                    .with_images(turn_images)
                    .with_audio(turn_audio),
            );
        }

        let generation = state.generations.attach(req.chat_id);
        let tx = generation.tx;
        let text_buf = generation.text;
        let thinking_buf = generation.thinking;
        // Stop requests land on this flag (the stop endpoint and steered
        // sends); every cancel decision below reads it inside a journaled
        // step, so the turn's shape replays deterministically.
        let cancel = generation.cancel;

        // Journaled: the chat is generating from here until the turn exits
        // (final answer, uniform failure, or step limit — each clears it).
        // Set after route/quota resolution: their terminal failures happen
        // before the flag exists, so nothing to clear on that path.
        set_generating_step!(ctx, state, req, true);

        // Returns Ok(()) when the turn ended — a final answer, or a stop
        // request the epilogue below settles. Errors propagate.
        let steps_used = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        // Whether the turn was interrupted by a stop request: the epilogue
        // persists the delivered prefix as an interrupted event and skips
        // usage recording. Set from journaled step outputs only.
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Id of the last persisted assistant event of this turn — the Done
        // frame's message id when a stop lands with nothing partial buffered.
        let last_event_id = std::sync::Arc::new(tokio::sync::Mutex::new(None::<Uuid>));
        // Whether this step's assistant event was already persisted: the
        // interrupted-append in the failure path below must not re-append a
        // turn the log already holds. The flag is reset only just before the
        // model-call streaming starts (next to the buffer resets) — every
        // step-top failure (auto-compact, event reload) still sees the
        // previous step's persist as done, while the streaming window
        // itself (partial delivery, persist failure) stays covered.
        let step_persisted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_out: HandlerResult<()> = async {
        let state = state.clone();
        let mut step: usize = 0;
        loop {
            steps_used.store(step as u32, std::sync::atomic::Ordering::SeqCst);

            // Journaled: stop request observed as a step output, so replay
            // deterministically ends the turn here whatever the flag does
            // later. At a step top nothing partial is buffered — the previous
            // step's events already stand in history.
            let stop_now: bool = {
                let cancel = cancel.clone();
                ctx.run(move || {
                    let stop = cancel.load(std::sync::atomic::Ordering::SeqCst);
                    async move { Ok(Json(stop)) }
                })
                .await?
                .into_inner()
            };
            if stop_now {
                cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                break;
            }

            // Auto-compact, proactive path: before each model call,
            // when the last known request size crossed the route's window
            // minus the 16k reserve, summarize the thread once and re-derive
            // the model-facing messages from the event log.
            let context_window = route.context_window.unwrap_or(128_000);
            if should_auto_compact(last_context_tokens, context_window, compacted_this_turn) {
                let all_events = journaled_load_events!(ctx, state, req.org_id, req.chat_id);
                let history = build_model_history(&all_events, &media_map, &route.modalities);
                if too_short_to_compact(&history) {
                    tracing::warn!(
                        chat = %req.chat_id,
                        "auto-compaction skipped: thread too short to compact"
                    );
                } else {
                    tracing::info!(
                        chat = %req.chat_id,
                        "auto-compaction triggered: {last_context_tokens} > {context_window} - 16384"
                    );
                    compact_core(&ctx, &state, req.org_id, req.chat_id, &all_events).await?;
                    let refreshed = journaled_load_events!(ctx, state, req.org_id, req.chat_id);
                    messages = build_model_history(&refreshed, &media_map, &route.modalities);
                }
                // Either way, do not re-attempt within this turn.
                compacted_this_turn = true;
            }

            // Journaled: one model call with the full tool surface. On a
            // context-overflow provider error: compact once,
            // re-derive messages from the event log, retry the call once.
            let mut msgs = messages.clone();
            let mut retry_compacted = false;
            let completion: CompletionOut = loop {
                let st = state.clone();
                let org2 = req.org_id;
                let model2 = req.model.clone();
                let specs = tool_specs.clone();
                let system2 = system.clone();
                let chat_id = req.chat_id;
                let tx_loop = tx.clone();
                let buf_loop = text_buf.clone();
                let think_loop = thinking_buf.clone();
                let flag_loop = step_persisted.clone();
                let cancel_loop = cancel.clone();
                let attempt_msgs = msgs.clone();
                let call = ctx
                    .run(move || {
                        let state = st.clone();
                        let org = org2;
                        let model = model2.clone();
                        let tx = tx_loop.clone();
                        let text_buf = buf_loop.clone();
                        let thinking_buf = think_loop.clone();
                        let step_persisted = flag_loop.clone();
                        async move {
                        // The key is resolved here, inside the journaled
                        // step — never carried through step outputs.
                        let store = state.store().await.map_err(api_err)?;
                        let master = state.config.master_key()?;
                        let route = store
                            .gateway()
                            .resolve_route(org, &model, &master)
                            .await
                            .map_err(|e| {
                                HandlerError::from(TerminalError::new(format!(
                                    "route re-resolve failed: {e:?}"
                                )))
                            })?;
                        let provider: Arc<dyn ModelProvider> =
                            guild_core::provider::for_protocol(&route.protocol).ok_or_else(|| {
                                TerminalError::new(format!("unknown protocol {}", route.protocol))
                            })?;
                        let preq = ProviderRequest {
                            model: &model,
                            system: Some(system2.as_str()),
                            messages: &attempt_msgs,
                            api_key: &route.api_key,
                            base_url: &route.base_url,
                            tools: Some(&specs),
                            max_tokens: route.max_output_tokens.unwrap_or(0).max(0) as u32,
                        };
                        let stream = provider.chat_stream(preq).await.map_err(|e| {
                            let _ = tx.send(StreamEvent::Error {
                                code: "provider".into(),
                                message: e.to_string(),
                            });
                            // Remove the broadcast entry or the chat keeps a
                            // zombie generation: attach streams would hang
                            // forever with the caret blinking on a dead thread.
                            state.generations.remove(chat_id);
                            HandlerError::from(TerminalError::new(format!("provider error: {e}")))
                        })?;
                        // The model call is about to stream: only now is
                        // the previous step's persist treated as "not this
                        // step's" — from here on a failure delivers a
                        // genuinely partial turn that the failure path
                        // appends as interrupted. Buffers reset first (the
                        // attach catch-up snapshot must not re-serve the
                        // previous step's text), then the flag: the
                        // flag-clear window covers exactly this step's
                        // streaming.
                        *text_buf.write().await = String::new(); // reset per model call
                        *thinking_buf.write().await = String::new();
                        step_persisted.store(false, std::sync::atomic::Ordering::SeqCst);
                        let mut text = String::new();
                        let mut tokens_in = 0u32;
                        let mut tokens_out = 0u32;
                        let mut tool_calls: Vec<ToolCall> = Vec::new();
                        let mut reasoning = String::new();
                        // A stop request truncates the stream at the next
                        // chunk boundary; the delivered prefix stays in the
                        // buffers and persists as an interrupted event.
                        let mut stopped = false;
                        let mut pinned = Box::pin(stream);
                        loop {
                            // Cancel is checked on every chunk AND on a
                            // 250 ms tick — a provider that streams nothing
                            // (slow first token, hung connection) must not
                            // delay a stop past its next chunk.
                            let item = tokio::select! {
                                item = pinned.next() => match item {
                                    Some(item) => item,
                                    None => break,
                                },
                                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                                    if cancel_loop.load(std::sync::atomic::Ordering::SeqCst) {
                                        stopped = true;
                                        break;
                                    }
                                    continue;
                                }
                            };
                            if cancel_loop.load(std::sync::atomic::Ordering::SeqCst) {
                                stopped = true;
                                break;
                            }
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
                                Ok(ProviderChunk::Thinking(chunk)) => {
                                    if !chunk.text_delta.is_empty() {
                                        reasoning.push_str(&chunk.text_delta);
                                        *thinking_buf.write().await = reasoning.clone();
                                        let _ = tx.send(StreamEvent::ThinkingDelta {
                                            content: chunk.text_delta.clone(),
                                        });
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
                                    state.generations.remove(chat_id);
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
                            reasoning,
                            stopped,
                        }))
                    }
                })
                .await;
                    let json = match call {
                        Ok(json) => json,
                        // ctx.run surfaces `Result<_, TerminalError>` (SDK
                        // endpoint/context.rs); convert to the block's
                        // HandlerError explicitly — a bare `return Err(e)`
                        // would pin the async block's error type to
                        // TerminalError and break every other `?` below.
                        Err(e) => {
                            // Overflow retry: a provider error
                            // saying the request exceeded the context window
                            // gets exactly one compaction + re-derivation +
                            // retry per turn; every other error propagates
                            // unchanged.
                            if compacted_this_turn || !is_context_overflow(&e.to_string()) {
                                return Err(HandlerError::from(e));
                            }
                            compacted_this_turn = true;
                            let all_events =
                                journaled_load_events!(ctx, state, req.org_id, req.chat_id);
                            let history =
                                build_model_history(&all_events, &media_map, &route.modalities);
                            if too_short_to_compact(&history) {
                                return Err(HandlerError::from(e));
                            }
                            tracing::info!(
                                chat = %req.chat_id,
                                "auto-compaction triggered by context-overflow error; retrying the model call once"
                            );
                            compact_core(&ctx, &state, req.org_id, req.chat_id, &all_events)
                                .await?;
                            let refreshed =
                                journaled_load_events!(ctx, state, req.org_id, req.chat_id);
                            msgs = build_model_history(&refreshed, &media_map, &route.modalities);
                            retry_compacted = true;
                            continue;
                        }
                    };
                    break json.into_inner();
            };
            if completion.stopped {
                // Journaled step output says the stream was truncated: end
                // the turn with the delivered prefix (the epilogue persists
                // it as an interrupted event).
                cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                break;
            }
            if completion.tokens_in > 0 {
                last_context_tokens = completion.tokens_in;
            }
            // The overflow retry compacted and re-derived history: propagate
            // it to the step-level `messages`, or the next step (and the
            // persisted turn) would run on the pre-compaction history and
            // overflow again with the retry already spent.
            if retry_compacted {
                messages = msgs;
            }

            let is_final = completion.tool_calls.is_empty();

            // Journaled: persist ONE assistant_message event for this model
            // call — blocks [reasoning?, text?, tool_call*] in stream order,
            // usage, model, turn/step (spec §B.4). Replaces the old
            // append_message write.
            let st = state.clone();
            let chat_id = req.chat_id;
            let completion2 = completion.clone();
            let route2 = route.clone();
            let model_name = req.model.clone();
            let turn2 = turn_no;
            let step2 = step as u32;
            let event_id: Uuid = ctx
                .run(move || {
                    let state = st.clone();
                    let c = completion2.clone();
                    let route = route2.clone();
                    async move {
                        let event = ThreadEvent::AssistantMessage {
                            turn: turn2,
                            step: step2,
                            blocks: assistant_blocks(&c.reasoning, &c.text, &c.tool_calls),
                            usage: UsagePayload {
                                tokens_in: Some(c.tokens_in),
                                tokens_out: Some(c.tokens_out),
                                cost_usd: Some(UsageEvent::cost_usd(
                                    c.tokens_in,
                                    c.tokens_out,
                                    route.price_in,
                                    route.price_out,
                                )),
                            },
                            model: model_name,
                            interrupted: None,
                        };
                        let row = crate::http::gateway::persist_assistant_step(&state, chat_id, &event)
                            .await.map_err(api_err)?;
                        Ok(Json(row.id))
                    }
                })
                .await?
                .into_inner();
            // Persisted: the log holds this turn now. A failure later in
            // the step (tool execution, tool-result persistence, next
            // step's auto-compact) must not append the same text again as
            // "interrupted" — the flag stays set until the next model call
            // starts streaming, so every step-top failure path sees it.
            step_persisted.store(true, std::sync::atomic::Ordering::SeqCst);
            *last_event_id.lock().await = Some(event_id);

            if is_final {
                // Journaled: record usage, then finish. The chat-freeing and
                // queued-flush epilogue runs after the turn block exits.
                record_usage!(ctx, state, req, completion, route);
                let _ = tx.send(StreamEvent::Done {
                    message_id: event_id,
                    cost_usd: UsageEvent::cost_usd(
                        completion.tokens_in,
                        completion.tokens_out,
                        route.price_in,
                        route.price_out,
                    ),
                    tokens_in: completion.tokens_in,
                    tokens_out: completion.tokens_out,
                });
                return Ok(());
            }

            // Reasoning replay: the next model call sees the reasoning of
            // this one (openai.rs serializes it as reasoning_content).
            messages.push(Message {
                role: "assistant".into(),
                content: completion.text.clone(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: Some(completion.tool_calls.clone()),
                tool_call_id: None,
                reasoning: if completion.reasoning.is_empty() {
                    None
                } else {
                    Some(completion.reasoning.clone())
                },
            });

            // Execute each requested tool call in order.
            for (idx, call) in completion.tool_calls.iter().enumerate() {
                let is_client_tool = client_tool_names().contains(&call.name.as_str());
                // Coarse category from the resolved spec — rides on the
                // tool_result event for native UI labels.
                let tool_kind = if is_client_tool {
                    None
                } else {
                    plugin_turns.iter().find_map(|turn| {
                        turn.tools
                            .iter()
                            .find(|t| {
                                integrations::tool_matches(&turn.slug, &t.spec.name, &call.name)
                            })
                            .map(|info| info.spec.kind)
                    })
                };
                // Tool-carried artifacts and oversized results spill inside
                // server_tool_step; the spilled descriptor rides to the
                // event's artifact_id and claims the meta card.
                let mut spilled: Option<crate::worker::spill::SpilledArtifact> = None;
                let (content, is_error, meta, tool_images) = if is_client_tool {
                    let payload = if let Some(ws_name) = req.server_workspace.clone() {
                        // Server-local executor (batch workspace backend):
                        // the server itself runs the tool in the org
                        // workspace — same dispatch shape, no hub.
                        let dir = crate::http::agents::workspace_dir(&state, req.org_id, &ws_name);
                        server_local_tool_step(&ctx, &state, &tx, call, req.org_id, req.chat_id, dir)
                            .await?
                    } else {
                        client_tool_step(
                            &ctx,
                            &state,
                            &tx,
                            req.org_id,
                            &req.model,
                            req.chat_id,
                            call,
                            format!("{step}.{idx}"),
                            req.machine_id.clone(),
                            req.machine_label.clone(),
                            req.origin_machine_id.clone(),
                            workspace.as_ref().map(|w| w.folder.clone()),
                        )
                        .await?
                    };
                    (
                        payload.content,
                        payload.is_error,
                        payload.meta,
                        payload.images,
                    )
                } else {
                    let (content3, is_error3, meta3, spilled3) = server_tool_step(
                        &ctx,
                        &state,
                        &tx,
                        call,
                        format!("{step}.{idx}"),
                        req.org_id,
                        &req.model,
                        req.user_id,
                        req.chat_id,
                        &plugin_turns,
                        &mcp_caller_role,
                        Some(mcp_caller_email.as_str()),
                    )
                    .await?;
                    // Spilled results claim the meta card for the download
                    // card (exact keys: card/id/filename/content_type/
                    // size_bytes/path); tool-owned meta keys ride along.
                    let meta3 = match &spilled3 {
                        Some(s) => Some(crate::worker::spill::artifact_meta(meta3, s)),
                        None => meta3,
                    };
                    spilled = spilled3;
                    (content3, is_error3, meta3, Vec::new())
                };

                // Journaled: persist the tool_result event with turn/step and
                // the executor's widget meta (spec §C.2). Image parts ride
                // only when the route supports the image modality (spec §4.3);
                // gating at persist time keeps replay identical.
                let st = state.clone();
                let chat_id = req.chat_id;
                let call2 = call.clone();
                let content2 = content.clone();
                let meta2 = meta.clone();
                let turn2 = turn_no;
                let step2 = step as u32;
                let event_images = if route.modalities.iter().any(|m| m == "image") {
                    tool_images.clone()
                } else {
                    Vec::new()
                };
                let persisted_images = event_images.clone();
                ctx.run(move || {
                    let state = st.clone();
                    let call = call2.clone();
                    async move {
                        let store = state.store().await.map_err(api_err)?;
                        let event = ThreadEvent::ToolResult {
                            turn: turn2,
                            step: step2,
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            content: content2.clone(),
                            is_error,
                            meta: meta2.clone(),
                            images: persisted_images,
                            kind: tool_kind,
                            artifact_id: spilled.as_ref().map(|s| s.artifact_id),
                        };
                        store
                            .thread()
                            .append_event(chat_id, &event)
                            .await
                            .map_err(api_err)?;
                        Ok(Json(()))
                    }
                })
                .await?;

                messages.push(Message {
                    role: "tool".into(),
                    content,
                    images: event_images,
                    audio: Vec::new(),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                    reasoning: None,
                });
            }
        step += 1;
        }
        Ok(())
        }
        .await;
        // Uniform failure path: notify clients, persist the delivered prefix
        // as an interrupted assistant event (best effort), and free the chat
        // (registry + recorded invocation) so a failed turn never jams the
        // thread.
        if let Err(e) = turn_out {
                tracing::error!(chat = %req.chat_id, "turn failed: {e:?}");
                let _ = tx.send(StreamEvent::Error {
                    code: "turn_failed".into(),
                    message: "the turn failed; see server logs".into(),
                });
                // Best effort (spec §B.4): append what was delivered so far
                // as an interrupted assistant event — only while this step's
                // assistant event is not persisted yet (otherwise the log
                // already holds the full turn) and something was delivered.
                // Fire-and-forget — a failure here must not mask the
                // original error.
                let partial_text = text_buf.read().await.clone();
                let partial_reasoning = thinking_buf.read().await.clone();
                if !step_persisted.load(std::sync::atomic::Ordering::SeqCst)
                    && (!partial_text.is_empty() || !partial_reasoning.is_empty())
                {
                    {
                        let event = ThreadEvent::AssistantMessage {
                            turn: turn_no,
                            step: steps_used.load(std::sync::atomic::Ordering::SeqCst),
                            blocks: assistant_blocks(&partial_reasoning, &partial_text, &[]),
                            usage: UsagePayload::default(),
                            model: req.model.clone(),
                            interrupted: Some(true),
                        };
                        let _ = crate::http::gateway::persist_assistant_step(
                            &state,
                            req.chat_id,
                            &event,
                        )
                        .await;
                    }
                }
                state.generations.remove(req.chat_id);
                if let Ok(store) = state.store().await {
                    let _ = store
                        .kv()
                        .delete(&format!("chatgen_inv:{}", req.chat_id))
                        .await;
                }
                // Journaled: the turn failed — clear the spinner before the
                // workflow ends (terminal error, no further steps run).
                set_generating_step!(ctx, state, req, false);
                return Err(e);
        }
        // Every Ok ending already delivered its Done frame: a final answer
        // sent it inline, a stop lands in the stop epilogue below.

        // Stop epilogue: the delivered prefix persists as an interrupted
        // assistant event (journaled — replay keeps it), then the turn ends
        // with a Done frame. Same guards as the failure path: only when this
        // step's assistant event is not persisted yet and something was
        // delivered.
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            let partial_text = text_buf.read().await.clone();
            let partial_reasoning = thinking_buf.read().await.clone();
            let mut interrupted_id: Option<Uuid> = None;
            if !step_persisted.load(std::sync::atomic::Ordering::SeqCst)
                && (!partial_text.is_empty() || !partial_reasoning.is_empty())
            {
                let event = ThreadEvent::AssistantMessage {
                    turn: turn_no,
                    step: steps_used.load(std::sync::atomic::Ordering::SeqCst),
                    blocks: assistant_blocks(&partial_reasoning, &partial_text, &[]),
                    usage: UsagePayload::default(),
                    model: req.model.clone(),
                    interrupted: Some(true),
                };
                let st = state.clone();
                let chat_id = req.chat_id;
                interrupted_id = ctx
                    .run(move || {
                        let state = st.clone();
                        let event = event.clone();
                        async move {
                            let row = crate::http::gateway::persist_assistant_step(
                                &state,
                                chat_id,
                                &event,
                            )
                            .await
                            .map_err(api_err)?;
                            Ok(Json(row.id))
                        }
                    })
                    .await
                    .ok()
                    .map(|j| j.into_inner());
            }
            let done_id = interrupted_id
                .or(*last_event_id.lock().await)
                .unwrap_or_else(Uuid::now_v7);
            let _ = tx.send(StreamEvent::Done {
                message_id: done_id,
                cost_usd: 0.0,
                tokens_in: 0,
                tokens_out: 0,
            });
        }

        // Common exit: free the chat first — a send arriving from here on
        // takes the normal start path, while anything committed before the
        // queued-flush check below is picked up by this turn's epilogue.
        state.generations.remove(req.chat_id);
        clear_chatgen_kv!(ctx, state, req.chat_id);

        // Queued-turn flush: the last turn-bearing event is a user message
        // (a send that queued while this turn ran). Invoke a fresh turn —
        // journaled background call, delivered when this handler exits —
        // whose parameters come from the queueing send's kv record when one
        // exists. The flag clears unconditionally here (a flush that fails
        // before its own flag-set must not inherit it); the flush re-sets
        // it, so at worst the sidebar spinner blinks across the boundary.
        let has_queued: bool = {
            let st = state.clone();
            let chat_id = req.chat_id;
            let org_id = req.org_id;
            ctx.run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let events = store
                        .thread()
                        .list_events(org_id, chat_id)
                        .await
                        .map_err(api_err)?;
                    Ok(Json(has_queued_user_turn(
                        &events.into_iter().map(|r| r.event).collect::<Vec<_>>(),
                    )))
                }
            })
            .await?
            .into_inner()
        };
        // Journaled: turn over — the sidebar spinner clears and the (unread)
        // dot takes over; a queued flush turns it back on within moments.
        set_generating_step!(ctx, state, req, false);
        if !has_queued {
            return Ok(());
        }
        let opts: Option<ChatRunPayload> = {
            let st = state.clone();
            let chat_id = req.chat_id;
            ctx.run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    let raw = store
                        .kv()
                        .get(&format!("chat_queue:{chat_id}"))
                        .await
                        .map_err(api_err)?;
                    let parsed = raw.as_deref().and_then(|v| serde_json::from_str(v).ok());
                    if raw.is_some() {
                        let _ = store.kv().delete(&format!("chat_queue:{chat_id}")).await;
                    }
                    Ok(Json(parsed))
                }
            })
            .await?
            .into_inner()
        };
        let mut flush = opts.unwrap_or_else(|| req.clone());
        flush.user_message_id = None;
        flush.user_message = String::new();
        flush.attachment_ids = Vec::new();
        ctx.object_client::<ChatRunnerClient>(&req.chat_id.to_string())
            .generate(Json(flush))
            .send();
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
        let pending: Option<String> = ctx
            .get(key.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let Some(awakeable_id) = pending else {
            return Ok(()); // nobody is waiting (timed out or not a client tool)
        };
        ctx.resolve_awakeable(
            &awakeable_id,
            Json(ToolResultPayload {
                content: req.content.clone(),
                is_error: req.is_error,
                meta: req.meta.clone(),
                images: req.images.clone(),
            }),
        );
        Ok(())
    }

    /// Delivers an approval decision to the waiting generate loop (phase 2
    /// gate). First answer wins: Restate dedupes late completions for an
    /// already-resolved awakeable, and the waiting turn clears the state key
    /// when it resumes. The resolution must stay in this SHARED handler — a
    /// virtual object handler awaiting an awakeable holds the instance lock,
    /// so an exclusive wake handler would inbox behind the waiting turn
    /// forever (the claim_approval deadlock, reverted).
    #[handler]
    async fn complete_approval(
        &self,
        ctx: SharedObjectContext<'_>,
        req: Json<ApprovalReq>,
    ) -> HandlerResult<()> {
        let req = req.into_inner();
        let key = approval_state_key(&req.call_id);
        let pending: Option<String> = ctx
            .get(key.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let Some(awakeable_id) = pending else {
            return Ok(()); // first answer already won, or nobody waiting
        };
        // Resolved directly from this shared handler, mirroring
        // `complete_tool`: an exclusive wake handler must not be used here —
        // a virtual object handler awaiting an awakeable keeps the instance
        // locked, so an exclusive claim would inbox behind the waiting turn
        // forever and the decision could never land. Late duplicate
        // resolutions for an already-resolved awakeable are dropped by
        // Restate; the waiting turn clears the key on resume.
        ctx.resolve_awakeable(
            &awakeable_id,
            Json(ApprovalResolution {
                approved: req.approved,
                reason: req.reason,
            }),
        );
        Ok(())
    }

    /// Write-side claim of an approval decision: serialized against every
    /// other invocation on this chat object, so read+clear here is the
    /// whole critical section for the user-vs-timer decision race.
    #[handler]
    async fn claim_approval(
        &self,
        ctx: ObjectContext<'_>,
        req: Json<ApprovalReq>,
    ) -> HandlerResult<()> {
        let req = req.into_inner();
        let key = approval_state_key(&req.call_id);
        tracing::warn!("approval-flow: claim_approval entered call={}", req.call_id);
        let pending: Option<String> = ctx
            .get(key.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let Some((awakeable_id, resolution)) = approval_on_decision(pending, req) else {
            tracing::warn!("approval-flow: claim_approval no-op (pending absent)");
            return Ok(()); // first answer already won, or nobody waiting
        };
        tracing::warn!(
            "approval-flow: claim_approval resolving awakeable {}",
            awakeable_id
        );
        ctx.clear(&key);
        ctx.resolve_awakeable(&awakeable_id, Json(resolution));
        Ok(())
    }

    /// Compacts the thread (phase 3, design §C): one journaled non-streaming
    /// summarization call over the FULL pre-compaction history, then a
    /// durable `Compaction` event appended to the thread log. The log itself
    /// is never rewritten — compaction is a derivation change (the next
    /// `generate` derives through the event). Fire-and-forget: no broadcast,
    /// no generation registry entry — the chat's generating flag is set for
    /// the duration, so the thread reads busy and sends queue behind it;
    /// clients poll GET /thread for the new event. Virtual-object serialization already keeps compact and
    /// generate from overlapping on the same key; the generations-registry
    /// check below is a terminal guard against a stale in-flight turn
    /// (nothing is taken that would need freeing on failure).
    #[handler]
    async fn compact(&self, ctx: ObjectContext<'_>, req: Json<CompactReq>) -> HandlerResult<()> {
        let req = req.into_inner();
        let state = self.state.clone();

        // (a) A generation in flight must finish first — compacting a
        // half-written thread would summarize a turn in progress.
        if state.generations.is_generating(req.chat_id) {
            return Err(TerminalError::new("cannot compact while a generation is running").into());
        }

        // Journaled: the thread is busy while the summarization call runs —
        // the same generating flag the turn path drives (sidebar spinner,
        // composer busy state). Cleared on every exit below.
        set_generating_step!(ctx, state, req, true);

        // Journaled: load the thread event log; the shared core derives the
        // pre-compaction history, runs the summarization call and appends
        // the durable checkpoint (also used by auto-compaction).
        let prior_events = journaled_load_events!(ctx, state, req.org_id, req.chat_id);
        let result = compact_core(&ctx, &state, req.org_id, req.chat_id, &prior_events).await;

        // Journaled: compaction over — success or failure, the spinner
        // clears. Bound (not `?`) so the clear also runs on the error path;
        // a failed compaction appends nothing to the log.
        set_generating_step!(ctx, state, req, false);
        result
    }
}

/// The approval gate (phase 2, design §C) — shared by client-side and
/// server-side tool steps. Reads the chat owner's policy, applies it over
/// `tool_default`, and on Ask runs the journaled request → durable awakeable
/// wait → journaled decision flow (user decision or auto-deny timer).
/// Returns Some(denial payload) when the call must not run, None when it may
/// proceed. The denial payload is a normal tool_result (is_error) so callers
/// persist it unchanged.
#[allow(clippy::too_many_arguments)]
/// How long the AI auto-approval judge may take before the gate falls back
/// to asking the user (the safe direction).
const APPROVAL_POLICY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// AI auto-approval verdict for a proposed tool call under the chat's
/// "approve for me" mode. Journaled model call: the admin-tunable policy
/// prompt (org KV, falling back to the built-in default) judges the action;
/// true = run silently, false/timeout/parse failure = ask the user (the
/// safe direction on any uncertainty).
async fn approval_policy_verdict(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    org: Uuid,
    model: &str,
    call: &ToolCall,
) -> HandlerResult<bool> {
    let action = serde_json::json!({
        "tool": call.name,
        "arguments": call.arguments,
    });
    let action = serde_json::to_string(&action).unwrap_or_else(|_| "{}".to_string());
    let st = state.clone();
    let org2 = org;
    let model2 = model.to_string();
    let action2 = action.clone();
    let run = ctx.run(move || {
        let state = st.clone();
        let org = org2;
        let model = model2.clone();
        let action = action2.clone();
        async move {
            let store = state.store().await.map_err(api_err)?;
            let prompt = store
                .org_kv()
                .get(org, APPROVAL_POLICY_PROMPT_KEY)
                .await
                .map_err(api_err)?
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_APPROVAL_POLICY_PROMPT.to_string());
            let master = state.config.master_key()?;
            let route = store
                .gateway()
                .resolve_route(org, &model, &master)
                .await
                .map_err(|e| {
                    HandlerError::from(TerminalError::new(format!(
                        "approval policy route resolve failed: {e:?}"
                    )))
                })?;
            let provider: Arc<dyn ModelProvider> =
                guild_core::provider::for_protocol(&route.protocol).ok_or_else(|| {
                    TerminalError::new(format!("unknown protocol {}", route.protocol))
                })?;
            let preq = ProviderRequest {
                model: &model,
                system: Some(prompt.as_str()),
                messages: &[Message {
                    role: "user".to_string(),
                    content: action,
                    images: Vec::new(),
                    audio: Vec::new(),
                    tool_calls: None,
                    tool_call_id: None,
                    reasoning: None,
                }],
                api_key: &route.api_key,
                base_url: &route.base_url,
                tools: None,
                max_tokens: route.max_output_tokens.unwrap_or(0).max(0) as u32,
            };
            let stream = provider
                .chat_stream(preq)
                .await
                .map_err(|e| TerminalError::new(format!("approval policy model error: {e}")))?;
            let mut out = String::new();
            let mut stream = stream;
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(ProviderChunk::Text(c)) => out.push_str(&c.text_delta),
                    Ok(_) => {}
                    Err(e) => {
                        return Err(
                            TerminalError::new(format!("approval policy model error: {e}")).into(),
                        )
                    }
                }
            }
            Ok(Json(out))
        }
    });
    // The judge gets one short JSON verdict; a hung call must not stall the
    // turn — the timeout falls back to asking (empty text → no verdict).
    let raw: String = match tokio::time::timeout(APPROVAL_POLICY_TIMEOUT, run).await {
        Ok(res) => match res {
            Ok(v) => v.into_inner(),
            Err(e) => {
                tracing::warn!("approval policy judge failed, asking the user: {e:?}");
                String::new()
            }
        },
        Err(_) => {
            tracing::warn!("approval policy judge timed out, asking the user");
            String::new()
        }
    };
    let s = raw.trim();
    let verdict: Option<(bool, Option<String>)> = (|| {
        let a = s.find('{')?;
        let b = s.rfind('}')?;
        if b < a {
            return None;
        }
        let v: Value = serde_json::from_str(&s[a..=b]).ok()?;
        let approve = v.get("approve")?.as_bool()?;
        let reason = v.get("reason").and_then(|r| r.as_str()).map(String::from);
        Some((approve, reason))
    })();
    let Some((approved, reason)) = verdict else {
        tracing::warn!("approval policy judge returned no verdict, asking the user");
        return Ok(false);
    };
    tracing::info!(
        tool = %call.name,
        approved,
        reason = reason.as_deref().unwrap_or(""),
        "approval policy judge decision"
    );
    Ok(approved)
}

async fn approval_gate(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    org: Uuid,
    model: &str,
    chat_id: Uuid,
    call: &ToolCall,
    tool_default: Approval,
    force_ask: bool,
) -> HandlerResult<Option<ToolResultPayload>> {
    // The chat's approval mode (composer selector, migration 0043/0044 —
    // codex vocabulary) overrides the chat owner's user-level policy for
    // every tool in the chat.
    let (chat_mode, user_policy): (Option<String>, Option<Value>) = ctx
        .run({
            let state = state.clone();
            move || {
                let state = state.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    match sqlx::query_as::<_, (Option<String>, Option<Value>)>(
                        "SELECT c.approval->>'default' AS chat_mode, u.approval AS user_policy \
                         FROM chats c JOIN users u ON u.id = c.user_id \
                         WHERE c.id = $1",
                    )
                    .bind(chat_id)
                    .fetch_optional(store.pool())
                    .await
                    {
                        Ok(row) => Ok(Json(row.unwrap_or((None, None)))),
                        Err(e) => {
                            // Approval column not migrated yet (or DB hiccup):
                            // the server default is the safe direction.
                            tracing::warn!(
                                chat = %chat_id,
                                "approval policy read failed, using server default: {e}"
                            );
                            Ok(Json((None, None)))
                        }
                    }
                }
            }
        })
        .await?
        .into_inner();
    // Chat mode wins when set; "never" is remapped to ask (chat-level deny
    // was dropped with the codex modes — the account policy remains the
    // place for a hard deny).
    // Per-tool admin curation (adapters spec §6): a tool set to always_ask
    // forces the durable approval card on every call, ahead of the chat's
    // approval mode and the user's policy — org governance wins. This
    // includes a user-policy per-tool `never`: the org asks for a
    // confirmation, prohibition stays with the class floor and `enabled`.
    let decision: Approval = if force_ask {
        Approval::Ask
    } else {
        match chat_mode.as_deref() {
            Some("approve_for_me") => {
                // AI auto-approval policy (codex/claude-code style): a model
                // judge decides whether this action is routine enough to run
                // silently; anything it flags goes to the user as a card.
                if approval_policy_verdict(ctx, state, org, model, call).await? {
                    Approval::Allow
                } else {
                    Approval::Ask
                }
            }
            Some("full_access") | Some("allow") => Approval::Allow,
            Some("ask") | Some("never") => Approval::Ask,
            // Unset chat mode: an explicitly stored account policy wins
            // (Settings per-tool overrides stay meaningful); no stored
            // policy defaults to the same AI judge as `approve_for_me`.
            _ => match user_policy {
                Some(_) => resolve_policy(user_policy).for_tool(&call.name, tool_default),
                None => {
                    if approval_policy_verdict(ctx, state, org, model, call).await? {
                        Approval::Allow
                    } else {
                        Approval::Ask
                    }
                }
            },
        }
    };
    match decision {
        Approval::Never => {
            return Ok(Some(ToolResultPayload {
                content: "denied by policy".to_string(),
                is_error: true,
                meta: None,
                images: Vec::new(),
            }));
        }
        Approval::Allow => {}
        Approval::Ask => {
            let args_json =
                serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string());

            // Journaled: append the approval request to the thread log.
            let st = state.clone();
            let call_id = call.id.clone();
            let name = call.name.clone();
            let args = args_json.clone();
            ctx.run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    store
                        .thread()
                        .append_event(
                            chat_id,
                            &ThreadEvent::ApprovalRequest {
                                call_id: call_id.clone(),
                                name: name.clone(),
                                arguments: args.clone(),
                            },
                        )
                        .await
                        .map_err(api_err)?;
                    Ok(Json(()))
                }
            })
            .await?;

            // Journaled: broadcast the pending approval card to attached
            // clients.
            let tx2 = tx.clone();
            let call_id = call.id.clone();
            let name = call.name.clone();
            let args = args_json.clone();
            ctx.run(move || {
                let tx = tx2.clone();
                async move {
                    let _ = tx.send(StreamEvent::ApprovalRequested {
                        call_id,
                        name,
                        arguments: args,
                    });
                    Ok(Json(()))
                }
            })
            .await?;

            // Journaled awakeable + durable timeout: the first decision (a
            // user, or the auto-deny timer) claims the state key atomically
            // in complete_approval and resolves the promise; the loser sees
            // no key and no-ops. Resolution replays from the journal like
            // the client-tool result.
            let (awakeable_id, promise) = ctx.awakeable::<Json<ApprovalResolution>>();
            ctx.set(&approval_state_key(&call.id), awakeable_id.clone());
            ctx.object_client::<ChatRunnerClient>(&chat_id.to_string())
                .complete_approval(Json(ApprovalReq {
                    call_id: call.id.clone(),
                    approved: false,
                    reason: Some("timed out awaiting approval".to_string()),
                }))
                .send_after(APPROVAL_TIMEOUT);
            // Stop responsiveness: a stop while the gate is pending resolves
            // it as denied so the turn resumes and ends at the next
            // journaled cancel check. Spawned outside journaled sections on
            // purpose: a replay re-spawns the watcher.
            crate::http::gateway::spawn_stop_approval_watcher(state, chat_id, call.id.clone());

            let decision: ApprovalResolution = match promise.await {
                Ok(Json(d)) => d,
                Err(t) => ApprovalResolution {
                    approved: false,
                    reason: Some(format!("approval failed: {t}")),
                },
            };
            ctx.clear(&approval_state_key(&call.id));

            // Journaled: persist the decision, then broadcast the resolved
            // frame so every client's card settles.
            let st = state.clone();
            let call_id = call.id.clone();
            let approved = decision.approved;
            let reason = decision.reason.clone();
            ctx.run(move || {
                let state = st.clone();
                async move {
                    let store = state.store().await.map_err(api_err)?;
                    store
                        .thread()
                        .append_event(
                            chat_id,
                            &ThreadEvent::ApprovalDecision {
                                call_id: call_id.clone(),
                                approved,
                                reason: reason.clone(),
                                expired: false,
                            },
                        )
                        .await
                        .map_err(api_err)?;
                    Ok(Json(()))
                }
            })
            .await?;
            let tx2 = tx.clone();
            let call_id = call.id.clone();
            let approved = decision.approved;
            let reason = decision.reason.clone();
            ctx.run(move || {
                let tx = tx2.clone();
                async move {
                    let _ = tx.send(StreamEvent::ApprovalResolved {
                        call_id,
                        approved,
                        reason,
                    });
                    Ok(Json(()))
                }
            })
            .await?;

            if !decision.approved {
                return Ok(Some(ToolResultPayload {
                    content: match decision.reason.as_deref() {
                        Some(r) if !r.is_empty() => format!("denied by user: {r}"),
                        _ => "denied by user".to_string(),
                    },
                    is_error: true,
                    meta: None,
                    images: Vec::new(),
                }));
            }
            // Approved: fall through to the caller's execution flow.
        }
    }
    Ok(None)
}

/// Phase 5b: the sandbox executor for web chats with no desktop present —
/// the same tool runs on the server against a per-chat sandbox dir
/// (`data_dir/sandbox/{chat_id}`), behind the same static exec-policy and
/// interactive approval gates as client tools. The sandbox is private to
/// the chat; shell tools additionally require the server allowlist flag.
async fn sandbox_tool_step(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    org_id: Uuid,
    model: &str,
    chat_id: Uuid,
    call: &ToolCall,
) -> HandlerResult<ToolResultPayload> {
    // Static exec policy first (codex model): a `forbidden` rule is a hard
    // deny; `prompt` rules and unmatched commands fall through to the
    // chat's interactive approval flow — the web client answers it like any
    // other executor's.
    let static_decision = exec_policy_gate::evaluate_execute(&call.arguments);
    if let exec_policy_gate::ExecPolicyDecision::Deny(reason) = &static_decision {
        return Ok(ToolResultPayload {
            content: format!("denied by exec policy: {reason}"),
            is_error: true,
            meta: None,
            images: Vec::new(),
        });
    }
    if !matches!(static_decision, exec_policy_gate::ExecPolicyDecision::Allow) {
        if let Some(denial) =
            approval_gate(ctx, state, tx, org_id, model, chat_id, call, Approval::Ask, false)
                .await?
        {
            return Ok(denial);
        }
    } // static allow skips the interactive gate entirely
    let dir = std::path::Path::new(&state.config.data_dir)
        .join("sandbox")
        .join(chat_id.to_string());
    server_local_tool_step(ctx, state, tx, call, org_id, chat_id, dir).await
}

/// One server-local tool call (spec 2026-09-18 unification §4 phases 4+5b):
/// the server executes the client-tool in-process against the given
/// workspace dir — journaled side effect (the result replays without
/// re-running), then notifies attached clients exactly like the machine
/// dispatch does. No interactive approvals here: the batch contract is
/// "trusted workspace, pre-approved" and the sandbox caller runs its gates
/// before dispatching; `execute` still passes the static exec-policy gate,
/// and shell tools require the server allowlist flag.
async fn server_local_tool_step(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    call: &ToolCall,
    _org_id: Uuid,
    _chat_id: Uuid,
    dir: std::path::PathBuf,
) -> HandlerResult<ToolResultPayload> {
    let args_json = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string());
    // Journaled: notify attached clients that this call runs server-side.
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
                kind: None,
            });
            Ok(Json(()))
        }
    })
    .await?;

    let shell_allowed = state.config.allow_shell_tools;
    let name = call.name.clone();
    let args = call.arguments.clone();
    let payload: ToolResultPayload = ctx
        .run(move || {
            let dir = dir.clone();
            let name = name.clone();
            let args = args.clone();
            async move {
                if name == "execute" && !shell_allowed {
                    return Ok(Json(ToolResultPayload {
                        content: "denied: shell tools are disabled on this server".into(),
                        is_error: true,
                        meta: None,
                        images: Vec::new(),
                    }));
                }
                if name == "execute" {
                    if let exec_policy_gate::ExecPolicyDecision::Deny(reason) =
                        exec_policy_gate::evaluate_execute(&args)
                    {
                        return Ok(Json(ToolResultPayload {
                            content: format!("denied by exec policy: {reason}"),
                            is_error: true,
                            meta: None,
                            images: Vec::new(),
                        }));
                    }
                }
                tokio::fs::create_dir_all(&dir)
                    .await
                    .map_err(|e| anyhow::anyhow!("workspace dir: {e}"))?;
                let mut registry = guild_core::tools::ToolRegistry::new();
                registry.add(Arc::new(guild_core::tools::fs::ReadFile::default()));
                registry.add(Arc::new(guild_core::tools::fs::WriteFile));
                registry.add(Arc::new(guild_core::tools::fs::EditFile));
                if shell_allowed {
                    registry.add(Arc::new(guild_core::tools::shell::RunCommand));
                }
                let payload = match registry.get(&name) {
                    Some(tool) => match tool.run(std::path::Path::new(&dir), args).await {
                        Ok(out) => ToolResultPayload {
                            content: out.output_for_model,
                            is_error: false,
                            meta: out.meta,
                            images: out.images,
                        },
                        Err(e) => ToolResultPayload {
                            content: e.to_string(),
                            is_error: true,
                            meta: None,
                            images: Vec::new(),
                        },
                    },
                    None => ToolResultPayload {
                        content: format!("unknown tool {name}"),
                        is_error: true,
                        meta: None,
                        images: Vec::new(),
                    },
                };
                Ok(Json(payload))
            }
        })
        .await?
        .into_inner();

    // Journaled: report completion.
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name2 = call.name.clone();
    let content2 = payload.content.clone();
    let is_error = payload.is_error;
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name2.clone();
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

    Ok(payload)
}

/// Phase 5a: one machine-mediated read_file for the bound project's
/// AGENTS.md (web chats: the caller cannot assemble the chain). Same durable
/// dispatch shape as a client tool, minus the interactive gate (read-only,
/// pre-approved) and minus thread events (internal fetch — nothing
/// user-visible, nothing journaled beyond the dispatch itself). An offline
/// machine, an error result, or a timeout yields None: the turn proceeds
/// without project instructions rather than failing.
async fn fetch_agents_md_via_machine(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    chat_id: Uuid,
    workspace: Option<WorkspaceRef>,
    machine_id: Option<String>,
    turn_no: u32,
) -> HandlerResult<Option<String>> {
    const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
    let Some(ws) = workspace else {
        return Ok(None);
    };
    let Some(mid) = machine_id else {
        return Ok(None);
    };
    {
        let cache = state.agents_md_cache.lock().unwrap();
        if let Some((at, content)) = cache.get(&ws.folder) {
            if at.elapsed() < CACHE_TTL {
                return Ok(Some(content.clone()));
            }
        }
    }
    // Journaled snapshot: dispatch only when the machine is reachable (a
    // replayed turn re-derives this from the hub state at its own time —
    // both outcomes degrade to None, so replay stays safe).
    let online: bool = ctx
        .run({
            let state = state.clone();
            let mid = mid.clone();
            move || {
                let state = state.clone();
                let mid = mid.clone();
                async move { Ok(Json(state.hub.machine_online(&mid))) }
            }
        })
        .await?
        .into_inner();
    if !online {
        return Ok(None);
    }
    // Deterministic per-turn dispatch id (replay-stable, never collides
    // with real tool-call ids).
    let call_id = format!("agents_md_fetch:{turn_no}");
    let arguments = serde_json::json!({ "path": "AGENTS.md" }).to_string();
    let (awakeable_id, promise) = ctx.awakeable::<Json<ToolResultPayload>>();
    ctx.set(&state_key(&call_id), awakeable_id.clone());
    let label = ws.machine_label.clone().unwrap_or_else(|| mid.clone());
    let done = note_pending_tool(
        state,
        chat_id,
        &call_id,
        "read_file",
        &arguments,
        Some(&mid),
        Some(&ws.folder),
    );
    let dispatch_state = state.clone();
    let dispatch_id = awakeable_id.clone();
    let dispatch_call = call_id.clone();
    let dispatched_connection = ctx
        .run(move || {
            let state = dispatch_state.clone();
            let dispatch_id = dispatch_id.clone();
            let call_id = dispatch_call.clone();
            async move {
                Ok(Json(
                    crate::http::gateway::dispatch_pending_tool(
                        &state,
                        chat_id,
                        &call_id,
                        &dispatch_id,
                    )
                    .await
                    .map_err(api_err)?,
                ))
            }
        })
        .await?
        .into_inner();
    crate::http::gateway::restore_dispatch_connection(
        state,
        chat_id,
        &call_id,
        dispatched_connection,
    );
    // Executor disappearance mid-fetch resolves with an error after a grace
    // window (same watcher as client tools). No stop watcher: the internal
    // fetch resolves on its own within the timeout, and the turn's stop
    // checks resume right after.
    crate::http::gateway::spawn_machine_watcher(
        state,
        chat_id,
        call_id.clone(),
        "read_file".to_string(),
        mid.clone(),
        label,
        done,
    );
    // Durable timeout: the delayed complete_tool resolves the awakeable while
    // this handler is suspended (shared handler — see complete_tool).
    ctx.object_client::<ChatRunnerClient>(&chat_id.to_string())
        .complete_tool(Json(ToolResultReq {
            call_id: call_id.clone(),
            content: "AGENTS.md fetch timed out after 30 seconds".into(),
            is_error: true,
            meta: None,
            images: Vec::new(),
        }))
        .send_after(FETCH_TIMEOUT);
    let payload: ToolResultPayload = match promise.await {
        Ok(Json(p)) => p,
        Err(t) => ToolResultPayload {
            content: format!("AGENTS.md fetch failed: {t}"),
            is_error: true,
            meta: None,
            images: Vec::new(),
        },
    };
    ctx.clear(&state_key(&call_id));
    crate::http::gateway::clear_pending_tool(state, chat_id, &call_id);
    if payload.is_error {
        return Ok(None);
    }
    state
        .agents_md_cache
        .lock()
        .unwrap()
        .insert(ws.folder, (std::time::Instant::now(), payload.content.clone()));
    Ok(Some(payload.content))
}

/// One machine-tool call: resolve the bound executor machine (fail fast when
/// unbound/offline), notify attached clients, durably wait for the machine's
/// result (bounded), report completion. Returns the tool result payload for
/// the model-facing history and the tool_result event (content, is_error,
/// meta).
#[allow(clippy::too_many_arguments)]
async fn client_tool_step(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    org_id: Uuid,
    model: &str,
    chat_id: Uuid,
    call: &ToolCall,
    _seq: String,
    machine_id: Option<String>,
    machine_label: Option<String>,
    origin_machine_id: Option<String>,
    workdir: Option<String>,
) -> HandlerResult<ToolResultPayload> {
    // Resolve the executor machine. Journaled ctx.run snapshots: the result
    // replays deterministically even if the in-memory registry changes
    // between execution and replay (e.g. worker restart).
    let sandbox_fallback = machine_id.is_none() && origin_machine_id.is_none();
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
                        if state.hub.machine_online(&omid) {
                            let label = state.machine_label(&omid).unwrap_or_else(|| omid.clone());
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
        // Phase 5b (spec 2026-09-18 unification): a web chat with no desktop
        // present — nothing was ever bound, so the tools run on the server in
        // a per-chat sandbox (same specs, same policy/approval gates, no hub
        // round trip). A bound-but-offline desktop keeps its explicit
        // message: the user's workspace is on that machine, not the sandbox.
        if sandbox_fallback {
            return sandbox_tool_step(&ctx, state, tx, org_id, model, chat_id, call).await;
        }
        return Ok(ToolResultPayload {
            content:
                "client tool not executed: this chat is not bound to a machine — bind it in the chat settings, or send the message from the Guild desktop app on the target machine"
                    .to_string(),
            is_error: false,
            meta: None,
            images: Vec::new(),
        });
    };
    // Fail fast when the bound machine is offline (journaled snapshot).
    let online: bool = ctx
        .run({
            let state = state.clone();
            let mid = mid.clone();
            move || {
                let state = state.clone();
                let mid = mid.clone();
                async move { Ok(Json(state.hub.machine_online(&mid))) }
            }
        })
        .await?
        .into_inner();
    if !online {
        return Ok(ToolResultPayload {
            content: format!(
                "client tool not executed: the bound machine '{mlabel}' is offline — start the Guild desktop app on it, then ask again"
            ),
            is_error: false,
            meta: None,
            images: Vec::new(),
        });
    }

    // ---- Static exec policy (codex model): Starlark prefix rules decide
    // before the interactive gate. An `allow` rule runs the command with no
    // gate at all; a `forbidden` rule is a hard deny whose text is the rule's
    // justification (the model recovers by trying a materially different
    // command, never by escalating); `prompt` rules and unmatched commands
    // fall through to the chat's approval flow below. Pure function of the
    // compiled-in rules and the command string — replay-stable.
    let static_decision = exec_policy_gate::evaluate_execute(&call.arguments);
    if let exec_policy_gate::ExecPolicyDecision::Deny(reason) = &static_decision {
        return Ok(ToolResultPayload {
            content: format!("denied by exec policy: {reason}"),
            is_error: true,
            meta: None,
            images: Vec::new(),
        });
    }
    if !matches!(static_decision, exec_policy_gate::ExecPolicyDecision::Allow) {
        // ---- Approval gate (phase 2, design §C). Journaled request/decision
        // flow; denial is a normal tool_result payload the caller persists.
        if let Some(denial) = approval_gate(
            ctx,
            state,
            tx,
            org_id,
            model,
            chat_id,
            call,
            Approval::Ask,
            false,
        )
        .await?
        {
            return Ok(denial);
        }
    } // static allow skips the interactive gate entirely

    // Journaled awakeable: stable id across replays.
    let (awakeable_id, promise) = ctx.awakeable::<Json<ToolResultPayload>>();
    ctx.set(&state_key(&call.id), awakeable_id.clone());
    // Journaled: notify attached clients that this call must run client-side.
    let args_json = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string());
    let done = note_pending_tool(
        state,
        chat_id,
        &call.id,
        &call.name,
        &args_json,
        Some(&mid),
        workdir.as_deref(),
    );
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name = call.name.clone();
    let args2 = args_json.clone();
    let dispatch_state = state.clone();
    let dispatch_id = awakeable_id.clone();
    let dispatched_connection = ctx
        .run(move || {
            let state = dispatch_state.clone();
            let dispatch_id = dispatch_id.clone();
            let tx = tx2.clone();
            let call_id = call_id.clone();
            let name = name.clone();
            let args = args2.clone();
            async move {
                let connection = crate::http::gateway::dispatch_pending_tool(
                    &state,
                    chat_id,
                    &call_id,
                    &dispatch_id,
                )
                .await
                .map_err(api_err)?;
                let _ = tx.send(StreamEvent::ToolStarted {
                    call_id,
                    name,
                    arguments: args,
                    executor: ToolExecutor::Client,
                    kind: None,
                });
                Ok(Json(connection))
            }
        })
        .await?
        .into_inner();
    crate::http::gateway::restore_dispatch_connection(
        state,
        chat_id,
        &call.id,
        dispatched_connection,
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
        done.clone(),
    );
    // Stop responsiveness: a stop while the tool is suspended resolves it
    // immediately (same durable funnel), so the turn ends at the next
    // journaled cancel check instead of waiting out the executor.
    crate::http::gateway::spawn_stop_watcher(state, chat_id, call.id.clone(), done);
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
            meta: None,
            images: Vec::new(),
        }))
        .send_after(CLIENT_TOOL_TIMEOUT);

    let payload: ToolResultPayload = match promise.await {
        Ok(Json(p)) => p,
        Err(t) => ToolResultPayload {
            content: format!("client tool failed: {t}"),
            is_error: true,
            meta: None,
            images: Vec::new(),
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

    Ok(payload)
}

/// One server-side tool call: notify clients, execute the integration plugin
/// (journaled), report completion. Returns (content, is_error, meta) for the
/// model-facing history and the tool_result event (meta per spec §C.2). The
/// model sees `content` only; meta rides to the client widget.
#[allow(clippy::type_complexity)]
#[allow(clippy::too_many_arguments)]
async fn server_tool_step(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &broadcast::Sender<StreamEvent>,
    call: &ToolCall,
    _seq: String,
    org_id: Uuid,
    model: &str,
    caller_id: Uuid,
    chat_id: Uuid,
    plugin_turns: &[integrations::PluginTurn],
    caller_role: &str,
    acting_as: Option<&str>,
) -> HandlerResult<
    (
        String,
        bool,
        Option<Value>,
        Option<crate::worker::spill::SpilledArtifact>,
    ),
> {
    // Resolve the tool once: target (turn + info) drives everything below —
    // the spec kind on the started frame, the approval gate, the policy
    // check, and execution. Auto-tools (list_tools/guide) have no target and
    // no gate. The matching tolerates legacy-prefixed journal names.
    let target = plugin_turns.iter().enumerate().find_map(|(i, turn)| {
        turn.tools
            .iter()
            .find(|t| integrations::tool_matches(&turn.slug, &t.spec.name, &call.name))
            .map(|info| (i, info))
    });
    let (tool_kind, write_class, always_ask) = match target {
        Some((i, info)) => {
            let turn = &plugin_turns[i];
            let raw = integrations::unnamespaced_tool(&turn.slug, &info.spec.name)
                .unwrap_or(&info.spec.name);
            (
                Some(info.spec.kind),
                info.class == "write",
                integrations::tool_curate(
                    &turn.row_config,
                    turn.executor == integrations::PluginExecutor::Mcp,
                    raw,
                )
                .always_ask,
            )
        }
        None => (None, false, false),
    };
    // Approval gate for state-changing (write-class) server tools — Slack
    // posts, integration writes, and MCP writes all ask; reads flow without
    // a gate. always_ask (adapters spec §6) forces the card ahead of the
    // chat's approval mode and the user's policy — org governance wins.
    // Journaled: replay re-derives the same decision.
    if always_ask || write_class {
        if let Some(denial) = approval_gate(
            ctx,
            state,
            tx,
            org_id,
            model,
            chat_id,
            call,
            Approval::Ask,
            always_ask,
        )
        .await?
        {
            return Ok((denial.content, denial.is_error, denial.meta, None));
        }
    }
    // Journaled: notify attached clients.
    let args_json = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string());
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
                kind: tool_kind,
            });
            Ok(Json(()))
        }
    })
    .await?;

    // Journaled: execute the integration tool. Guild-provided disclosure
    // tools (spec §7.2/§7.3) and plugin calls go through the turn snapshot;
    // built-in and MCP tools execute through the same policy filter and
    // call path. MCP connections ride the pool with the identity envelope +
    // secret headers (connection state stays outside the journal —
    // reconnecting on replay is safe, spec §8); the secret VALUES are
    // re-resolved from the store inside the step, never journaled.
    let call2 = call.clone();
    let st = state.clone();
    let mcp = plugin_turns.to_vec();
    let role = caller_role.to_string();
    let acting = acting_as.map(str::to_string);
    let org = org_id;
    let chat = chat_id;
    let (content, is_error, meta, spilled) = ctx
        .run(move || {
            let call = call2.clone();
            let state = st.clone();
            async move {
                // Guild-provided disclosure tools (never sent to the server).
                if let Some((i, kind)) = integrations::parse_auto_tool(&mcp, &call.name) {
                    let turn = &mcp[i];
                    return Ok(Json(match kind {
                        integrations::AutoTool::ListTools => (
                            serde_json::to_string(&turn.allowed_specs(&role))
                                .unwrap_or_else(|_| "[]".to_string()),
                            false,
                            None,
                            None,
                        ),
                        integrations::AutoTool::Guide => match &turn.guide_object_key {
                            Some(key) => (
                                integrations::fetch_guide(&state, key)
                                    .await
                                    .unwrap_or_else(|| "guide not available".to_string()),
                                false,
                                None,
                                None,
                            ),
                            None => (
                                format!("integration {} has no guide", turn.slug),
                                false,
                                None,
                                None,
                            ),
                        },
                    }));
                }
                // Plugin tool (built-in or MCP): policy-check, then call.
                // The target is re-derived from the journaled snapshot (the
                // outer borrow cannot cross the run closure) — same matching
                // as the gate above, so both decisions re-derive identically.
                let target = mcp.iter().enumerate().find_map(|(i, turn)| {
                    turn.tools
                        .iter()
                        .find(|t| integrations::tool_matches(&turn.slug, &t.spec.name, &call.name))
                        .map(|info| (i, info))
                });
                if let Some((i, info)) = target {
                    if !integrations::tool_allowed(&mcp[i], info, &role) {
                        return Ok(Json((
                            "not permitted by integration policy".to_string(),
                            true,
                            None,
                            None,
                        )));
                    }
                    let raw = integrations::unnamespaced_tool(&mcp[i].slug, &call.name)
                        .unwrap_or(call.name.as_str());
                    let out = integrations::call_plugin(
                        &state,
                        &mcp[i],
                        raw,
                        call.arguments.clone(),
                        org,
                        acting.as_deref(),
                    )
                    .await;
                    return Ok(Json(match out {
                        Ok(outcome) => {
                            // Spill choke point (tool artifacts design): a
                            // tool-carried artifact payload spills always, a
                            // serialized result above the threshold spills
                            // too; both replace `content` with the pointer
                            // text naming the materialized path. The spill
                            // rides this journaled run — a replay restores
                            // the recorded result instead of re-uploading —
                            // and spill_artifact is additionally idempotent
                            // (deterministic uuid v5 + ON CONFLICT DO
                            // NOTHING), so a re-executed run reuses the row.
                            let spilled = match outcome.artifact {
                                Some(artifact) => {
                                    match crate::worker::spill::spill_tool_artifact(
                                        &state, org, chat, &call.id, raw, &artifact,
                                    )
                                    .await
                                    {
                                        Ok((spilled, pointer)) => Some((spilled, pointer)),
                                        Err(e) => {
                                            return Ok(Json((
                                                format!("artifact spill failed: {e}"),
                                                true,
                                                outcome.meta,
                                                None,
                                            )));
                                        }
                                    }
                                }
                                None if crate::worker::spill::should_spill(&outcome.content) => {
                                    match crate::worker::spill::spill_artifact(
                                        &state,
                                        org,
                                        chat,
                                        &call.id,
                                        raw,
                                        &format!("{raw}_result.txt"),
                                        "text/plain; charset=utf-8",
                                        outcome.content.as_bytes(),
                                    )
                                    .await
                                    {
                                        // Spill failure must not lose the
                                        // result: fall back to the inline
                                        // content.
                                        Ok(spilled) => {
                                            let pointer = crate::worker::spill::pointer_text(
                                                raw,
                                                &spilled,
                                                "text/plain; charset=utf-8",
                                                Some(&outcome.content),
                                            );
                                            Some((spilled, pointer))
                                        }
                                        Err(e) => {
                                            tracing::warn!(
                                                tool = raw,
                                                "oversized result spill failed, keeping inline: {e:?}"
                                            );
                                            None
                                        }
                                    }
                                }
                                None => None,
                            };
                            match spilled {
                                Some((s, pointer)) => (pointer, false, outcome.meta, Some(s)),
                                None => (outcome.content, false, outcome.meta, None),
                            }
                        }
                        Err(e) => (format!("web tool failed: {e}"), true, None, None),
                    }));
                }
                Ok(Json((
                    format!("unknown server tool {}", call.name),
                    true,
                    None,
                    None,
                )))
            }
        })
        .await?
        .into_inner();

    // Journaled: audit the identity of one plugin tool call (spec §8) —
    // built-in and MCP alike. Auto tools are disclosure-only, not audited.
    let audited = plugin_turns.iter().any(|turn| {
        integrations::unnamespaced_tool(&turn.slug, &call.name).is_some()
            && turn.tools.iter().any(|t| t.spec.name == call.name)
    });
    if audited {
        let st = state.clone();
        let slug = plugin_turns
            .iter()
            .find(|turn| turn.tools.iter().any(|t| t.spec.name == call.name))
            .map(|turn| turn.slug.clone())
            .unwrap_or_default();
        let raw = plugin_turns
            .iter()
            .find_map(|turn| integrations::unnamespaced_tool(&turn.slug, &call.name))
            .unwrap_or(call.name.as_str())
            .to_string();
        let acting = acting_as.map(str::to_string);
        let ok = !is_error;
        ctx.run(move || {
            let state = st.clone();
            async move {
                let store = state.store().await.map_err(api_err)?;
                store
                    .events()
                    .emit(
                        org_id,
                        "integration.tool_called",
                        serde_json::json!({
                            "slug": slug,
                            "tool": raw,
                            "caller": caller_id,
                            "acting_as": acting,
                            "ok": ok,
                            "via": "chat",
                        }),
                    )
                    .await
                    .map_err(api_err)?;
                Ok(Json(()))
            }
        })
        .await?;
    }

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
    let _ = tx;
    Ok((content, is_error, meta, spilled))
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
pub(crate) fn workflow_schema_version() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    include_str!("restate.rs").hash(&mut h);
    format!("{:x}", h.finish())
}

/// How the sweep treats one recorded chat-generation invocation.
enum StaleChatgenEntry {
    /// Current workflow version — replays fine; only the record goes.
    DropCurrent,
    /// No killable invocation in the record — drop it.
    DropUnusable,
    /// Invocation dispatched by a different (or unstamped) workflow
    /// version — kill it.
    Kill(String),
}

/// Classifies one `chatgen_inv:*` kv value. The writer stamps
/// `"{workflow_version}:{invocation_id}"`; a bare value predates version
/// stamping and cannot prove it replays, so it is treated as stale.
fn classify_chatgen_entry(current_version: &str, value: &str) -> StaleChatgenEntry {
    match value.split_once(':') {
        Some((ver, inv)) => {
            if ver == current_version {
                StaleChatgenEntry::DropCurrent
            } else if inv.is_empty() {
                StaleChatgenEntry::DropUnusable
            } else {
                StaleChatgenEntry::Kill(inv.to_string())
            }
        }
        None => {
            if value.is_empty() {
                StaleChatgenEntry::DropUnusable
            } else {
                StaleChatgenEntry::Kill(value.to_string())
            }
        }
    }
}

/// Purges in-flight chat generations dispatched by a different workflow
/// version. They cannot replay after the deploy and would jam their chat
/// (virtual objects serialize per key) until the inactivity timeout.
pub(crate) async fn purge_stale_chat_generations(state: &AppState) {
    let Ok(store) = state.store().await else {
        return;
    };
    let current = workflow_schema_version();
    let Ok(entries) = store.kv().list_prefix("chatgen_inv:").await else {
        return;
    };
    for (key, value) in entries {
        let chat_id = key
            .strip_prefix("chatgen_inv:")
            .and_then(|s| s.parse::<Uuid>().ok());
        // A dead workflow can no longer clear its chat's generating flag —
        // the sweep does it, so the sidebar never keeps a forever-spinner.
        async fn clear_flag(store: &crate::store::Store, chat_id: Option<Uuid>) {
            if let Some(chat_id) = chat_id {
                if let Err(e) = store.chats().clear_generating(chat_id).await {
                    tracing::warn!("sweep could not clear generating for {chat_id}: {e:?}");
                }
            }
        }
        match classify_chatgen_entry(&current, &value) {
            StaleChatgenEntry::DropCurrent => {
                // Current workflow version — it replays and clears its own
                // flag at the exit; only the record goes.
                let _ = store.kv().delete(&key).await;
            }
            StaleChatgenEntry::DropUnusable => {
                let _ = store.kv().delete(&key).await;
                clear_flag(&store, chat_id).await;
            }
            StaleChatgenEntry::Kill(inv) => {
                let url = format!(
                    "{}/invocations/{}?mode=kill",
                    state.config.restate_admin_url.trim_end_matches('/'),
                    inv
                );
                // Graceful cancel cannot reach an invocation stuck in
                // journal-mismatch backoff (RT0016); a hard kill is the
                // only reliable way to free the chat key. The record
                // survives a failed kill so the next sweep retries.
                match reqwest::Client::new().delete(&url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        tracing::info!(
                            "killed stale chat generation {inv} (deploy changed): {}",
                            resp.status()
                        );
                        let _ = store.kv().delete(&key).await;
                        clear_flag(&store, chat_id).await;
                    }
                    Ok(resp) => {
                        tracing::warn!(
                            "kill of stale chat generation {inv} got {} — record kept for retry",
                            resp.status()
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "kill of stale chat generation {inv} failed: {e} — record kept for retry"
                        );
                    }
                }
            }
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
    // Hourly prune of expired sessions and dead pairing tokens (startup +
    // interval; unpruned they accumulate forever).
    let prune_state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Ok(store) = prune_state.store().await {
                let sessions = store.identity().prune_expired_sessions().await.unwrap_or(0);
                let tokens = store.pairing().prune_dead_tokens().await.unwrap_or(0);
                if sessions + tokens > 0 {
                    tracing::info!(
                        "pruned {sessions} expired sessions, {tokens} dead pairing tokens"
                    );
                }
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });

    // Listen first: Restate probes the advertised URI during registration.
    let server = tokio::spawn(async move {
        // One journaled completion can legitimately run for minutes without
        // emitting a Restate command; the default inactivity timeout would
        // abort such runs mid-generation.
        let chat_options = ServiceOptions::new()
            .inactivity_timeout(Duration::from_secs(10 * 60))
            .abort_timeout(Duration::from_secs(60));
        HttpServer::new(
            Endpoint::builder()
                .bind(RoutineRunner {
                    state: state.clone(),
                })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_chatgen_entry_matches_the_writer_format() {
        let current = "abc123";
        // Current version: the record goes, nothing is killed.
        assert!(matches!(
            classify_chatgen_entry(current, "abc123:inv-1"),
            StaleChatgenEntry::DropCurrent
        ));
        // A different version is killed by its invocation id.
        assert!(matches!(
            classify_chatgen_entry(current, "oldver:inv-2"),
            StaleChatgenEntry::Kill(v) if v == "inv-2"
        ));
        // Bare values predate version stamping — treated as stale.
        assert!(matches!(
            classify_chatgen_entry(current, "inv-3"),
            StaleChatgenEntry::Kill(v) if v == "inv-3"
        ));
        // Unusable records (empty invocation) are dropped, not killed. The
        // current-version variant classifies as current — both drop.
        assert!(matches!(
            classify_chatgen_entry(current, "other:"),
            StaleChatgenEntry::DropUnusable
        ));
        assert!(matches!(
            classify_chatgen_entry(current, "abc123:"),
            StaleChatgenEntry::DropCurrent
        ));
        assert!(matches!(
            classify_chatgen_entry(current, ""),
            StaleChatgenEntry::DropUnusable
        ));
    }

    #[test]
    fn system_prompt_default_persona_is_helpful_assistant() {
        let p = build_system_prompt(None, false, false, false, None, None, "", "", None);
        assert!(p.starts_with("You are a helpful assistant."));
        assert!(!p.contains("coding agent"));
    }

    #[test]
    fn system_prompt_org_persona_replaces_default_only() {
        let ws = WorkspaceRef {
            folder: "/w".into(),
            machine_label: None,
        };
        let p = build_system_prompt(Some("You are GLaDOS."), true, false, true, None, Some(&ws), "", "", None);
        assert!(p.starts_with("You are GLaDOS."));
        assert!(!p.contains("helpful assistant"));
        // Operational instructions are appended regardless of the persona.
        assert!(p.contains("You have tools"));
        assert!(p.contains("web_search"));
        assert!(p.contains("The workspace directory is /w"));
    }

    #[test]
    fn workspace_sentence_plain_folder_keeps_today_shape() {
        assert_eq!(
            workspace_sentence(r"C:\code\web", Some("devbox")),
            r" The workspace directory is C:\code\web."
        );
        assert!(!workspace_sentence(r"C:\code\web", None).contains("WSL"));
    }

    #[test]
    fn workspace_sentence_wsl_unc_names_distro_inner_path_and_machine() {
        let (distro, inner) =
            parse_wsl_unc(r"\\wsl.localhost\Ubuntu-22.04\home\u\repo").unwrap();
        assert_eq!(distro, "Ubuntu-22.04");
        assert_eq!(inner, "/home/u/repo");
        let s = workspace_sentence(r"\\wsl.localhost\Ubuntu-22.04\home\u\repo", Some("devbox"));
        assert!(s.contains(
            "The workspace is `/home/u/repo` inside WSL distro `Ubuntu-22.04` on machine `devbox`; shell commands run inside that distro."
        ));
        // Legacy wsl$ share and missing label both parse.
        assert_eq!(
            parse_wsl_unc(r"\\wsl$\archlinux\srv\code").unwrap(),
            ("archlinux".to_string(), "/srv/code".to_string())
        );
        let s = workspace_sentence(r"\\wsl.localhost\archlinux\srv", None);
        assert!(s.contains("distro `archlinux`;"));
        assert!(!s.contains("on machine"));
    }

    #[test]
    fn wsl_unc_parse_matrix() {
        // Not WSL.
        assert_eq!(parse_wsl_unc(r"C:\code"), None);
        assert_eq!(parse_wsl_unc(r"\\server\share"), None);
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost\"), None);
        // Near-miss prefixes are not WSL (same verdict as guild-core).
        assert_eq!(parse_wsl_unc(r"\\wsl.localhostx\Ubuntu\home"), None);
        assert_eq!(parse_wsl_unc(r"\\wsl\Ubuntu\home"), None);
        // Distro-only folder → the distro root.
        assert_eq!(
            parse_wsl_unc(r"\\wsl.localhost\archlinux").unwrap(),
            ("archlinux".to_string(), "/".to_string())
        );
    }

    #[test]
    fn wsl_unc_parse_is_case_insensitive_and_device_form_aware() {
        assert_eq!(
            parse_wsl_unc(r"\\WSL.LOCALHOST\archlinux\root\work").unwrap(),
            ("archlinux".to_string(), "/root/work".to_string())
        );
        assert_eq!(
            parse_wsl_unc(r"\\Wsl$\Debian\home\x").unwrap(),
            ("Debian".to_string(), "/home/x".to_string())
        );
        assert_eq!(
            parse_wsl_unc(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\proj").unwrap(),
            ("Ubuntu".to_string(), "/home/me/proj".to_string())
        );
        // Forward slashes parse like backslashes.
        assert_eq!(
            parse_wsl_unc("//wsl.localhost/debian/home/x").unwrap(),
            ("debian".to_string(), "/home/x".to_string())
        );
    }

    /// The two WSL parsers must agree on every literal: the system prompt
    /// (server `parse_wsl_unc`) and the tool routing (guild-core `classify`)
    /// derive from the same shape, so a folder the tools route into a distro
    /// is never described to the model as a plain directory (and vice versa).
    #[test]
    fn server_and_core_wsl_parsers_agree_on_every_literal() {
        use guild_core::tools::workspace::{classify, to_inner};
        use std::path::Path;
        let literals = [
            r"\\wsl.localhost\Ubuntu\home\me\proj",
            r"\\wsl$\Ubuntu\home\me\proj",
            r"\\WSL.LOCALHOST\archlinux\root\work",
            r"\\Wsl$\Debian\home\x",
            "//wsl.localhost/debian/home/x",
            "//wsl$/fedora/home/x",
            r"\\wsl.localhost\Ubuntu-22.04\home\me",
            r"\\?\UNC\wsl.localhost\Ubuntu\home\me\proj",
            r"\\?\UNC\WSL$\arch\srv",
            r"\\wsl.localhost\archlinux",
            r"\\wsl.localhost\",
            r"\\wsl.localhostx\Ubuntu\home",
            r"\\wsl\Ubuntu\home",
            r"\\server\share",
            r"C:\code\web",
            "/home/me/proj",
        ];
        for literal in literals {
            let server = parse_wsl_unc(literal);
            let kind = classify(Path::new(literal));
            match (&server, &kind) {
                (
                    Some((distro, inner)),
                    guild_core::tools::workspace::WorkspaceKind::Wsl {
                        distro: core_distro,
                    },
                ) => {
                    assert_eq!(distro, core_distro, "distro mismatch for {literal:?}");
                    assert_eq!(
                        to_inner(Path::new(literal)).as_deref(),
                        Some(inner.as_str()),
                        "inner-path mismatch for {literal:?}"
                    );
                }
                (None, other) => assert!(
                    !matches!(
                        other,
                        guild_core::tools::workspace::WorkspaceKind::Wsl { .. }
                    ),
                    "server says non-WSL but core says {other:?} for {literal:?}"
                ),
                (Some(_), other) => {
                    panic!("server says WSL but core says {other:?} for {literal:?}")
                }
            }
        }
    }

    #[test]
    fn system_prompt_blank_org_prompt_falls_back_to_default() {
        let p = build_system_prompt(Some("   "), false, false, false, None, None, "", "", None);
        assert!(p.starts_with("You are a helpful assistant."));
    }

    #[test]
    fn system_prompt_appends_skills_index_and_caps_it() {
        let idx = format!(
            "\n# Available skills\n- a: {}\n",
            "x".repeat(SKILLS_INDEX_CAP + 500)
        );
        let p = build_system_prompt(None, false, false, false, None, None, "", &idx, None);
        assert!(p.contains("# Available skills"));
        assert!(
            p.len()
                < build_system_prompt(None, false, false, false, None, None, "", "", None).len()
                    + SKILLS_INDEX_CAP
                    + 300
        );
        // Server-side cap truncates an oversized client index.
        assert!(p.len() < 20_000);
    }

    #[test]
    fn system_prompt_renders_agents_md_with_codex_markers_and_caps_it() {
        let md = "Project conventions here.".to_string();
        let ws = WorkspaceRef {
            folder: "/home/u/repo".into(),
            machine_label: Some("box".into()),
        };
        let p = build_system_prompt(None, false, false, false, None, Some(&ws), "", "", Some(&md));
        // Codex's user-instructions fragment format, with the directory label.
        assert!(p.contains("# AGENTS.md instructions for /home/u/repo"));
        assert!(p.contains("<INSTRUCTIONS>\nProject conventions here.\n</INSTRUCTIONS>"));
        // Cap: an oversized payload is truncated server-side.
        let big = "x".repeat(AGENTS_MD_CAP + 1000);
        let p2 = build_system_prompt(None, false, false, false, None, None, "", "", Some(&big));
        assert!(p2.len() < AGENTS_MD_CAP + 200);
        // Blank client payload renders nothing.
        let p3 = build_system_prompt(None, false, false, false, None, None, "", "", Some("   "));
        assert!(!p3.contains("AGENTS.md"));
    }

    #[test]
    fn auto_compact_threshold_uses_window_minus_reserve() {
        // Below the threshold: no compaction.
        assert!(!should_auto_compact(111_616, 128_000, false));
        // Over the threshold (128_000 - 16_384 = 111_616): compact.
        assert!(should_auto_compact(111_617, 128_000, false));
        // No window configured → 128k fallback applies.
        assert!(should_auto_compact(200_000, 128_000, false));
    }

    #[test]
    fn auto_compact_runs_at_most_once_per_turn() {
        assert!(!should_auto_compact(200_000, 128_000, true));
    }

    #[test]
    fn auto_compact_zero_tokens_never_triggers() {
        assert!(!should_auto_compact(0, 128_000, false));
    }

    #[test]
    fn latest_tokens_in_takes_the_last_assistant_usage() {
        let events = vec![
            ThreadEvent::UserMessage {
                content: "hi".into(),
                attachments: Vec::new(),
            },
            ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![],
                usage: UsagePayload {
                    tokens_in: Some(900),
                    tokens_out: Some(10),
                    cost_usd: None,
                },
                model: "m".into(),
                interrupted: None,
            },
            ThreadEvent::AssistantMessage {
                turn: 1,
                step: 1,
                blocks: vec![],
                usage: UsagePayload {
                    tokens_in: Some(1500),
                    tokens_out: Some(20),
                    cost_usd: None,
                },
                model: "m".into(),
                interrupted: None,
            },
        ];
        assert_eq!(latest_tokens_in(&events), 1500);
        assert_eq!(latest_tokens_in(&[]), 0);
    }

    #[test]
    fn server_default_read_flows_state_changers_ask() {
        let p = server_default_policy();
        assert_eq!(p.for_tool("read_file", Approval::Ask), Approval::Allow);
        assert_eq!(p.for_tool("execute", Approval::Ask), Approval::Ask);
        assert_eq!(p.for_tool("edit_file", Approval::Ask), Approval::Ask);
        assert_eq!(p.for_tool("write_file", Approval::Ask), Approval::Ask);
    }

    #[test]
    fn stored_policy_override_wins_over_default() {
        let p = resolve_policy(Some(json!({
            "default": "never",
            "overrides": { "execute": "allow" }
        })));
        assert_eq!(p.for_tool("execute", Approval::Ask), Approval::Allow);
        assert_eq!(p.for_tool("read_file", Approval::Ask), Approval::Never);
        assert_eq!(p.for_tool("write_file", Approval::Ask), Approval::Never);
    }

    #[test]
    fn null_policy_resolves_to_server_default() {
        let p = resolve_policy(None);
        assert_eq!(p.for_tool("read_file", Approval::Ask), Approval::Allow);
        assert_eq!(p.for_tool("execute", Approval::Ask), Approval::Ask);
    }

    #[test]
    fn malformed_policy_falls_back_to_server_default() {
        let p = resolve_policy(Some(json!("not-a-policy")));
        assert_eq!(p.for_tool("execute", Approval::Ask), Approval::Ask);
        assert_eq!(p.for_tool("read_file", Approval::Ask), Approval::Allow);
    }

    #[test]
    fn approval_state_key_format() {
        assert_eq!(approval_state_key("call-1"), "approval:call-1");
    }

    // --- compaction derivation (design §B) ---

    fn user_ev(content: &str) -> ThreadEvent {
        ThreadEvent::UserMessage {
            content: content.into(),
            attachments: Vec::new(),
        }
    }

    fn text_assistant(turn: u32, step: u32, text: &str) -> ThreadEvent {
        ThreadEvent::AssistantMessage {
            turn,
            step,
            blocks: vec![Block::Text { text: text.into() }],
            usage: UsagePayload::default(),
            model: "deepseek-test".into(),
            interrupted: None,
        }
    }

    fn tool_result(turn: u32, call_id: &str) -> ThreadEvent {
        ThreadEvent::ToolResult {
            turn,
            step: 0,
            call_id: call_id.into(),
            name: "execute".into(),
            content: "ok".into(),
            is_error: false,
            meta: None,
            images: Vec::new(),
            kind: None,
            artifact_id: None,
        }
    }

    #[test]
    fn queued_turn_detection_follows_the_last_turn_bearing_event() {
        // Completed turn: not queued.
        assert!(!has_queued_user_turn(&[user_ev("q"), text_assistant(1, 0, "a")]));
        // Queued send after the completed turn: queued.
        assert!(has_queued_user_turn(&[
            user_ev("q"),
            text_assistant(1, 0, "a"),
            user_ev("second")
        ]));
        // Turn paused on tool results with a queued send behind: queued.
        assert!(has_queued_user_turn(&[
            user_ev("q"),
            text_assistant(1, 0, "with tools"),
            tool_result(1, "c1"),
            user_ev("while you are at it")
        ]));
        // Interrupted turn without a queued send: not queued.
        assert!(!has_queued_user_turn(&[user_ev("q"), text_assistant(1, 0, "partial")]));
        // Empty log: not queued.
        assert!(!has_queued_user_turn(&[]));
    }

    #[test]
    fn completion_out_parses_old_journals_without_the_stopped_flag() {
        let out: CompletionOut = serde_json::from_str(
            r#"{"text":"t","tool_calls":[],"tokens_in":1,"tokens_out":2,"reasoning":""}"#,
        )
        .unwrap();
        assert!(!out.stopped);
    }

    fn compaction(summary: &str, keep_last: Option<u32>) -> ThreadEvent {
        ThreadEvent::Compaction {
            summary: summary.into(),
            tokens_before: None,
            keep_last,
            model: None,
            usage: None,
        }
    }

    fn summarized(summary: &str) -> String {
        format!("[Conversation summary so far]\n\n{summary}")
    }

    #[test]
    fn compaction_replaces_prefix_with_summary_and_tail() {
        let events = vec![
            user_ev("q1"),
            text_assistant(1, 0, "a1"),
            user_ev("q2"),
            text_assistant(1, 1, "a2"),
            compaction("S", Some(2)),
            user_ev("q3"),
            text_assistant(2, 0, "a3"),
        ];
        let msgs = build_model_history(&events, &Default::default(), &[]);
        assert_eq!(msgs.len(), 5, "summary + 2 tail + 2 post-compaction");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, summarized("S"));
        assert_eq!(msgs[1].content, "q2", "tail = last keep_last buffered");
        assert_eq!(msgs[2].content, "a2");
        assert_eq!(msgs[3].content, "q3", "post-compaction events flow");
        assert_eq!(msgs[4].content, "a3");
        // Older messages are folded into the summary, not re-emitted.
        assert!(!msgs.iter().any(|m| m.content == "q1"));
        assert!(!msgs.iter().any(|m| m.content == "a1"));
    }

    #[test]
    fn compaction_keep_last_defaults_to_four() {
        let events = vec![
            user_ev("q1"),
            text_assistant(1, 0, "a1"),
            user_ev("q2"),
            text_assistant(1, 1, "a2"),
            user_ev("q3"),
            text_assistant(2, 0, "a3"),
            user_ev("q4"),
            text_assistant(3, 0, "a4"),
            compaction("S", None),
            user_ev("q5"),
        ];
        let msgs = build_model_history(&events, &Default::default(), &[]);
        // summary + last 4 buffered (q3,a3,q4,a4) + q5
        assert_eq!(msgs.len(), 6);
        assert_eq!(msgs[0].content, summarized("S"));
        assert_eq!(msgs[1].content, "q3");
        assert_eq!(msgs[4].content, "a4");
        assert_eq!(msgs[5].content, "q5");
        assert!(!msgs.iter().any(|m| m.content == "q1" || m.content == "a1"));
    }

    #[test]
    fn compaction_keep_last_larger_than_buffer_emits_all() {
        let events = vec![
            user_ev("q1"),
            text_assistant(1, 0, "a1"),
            compaction("S", Some(99)),
            user_ev("q2"),
        ];
        let msgs = build_model_history(&events, &Default::default(), &[]);
        assert_eq!(msgs.len(), 4, "summary + both buffered + post");
        assert_eq!(msgs[0].content, summarized("S"));
        assert_eq!(msgs[1].content, "q1");
        assert_eq!(msgs[2].content, "a1");
        assert_eq!(msgs[3].content, "q2");
    }

    #[test]
    fn compaction_keep_last_zero_emits_summary_only() {
        let events = vec![
            user_ev("q1"),
            text_assistant(1, 0, "a1"),
            compaction("S", Some(0)),
            user_ev("q2"),
        ];
        let msgs = build_model_history(&events, &Default::default(), &[]);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, summarized("S"));
        assert_eq!(msgs[1].content, "q2");
    }

    #[test]
    fn two_compactions_compose() {
        let events = vec![
            user_ev("q1"),
            text_assistant(1, 0, "a1"),
            compaction("S1", Some(1)),
            user_ev("q2"),
            text_assistant(2, 0, "a2"),
            compaction("S2", Some(1)),
            user_ev("q3"),
        ];
        let msgs = build_model_history(&events, &Default::default(), &[]);
        // Each compaction applies at its position: S1 replaces q1/a1 keeping
        // a1; S2 replaces the segment since S1 (q2/a2) keeping a2; q3 flows.
        assert_eq!(msgs.len(), 5);
        assert_eq!(msgs[0].content, summarized("S1"));
        assert_eq!(msgs[1].content, "a1");
        assert_eq!(msgs[2].content, summarized("S2"));
        assert_eq!(msgs[3].content, "a2");
        assert_eq!(msgs[4].content, "q3");
    }

    #[test]
    fn compaction_informational_fields_ignored_by_derivation() {
        let plain = vec![user_ev("q1"), compaction("S", Some(1)), user_ev("q2")];
        let annotated = vec![
            user_ev("q1"),
            ThreadEvent::Compaction {
                summary: "S".into(),
                tokens_before: Some(12345),
                keep_last: Some(1),
                model: Some("deepseek-test".into()),
                usage: Some(UsagePayload {
                    tokens_in: Some(12000),
                    tokens_out: Some(345),
                    cost_usd: Some(0.01),
                }),
            },
            user_ev("q2"),
        ];
        assert_eq!(
            build_model_history(&plain, &Default::default(), &[]),
            build_model_history(&annotated, &Default::default(), &[])
        );
    }

    #[test]
    fn compaction_preserves_per_event_semantics() {
        // Reasoning replay, tool_call parsing and tool results survive
        // compaction both in the tail and after the checkpoint.
        let events = vec![
            user_ev("q1"),
            text_assistant(1, 0, "gone"),
            compaction("S", Some(3)),
            user_ev("q2"),
            ThreadEvent::AssistantMessage {
                turn: 2,
                step: 0,
                blocks: vec![
                    Block::Reasoning {
                        text: "think".into(),
                    },
                    Block::ToolCall {
                        id: "c1".into(),
                        name: "read".into(),
                        arguments: "{\"path\":\"a.rs\"}".into(),
                    },
                ],
                usage: UsagePayload::default(),
                model: "deepseek-test".into(),
                interrupted: None,
            },
            ThreadEvent::ToolResult {
                turn: 2,
                step: 0,
                call_id: "c1".into(),
                name: "read".into(),
                content: "fn main() {}".into(),
                is_error: false,
                meta: None,
                images: Vec::new(),
                kind: None,
                artifact_id: None,
            },
        ];
        let msgs = build_model_history(&events, &Default::default(), &[]);
        assert_eq!(
            msgs.len(),
            6,
            "summary + tail(q1,a1) + q2 + assistant(tool) + tool"
        );
        assert_eq!(msgs[0].content, summarized("S"));
        assert_eq!(msgs[3].content, "q2");
        assert_eq!(msgs[4].reasoning.as_deref(), Some("think"));
        let calls = msgs[4].tool_calls.as_ref().expect("tool calls carried");
        assert_eq!(calls[0].id, "c1");
        assert_eq!(calls[0].arguments["path"], "a.rs");
        assert_eq!(msgs[5].role, "tool");
        assert_eq!(msgs[5].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(msgs[5].content, "fn main() {}");
    }

    #[test]
    fn complete_approval_dedupe_first_answer_wins() {
        // Absent key (already decided / timed out / not waiting): no-op.
        let req = ApprovalReq {
            call_id: "c".into(),
            approved: true,
            reason: None,
        };
        assert!(approval_on_decision(None, req.clone()).is_none());
        // Present key: the awakeable resolves with the decision.
        let (id, decision) = approval_on_decision(Some("awakeable-1".into()), req.clone()).unwrap();
        assert_eq!(id, "awakeable-1");
        assert!(decision.approved);
        assert_eq!(decision.reason, None);
        // A denied decision carries its reason through.
        let denied = ApprovalReq {
            call_id: "c".into(),
            approved: false,
            reason: Some("no".into()),
        };
        let (_, decision) = approval_on_decision(Some("awakeable-2".into()), denied).unwrap();
        assert!(!decision.approved);
        assert_eq!(decision.reason.as_deref(), Some("no"));
    }

    // ---- compaction pure parts (phase 3, design §C) ----

    fn assistant(turn: u32, step: u32, text: &str, model: &str) -> ThreadEvent {
        ThreadEvent::AssistantMessage {
            turn,
            step,
            blocks: vec![Block::Text { text: text.into() }],
            usage: UsagePayload::default(),
            model: model.into(),
            interrupted: None,
        }
    }

    #[test]
    fn latest_assistant_model_takes_the_last_assistant_event() {
        let events = vec![
            ThreadEvent::UserMessage {
                content: "hi".into(),
                attachments: Vec::new(),
            },
            assistant(1, 0, "first", "model-a"),
            ThreadEvent::UserMessage {
                content: "more".into(),
                attachments: Vec::new(),
            },
            assistant(2, 0, "second", "model-b"),
            ThreadEvent::ToolResult {
                turn: 2,
                step: 0,
                call_id: "c".into(),
                name: "read".into(),
                content: "x".into(),
                is_error: false,
                meta: None,
                images: Vec::new(),
                kind: None,
                artifact_id: None,
            },
        ];
        assert_eq!(latest_assistant_model(&events).as_deref(), Some("model-b"));
    }

    #[test]
    fn latest_assistant_model_none_without_assistant_events() {
        let events = vec![
            ThreadEvent::SystemMessage {
                content: "s".into(),
            },
            ThreadEvent::UserMessage {
                content: "hi".into(),
                attachments: Vec::new(),
            },
            ThreadEvent::Compaction {
                summary: "earlier".into(),
                tokens_before: None,
                keep_last: None,
                model: Some("old-model".into()),
                usage: None,
            },
        ];
        assert_eq!(latest_assistant_model(&events), None);
    }

    #[test]
    fn message_bearing_count_ignores_log_only_events() {
        let history = build_model_history(
            &[
                ThreadEvent::SystemMessage {
                    content: "s".into(),
                },
                ThreadEvent::ApprovalRequest {
                    call_id: "c".into(),
                    name: "bash".into(),
                    arguments: "{}".into(),
                },
                ThreadEvent::ApprovalDecision {
                    call_id: "c".into(),
                    approved: true,
                    reason: None,
                    expired: false,
                },
                ThreadEvent::UserMessage {
                    content: "q".into(),
                    attachments: Vec::new(),
                },
                assistant(1, 0, "a", "m"),
            ],
            &Default::default(),
            &[],
        );
        assert_eq!(message_bearing_count(&history), 2);
    }

    #[test]
    fn too_short_rejection_threshold_is_four() {
        // Fewer than 4 message-bearing messages: rejected.
        for n in 0..4 {
            let history: Vec<Message> = (0..n).map(|i| Message::user(format!("u{i}"))).collect();
            assert!(too_short_to_compact(&history), "n={n} should be too short");
        }
        // 4 and up: compactible (user/assistant/tool all count).
        let history = vec![
            Message::user("q"),
            Message {
                role: "assistant".into(),
                content: String::new(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: Some(vec![]),
                tool_call_id: None,
                reasoning: None,
            },
            Message::tool_result("c1", "out"),
            Message::user("next"),
        ];
        assert!(!too_short_to_compact(&history));
        assert_eq!(message_bearing_count(&history), 4);
    }

    #[test]
    fn compaction_request_serializes_minimally() {
        // The gateway sends this via restate_send_one_way; the JSON shape is
        // the handler contract (org + chat only — history is loaded in the
        // workflow).
        let org = Uuid::now_v7();
        let chat = Uuid::now_v7();
        let v = serde_json::to_value(CompactReq {
            org_id: org,
            chat_id: chat,
        })
        .unwrap();
        assert_eq!(v["org_id"], serde_json::to_value(org).unwrap());
        assert_eq!(v["chat_id"], serde_json::to_value(chat).unwrap());
    }

    // INTEGRATION GAP (noted per task C2): the happy-path handler test
    // against a wiremock-mocked provider (summary event appended with
    // model/usage; generation-in-flight rejection) needs an embedded Restate
    // runtime to drive the ChatRunner virtual object — the same gap that
    // keeps the existing gateway/approval suites `#[ignore]`d (see
    // crates/server/tests/gateway_api.rs). The pure parts above cover model
    // selection, log-only exclusion, and the too-short threshold; the
    // handler itself mirrors the journaled shape of `generate` line-for-line.
}
