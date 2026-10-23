//! Cloud API schemas (app-server <-> guild-server), spec §4/§5.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct UserInfo {
    pub id: Uuid,
    pub email: String,
    pub org_id: Uuid,
    pub role: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
}

/// Desktop-app enrollment: the webapp shows a one-time pairing code
/// (`g1|<server_url>|<hex secret>`) that the client redeems here for a
/// normal session. Format: CreatePairingTokenResponse is returned once.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct PairRequest {
    pub code: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct PairResponse {
    pub token: String,
    pub user: UserInfo,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct CreatePairingTokenRequest {
    /// Token lifetime in minutes (default 30, capped server-side).
    #[serde(skip_serializing_if = "Option::is_none")]
    /// JSON numbers, not TS bigint — the wire is JSON.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub ttl_minutes: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct PairingTokenResponse {
    pub id: Uuid,
    /// One-time secret — shown/copied once; the client composes the full
    /// code as `g1|<server_url>|<secret>` (the server URL is routing info).
    pub secret: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct PairingTokenInfo {
    pub id: Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct CreateChatRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional project binding at creation (the composer chip).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
}

/// One project (spec §1): a named folder bound to a machine.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    /// Windows path; UNC (`\\wsl.localhost\…`) for a WSL distro folder.
    pub folder: String,
    pub machine_id: String,
    pub machine_label: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct CreateProjectRequest {
    /// Display label; defaults to the folder's basename when omitted.
    pub name: Option<String>,
    pub folder: String,
    pub machine_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct UpdateProjectRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    /// Soft-hide: archived projects drop out of every list; `false`
    /// unarchives. Absent = unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

/// PATCH /api/v1/chats/{id} — rename and/or archive. Only present fields
/// change.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct UpdateChatRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct Chat {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Bound executor machine: machine tools run only there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_label: Option<String>,
    /// A generation is in flight (sidebar spinner). Defaults for old
    /// journals/clients.
    #[serde(default)]
    pub generating: bool,
    /// The reader has an unseen assistant turn (sidebar dot).
    #[serde(default)]
    pub unread: bool,
    /// The project (named workspace folder) the chat runs in; None =
    /// folderless. Defaults for old clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_machine_label: Option<String>,
    /// Whether the bound machine's singleton socket is live right now
    /// (drives the connection dot next to the folder chip). Always false
    /// for unbound chats.
    #[serde(default)]
    pub machine_online: bool,
}

/// One durable machine-registry row for the machines page (spec §2.3),
/// joined with the hub's live socket state. Connected rows sort before
/// offline ones, then by last_seen_at descending.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct MachineInfo {
    pub machine_id: String,
    /// Hostname label; falls back to machine_id when unset.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// Raw peer address of the last connect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ip: Option<String>,
    pub first_connected_at: DateTime<Utc>,
    pub last_connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    /// The machine's singleton socket is live right now.
    pub connected: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct Message {
    pub role: String,
    pub content: String,
    /// Image parts (data URIs, e.g. `data:image/png;base64,…`). Serialized
    /// as `image_url` content parts on OpenAI-shape routes and base64 image
    /// blocks on Anthropic routes — on user turns and tool results (read_file
    /// on an image) alike, only when the resolved route supports the image
    /// modality.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// User-turn audio parts (base64 + `wav`/`mp3` per the OpenAI
    /// `input_audio` contract). Anthropic routes have no audio input —
    /// media is never dropped from the thread log; it is only skipped on
    /// the wire for routes without the modality.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio: Vec<MessageAudio>,
    /// Assistant message tool invocations (agentic loop replay).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Set on role="tool" messages: which call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Assistant-only: chain-of-thought reasoning for this message. Persisted
    /// on the thread and REPLAYED to the model on every reasoning-carrying
    /// turn (serialized as `reasoning_content` on OpenAI-shape routes) —
    /// never dropped from context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

/// One audio part on a user turn (OpenAI `input_audio` contract).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct MessageAudio {
    /// Raw base64 (no data: prefix).
    pub data: String,
    /// `wav` or `mp3`.
    pub format: String,
}

impl Message {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            images: Vec::new(),
            audio: Vec::new(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
        }
    }

    pub fn with_images(mut self, images: Vec<String>) -> Self {
        self.images = images;
        self
    }

    pub fn with_audio(mut self, audio: Vec<MessageAudio>) -> Self {
        self.audio = audio;
        self
    }

    /// Whether this message carries image/audio parts.
    pub fn has_media(&self) -> bool {
        !self.images.is_empty() || !self.audio.is_empty()
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            images: Vec::new(),
            audio: Vec::new(),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
            reasoning: None,
        }
    }
}

