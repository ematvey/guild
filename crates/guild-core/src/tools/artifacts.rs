//! Artifact materialization (tool-artifacts spec): server-side tools spill
//! oversized results into `tool_artifacts`; the model reads them as real
//! files at `<workdir>/.guild/artifacts/<chat_id>/<filename>`. This module
//! owns the model-facing path contract, the path→artifact-id index built
//! from `tool_result` thread events, and the fetch-and-write materialization
//! step used by both touch-time and prefetch paths.

use super::ToolFailure;
use async_trait::async_trait;
use protocol::api::ThreadEvent;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Workspace-relative root of the model-facing artifact tree.
pub const ARTIFACTS_REL: &str = ".guild/artifacts";

/// An artifact referenced by a model-facing path: the chat that owns it and
/// its filename inside `.guild/artifacts/<chat_id>/`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ArtifactPath {
    pub chat_id: Uuid,
    pub filename: String,
}

impl ArtifactPath {
    /// The workspace-relative pointer text the model sees
    /// (`.guild/artifacts/<chat_id>/<filename>`).
    pub fn rel_path(&self) -> String {
        format!("{ARTIFACTS_REL}/{}/{}", self.chat_id, self.filename)
    }
}

/// The absolute model-facing path for an artifact inside `workdir`.
pub fn model_path(workdir: &Path, artifact: &ArtifactPath) -> PathBuf {
    workdir.join(artifact.rel_path())
}

/// Lexically normalizes a path (no filesystem access): collapses `.` and
/// `..` components so a not-yet-existing artifact path parses the same as a
/// materialized one.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Parses a candidate path string into an artifact reference. Accepts
/// workdir-relative and workdir-absolute spellings; rejects anything outside
/// `.guild/artifacts/<chat_id>/` (including `..` escapes and non-UUID chat
/// segments). Purely lexical: works before the file exists.
pub fn parse_artifact_path(workdir: &Path, candidate: &str) -> Option<ArtifactPath> {
    if candidate.is_empty() {
        return None;
    }
    let raw = Path::new(candidate);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workdir.join(raw)
    };
    let norm = normalize(&joined);
    let root = normalize(&workdir.join(ARTIFACTS_REL));
    let rel = norm.strip_prefix(&root).ok()?;
    let mut comps = rel.components();
    let chat = comps.next()?.as_os_str().to_str()?;
    let chat_id = Uuid::parse_str(chat).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for c in comps {
        parts.push(c.as_os_str().to_str()?.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(ArtifactPath {
        chat_id,
        filename: parts.join("/"),
    })
}

/// Characters that terminate an artifact pointer token inside free text.
fn is_token_break(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '<' | '>' | ',')
}

/// Scans free text (tool-result pointer text, shell command lines) for
/// artifact paths written after the `.guild/artifacts/` marker — relative
/// pointers per the spec, plus workdir-absolute spellings.
pub fn scan_text(workdir: &Path, text: &str) -> Vec<ArtifactPath> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(ARTIFACTS_REL) {
        let after = &rest[i + ARTIFACTS_REL.len()..];
        let token: String = after
            .chars()
            .take_while(|c| !is_token_break(*c))
            .collect();
        // sentence punctuation clings to the token; real filenames never
        // end in it
        let token = token.trim_end_matches(['.', ',', ';', ':', '!', '?']);
        // Absolute spelling: the token itself is already a path under workdir.
        if let Some(a) = parse_artifact_path(workdir, &token) {
            out.push(a);
        }
        // Relative pointer: rebuild `.guild/artifacts/<tail>` from the token.
        let tail = token.trim_start_matches('/');
        if let Some(a) = parse_artifact_path(workdir, &format!("{ARTIFACTS_REL}/{tail}")) {
            out.push(a);
        }
        rest = after;
    }
    out
}

/// Scans tool-call arguments recursively for artifact paths — direct path
/// arguments (`read_file`'s `path`) and pointers embedded in free text
/// (`execute`'s `command`). Deduplicated.
pub fn scan_args(workdir: &Path, args: &Value) -> Vec<ArtifactPath> {
    let mut found = Vec::new();
    scan_value(workdir, args, &mut found);
    found.sort();
    found.dedup();
    found
}

