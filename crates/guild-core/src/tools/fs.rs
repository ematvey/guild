//! File tools: read, write, edit — all scoped to the project dir.

use super::workspace::{self, WorkspaceKind};
use super::{diff_text, resolve_scoped, resolve_scoped_in, truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use base64::Engine as _;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::Path;
use tokio::io::AsyncWriteExt as _;

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

// --- WSL transport (spec §4) ---------------------------------------------
//
// A `\\wsl.localhost\<d>\…` (or legacy `\\wsl$\…`) path is served by
// routing file access through wsl.exe into the distro, never through the
// 9P share. Every path reaching these helpers is resolve_scoped-checked
// first; the inner Linux path is derived from that resolved path, so it
// inherits the scoping. Writes land with the distro's default umask — no
// mode preservation.

/// File bytes: WSL transport for distro paths, direct fs for everything
/// else (native paths, and extra read roots on the host such as skill dirs).
async fn read_bytes(path: &Path) -> Result<Vec<u8>, ToolFailure> {
    match workspace::classify(path) {
        WorkspaceKind::Wsl { distro } => {
            let inner = wsl_inner(path, "read")?;
            wsl_read_bytes(&distro, &inner).await
        }
        _ => tokio::fs::read(path)
            .await
            .map_err(|e| ToolFailure::Execution(format!("read {}: {e}", path.display()))),
    }
}

/// Best-effort read: a missing or unreadable file reads as empty — used for
/// the `old` side of a write diff.
async fn read_bytes_optional(path: &Path) -> Vec<u8> {
    read_bytes(path).await.unwrap_or_default()
}

async fn write_bytes(path: &Path, content: &[u8]) -> Result<(), ToolFailure> {
    match workspace::classify(path) {
        WorkspaceKind::Wsl { distro } => {
            let inner = wsl_inner(path, "write")?;
            if let Some(parent) = path.parent() {
                // Parent check runs through the host fs (metadata only, no
                // content transport); the distro creates what is missing.
                if !tokio::fs::try_exists(parent).await.unwrap_or(false) {
                    let parent_inner = wsl_inner(parent, "mkdir")?;
                    wsl_mkdir(&distro, &parent_inner).await?;
                }
            }
            wsl_write_bytes(&distro, &inner, content).await
        }
        _ => {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| ToolFailure::Execution(format!("mkdir: {e}")))?;
            }
            tokio::fs::write(path, content)
                .await
                .map_err(|e| ToolFailure::Execution(format!("write {}: {e}", path.display())))
        }
    }
}

fn wsl_inner(path: &Path, op: &str) -> Result<String, ToolFailure> {
    workspace::to_inner(path).ok_or_else(|| {
        ToolFailure::Execution(format!("{op} {}: not a WSL distro path", path.display()))
    })
}

/// wsl.exe child with the same guards the shell tool gives cmd.exe: no
/// console window on the user's desktop, killed and reaped when the future
/// is dropped.
fn wsl_command(argv: &[String]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(&argv[0]);
    c.args(&argv[1..]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.kill_on_drop(true);
    c
}

async fn wsl_run_collecting(
    argv: &[String],
    stdin: std::process::Stdio,
) -> Result<std::process::Output, ToolFailure> {
    let child = wsl_command(argv)
        .stdin(stdin)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| ToolFailure::Execution(format!("wsl.exe spawn failed: {e}")))?;
    child
        .wait_with_output()
        .await
        .map_err(|e| ToolFailure::Execution(format!("wsl.exe wait failed: {e}")))
}

