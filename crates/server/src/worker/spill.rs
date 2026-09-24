//! Spill of oversized tool results into tool artifacts (tool artifacts
//! design). One choke point: when a server-side tool outcome becomes a
//! `ThreadEvent::ToolResult`, the worker either spills a huge result or a
//! tool-carried artifact payload into a `tool_artifacts` row + object
//! storage bytes, and replaces the model-facing content with a short
//! pointer text naming the materialized path `.guild/artifacts/<chat>/
//! <filename>`.

use crate::state::AppState;
use guild_core::tools::ToolArtifact;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Serialized model-facing content above this size spills into an artifact
/// (one shared threshold for every server-side tool).
pub const SPILL_THRESHOLD_BYTES: usize = 64 * 1024;

/// Head excerpt kept inline for spilled text results.
pub const EXCERPT_BYTES: usize = 2048;

/// Model-facing workspace path prefix for materialized artifacts.
pub const ARTIFACT_DIR: &str = ".guild/artifacts";

/// A spill decision as journaled by the tool-execution run: everything the
/// ToolResult event needs besides the pointer text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpilledArtifact {
    pub artifact_id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    /// Relative model-facing path: `.guild/artifacts/{chat_id}/{filename}`.
    pub path: String,
}

/// The spill trigger for plain text results: serialized content above the
/// threshold spills; tool-carried artifact payloads spill regardless.
pub fn should_spill(content: &str) -> bool {
    content.len() > SPILL_THRESHOLD_BYTES
}

/// Text mimes get a head excerpt; everything else gets path + size + mime.
pub fn is_text_mime(content_type: &str) -> bool {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ct.starts_with("text/")
        || matches!(
            ct.as_str(),
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/yaml"
                | "application/x-yaml"
                | "application/x-ndjson"
                | "application/sql"
                | "application/xhtml+xml"
                | "application/rss+xml"
                | "application/atom+xml"
                | "application/toml"
                | "application/csv"
                | "application/x-www-form-urlencoded"
        )
        || ct.ends_with("+json")
        || ct.ends_with("+xml")
}

/// KiB rounding for the "(first 2 KiB of N KiB)" marker — a 1-byte spill
/// reads "of 1 KiB", never "of 0 KiB".
pub fn size_kib(size_bytes: i64) -> i64 {
    ((size_bytes + 1023) / 1024).max(1)
}

/// Model-facing pointer text for a spilled result.
///
/// Text mime: one line naming tool/filename/size, then the explicit marker
/// and the first 2 KiB excerpt. Binary mime: one line with path, size and
/// mime only. This exact shape is contract for the model-facing history.
pub fn pointer_text(
    tool_name: &str,
    spilled: &SpilledArtifact,
    content_type: &str,
    full_text: Option<&str>,
) -> String {
    let head = format!(
        "Tool \"{tool_name}\" returned a large result saved as {} ({} — {} bytes, {}).",
        spilled.filename,
        format_size(spilled.size_bytes),
        spilled.size_bytes,
        content_type
    );
    match full_text {
        Some(text) if is_text_mime(content_type) => {
            let excerpt: String = text.chars().take(EXCERPT_BYTES).collect();
            format!(
                "{head}\n\
                 First 2 KiB of {} KiB; full result at {}:\n\
                 {}",
                size_kib(spilled.size_bytes),
                spilled.path,
                excerpt
            )
        }
        _ => format!("{head} Full result at {}.", spilled.path),
    }
}

fn format_size(size_bytes: i64) -> String {
    if size_bytes >= 1024 * 1024 {
        format!("{:.1} MiB", size_bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} KiB", size_bytes as f64 / 1024.0)
    }
}

