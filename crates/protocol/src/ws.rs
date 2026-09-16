//! Wire envelopes for the per-client WebSocket connection (spec §1). One
//! socket per browser tab or desktop app; machines are singletons. Every
//! message is a JSON text frame tagged by `type`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Client → server. `Sync` declares the currently open chat (None = none
/// open); the server answers with the state-sync sequence. `ToolResult`
/// delivers a machine-tool outcome (the WS replacement for the HTTP
/// tool-result endpoint).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsClientMsg {
    Sync { chat_id: Option<Uuid> },
    ToolResult {
        chat_id: Uuid,
        call_id: String,
        content: String,
        is_error: bool,
        meta: Option<serde_json::Value>,
    },
}

/// Server → client. Snapshot/live frames reuse the existing app-frame
/// envelope shape ({chat_id, machine_id, event}) so client render code is
/// unchanged; the sync bracket (SyncBegin..SyncDone) tells the client where
/// "overwrite local with server state" starts and ends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerMsg {
    Hello,
    /// This machine's singleton slot was taken by a newer connection.
    Displaced,
    AuthRequired,
    Error { message: String },
    ThreadList { chats: Vec<serde_json::Value> },
    /// Owner-scoped thread-list spinner/unread frame (from the existing
    /// chat-status NOTIFY channel).
    ChatStatus { chat_id: Uuid, generating: bool },
    /// Bracket for the state-sync of one chat.
    SyncBegin { chat_id: Uuid },
    /// Full durable history of the chat from the thread log, oldest first.
    History { chat_id: Uuid, events: Vec<serde_json::Value> },
    /// In-flight generation state, frame-shaped exactly like live frames.
    SnapshotFrame { chat_id: Uuid, machine_id: Option<String>, event: crate::api::StreamEvent },
    SyncDone { chat_id: Uuid },
    /// Live fan-out frame (generation delta, tool dispatch, ...).
    LiveFrame { chat_id: Uuid, machine_id: Option<String>, event: crate::api::StreamEvent },
    /// Org-scoped event from the events NOTIFY channel.
    OrgEvent { event: serde_json::Value },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msgs_round_trip() {
        let sync = WsClientMsg::Sync { chat_id: Some(Uuid::nil()) };
        let json = serde_json::to_string(&sync).unwrap();
        assert!(json.contains(r#""type":"sync""#));
        assert_eq!(serde_json::from_str::<WsClientMsg>(&json).unwrap(), sync);

        let tr = WsClientMsg::ToolResult {
            chat_id: Uuid::nil(),
            call_id: "c1".into(),
            content: "out".into(),
            is_error: false,
            meta: None,
        };
        assert_eq!(
            serde_json::from_str::<WsClientMsg>(&serde_json::to_string(&tr).unwrap()).unwrap(),
            tr
        );
    }

    #[test]
    fn server_msgs_round_trip_and_frame_shape() {
        let ev = crate::api::StreamEvent::Delta { content: "hi".into() };
        let f = WsServerMsg::LiveFrame { chat_id: Uuid::nil(), machine_id: None, event: ev };
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains(r#""type":"live_frame""#));
        assert_eq!(serde_json::from_str::<WsServerMsg>(&json).unwrap(), f);
        let d = WsServerMsg::Displaced;
        assert!(serde_json::to_string(&d).unwrap().contains(r#""type":"displaced""#));
    }
}