async fn wsl_read_bytes(distro: &str, inner: &str) -> Result<Vec<u8>, ToolFailure> {
    let argv = wsl_read_argv(distro, inner);
    let out = wsl_run_collecting(&argv, std::process::Stdio::null()).await?;
    if !out.status.success() {
        return Err(ToolFailure::Execution(format!(
            "read {inner} (distro {distro}): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    // base64 wraps its output at 76 columns — decode the whitespace-stripped
    // payload.
    let flat: Vec<u8> = out
        .stdout
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(&flat)
        .map_err(|e| ToolFailure::Execution(format!("read {inner}: bad base64 from wsl: {e}")))
}

async fn wsl_write_bytes(distro: &str, inner: &str, content: &[u8]) -> Result<(), ToolFailure> {
    let argv = wsl_write_argv(distro, inner);
    let mut child = wsl_command(&argv)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| ToolFailure::Execution(format!("wsl.exe spawn failed: {e}")))?;
    {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            ToolFailure::Execution("wsl.exe stdin unavailable".to_string())
        })?;
        stdin
            .write_all(content)
            .await
            .map_err(|e| ToolFailure::Execution(format!("wsl.exe stdin write failed: {e}")))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| ToolFailure::Execution(format!("wsl.exe stdin close failed: {e}")))?;
        // Dropping the handle delivers EOF so `cat` can finish.
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| ToolFailure::Execution(format!("wsl.exe wait failed: {e}")))?;
    if !out.status.success() {
        return Err(ToolFailure::Execution(format!(
            "write {inner} (distro {distro}): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

async fn wsl_mkdir(distro: &str, inner: &str) -> Result<(), ToolFailure> {
    let argv = wsl_mkdir_argv(distro, inner);
    let out = wsl_run_collecting(&argv, std::process::Stdio::null()).await?;
    if !out.status.success() {
        return Err(ToolFailure::Execution(format!(
            "mkdir {inner} (distro {distro}): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// WSL read argv: `wsl.exe -d <d> --exec base64 <abs-inner-path>`.
fn wsl_read_argv(distro: &str, inner: &str) -> Vec<String> {
    vec![
        "wsl.exe".to_string(),
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "base64".to_string(),
        inner.to_string(),
    ]
}

/// WSL write argv: `wsl.exe -d <d> --exec sh -c 'cat > <path>'` — bytes
/// arrive on stdin, the path is single-quote-escaped inside the sh
/// argument. The path is resolve_scoped-checked before it reaches here.
fn wsl_write_argv(distro: &str, inner: &str) -> Vec<String> {
    vec![
        "wsl.exe".to_string(),
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        format!("cat > {}", single_quote(inner)),
    ]
}

fn wsl_mkdir_argv(distro: &str, inner: &str) -> Vec<String> {
    vec![
        "wsl.exe".to_string(),
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "mkdir".to_string(),
        "-p".to_string(),
        inner.to_string(),
    ]
}

/// Shell single-quote: `'…'` with embedded quotes spelled `'\''`.
fn single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

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
        let bytes = read_bytes(&path).await?;
        if let Some(mime) = image_mime(&ext) {
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

        let content = match String::from_utf8(bytes) {
            Ok(c) => c,
            Err(e) => {
                let size = e.as_bytes().len();
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
        let old = String::from_utf8_lossy(&read_bytes_optional(&path).await).into_owned();
        write_bytes(&path, content.as_bytes()).await?;
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
        let bytes = read_bytes(&path).await?;
        let content = String::from_utf8(bytes).map_err(|_| {
            ToolFailure::Execution(format!(
                "read {}: file is not valid UTF-8 — edit_file is text only",
                path.display()
            ))
        })?;
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
                // Read-modify-write, not atomic: a change landing between the
                // read and the write is silently overwritten (last write
                // wins). Accepted for this tool shape; a size/mtime guard
                // would be the follow-up if it ever matters.
                let updated = content.replacen(old, new, 1);
                write_bytes(&path, updated.as_bytes()).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// UNC path over a real temp tree so scoped checks canonicalize on this
    /// Linux host: the prefix is string-level, the tail is a real directory.
    fn wsl_unc(tmp: &Path, rest: &str) -> PathBuf {
        let mut s = format!(r"\\wsl.localhost\TestDistro\{}", tmp.display());
        s.push_str(rest);
        PathBuf::from(s)
    }

    #[test]
    fn wsl_argv_shapes() {
        assert_eq!(
            wsl_read_argv("Ubuntu", "/home/me/proj/f.txt"),
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu",
                "--exec",
                "base64",
                "/home/me/proj/f.txt"
            ]
        );
        assert_eq!(
            wsl_write_argv("Ubuntu", "/home/me/proj/f.txt")[6],
            "cat > '/home/me/proj/f.txt'"
        );
        assert_eq!(
            wsl_mkdir_argv("Ubuntu", "/home/me/proj/new"),
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu",
                "--exec",
                "mkdir",
                "-p",
                "/home/me/proj/new"
            ]
        );
    }

    #[test]
    fn wsl_write_quoting_spaces_and_quotes() {
        assert_eq!(
            wsl_write_argv("Ubuntu", "/home/a b/f.txt")[6],
            "cat > '/home/a b/f.txt'"
        );
        assert_eq!(
            wsl_write_argv("Ubuntu", "/home/a'b/f.txt")[6],
            "cat > '/home/a'\\''b/f.txt'"
        );
        assert_eq!(single_quote("plain"), "'plain'");
        assert_eq!(single_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn wsl_inner_scope_rejects_escapes() {
        let tag = format!("guild-wsl-scope-{}", std::process::id());
        let dir = std::env::temp_dir().join(tag);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let inner = workspace::to_inner(&wsl_unc(&dir, "")).unwrap();
        assert_eq!(inner, dir.display().to_string());
        let base = Path::new(&inner);
        assert!(resolve_scoped(base, "sub/f.txt").is_ok());
        assert!(resolve_scoped(base, "../outside.txt").is_err());
        assert!(resolve_scoped(base, "/etc/passwd").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
