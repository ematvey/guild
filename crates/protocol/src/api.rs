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
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, optional_fields))]
pub struct Message {
    pub role: String,
    pub content: String,
    /// Assistant message tool invocations (agentic loop replay).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Set on role="tool" messages: which call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
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
            tool_calls: Some(vec![tc.clone()]),
            tool_call_id: None,
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
