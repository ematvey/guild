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
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
}

/// Desktop-app enrollment: the webapp shows a one-time pairing code
/// (`g1.<b64url(server_url)>.<secret>`) that the client redeems here for a
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
    /// Optional machine binding at creation (desktop apps bind their own
    /// machine so machine tools work from the first turn).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
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
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct Message {
    pub role: String,
    pub content: String,
    /// User-turn image parts (data URIs, e.g. `data:image/png;base64,…`).
    /// Serialized as `image_url` content parts on OpenAI-shape routes and
    /// base64 image blocks on Anthropic routes — only when the resolved
    /// route supports the image modality.
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

/// Declared callable tool (JSON Schema parameters).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
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
    pub chat_id: Uuid,
    pub model: String,
    pub messages: Vec<Message>,
    /// Agentic tool calling: declared tools for this turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolSpec>>,
    /// Optional system prompt (agent sessions set this).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// True when the calling client can execute machine tools (read/bash/
    /// edit/write) — i.e. the Tauri desktop app. Web clients cannot, and
    /// declaring the tools there makes the model call them and the durable
    /// turn suspend for the 5-minute client-tool timeout with no one to
    /// answer it.
    #[serde(default)]
    pub client_tools: bool,
    /// Workspace directory the client executes machine tools in. The server
    /// includes it in the system prompt it builds (the server owns the
    /// prompt; the client never sends one for agent turns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    /// Context attachments for this turn: uploaded beforehand via
    /// POST /api/v1/chats/{id}/attachments; the server inlines documents'
    /// text and passes image/audio parts when the route supports the
    /// modality (spec §4.3).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachment_ids: Vec<Uuid>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct MessageRow {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub created_at: DateTime<Utc>,
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
    /// client must run it (machine tools: read/bash/edit/write) or it runs
    /// server-side (integrations, e.g. web_search). Clients that cannot
    /// execute client tools just display it.
    ToolStarted {
        call_id: String,
        name: String,
        arguments: String,
        executor: ToolExecutor,
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
    ThinkingDelta { content: String },
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
    Text { text: String },
    /// Chain-of-thought reasoning. Persisted on the thread and replayed to
    /// the model; never dropped from context.
    Reasoning { text: String },
    /// A tool invocation requested by the model. `arguments` is the RAW JSON
    /// string exactly as the model produced it — never parse/reserialize on
    /// the persist path.
    ToolCall { id: String, name: String, arguments: String },
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
    pub size_bytes: i64,
    /// `image` | `audio` | `video` | `document` — derived from the content
    /// type; drives chip rendering and model-modality gating.
    pub modality: String,
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
    },
    /// The decision for a prior `approval_request`. First answer wins; the
    /// timeout auto-denies.
    ApprovalDecision {
        call_id: String,
        approved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

fn is_false(b: &bool) -> bool {
    !b
}

/// The fixed set of machine tools executed by the attached client, modeled on
/// pi's core coding-agent tool set. Declared here so server and clients share
/// one definition.
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
        }
    }
    let str_prop = serde_json::json!({ "type": "string" });
    let num_prop = serde_json::json!({ "type": "number" });
    vec![
        spec(
            "read",
            "Read a text file from the workspace. Returns up to 2000 lines starting at `offset` (1-based).",
            serde_json::json!({
                "path": str_prop,
                "offset": num_prop,
                "limit": num_prop
            }),
            &["path"],
        ),
        spec(
            "bash",
            "Run a shell command in the workspace and return combined stdout+stderr.",
            serde_json::json!({
                "command": str_prop,
                "timeout_ms": num_prop
            }),
            &["command"],
        ),
        spec(
            "edit",
            "Replace one exact occurrence of `oldText` in a file with `newText`. Fails when oldText is not found or is ambiguous.",
            serde_json::json!({
                "path": str_prop,
                "oldText": str_prop,
                "newText": str_prop
            }),
            &["path", "oldText", "newText"],
        ),
        spec(
            "write",
            "Create a file or overwrite it with `content`. Parent directories are created automatically.",
            serde_json::json!({
                "path": str_prop,
                "content": str_prop
            }),
            &["path", "content"],
        ),
    ]
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
            },
        };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<LoginResponse>(&s).unwrap(), r);
    }
}