/// Coarse tool category the UI renders natively: `web_search` and
/// `web_browse` get native labels and cards regardless of which integration
/// provides the tool; `generic` renders the bare tool name.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    WebSearch,
    WebBrowse,
    #[default]
    Generic,
}

/// Declared callable tool (JSON Schema parameters).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    #[serde(default)]
    pub kind: ToolKind,
}

/// One tool invocation requested by the model.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct ChatCompletionRequest {
    /// Optional stable identity for the committed user-message echo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<Uuid>,
    pub chat_id: Uuid,
    pub model: String,
    pub messages: Vec<Message>,
    /// Agentic tool calling: declared tools for this turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolSpec>>,
    /// Optional system prompt (agent sessions set this).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// True when the calling client can execute machine tools (read_file/execute/
    /// edit_file/write_file) — i.e. the Tauri desktop app. Web clients cannot, and
    /// declaring the tools there makes the model call them and the durable
    /// turn suspend for the 5-minute client-tool timeout with no one to
    /// answer it.
    #[serde(default)]
    pub client_tools: bool,
    /// The project (named workspace folder) this turn runs in; the server
    /// resolves folder + machine label journaled and names the workspace in
    /// the system prompt it builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    /// Context attachments for this turn: uploaded beforehand via
    /// POST /api/v1/chats/{id}/attachments; the server inlines documents'
    /// text and passes image/audio parts when the route supports the
    /// modality (spec §4.3).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachment_ids: Vec<Uuid>,
    /// Server-local execution: the NAME of this org's workspace directory
    /// the server itself executes tools in (batch/automation backend). The
    /// name is resolved against the org's workspace root server-side — a
    /// request can never point the executor outside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_workspace: Option<String>,
    /// Client-discovered local-skills index, appended to the server-owned
    /// system prompt. Additive and server-capped: the client never overrides
    /// persona or tool instructions, it may only append this bounded block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_index: Option<String>,
    /// Client-discovered AGENTS.md instructions (Codex semantics: the global
    /// config-dir file plus the project chain from the git root down to the
    /// working folder). Additive like skills_index — the server appends it to
    /// the agent's workspace instructions as a `## Project instructions`
    /// block under its own 32 KiB cap; the client may not override persona
    /// or tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_md: Option<String>,
    /// What to do when a turn is already generating in this chat:
    /// `"queue"` (default) commits the message to the thread and the running
    /// turn flushes it at its exit; `"steer"` also interrupts the in-flight
    /// turn (delivered prefix stays in history) so the message runs now.
    /// Ignored when no turn is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_mode: Option<String>,
}