/// The `meta` payload a spilled ToolResult carries so clients can render the
/// download card: existing tool meta keys are preserved, `card` is claimed
/// by the artifact card, and the artifact keys below are exact contract for
/// the client/UI lanes.
pub fn artifact_meta(
    existing: Option<serde_json::Value>,
    spilled: &SpilledArtifact,
) -> serde_json::Value {
    let mut obj = match existing {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    obj.insert("card".into(), serde_json::json!("artifact"));
    obj.insert("id".into(), serde_json::json!(spilled.artifact_id));
    obj.insert("filename".into(), serde_json::json!(spilled.filename));
    obj.insert(
        "content_type".into(),
        serde_json::json!(spilled.content_type),
    );
    obj.insert("size_bytes".into(), serde_json::json!(spilled.size_bytes));
    obj.insert("path".into(), serde_json::json!(spilled.path));
    serde_json::Value::Object(obj)
}

/// Creates (or reuses) the artifact row and object bytes for one tool
/// result, resolving the filename collision rule: when the same filename
/// already exists in the chat under a different artifact, the materialized
/// filename is prefixed with a short id segment.
///
/// Idempotence (replay safety): the id is uuid v5 over chat_id + call_id, so
/// a Restate replay of the tool execution resolves to the same artifact; the
/// store insert is `ON CONFLICT DO NOTHING` and an existing row is reused,
/// so even a re-executed run (crash before the journal entry committed)
/// re-uploads the same bytes under the same key and never duplicates the
/// row. The spill itself rides the journaled tool-execution run, whose
/// recorded result restores the spill decision on replay without executing.
// Storage, caller and tool provenance remain explicit at the spill boundary.
#[allow(clippy::too_many_arguments)]
pub async fn spill_artifact(
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    call_id: &str,
    tool_name: &str,
    filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> anyhow::Result<SpilledArtifact> {
    let artifact_id = crate::store::tool_artifacts::artifact_uuid(chat_id, call_id);
    let store = state.store().await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    // Replay fast path: the artifact of this call already exists.
    if let Ok(existing) = store.tool_artifacts().get(org_id, artifact_id).await {
        return Ok(spilled_from_row(&existing));
    }
    let filename = crate::store::attachments::safe_filename(filename)
        .unwrap_or_else(|| "artifact.bin".to_string());
    // Collision rule: same filename under a different artifact in this chat
    // gets an id-prefix (deterministic — the segment derives from the fixed
    // artifact id, so a replay re-derives the same materialized name).
    let filename = if store
        .tool_artifacts()
        .list_for_chat(org_id, chat_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?
        .iter()
        .any(|row| row.filename == filename)
    {
        let seg = artifact_id.simple().to_string()[..8].to_string();
        format!("{seg}_{filename}")
    } else {
        filename
    };
    let key = crate::store::tool_artifacts::object_key(org_id, artifact_id, &filename);
    state
        .objects()
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?
        .put(&key, bytes.to_vec())
        .await
        .map_err(|e| anyhow::anyhow!("object store write failed: {e:?}"))?;
    let row = store
        .tool_artifacts()
        .create(
            artifact_id,
            org_id,
            chat_id,
            &filename,
            content_type,
            bytes.len() as i64,
            &key,
            tool_name,
            call_id,
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(spilled_from_row(&row))
}

/// Spills a tool-carried artifact payload (always, any size) and returns the
/// spill descriptor plus the pointer text.
pub async fn spill_tool_artifact(
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    call_id: &str,
    tool_name: &str,
    artifact: &ToolArtifact,
) -> anyhow::Result<(SpilledArtifact, String)> {
    let spilled = spill_artifact(
        state,
        org_id,
        chat_id,
        call_id,
        tool_name,
        &artifact.filename,
        &artifact.content_type,
        &artifact.bytes,
    )
    .await?;
    let text = pointer_text(tool_name, &spilled, &artifact.content_type, None);
    Ok((spilled, text))
}

fn spilled_from_row(row: &crate::store::tool_artifacts::ToolArtifactRow) -> SpilledArtifact {
    SpilledArtifact {
        artifact_id: row.id,
        filename: row.filename.clone(),
        content_type: row.content_type.clone(),
        size_bytes: row.size_bytes,
        path: format!("{ARTIFACT_DIR}/{}/{}", row.chat_id, row.filename),
    }
}

/// The spill decision for one server tool outcome: `Some` when the outcome
/// carries an artifact payload (spilled regardless of size) or the content
/// exceeds the threshold; `None` keeps the inline result. The threshold path
/// spills the content text itself as a plain-text artifact named after the
/// tool.
pub fn spill_decision(outcome_content: &str, artifact: Option<&ToolArtifact>) -> SpillDecision {
    match artifact {
        Some(a) => SpillDecision::Artifact(a.clone()),
        None if should_spill(outcome_content) => SpillDecision::Oversize,
        None => SpillDecision::Inline,
    }
}

pub enum SpillDecision {
    /// Tool handed the model a real file — spill its bytes.
    Artifact(ToolArtifact),
    /// Plain content above the threshold — spill the text.
    Oversize,
    /// Normal inline result.
    Inline,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spilled() -> SpilledArtifact {
        SpilledArtifact {
            artifact_id: Uuid::nil(),
            filename: "report.xlsx".into(),
            content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                .into(),
            size_bytes: 48 * 1024,
            path: format!("{ARTIFACT_DIR}/11111111-2222-3333-4444-555555555555/report.xlsx"),
        }
    }

    #[test]
    fn threshold_spills_only_above_64k() {
        assert!(!should_spill(&"x".repeat(SPILL_THRESHOLD_BYTES)));
        assert!(should_spill(&"x".repeat(SPILL_THRESHOLD_BYTES + 1)));
    }

    #[test]
    fn text_and_binary_pointer_shapes() {
        let s = spilled();
        // Binary mime: path + size + mime on one line, no excerpt.
        let bin = pointer_text("api", &s, &s.content_type, None);
        assert!(bin.contains("report.xlsx"));
        assert!(bin.contains(&s.path));
        assert!(bin.contains("application/vnd"));
        assert!(!bin.contains("First 2 KiB"));

        // Text mime: explicit first-2KiB marker and excerpt.
        let big = "a".repeat(EXCERPT_BYTES + 50);
        let txt = pointer_text("api", &s, "text/plain", Some(&big));
        assert!(txt.contains("First 2 KiB of 48 KiB; full result at"));
        assert!(txt.contains(&s.path));
        assert!(txt.contains(&"a".repeat(EXCERPT_BYTES)));
        // Excerpt is cut at 2 KiB — the tail never leaks.
        assert!(txt.len() < EXCERPT_BYTES + 400);
    }

    #[test]
    fn artifact_meta_carries_exact_keys() {
        let meta = artifact_meta(None, &spilled());
        let obj = meta.as_object().unwrap();
        assert_eq!(obj["card"], "artifact");
        for key in ["id", "filename", "content_type", "size_bytes", "path"] {
            assert!(obj.contains_key(key), "missing meta key {key}");
        }
        assert_eq!(obj["path"], spilled().path);
        assert_eq!(obj["size_bytes"], 48 * 1024);
    }

    #[test]
    fn artifact_meta_preserves_tool_meta_and_claims_card() {
        let existing = serde_json::json!({ "card": "api", "status": 200 });
        let meta = artifact_meta(Some(existing), &spilled());
        let obj = meta.as_object().unwrap();
        assert_eq!(obj["card"], "artifact");
        assert_eq!(obj["status"], 200);
    }

    /// Contract test: the engine's index-rebuild parser reads the meta this
    /// server writes (flat card keys on meta).
    #[test]
    fn the_engines_artifact_parser_reads_the_servers_card() {
        let meta = artifact_meta(None, &spilled());
        assert_eq!(
            guild_core::tools::artifacts::artifact_card_filename(&meta).as_deref(),
            Some("report.xlsx")
        );
        let meta = artifact_meta(Some(serde_json::json!({ "status": 200 })), &spilled());
        assert_eq!(
            guild_core::tools::artifacts::artifact_card_filename(&meta).as_deref(),
            Some("report.xlsx")
        );
        // A foreign card is not an artifact card.
        assert_eq!(
            guild_core::tools::artifacts::artifact_card_filename(
                &serde_json::json!({ "card": "web", "kind": "fetch" })
            ),
            None
        );
    }

    #[test]
    fn mime_classification() {
        assert!(is_text_mime("text/plain"));
        assert!(is_text_mime("application/json"));
        assert!(is_text_mime("application/vnd.api+json"));
        assert!(is_text_mime("text/html; charset=utf-8"));
        assert!(!is_text_mime("application/pdf"));
        assert!(!is_text_mime(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ));
        assert!(!is_text_mime("image/png"));
        assert!(!is_text_mime("application/zip"));
    }

    #[test]
    fn spill_decision_matches_outcome_shape() {
        assert!(matches!(
            spill_decision("small", None),
            SpillDecision::Inline
        ));
        assert!(matches!(
            spill_decision(&"x".repeat(SPILL_THRESHOLD_BYTES + 1), None),
            SpillDecision::Oversize
        ));
        let a = ToolArtifact {
            filename: "f.bin".into(),
            content_type: "application/octet-stream".into(),
            bytes: vec![1],
        };
        assert!(matches!(
            spill_decision("", Some(&a)),
            SpillDecision::Artifact(_)
        ));
    }
}

/// Best-effort delivery after the artifact's thread event commits. Old
/// executors decline capability discovery; first-touch fetch remains available.
pub fn spawn_machine_prefetch(
    state: &crate::state::AppState,
    org_id: Uuid,
    chat_id: Uuid,
    machine: &str,
    folder: &str,
    artifact: &SpilledArtifact,
) {
    let state = state.clone();
    let machine = machine.to_owned();
    let payload = serde_json::json!({"workdir": folder, "chat_id": chat_id,
        "artifact_id": artifact.artifact_id, "filename": artifact.filename});
    tokio::spawn(async move {
        let timeout = std::time::Duration::from_secs(10);
        let Ok(caps) = state
            .hub
            .machine_request(
                &machine,
                org_id,
                "capabilities",
                serde_json::json!({}),
                timeout,
            )
            .await
        else {
            return;
        };
        if !caps["operations"]
            .as_array()
            .is_some_and(|ops| ops.iter().any(|v| v == "artifact.prefetch_v1"))
        {
            return;
        }
        if let Err(error) = state
            .hub
            .machine_request(&machine, org_id, "artifact.prefetch_v1", payload, timeout)
            .await
        {
            tracing::debug!(?error, "artifact prefetch deferred to first touch");
        }
    });
}
