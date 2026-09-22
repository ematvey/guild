//! Wire envelopes for the per-client WebSocket connection (spec §1). One
//! socket per browser tab or desktop app; machines are singletons. Every
//! message is a JSON text frame tagged by `type`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Client → server. `Sync` declares the currently open chat (None = none
/// open); the server answers with the state-sync sequence. `ToolResult`
/// delivers a machine-tool outcome (the WS replacement for the HTTP
/// tool-result endpoint). `MachineResponse` answers a `MachineRequest` the
/// server sent over this socket (control-plane ops: folder browse).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsClientMsg {
    Sync {
        chat_id: Option<Uuid>,
    },
    MachineResponse {
        request_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    ToolResult {
        chat_id: Uuid,
        call_id: String,
        content: String,
        is_error: bool,
        meta: Option<serde_json::Value>,
    },
}

/// Server → client. ThreadState is the only rendered-content source: both
/// sync and live updates replace the whole view at an ordered watermark.
/// LiveFrame is a separate, non-replayable stream for command consumers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerMsg {
    Hello,
    /// This machine's singleton slot was taken by a newer connection.
    Displaced,
    AuthRequired,
    /// Execution is addressed to one connection, never replayed as display state.
    /// `workdir` is the workspace folder the executor runs the tool in (from
    /// the chat's project); None = no workspace (the executor errors the
    /// machine tools).
    ToolDispatch {
        chat_id: Uuid,
        call_id: String,
        name: String,
        arguments: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workdir: Option<String>,
    },
    Error {
        message: String,
    },
    /// Control-plane request to a machine connection (executor socket):
    /// read-only ops the desktop UI drives directly, answered by
    /// `MachineResponse` with the same `request_id`.
    MachineRequest {
        request_id: String,
        op: String,
        payload: serde_json::Value,
    },
    ThreadList {
        chats: Vec<serde_json::Value>,
    },
    /// Owner-scoped thread-list spinner/unread frame (from the existing
    /// chat-status NOTIFY channel).
    ChatStatus {
        chat_id: Uuid,
        generating: bool,
    },
    /// Bracket for the state-sync of one chat.
    SyncBegin {
        chat_id: Uuid,
    },
    /// Atomic authoritative content, used for both initial sync and live updates.
    /// `seq` is reserved from the thread-log sequence after capture. A client
    /// replaces its view only when this watermark is newer than its last view.
    ThreadState {
        chat_id: Uuid,
        seq: i64,
        events: Vec<serde_json::Value>,
        text: String,
        thinking: String,
        generating: bool,
        /// The chat's project, for the sidebar's grouping. Defaults keep old
        /// senders deserializable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_machine_label: Option<String>,
        /// True when `events` is only the NEWEST page of the durable log
        /// (the sync payload is capped for long threads): older events load
        /// on scroll-up via `GET /api/v1/chats/{id}/thread?before_seq=`.
        /// Absent/false = the payload is the whole log.
        #[serde(default)]
        has_more_events: bool,
    },
    SyncDone {
        chat_id: Uuid,
    },
    /// Non-replayable generation events for a command-scoped stream consumer.
    /// View clients use ThreadState exclusively, never append these deltas to it.
    LiveFrame {
        chat_id: Uuid,
        generation_id: Uuid,
        seq: i64,
        machine_id: Option<String>,
        event: crate::api::StreamEvent,
    },
    /// Org-scoped event from the events NOTIFY channel.
    OrgEvent {
        event: serde_json::Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msgs_round_trip() {
        let sync = WsClientMsg::Sync {
            chat_id: Some(Uuid::nil()),
        };
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
        let ev = crate::api::StreamEvent::Delta {
            content: "hi".into(),
        };
        let f = WsServerMsg::LiveFrame {
            chat_id: Uuid::nil(),
            generation_id: Uuid::nil(),
            seq: 1,
            machine_id: None,
            event: ev,
        };
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains(r#""type":"live_frame""#));
        assert_eq!(serde_json::from_str::<WsServerMsg>(&json).unwrap(), f);
        let d = WsServerMsg::Displaced;
        assert!(serde_json::to_string(&d)
            .unwrap()
            .contains(r#""type":"displaced""#));
    }
}