/// Frames streamed from the gateway on `POST /api/v1/gateway/chat`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum StreamEvent {
    Delta {
        content: String,
    },
    /// Sent (only on the attach endpoint) when the chat has no generation in
    /// flight: lets a (re)attaching client distinguish "nothing running" from
    /// a dropped connection, which just ends the stream without a frame.
    Idle,
    Done {
        message_id: Uuid,
        cost_usd: f64,
        tokens_in: u32,
        tokens_out: u32,
    },
    Error {
        code: String,
        message: String,
    },
    /// Fragment of a tool call streamed by the model; arguments accumulate
    /// client-side by `index`.
    ToolCallDelta {
        index: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments_delta: String,
    },
    /// A completed tool call (arguments fully accumulated).
    ToolCallDone {
        call: ToolCall,
    },
    /// A tool call is being executed: `executor` says whether the attached
    /// client must run it (machine tools: read_file/execute/edit_file/write_file) or it runs
    /// server-side (integrations, e.g. web_search). Clients that cannot
    /// execute client tools just display it.
    ToolStarted {
        call_id: String,
        name: String,
        arguments: String,
        executor: ToolExecutor,
        /// Coarse category of the tool, for native UI labels. Client tools
        /// and pre-kind frames carry none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<ToolKind>,
    },
    /// A tool call finished with its result (both executors).
    ToolCompleted {
        call_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    /// A client-tool call is awaiting user approval (phase 2 gate). All
    /// attached clients show an approval card; first Approve/Deny wins.
    ApprovalRequested {
        call_id: String,
        name: String,
        arguments: String,
    },
    /// The approval for `call_id` was decided (by any attached client, or by
    /// the timeout). Updates the card on every client.
    ApprovalResolved {
        call_id: String,
        approved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Fragment of the model's chain-of-thought reasoning. Accumulates into
    /// the current `reasoning` block of the in-flight assistant turn. On the
    /// attach catch-up path the FIRST frame after attaching carries the full
    /// buffer so far, not a delta.
    ThinkingDelta {
        content: String,
    },
}

/// Who runs a tool call.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ToolExecutor {
    Client,
    Server,
}

/// Token accounting carried on an assistant thread event.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct UsagePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// One typed block inside an assistant thread event, in stream order.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum Block {
    Text {
        text: String,
    },
    /// Chain-of-thought reasoning. Persisted on the thread and replayed to
    /// the model; never dropped from context.
    Reasoning {
        text: String,
    },
    /// A tool invocation requested by the model. `arguments` is the RAW JSON
    /// string exactly as the model produced it — never parse/reserialize on
    /// the persist path.
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
}

/// A file attached to a user turn (chip metadata: the bytes live in object
/// storage; documents' text is inlined into the turn content).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct MessageAttachment {
    pub id: Uuid,
    pub filename: String,
    pub content_type: String,
    /// JSON numbers, not TS bigint — the wire is JSON.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size_bytes: i64,
    /// `image` | `audio` | `video` | `document` — derived from the content
    /// type; drives chip rendering and model-modality gating.
    pub modality: String,
}

/// The approval judge's verdict on one gated tool call (the "approve for
/// me" policy LLM). Journaled on the approval request so the thread shows
/// why a call asked instead of running silently.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct JudgeVerdict {
    pub approve: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Judge round-trip time in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u32>,
}

