//! Wire envelopes for the per-client WebSocket connection (spec §1). One
//! socket per browser tab or desktop app; machines are singletons. Every
//! message is a JSON text frame tagged by `type`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Executor-owned context returned by the versioned context.prepare_v1 operation.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "Ws.ts", optional_fields))]
pub struct MachineContext {
    pub instructions: Option<String>,
    pub skills_index: String,
    pub skill_expansions: String,
}

/// Client → server. `Sync` declares the currently open chat (None = none
/// open); the server answers with the state-sync sequence. `ToolResult`
/// delivers a machine-tool outcome (the WS replacement for the HTTP
/// tool-result endpoint). `MachineResponse` answers a `MachineRequest` the
/// server sent over this socket (control-plane ops: folder browse).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "Ws.ts", optional_fields))]
pub enum WsClientMsg {
    /// Liveness probe: the server answers with a `pong` server frame
    /// without any per-message session revalidation. Web clients cannot
    /// observe protocol-level pings (browsers auto-pong below JS), so this
    /// app-level round trip is their only liveness signal.
    Ping {},
    Sync {
        chat_id: Option<Uuid>,
    },
    /// The member socket's duplex read-mark: moves the caller's marker to
    /// the chat's newest event (the REST POST /chats/:id/read, on the wire
    /// the turn already rides).
    Read {
        chat_id: Uuid,
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
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
}

/// Server → client. ThreadState is the only rendered-content source: both
/// sync and live updates replace the whole view at an ordered watermark.
/// LiveFrame is a separate, non-replayable stream for command consumers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "Ws.ts", optional_fields))]
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
    /// Stop a call owned by this executor connection. Unknown/completed IDs are ignored.
    ToolCancel {
        call_id: String,
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
    /// Incremental durable-log fan-out: only the events appended since the
    /// client's last view. The client renders them through the same replay
    /// rules a full sync uses, so tool calls and approval cards land live
    /// from the journal instead of turn-end publishes. Tag-peeking daemons
    /// classify unknown tags as `Other` and ignore this frame.
    ThreadEvents {
        chat_id: Uuid,
        /// Newest `seq` carried by `events` (client watermark guard).
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        seq: i64,
        events: Vec<serde_json::Value>,
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
        /// JSON numbers, not TS bigint — the wire is JSON and the member
        /// watermark comparison runs on `number`.
        #[cfg_attr(feature = "ts", ts(type = "number"))]
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
    /// Liveness probe answer to a client `ping`. Daemons tag-peek frames and
    /// ignore unknown types, so older clients are unaffected.
    Pong {},
    /// Non-replayable generation events for a command-scoped stream consumer.
    /// View clients use ThreadState exclusively, never append these deltas to it.
    LiveFrame {
        chat_id: Uuid,
        generation_id: Uuid,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        seq: i64,
        machine_id: Option<String>,
        event: crate::api::StreamEvent,
    },
    /// Org-scoped event from the events NOTIFY channel.
    OrgEvent {
        event: serde_json::Value,
    },
    /// The chat's thread subtree with each node's latest run status. Sent on
    /// the sync bracket and whenever a node is created, starts, finishes or
    /// closes. Daemons tag-peek frames and ignore unknown types.
    SubagentTree {
        chat_id: Uuid,
        nodes: Vec<serde_json::Value>,
    },
    /// One machine's socket presence flip, pushed to the owner's member
    /// sockets when its slot is claimed or released. Daemons tag-peek
    /// frames and ignore unknown types.
    MachineStatus {
        machine_id: String,
        online: bool,
    },
    /// The caller's archived chats (the sidebar's Archived section), sent
    /// with every workspace push. Daemons tag-peek and ignore it.
    ArchivedThreadList {
        chats: Vec<serde_json::Value>,
    },
    /// The caller's projects: active and archived rows, sent with every
    /// workspace push. Daemons tag-peek and ignore it.
    ProjectList {
        projects: Vec<serde_json::Value>,
        archived_projects: Vec<serde_json::Value>,
    },
    /// The caller's machine registry rows with their live socket flag.
    /// Sent with every workspace push. Daemons tag-peek and ignore it.
    MachineList {
        machines: Vec<serde_json::Value>,
    },
    /// The workspace's display identity: the name and logo the app shell
    /// shows in its title. Sent with every workspace push and to every
    /// member socket when an admin renames the workspace. Daemons tag-peek
    /// and ignore it.
    WorkspaceIdentity {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        logo_url: Option<String>,
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
            images: vec!["data:image/png;base64,eA==".into()],
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
    fn old_tool_result_without_images_still_deserializes() {
        let message: WsClientMsg = serde_json::from_value(serde_json::json!({
            "type": "tool_result", "chat_id": Uuid::nil(), "call_id": "old",
            "content": "text", "is_error": false, "meta": null
        }))
        .unwrap();
        assert!(matches!(message, WsClientMsg::ToolResult { images, .. } if images.is_empty()));
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
