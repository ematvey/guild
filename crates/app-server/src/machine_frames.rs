//! Classifies the server frames a machine link acts on.

use protocol::ws::WsServerMsg;
use uuid::Uuid;

/// The executor-relevant subset of `WsServerMsg`, extracted by tag-peeking
/// the raw JSON first: the link's liveness must not depend on the display
/// event vocabulary (`StreamEvent` gains variants regularly, and machine
/// sockets receive the same live feed as browser sockets). Only the frames
/// this socket acts on are parsed strictly; everything else — display
/// frames, unknown variants, unparseable text — is ignored.
pub enum ServerFrame {
    ToolDispatch {
        chat_id: Uuid,
        call_id: String,
        name: String,
        arguments: String,
        workdir: Option<String>,
    },
    ToolCancel {
        call_id: String,
    },
    MachineRequest {
        request_id: String,
        op: String,
        payload: serde_json::Value,
    },
    Displaced,
    AuthRequired,
    Error {
        message: String,
    },
    /// Anything the executor does not act on: display/state frames, frames
    /// with an unknown `type` tag, non-JSON text. All ignored, never fatal.
    Other,
}

pub fn classify_server_frame(text: &str) -> ServerFrame {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ServerFrame::Other;
    };
    let tag = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    match tag {
        "tool_dispatch" | "tool_cancel" | "machine_request" | "error" => {
            match serde_json::from_value::<WsServerMsg>(value) {
                Ok(WsServerMsg::ToolDispatch {
                    chat_id,
                    call_id,
                    name,
                    arguments,
                    workdir,
                }) => ServerFrame::ToolDispatch {
                    chat_id,
                    call_id,
                    name,
                    arguments,
                    workdir,
                },
                Ok(WsServerMsg::ToolCancel { call_id }) => ServerFrame::ToolCancel { call_id },
                Ok(WsServerMsg::MachineRequest {
                    request_id,
                    op,
                    payload,
                }) => ServerFrame::MachineRequest {
                    request_id,
                    op,
                    payload,
                },
                Ok(WsServerMsg::Error { message }) => ServerFrame::Error { message },
                _ => ServerFrame::Other,
            }
        }
        "displaced" => ServerFrame::Displaced,
        "auth_required" => ServerFrame::AuthRequired,
        _ => ServerFrame::Other,
    }
}