/// One durable thread event — the append-only source of truth for a chat.
/// Model-facing message history and client rendering are both derivations of
/// these events (deepseek-harness session model).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum ThreadEvent {
    /// File attached to this user turn: bytes live in object storage
    /// (`/api/v1/attachments/{id}`); documents' text is inlined into the
    /// turn content, image/audio parts ride on the model-facing Message
    /// when the route supports the modality; chips are for client rendering.
    UserMessage {
        content: String,
        #[serde(default)]
        attachments: Vec<MessageAttachment>,
        /// Admitted while a turn was still generating: the model has not
        /// seen this message yet — it sits in the conversation's inbox and
        /// is placed at the next boundary (or never, if withdrawn). The
        /// desktop renders it as a queued chip above the composer instead
        /// of a transcript bubble; the bridge clears the flag (and moves
        /// the row to the placement position) when the input is placed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queued: Option<bool>,
        /// Requested placement for the same chip: "steer" (joins the
        /// running turn at the next tool boundary) or "queue" (runs as the
        /// next turn's input). Absent on old events and idle sends.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    /// Server-owned system prompt for this turn. Log-only: rebuilds the
    /// request header on derivation, never rendered as a chat message.
    SystemMessage { content: String },
    AssistantMessage {
        turn: u32,
        step: u32,
        blocks: Vec<Block>,
        usage: UsagePayload,
        model: String,
        /// Aborted mid-stream: blocks carry the delivered prefix only.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interrupted: Option<bool>,
        /// A failed provider attempt: the human-readable error. The client
        /// renders it only while it is the thread's latest block (a later
        /// retry that produced content supersedes it).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    ToolResult {
        turn: u32,
        step: u32,
        call_id: String,
        name: String,
        /// Model-facing text (what the model reads as the tool result).
        content: String,
        #[serde(default)]
        is_error: bool,
        /// Tool-private widget payload (dsh presentationMeta pattern):
        /// provider-neutral render intent persisted with the event so UI
        /// cards reproduce identically on replay. Opaque to the loop.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
        /// Image parts (data URIs) attached to the model-facing tool result
        /// (e.g. read_file on an image), gated by the route's image modality
        /// at persist time. Empty on old events (serde default).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
        /// Coarse category of the tool (the spec's `kind`), so the UI can
        /// label the frame natively. Absent on old events (serde default).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<ToolKind>,
        /// Oversized results are spilled into `tool_artifacts` (bytes in
        /// object storage); `content` carries the pointer text and head
        /// excerpt. Absent on inline results and old events.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_id: Option<Uuid>,
    },
    /// Compaction checkpoint (phase 3): the model-facing history before
    /// this event is replaced by `summary` (plus a verbatim tail of
    /// `keep_last` message-bearing events); everything after flows normally.
    Compaction {
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens_before: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keep_last: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<UsagePayload>,
    },
    /// A client-tool call is awaiting user approval (phase 2). Log-only:
    /// excluded from model-facing history derivation.
    ApprovalRequest {
        call_id: String,
        name: String,
        arguments: String,
        /// The approval judge's verdict on this call, when the judge ran
        /// (absent when the judge was skipped or unavailable).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        judge: Option<JudgeVerdict>,
    },
    /// The decision for a prior `approval_request`. First answer wins; the
    /// timeout auto-denies.
    ApprovalDecision {
        call_id: String,
        approved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// Nobody was waiting when the decision landed: the turn is gone, so
        /// the call can never execute. The card stays visible as expired.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        expired: bool,
    },
    /// The turn's generation failed (model unreachable, route gone). The
    /// thread shows it as a terminal error card; excluded from model-facing
    /// history derivation.
    TurnError { message: String },
    /// Written to the parent chat when a spawn or send posts a child turn,
    /// so the row exists before the child finishes.
    ChildSpawned {
        thread_id: Uuid,
        run_id: Uuid,
        chat_id: Uuid,
        agent_name: String,
        title: String,
        status: String,
    },
    /// A child run ended: the delivery the parent drains at its next
    /// boundary (docs/specs/2026-10-22-agent-to-agent.md). Log-only: the
    /// delivery reaches the parent as a user message, not as this event.
    ChildResult {
        thread_id: Uuid,
        run_id: Uuid,
        /// The child thread's chat: the row navigates to `/thread/<chat_id>`.
        chat_id: Uuid,
        /// The child thread's agent name, for the row label.
        #[serde(default)]
        agent_name: String,
        /// The child thread's title: the session name its spawner chose.
        #[serde(default)]
        title: String,
        /// The child run's terminal status; `cancelled` is a user stop.
        status: String,
        /// The run's start, so a row rebuilt from the result alone still
        /// shows its duration.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default)]
        final_text: String,
        #[serde(default)]
        attachments: Vec<MessageAttachment>,
    },
    /// Written to the parent chat when a child thread is closed, so the row
    /// stays closed after a reload.
    ChildClosed { thread_id: Uuid },
}

