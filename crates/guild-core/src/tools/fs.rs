//! File tools: read, write, edit, glob, grep — all scoped to the project dir.

use super::{diff_text, resolve_scoped, truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use globset::GlobBuilder;
use protocol::api::ToolSpec;
use regex::Regex;
use serde_json::Value;
use std::path::Path;

pub struct ReadFile;

#[async_trait]
impl Tool for ReadFile {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read_file".into(),
            description: "Read a text file relative to the project directory.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            }),
        }
    }

    fn default_policy(&self) -> Approval {
        Approval::Allow
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let path = resolve_scoped(
            workdir,
            args["path"]
                .as_str()
                .ok_or_else(|| ToolFailure::InvalidInput("missing path".into()))?,
        )?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolFailure::Execution(format!("read {}: {e}", path.display())))?;
        Ok(ToolOutcome {
            output_for_model: truncate(content),
            ui_summary: None,
            diff: None,
        })
    }
}

pub struct WriteFile;

#[async_trait]
impl Tool for WriteFile {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write_file".into(),
            description: "Create or overwrite a file with the given content.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            }),
        }
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
            output_for_model: format!("wrote {n} bytes to {}", path.display()),
            ui_summary: Some(format!("write {}", path.display())),
            diff: Some(diff_text(&old, content, &path)),
        })
    }
}

pub struct EditFile;

#[async_trait]
impl Tool for EditFile {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "edit_file".into(),
            description: "Replace the unique occurrence of `old` with `new` in a file. `old` must appear exactly once.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old": {"type": "string"},
                    "new": {"type": "string"},
                },
                "required": ["path", "old", "new"],
            }),
        }
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
        let old = args["old"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing old".into()))?;
        let new = args["new"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing new".into()))?;
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
                    output_for_model: format!("edited {}", path.display()),
                    ui_summary: Some(format!("edit {}", path.display())),
                    diff: Some(diff_text(&content, &updated, &path)),
                })
            }
        }
    }
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "glob".into(),
            description: "List files matching a glob pattern (gitignore-aware), relative to the project directory.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            }),
        }
    }

    fn default_policy(&self) -> Approval {
        Approval::Allow
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let pattern = args["pattern"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing pattern".into()))?;
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|e| ToolFailure::InvalidInput(format!("bad glob: {e}")))?;
        let matcher = glob.compile_matcher();
        let mut matches: Vec<String> = Vec::new();
        let walker = ignore::WalkBuilder::new(workdir).require_git(false).build();
        for entry in walker {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let rel = path.strip_prefix(workdir).unwrap_or(path);
            if rel.as_os_str().is_empty() {
                continue;
            }
            if matcher.is_match(rel) || matcher.is_match(path) {
                matches.push(rel.to_string_lossy().into_owned());
                if matches.len() >= 200 {
                    matches.push("[limit reached]".into());
                    break;
                }
            }
        }
        Ok(ToolOutcome {
            output_for_model: if matches.is_empty() {
                "no matches".into()
            } else {
                truncate(matches.join("\n"))
            },
            ui_summary: None,
            diff: None,
        })
    }
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "grep".into(),
            description:
                "Search file contents with a regex (gitignore-aware). Returns path:line: line."
                    .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            }),
        }
    }

    fn default_policy(&self) -> Approval {
        Approval::Allow
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let pattern = args["pattern"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing pattern".into()))?;
        let re = Regex::new(pattern)
            .map_err(|e| ToolFailure::InvalidInput(format!("bad regex: {e}")))?;
        let mut out: Vec<String> = Vec::new();
        let mut truncated = false;
        let walker = ignore::WalkBuilder::new(workdir).require_git(false).build();
        for entry in walker {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            if path
                .file_name()
                .map(|n| n.to_string_lossy().contains("target"))
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(content) = tokio::fs::read_to_string(path).await else {
                continue;
            };
            for (i, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    out.push(format!(
                        "{}:{}: {}",
                        path.strip_prefix(workdir).unwrap_or(path).display(),
                        i + 1,
                        line.trim()
                    ));
                    if out.len() >= 100 {
                        truncated = true;
                        break;
                    }
                }
            }
            if truncated {
                break;
            }
        }
        let mut body = out.join("\n");
        if truncated {
            body.push_str("\n[limit reached]");
        }
        Ok(ToolOutcome {
            output_for_model: if body.is_empty() {
                "no matches".into()
            } else {
                body
            },
            ui_summary: None,
            diff: None,
        })
    }
}
