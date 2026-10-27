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

// REST fixtures: one file per $defs root, named rest.<Root>.json. The table
// below maps each root to the Rust type that owns it. A root with no mapping
// fails, and so does a fixture that Rust rejects.
fn check_rest_root(root: &str) {
    let file = format!("rest.{root}.json");
    let frames = fixture(&file);
    match root {
        "AuthManifest" => {
            round_trip::<protocol::registry::AuthManifest>(&file, frames);
        }
        "Block" => {
            round_trip::<protocol::api::Block>(&file, frames);
        }
        "BundleManifest" => {
            round_trip::<protocol::registry::BundleManifest>(&file, frames);
        }
        "FieldSpec" => {
            round_trip::<protocol::registry::FieldSpec>(&file, frames);
        }
        "JudgeVerdict" => {
            round_trip::<protocol::api::JudgeVerdict>(&file, frames);
        }
        "McpManifest" => {
            round_trip::<protocol::registry::McpManifest>(&file, frames);
        }
        "Message" => {
            round_trip::<protocol::api::Message>(&file, frames);
        }
        "MessageAttachment" => {
            round_trip::<protocol::api::MessageAttachment>(&file, frames);
        }
        "MessageAudio" => {
            round_trip::<protocol::api::MessageAudio>(&file, frames);
        }
        "SettingsManifest" => {
            round_trip::<protocol::registry::SettingsManifest>(&file, frames);
        }
        "ThreadEvent" => {
            round_trip::<protocol::api::ThreadEvent>(&file, frames);
        }
        "ToolCall" => {
            round_trip::<protocol::api::ToolCall>(&file, frames);
        }
        "ToolKind" => {
            round_trip::<protocol::api::ToolKind>(&file, frames);
        }
        "ToolSpec" => {
            round_trip::<protocol::api::ToolSpec>(&file, frames);
        }
        "ToolsManifest" => {
            round_trip::<protocol::registry::ToolsManifest>(&file, frames);
        }
        "TriggerSpec" => {
            round_trip::<protocol::registry::TriggerSpec>(&file, frames);
        }
        "UsagePayload" => {
            round_trip::<protocol::api::UsagePayload>(&file, frames);
        }
        other => panic!("no Rust type is mapped for rest fixture root {other}"),
    }
}

#[test]
fn rest_fixtures_match_the_schema() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures");
    let mut roots = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let path = entry.expect("read fixture dir entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(root) = name.strip_prefix("rest.").and_then(|n| n.strip_suffix(".json")) {
            roots.push(root.to_string());
        }
    }
    roots.sort();
    assert!(!roots.is_empty(), "the rest fixtures must not be empty");
    for root in roots {
        check_rest_root(&root);
    }
}
