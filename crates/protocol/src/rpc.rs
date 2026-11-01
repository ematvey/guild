//! JSON-RPC 2.0 envelope over line-delimited stdio, versioned per spec §6.
//! Every message carries `protocol` so UI and engine can negotiate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

/// Build identity (git commit at build time) embedded by protocol's build
/// script. Every binary in one workspace build graph links the same value;
/// the daemon reports it in daemon.hello and clients compare it so a new
/// GUI never inherits a stale background daemon from an older install.
pub const BUILD_ID: &str = env!("GUILD_BUILD_ID");

/// Request from client to server (either side can be "client").
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub jsonrpc: String,
    /// JSON numbers, not TS bigint — the wire is JSON.
    pub id: u64,
    pub protocol: u32,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl Request {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            protocol: PROTOCOL_VERSION,
            method: method.into(),
            params,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.jsonrpc == "2.0" && self.protocol == PROTOCOL_VERSION && !self.method.is_empty()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, thiserror::Error)]
#[error("rpc error {code}: {message}")]
pub struct RpcError {
    /// JSON numbers, not TS bigint — the wire is JSON.
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INTERNAL: i64 = -32603;
    pub const APP_BASE: i64 = -32000;
}

/// Reply to a `Request`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Response {
    pub jsonrpc: String,
    /// JSON numbers, not TS bigint — the wire is JSON.
    pub id: u64,
    pub protocol: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            protocol: PROTOCOL_VERSION,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            protocol: PROTOCOL_VERSION,
            result: None,
            error: Some(error),
        }
    }
}

/// Unsolicited server-push message (streaming deltas, status).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Event {
    pub protocol: u32,
    pub event: String,
    #[serde(default)]
    pub payload: Value,
}

impl Event {
    pub fn new(event: impl Into<String>, payload: Value) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            event: event.into(),
            payload,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_serializes_with_protocol_field() {
        let r = Request::new(1, "chat.send", serde_json::json!({"text": "hi"}));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["protocol"], 1);
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["method"], "chat.send");
        assert_eq!(v["params"]["text"], "hi");
        assert!(r.is_valid());
    }

    #[test]
    fn response_ok_and_err_shapes() {
        let ok = Response::ok(3, serde_json::json!({"a": 1}));
        assert!(ok.error.is_none() && ok.result.is_some());
        let err = Response::err(3, RpcError::new(RpcError::METHOD_NOT_FOUND, "nope"));
        assert!(err.result.is_none() && err.error.is_some());
    }
}
