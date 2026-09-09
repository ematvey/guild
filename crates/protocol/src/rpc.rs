//! JSON-RPC 2.0 envelope over line-delimited stdio, versioned per spec §6.
//! Every message carries `protocol` so UI and engine can negotiate.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::Mutex;

pub const PROTOCOL_VERSION: u32 = 1;

/// Request from client to server (either side can be "client").
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub jsonrpc: String,
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
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
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
    pub id: u64,
    pub protocol: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self { jsonrpc: "2.0".into(), id, protocol: PROTOCOL_VERSION, result: Some(result), error: None }
    }

    pub fn err(id: u64, error: RpcError) -> Self {
        Self { jsonrpc: "2.0".into(), id, protocol: PROTOCOL_VERSION, result: None, error: Some(error) }
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
        Self { protocol: PROTOCOL_VERSION, event: event.into(), payload }
    }
}

/// One message per line — any JSON value.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Response(Response),
    Event(Event),
}

/// Framed connection: reads one JSON per line from `R`, writes one JSON per
/// line to `W`. Shared writer so events can be pushed while a request is
/// being handled.
pub struct Connection<R: Read, W: Write> {
    reader: BufReader<R>,
    writer: Mutex<W>,
}

impl<R: Read, W: Write> Connection<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader: BufReader::new(reader), writer: Mutex::new(writer) }
    }

    pub fn write_line(&self, value: &impl Serialize) -> std::io::Result<()> {
        let mut w = self.writer.lock().expect("writer lock");
        serde_json::to_writer(&mut *w, value)?;
        w.write_all(b"\n")?;
        w.flush()
    }

    /// Reads the next line and parses it. `None` on clean EOF.
    pub fn read_message(&mut self) -> Option<Result<Message, RpcError>> {
        let mut line = String::new();
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => {
                    return if line.is_empty() { None } else { Some(Err(RpcError::new(RpcError::PARSE_ERROR, "unterminated line"))) }
                }
                Ok(_) => break,
                Err(e) => return Some(Err(RpcError::new(RpcError::INTERNAL, e.to_string()))),
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            self.read_message()
        } else {
            Some(serde_json::from_str::<Message>(trimmed).map_err(|e| RpcError::new(RpcError::PARSE_ERROR, e.to_string())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

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
    fn connection_roundtrips_request_and_event() {
        // Write a request and an event through a connection onto a buffer.
        let mut wire: Vec<u8> = Vec::new();
        {
            let conn = Connection::new(std::io::empty(), &mut wire);
            conn.write_line(&Request::new(7, "ping", Value::Null)).unwrap();
            conn.write_line(&Event::new("chat.delta", serde_json::json!({"t": "a"}))).unwrap();
        }
        // Read them back.
        let mut conn = Connection::new(Cursor::new(wire), std::io::sink());
        match conn.read_message().unwrap().unwrap() {
            Message::Request(r) => assert_eq!(r.method, "ping"),
            other => panic!("expected request, got {other:?}"),
        }
        match conn.read_message().unwrap().unwrap() {
            Message::Event(e) => assert_eq!(e.event, "chat.delta"),
            other => panic!("expected event, got {other:?}"),
        }
        assert!(conn.read_message().is_none(), "EOF after last line");
    }

    #[test]
    fn response_ok_and_err_shapes() {
        let ok = Response::ok(3, serde_json::json!({"a": 1}));
        assert!(ok.error.is_none() && ok.result.is_some());
        let err = Response::err(3, RpcError::new(RpcError::METHOD_NOT_FOUND, "nope"));
        assert!(err.result.is_none() && err.error.is_some());
    }
}