fn scan_value(workdir: &Path, v: &Value, out: &mut Vec<ArtifactPath>) {
    match v {
        Value::String(s) => {
            if let Some(a) = parse_artifact_path(workdir, s) {
                out.push(a);
            }
            out.extend(scan_text(workdir, s));
        }
        Value::Array(items) => {
            for item in items {
                scan_value(workdir, item, out);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                scan_value(workdir, item, out);
            }
        }
        _ => {}
    }
}

/// chat_id + filename → artifact id, built from `tool_result` thread events
/// whose `meta.card` is an artifact card. Shared by every run of a chat so
/// touch-time lookups hit what prefetch already learned.
#[derive(Default)]
pub struct ArtifactIndex {
    entries: Mutex<HashMap<(Uuid, String), Uuid>>,
}

impl ArtifactIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, chat_id: Uuid, filename: &str, artifact_id: Uuid) {
        self.entries
            .lock()
            .unwrap()
            .insert((chat_id, filename.to_string()), artifact_id);
    }

    pub fn lookup(&self, chat_id: Uuid, filename: &str) -> Option<Uuid> {
        self.entries
            .lock()
            .unwrap()
            .get(&(chat_id, filename.to_string()))
            .copied()
    }

    /// Records the artifact card carried by one thread event (if any).
    /// Returns the referenced artifact when the event carried one.
    pub fn record_thread_event(&self, chat_id: Uuid, event: &ThreadEvent) -> Option<ArtifactPath> {
        if let ThreadEvent::ToolResult {
            artifact_id: Some(id),
            meta: Some(meta),
            ..
        } = event
        {
            if let Some(filename) = artifact_card_filename(meta) {
                self.record(chat_id, &filename, *id);
                return Some(ArtifactPath {
                    chat_id,
                    filename,
                });
            }
        }
        None
    }
}

/// Extracts the filename from `meta.card = { card: "artifact", filename, … }`
/// (the card is UI render intent; the filename is the materialization key).
fn artifact_card_filename(meta: &Value) -> Option<String> {
    let card = meta.get("card")?;
    if card.get("card")?.as_str()? != "artifact" {
        return None;
    }
    card.get("filename")?.as_str().map(String::from)
}

/// Artifact byte + thread-event source. Implemented over the cloud API
/// client (app-server); faked in tests.
#[async_trait]
pub trait ArtifactFetcher: Send + Sync {
    /// Downloads the bytes of one spilled tool-result artifact
    /// (GET /api/v1/tool_artifacts/{id}).
    async fn fetch(&self, artifact_id: Uuid) -> Result<Vec<u8>, String>;
    /// The chat's thread event log — the source the index rebuilds from
    /// when a touched path has no known artifact id.
    async fn thread_events(&self, chat_id: Uuid) -> Result<Vec<ThreadEvent>, String>;
}

/// Writes fetched artifact bytes to the model-facing path, creating the
/// `.guild/artifacts/<chat_id>/` tree as needed.
pub async fn write_bytes(
    workdir: &Path,
    artifact: &ArtifactPath,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    let path = model_path(workdir, artifact);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, bytes).await?;
    Ok(path)
}

/// Materializes one artifact: no-op when the file already exists on disk
/// (materialized copies live indefinitely), otherwise resolves the id
/// through the index — rebuilding it from the chat's thread log when the
/// path is unknown — then fetches and writes the bytes.
pub async fn materialize(
    workdir: &Path,
    artifact: &ArtifactPath,
    index: &ArtifactIndex,
    fetcher: &dyn ArtifactFetcher,
) -> Result<PathBuf, String> {
    let path = model_path(workdir, artifact);
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Ok(path);
    }
    let id = match index.lookup(artifact.chat_id, &artifact.filename) {
        Some(id) => id,
        None => {
            let events = fetcher
                .thread_events(artifact.chat_id)
                .await
                .map_err(|e| format!("thread sync failed: {e}"))?;
            for ev in &events {
                index.record_thread_event(artifact.chat_id, ev);
            }
            index
                .lookup(artifact.chat_id, &artifact.filename)
                .ok_or_else(|| {
                    format!(
                        "no artifact record for {}",
                        artifact.rel_path()
                    )
                })?
        }
    };
    let bytes = fetcher
        .fetch(id)
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    write_bytes(workdir, artifact, &bytes)
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    Ok(path)
}