/// The fixed set of machine tools executed by the attached client. This is
/// the single definition of the built-in tool schemas: the guild-core
/// registry re-exports these specs verbatim, so what the model is told and
/// what the executor validates can never drift.
pub fn client_tool_specs() -> Vec<ToolSpec> {
    fn spec(
        name: &str,
        description: &str,
        properties: serde_json::Value,
        required: &[&str],
    ) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: description.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": properties,
                "required": required.iter().map(|r| serde_json::Value::from(*r)).collect::<Vec<serde_json::Value>>()
            }),
            kind: Default::default(),
        }
    }
    let str_prop = serde_json::json!({ "type": "string" });
    let num_prop = serde_json::json!({ "type": "number" });
    vec![
        spec(
            "read_file",
            "Read a text file relative to the project directory. Returns up to `limit` lines (default 2000) starting at `offset` (1-based). Image files (png/jpg/gif/webp) are returned as attached images for viewing.",
            serde_json::json!({
                "path": str_prop,
                "offset": num_prop,
                "limit": num_prop
            }),
            &["path"],
        ),
        spec(
            "write_file",
            "Create a file or overwrite it with `content`. Parent directories are created automatically.",
            serde_json::json!({
                "path": str_prop,
                "content": str_prop
            }),
            &["path", "content"],
        ),
        spec(
            "edit_file",
            "Replace one exact occurrence of `oldText` in a file with `newText`. Fails when oldText is not found or is ambiguous.",
            serde_json::json!({
                "path": str_prop,
                "oldText": str_prop,
                "newText": str_prop
            }),
            &["path", "oldText", "newText"],
        ),
        spec(
            "execute",
            "Run a shell command in the project directory (sh on Unix/macOS, cmd on Windows) and return combined stdout+stderr. Non-zero exits are reported, not errors.",
            serde_json::json!({
                "command": str_prop,
                "cwd": str_prop,
                "timeout_ms": { "type": "integer" }
            }),
            &["command"],
        ),
    ]
}

/// The spec for one built-in client tool by name (see `client_tool_specs`).
pub fn client_tool_spec(name: &str) -> Option<ToolSpec> {
    client_tool_specs().into_iter().find(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_event_roundtrip() {
        let d = StreamEvent::Delta {
            content: "hi".into(),
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["type"], "delta");
        assert_eq!(v["content"], "hi");
        assert_eq!(serde_json::from_value::<StreamEvent>(v).unwrap(), d);

        let done = StreamEvent::Done {
            message_id: Uuid::now_v7(),
            cost_usd: 0.01,
            tokens_in: 3,
            tokens_out: 2,
        };
        let v = serde_json::to_value(&done).unwrap();
        assert_eq!(v["type"], "done");
        assert_eq!(v["tokens_in"], 3);
    }

    #[test]
    fn tool_shapes_roundtrip() {
        let tc = ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "a.rs"}),
        };
        let spec = ToolSpec {
            name: "read_file".into(),
            description: "read a file".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
            kind: Default::default(),
        };
        let m = Message {
            role: "assistant".into(),
            content: String::new(),
            images: Vec::new(),
            audio: Vec::new(),
            tool_calls: Some(vec![tc.clone()]),
            tool_call_id: None,
            reasoning: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["tool_calls"][0]["name"], "read_file");
        assert_eq!(serde_json::from_value::<Message>(v).unwrap(), m);

        let delta = StreamEvent::ToolCallDelta {
            index: 0,
            id: Some("c1".into()),
            name: Some("read_file".into()),
            arguments_delta: "{\"pat".into(),
        };
        let v = serde_json::to_value(&delta).unwrap();
        assert_eq!(v["type"], "tool_call_delta");
        assert_eq!(v["arguments_delta"], "{\"pat");

        let done = StreamEvent::ToolCallDone { call: tc.clone() };
        let v = serde_json::to_value(&done).unwrap();
        assert_eq!(v["type"], "tool_call_done");
        assert_eq!(serde_json::from_value::<StreamEvent>(v).unwrap(), done);
        let _ = spec; // shape exercised in the full flow tests
    }

    #[test]
    fn plain_message_wire_shape_is_unchanged() {
        let m = Message::user("hi");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v, serde_json::json!({"role": "user", "content": "hi"}));
    }

    #[test]
    fn login_response_roundtrip() {
        let r = LoginResponse {
            token: "tok".into(),
            user: UserInfo {
                id: Uuid::now_v7(),
                email: "a@b.c".into(),
                org_id: Uuid::now_v7(),
                role: "admin".into(),
                display_name: Some("Admin".into()),
                avatar_url: None,
            },
        };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<LoginResponse>(&s).unwrap(), r);
    }
}