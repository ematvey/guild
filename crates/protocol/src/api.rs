//! Cloud API schemas (app-server <-> guild-server), spec §4/§5.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UserInfo {
    pub id: Uuid,
    pub email: String,
    pub org_id: Uuid,
    pub role: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CreateChatRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Chat {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChatCompletionRequest {
    pub chat_id: Uuid,
    pub model: String,
    pub messages: Vec<Message>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MessageRow {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub role: String,
    pub content: String,
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
