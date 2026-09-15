//! File tools: read, write, edit — all scoped to the project dir.

use super::{diff_text, resolve_scoped, resolve_scoped_in, truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use base64::Engine as _;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::Path;

/// Read-only file access scoped to the project dir plus explicit extra
/// roots (discovered skill dirs live outside the workspace, e.g.
/// `~/.agents/skills` — the index advertises those paths, so the agent
/// must be able to read them).
pub struct ReadFile {
    pub extra_read_roots: Vec<std::path::PathBuf>,
}

impl Default for ReadFile {
    fn default() -> Self {
        Self {
            extra_read_roots: Vec::new(),
        }
    }
}

/// Image extensions the model-facing providers accept (OpenAI image_url and
/// Anthropic base64 image blocks share this set).
fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Cap on an attached image's raw size — Anthropic rejects base64 images
/// over 5 MB; leave headroom for the request as a whole.
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;

#[async_trait]
impl Tool for ReadFile {
    fn spec(&self) -> ToolSpec {
        protocol::api::client_tool_spec("read_file").expect("built-in read_file spec")
    }

    fn default_policy(&self) -> Approval {
        Approval::Allow
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let path = resolve_scoped_in(
            workdir,
            &self.extra_read_roots,
            args["path"]
                .as_str()
                .ok_or_else(|| ToolFailure::InvalidInput("missing path".into()))?,
        )?;
        let display = path.display().to_string();
        let mut meta = serde_json::json!({ "card": "read", "path": display });

        // Image file: attach as a data URI (provider serialization turns it
        // into the right content block; the turn drops it when the route has
        // no image modality).
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if let Some(mime) = image_mime(&ext) {
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| ToolFailure::Execution(format!("read {display}: {e}")))?;
            let kb = bytes.len() / 1024;
            meta["size_kb"] = serde_json::json!(kb);
            if bytes.len() > MAX_IMAGE_BYTES {
                return Ok(ToolOutcome {
                    images: Vec::new(),
                    output_for_model: format!(
                        "[image file: {display} ({kb} KB) — too large to attach (limit 4 MB)]"
                    ),
                    ui_summary: None,
                    diff: None,
                    meta: Some(meta),
                });
            }
            let uri = format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            );
            return Ok(ToolOutcome {
                images: vec![uri],
                output_for_model: format!(
                    "[image file: {display} ({kb} KB) — the image is attached to this result; describe what you see when asked]"
                ),
                ui_summary: None,
                diff: None,
                meta: Some(meta),
            });
        }

        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                let size = tokio::fs::metadata(&path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                return Ok(ToolOutcome {
                    images: Vec::new(),
                    output_for_model: format!(
                        "[binary file: {display} ({size} bytes) — this tool returns text only]"
                    ),
                    ui_summary: None,
                    diff: None,
                    meta: Some(meta),
                });
            }
            Err(e) => return Err(ToolFailure::Execution(format!("read {display}: {e}"))),
        };
        let total_lines = content.lines().count();
        let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = args["limit"].as_u64().unwrap_or(2000).max(1) as usize;
        let page: Vec<&str> = content.lines().skip(offset - 1).take(limit).collect();
        meta["offset"] = serde_json::json!(offset);
        meta["limit"] = serde_json::json!(limit);
        if !ext.is_empty() {
            meta["lang"] = serde_json::json!(ext);
        }
        meta["total_lines"] = serde_json::json!(total_lines);
        Ok(ToolOutcome {
            images: Vec::new(),
            output_for_model: truncate(page.join("\n")),
            ui_summary: None,
            diff: None,
            meta: Some(meta),
        })
    }
}

pub struct WriteFile;

#[async_trait]
impl Tool for WriteFile {
    fn spec(&self) -> ToolSpec {
        protocol::api::client_tool_spec("write_file").expect("built-in write_file spec")
    }

    fn default_policy(&self) -> Approval {
        Approval::Ask
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let path = resolve_scoped(
            workdir,
            args["path"]
                .as_str()
                .ok_or_else(|| ToolFailure::InvalidInput("missing path".into()))?,
        )?;
        let content = args["content"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing content".into()))?;
        let old = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolFailure::Execution(format!("mkdir: {e}")))?;
        }
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| ToolFailure::Execution(format!("write {}: {e}", path.display())))?;
        let n = content.len();
        Ok(ToolOutcome {
            images: Vec::new(),
            output_for_model: format!("wrote {n} bytes to {}", path.display()),
            ui_summary: Some(format!("write {}", path.display())),
            diff: Some(diff_text(&old, content, &path)),
            meta: Some(serde_json::json!({
                "card": "diff",
                "path": path.display().to_string(),
            })),
        })
    }
}

pub struct EditFile;

#[async_trait]
impl Tool for EditFile {
    fn spec(&self) -> ToolSpec {
        protocol::api::client_tool_spec("edit_file").expect("built-in edit_file spec")
    }

    fn default_policy(&self) -> Approval {
        Approval::Ask
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let path = resolve_scoped(
            workdir,
            args["path"]
                .as_str()
                .ok_or_else(|| ToolFailure::InvalidInput("missing path".into()))?,
        )?;
        let old = args["oldText"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing oldText".into()))?;
        let new = args["newText"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing newText".into()))?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolFailure::Execution(format!("read {}: {e}", path.display())))?;
        let count = content.matches(old).count();
        match count {
            0 => Err(ToolFailure::InvalidInput(format!(
                "old text not found in {}; provide the exact current text",
                path.display()
            ))),
            n if n > 1 => Err(ToolFailure::InvalidInput(format!(
                "old text appears {n} times in {}; include more surrounding context so it is unique",
                path.display()
            ))),
            _ => {
                let updated = content.replacen(old, new, 1);
                tokio::fs::write(&path, &updated)
                    .await
                    .map_err(|e| ToolFailure::Execution(format!("write {}: {e}", path.display())))?;
                Ok(ToolOutcome {
            images: Vec::new(),
                    output_for_model: format!("edited {}", path.display()),
                    ui_summary: Some(format!("edit {}", path.display())),
                    diff: Some(diff_text(&content, &updated, &path)),
                    meta: Some(serde_json::json!({
                        "card": "diff",
                        "path": path.display().to_string(),
                    })),
                })
            }
        }
    }
}
