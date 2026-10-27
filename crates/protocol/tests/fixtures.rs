// Fixture conformance: every frame in the wire fixtures must deserialize into
// the Rust type, and survive a serialize/deserialize round trip. The fixtures
// are the shared truth with the schema and the TS side, so a rename on either
// side fails here.

use std::path::PathBuf;

use protocol::ws::{WsClientMsg, WsServerMsg};
use serde::de::DeserializeOwned;
use serde::Serialize;

fn fixture(name: &str) -> Vec<serde_json::Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures")
        .join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

// Deserialize one fixture array into T, then re-serialize and deserialize
// again. A mismatch between the two values is a round-trip failure.
fn round_trip<T>(file: &str, frames: Vec<serde_json::Value>) -> Vec<T>
where
    T: DeserializeOwned + Serialize + PartialEq + std::fmt::Debug,
{
    let mut out = Vec::with_capacity(frames.len());
    for (index, frame) in frames.into_iter().enumerate() {
        let value: T = serde_json::from_value(frame.clone()).unwrap_or_else(|e| {
            panic!("{file}[{index}]: Rust rejects this frame: {e}\nframe: {frame}")
        });
        let json = serde_json::to_value(&value)
            .unwrap_or_else(|e| panic!("{file}[{index}]: serialize: {e}"));
        let again: T = serde_json::from_value(json.clone()).unwrap_or_else(|e| {
            panic!("{file}[{index}]: round-trip deserialize: {e}\njson: {json}")
        });
        assert_eq!(
            value, again,
            "{file}[{index}]: round trip changed the value\njson: {json}"
        );
        out.push(value);
    }
    out
}

#[test]
fn server_frames_match_the_schema_fixtures() {
    let frames = fixture("socket.ServerFrame.json");
    let parsed: Vec<WsServerMsg> = round_trip("socket.ServerFrame.json", frames);
    assert!(!parsed.is_empty(), "the server fixture must not be empty");
}

#[test]
fn client_frames_match_the_schema_fixtures() {
    let frames = fixture("socket.ClientFrame.json");
    let parsed: Vec<WsClientMsg> = round_trip("socket.ClientFrame.json", frames);
    assert!(!parsed.is_empty(), "the client fixture must not be empty");
}