/// Materializes every artifact referenced by a tool call's arguments before
/// the tool runs (lazy pull on first touch).
pub async fn prepare_args(
    index: &ArtifactIndex,
    fetcher: &dyn ArtifactFetcher,
    workdir: &Path,
    args: &Value,
) -> Result<(), String> {
    for artifact in scan_args(workdir, args) {
        if let Err(e) = materialize(workdir, &artifact, index, fetcher).await {
            return Err(format!("{} ({e})", artifact.rel_path()));
        }
    }
    Ok(())
}

/// Registry-held materialization hooks: the shared index plus the fetch
/// source. Absent → the registry runs tools without artifact handling.
pub struct ArtifactHooks {
    pub index: Arc<ArtifactIndex>,
    pub fetcher: Arc<dyn ArtifactFetcher>,
}

/// Materializes referenced artifacts before `tool` runs. `read_file` fails
/// with an explicit error text when a referenced artifact cannot be pulled
/// (offline, unknown id) — never a bare ENOENT. Other tools materialize
/// best-effort: their references may be incidental (command text, render
/// hints), and a failed pull surfaces through the tool's own execution.
pub(crate) async fn prepare(
    hooks: &ArtifactHooks,
    tool_name: &str,
    workdir: &Path,
    args: &Value,
) -> Result<(), ToolFailure> {
    if scan_args(workdir, args).is_empty() {
        return Ok(());
    }
    if let Err(reason) = prepare_args(&hooks.index, hooks.fetcher.as_ref(), workdir, args).await {
        if tool_name == "read_file" {
            return Err(ToolFailure::Execution(format!(
                "artifact not materialized; will be fetched when the machine is online: {reason}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CHAT: Uuid = uuid::uuid!("00000000-0000-0000-0000-000000000001");
    const OTHER_CHAT: Uuid = uuid::uuid!("00000000-0000-0000-0000-000000000002");
    const ART: Uuid = uuid::uuid!("00000000-0000-0000-0000-00000000aaaa");

    fn workdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("guild-arts-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tool_result_event(artifact_id: Option<Uuid>, meta: Option<Value>) -> ThreadEvent {
        ThreadEvent::ToolResult {
            turn: 1,
            step: 1,
            call_id: "c1".into(),
            name: "api".into(),
            content: "pointer".into(),
            is_error: false,
            meta,
            images: Vec::new(),
            kind: None,
            artifact_id,
        }
    }

    fn artifact_card(filename: &str) -> Value {
        json!({ "card": {
            "card": "artifact",
            "id": ART,
            "filename": filename,
            "content_type": "application/vnd.ms-excel",
            "size_bytes": 1234,
            "path": format!(".guild/artifacts/{CHAT}/{filename}"),
        }})
    }

    // --- path contract -----------------------------------------------------

    #[test]
    fn parse_accepts_relative_and_absolute() {
        let dir = workdir("parse");
        let rel = format!(".guild/artifacts/{CHAT}/report.xlsx");
        let a = parse_artifact_path(&dir, &rel).unwrap();
        assert_eq!(a.chat_id, CHAT);
        assert_eq!(a.filename, "report.xlsx");
        let abs = dir.join(&rel);
        let b = parse_artifact_path(&dir, &abs.to_str().unwrap()).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.rel_path(), rel);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_rejects_non_artifact_paths() {
        let dir = workdir("reject");
        for bad in [
            "src/main.rs",
            ".guild/mcp.json",
            ".guild/artifacts/not-a-uuid/f.xlsx",
            ".guild/artifacts/f.xlsx",
            "../outside/f.xlsx",
            ".guild/artifacts/../secrets.txt",
            "",
        ] {
            assert!(parse_artifact_path(&dir, bad).is_none(), "accepted: {bad}");
        }
        // escape through the artifacts dir itself
        assert!(parse_artifact_path(
            &dir,
            &format!(".guild/artifacts/{CHAT}/../../x")
        )
        .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_works_before_materialization() {
        let dir = workdir("premat");
        // the chat dir does not exist yet — lexical parse still matches
        let a = parse_artifact_path(&dir, &format!(".guild/artifacts/{OTHER_CHAT}/new.bin"));
        assert!(a.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_finds_args_and_text_pointers() {
        let dir = workdir("scan");
        let args = json!({
            "path": format!(".guild/artifacts/{CHAT}/a.bin"),
            "command": format!("cat .guild/artifacts/{CHAT}/b.bin | head"),
            "nested": { "text": format!("full result at .guild/artifacts/{CHAT}/c.xlsx (2 KiB)") },
            "n": 5,
        });
        let found = scan_args(&dir, &args);
        let files: Vec<&str> = found.iter().map(|a| a.filename.as_str()).collect();
        assert_eq!(files, vec!["a.bin", "b.bin", "c.xlsx"]);
        // every hit belongs to the same chat
        assert!(found.iter().all(|a| a.chat_id == CHAT));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_text_stops_at_token_breaks() {
        let dir = workdir("scantext");
        let text = format!(
            "see .guild/artifacts/{CHAT}/rep.xlsx.\nand (.guild/artifacts/{CHAT}/two.bin)"
        );
        let found = scan_text(&dir, &text);
        let files: Vec<&str> = found.iter().map(|a| a.filename.as_str()).collect();
        // the trailing `.` and `)` must not leak into filenames
        assert_eq!(files, vec!["rep.xlsx", "two.bin"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- path→id mapping -----------------------------------------------------

    #[test]
    fn index_records_from_thread_events() {
        let index = ArtifactIndex::new();
        let ev = tool_result_event(Some(ART), Some(artifact_card("sheet.xlsx")));
        assert!(index.record_thread_event(CHAT, &ev).is_some());
        assert_eq!(index.lookup(CHAT, "sheet.xlsx"), Some(ART));
        // a different chat's same-named artifact maps independently
        assert_eq!(index.lookup(OTHER_CHAT, "sheet.xlsx"), None);
        // non-artifact events record nothing
        let plain = tool_result_event(None, None);
        assert!(index.record_thread_event(CHAT, &plain).is_none());
        let wrong_card = tool_result_event(Some(ART), Some(json!({ "card": { "card": "read" } })));
        assert!(index.record_thread_event(CHAT, &wrong_card).is_none());
        // artifact id without a card: no path mapping exists
        let id_only = tool_result_event(Some(ART), None);
        assert!(index.record_thread_event(CHAT, &id_only).is_none());
    }

    // --- materialization -----------------------------------------------------

    struct FakeFetcher {
        bytes: HashMap<Uuid, Vec<u8>>,
        events: HashMap<Uuid, Vec<ThreadEvent>>,
        fetches: AtomicUsize,
        syncs: AtomicUsize,
    }

    impl FakeFetcher {
        fn new() -> Self {
            Self {
                bytes: HashMap::new(),
                events: HashMap::new(),
                fetches: AtomicUsize::new(0),
                syncs: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ArtifactFetcher for FakeFetcher {
        async fn fetch(&self, artifact_id: Uuid) -> Result<Vec<u8>, String> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            self.bytes
                .get(&artifact_id)
                .cloned()
                .ok_or_else(|| "404".into())
        }
        async fn thread_events(&self, chat_id: Uuid) -> Result<Vec<ThreadEvent>, String> {
            self.syncs.fetch_add(1, Ordering::SeqCst);
            Ok(self.events.get(&chat_id).cloned().unwrap_or_default())
        }
    }

    #[tokio::test]
    async fn materializes_on_touch_and_skips_existing() {
        let dir = workdir("mat");
        let index = ArtifactIndex::new();
        index.record(CHAT, "out.bin", ART);
        let mut f = FakeFetcher::new();
        f.bytes.insert(ART, b"artifact-bytes".to_vec());
        let path = materialize(&dir, &ArtifactPath { chat_id: CHAT, filename: "out.bin".into() }, &index, &f)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"artifact-bytes");
        // second touch: already on disk, no refetch
        materialize(&dir, &ArtifactPath { chat_id: CHAT, filename: "out.bin".into() }, &index, &f)
            .await
            .unwrap();
        assert_eq!(f.fetches.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn unknown_path_rebuilds_index_from_thread_log() {
        let dir = workdir("rebuild");
        let index = ArtifactIndex::new();
        let mut f = FakeFetcher::new();
        f.bytes.insert(ART, b"xlsx-bytes".to_vec());
        f.events.insert(
            CHAT,
            vec![tool_result_event(Some(ART), Some(artifact_card("report.xlsx")))],
        );
        let path = materialize(
            &dir,
            &ArtifactPath { chat_id: CHAT, filename: "report.xlsx".into() },
            &index,
            &f,
        )
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"xlsx-bytes");
        assert_eq!(f.syncs.load(Ordering::SeqCst), 1);
        // the rebuilt mapping is now in the index for future touches
        assert_eq!(index.lookup(CHAT, "report.xlsx"), Some(ART));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn offline_touch_fails_with_explicit_reason() {
        let dir = workdir("offline");
        let index = ArtifactIndex::new();
        index.record(CHAT, "gone.bin", ART);
        let f = FakeFetcher::new(); // no bytes configured: fetch fails
        let err = materialize(
            &dir,
            &ArtifactPath { chat_id: CHAT, filename: "gone.bin".into() },
            &index,
            &f,
        )
        .await
        .unwrap_err();
        assert!(err.contains("fetch failed"), "got: {err}");
        // nothing written
        assert!(!dir.join(format!(".guild/artifacts/{CHAT}/gone.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn unknown_everywhere_names_the_missing_record() {
        let dir = workdir("unknown");
        let index = ArtifactIndex::new();
        let f = FakeFetcher::new(); // empty thread log, no bytes
        let err = materialize(
            &dir,
            &ArtifactPath { chat_id: CHAT, filename: "ghost.bin".into() },
            &index,
            &f,
        )
        .await
        .unwrap_err();
        assert!(err.contains("no artifact record"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- registry integration -----------------------------------------------

    use super::super::ToolRegistry;

    fn registry_with(hooks: Option<Arc<ArtifactHooks>>) -> ToolRegistry {
        let mut r = ToolRegistry::new();
        r.add(Arc::new(super::super::fs::ReadFile::default()));
        if let Some(h) = hooks {
            r = r.with_artifacts(h);
        }
        r
    }

    #[tokio::test]
    async fn read_file_pulls_artifact_before_running() {
        let dir = workdir("regmat");
        let index = Arc::new(ArtifactIndex::new());
        index.record(CHAT, "ok.bin", ART);
        let mut f = FakeFetcher::new();
        f.bytes.insert(ART, b"model-reads-this".to_vec());
        let registry = registry_with(Some(Arc::new(ArtifactHooks {
            index,
            fetcher: Arc::new(f),
        })));
        let out = registry
            .run(
                "read_file",
                &dir,
                json!({ "path": format!(".guild/artifacts/{CHAT}/ok.bin") }),
            )
            .await
            .unwrap();
        assert!(out.output_for_model.contains("model-reads-this"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn read_file_fails_explicitly_when_fetch_fails() {
        let dir = workdir("regfail");
        let index = Arc::new(ArtifactIndex::new());
        index.record(CHAT, "gone.bin", ART);
        let registry = registry_with(Some(Arc::new(ArtifactHooks {
            index,
            fetcher: Arc::new(FakeFetcher::new()),
        })));
        let err = registry
            .run(
                "read_file",
                &dir,
                json!({ "path": format!(".guild/artifacts/{CHAT}/gone.bin") }),
            )
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("artifact not materialized; will be fetched when the machine is online"),
            "got: {msg}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn plain_registry_is_unaffected() {
        let dir = workdir("plain");
        std::fs::write(dir.join("f.txt"), "plain").unwrap();
        let registry = registry_with(None);
        let out = registry
            .run("read_file", &dir, json!({ "path": "f.txt" }))
            .await
            .unwrap();
        assert_eq!(out.output_for_model, "plain");
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- scope verification (task 1) -----------------------------------------

    #[test]
    fn artifacts_subtree_is_inside_read_scope() {
        let dir = workdir("scope");
        std::fs::create_dir_all(dir.join(format!(".guild/artifacts/{CHAT}"))).unwrap();
        std::fs::write(
            dir.join(format!(".guild/artifacts/{CHAT}/f.bin")),
            "bytes",
        )
        .unwrap();
        // existing artifact file: resolves through the normal scoped path
        assert!(super::super::resolve_scoped(
            &dir,
            &format!(".guild/artifacts/{CHAT}/f.bin")
        )
        .is_ok());
        // not-yet-materialized artifact: resolve_scoped's missing-tail
        // fallback canonicalizes the nearest ancestor and rejoins — the
        // path stays under the workdir, so reads pass the scope check
        assert!(super::super::resolve_scoped(
            &dir,
            &format!(".guild/artifacts/{OTHER_CHAT}/new.bin")
        )
        .is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_args_dedupes_repeat_hits() {
        let dir = workdir("dedupe");
        let args = json!({
            "path": format!(".guild/artifacts/{CHAT}/a.bin"),
            "command": format!("cat .guild/artifacts/{CHAT}/a.bin"),
        });
        let found = scan_args(&dir, &args);
        assert_eq!(found.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
