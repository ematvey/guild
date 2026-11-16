//! File tools (read, write) scoped to the project dir, and the raw file
//! ops behind the server's machine file adapter.

use super::workspace::{self, WorkspaceKind};
use super::{resolve_scoped, resolve_scoped_in, truncate, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use base64::Engine as _;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt as _;

/// Read-only file access scoped to the project dir plus explicit extra
/// roots (discovered skill dirs live outside the workspace, e.g.
/// `~/.agents/skills` — the index advertises those paths, so the agent
/// must be able to read them).
pub struct ReadFile {
    pub extra_read_roots: Vec<std::path::PathBuf>,
    /// Byte cap on the model-facing text read (tests shrink it; production
    /// callers use the MAX_READ_BYTES default via Default).
    pub max_read_bytes: usize,
}

impl Default for ReadFile {
    fn default() -> Self {
        Self {
            extra_read_roots: Vec::new(),
            max_read_bytes: MAX_READ_BYTES,
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

/// Cap on a single read_file read: only the file's first MAX_READ_BYTES
/// bytes are loaded (the WSL transport reads just that prefix, `head -c`
/// style); a larger file is reported truncated instead of becoming a
/// multi-GB allocation for a paginated 64 KB output. Stays above
/// MAX_IMAGE_BYTES so image reads are never cut.
const MAX_READ_BYTES: usize = 8 * 1024 * 1024;

/// Wall-clock bound for every wsl.exe transport call. The shell tool bounds
/// its children to 300 s and the interop heal to 10 s; an unbounded wsl.exe
/// (distro cold start, hung session init) stalls its caller with no escape.
const WSL_TOOL_TIMEOUT: Duration = Duration::from_secs(300);

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
#[cfg(test)]
async fn read_bytes(path: &Path) -> Result<Vec<u8>, ToolFailure> {
    read_bytes_capped(path, usize::MAX).await
}

/// [`read_bytes`] capped at `cap` bytes: only the first `cap` bytes of the
/// file are transported (WSL reads a `head -c` prefix instead of piping the
/// whole file). usize::MAX reads everything, as read_bytes always did.
async fn read_bytes_capped(path: &Path, cap: usize) -> Result<Vec<u8>, ToolFailure> {
    match workspace::classify(path) {
        WorkspaceKind::Wsl { distro } => {
            let inner = wsl_inner(path, "read")?;
            if cap == usize::MAX {
                wsl_read_bytes(&distro, &inner).await
            } else {
                wsl_read_bytes_capped(&distro, &inner, cap).await
            }
        }
        _ => {
            use tokio::io::AsyncReadExt as _;
            let mut file = tokio::fs::File::open(path)
                .await
                .map_err(|e| ToolFailure::Execution(format!("read {}: {e}", path.display())))?;
            let mut buf = Vec::new();
            (&mut file)
                .take(cap as u64)
                .read_to_end(&mut buf)
                .await
                .map_err(|e| ToolFailure::Execution(format!("read {}: {e}", path.display())))?;
            Ok(buf)
        }
    }
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
    // kill_on_drop reaps the child when the timeout drops the wait future.
    tokio::time::timeout(WSL_TOOL_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            ToolFailure::Execution(format!(
                "wsl.exe timed out after {}s: {}",
                WSL_TOOL_TIMEOUT.as_secs(),
                argv.join(" ")
            ))
        })?
        .map_err(|e| ToolFailure::Execution(format!("wsl.exe wait failed: {e}")))
}

async fn wsl_read_bytes(distro: &str, inner: &str) -> Result<Vec<u8>, ToolFailure> {
    let argv = wsl_read_argv(distro, inner);
    let out = wsl_run_collecting(&argv, std::process::Stdio::null()).await?;
    decode_wsl_base64(&out, inner, distro)
}

async fn wsl_read_bytes_capped(
    distro: &str,
    inner: &str,
    cap: usize,
) -> Result<Vec<u8>, ToolFailure> {
    let argv = wsl_read_prefix_argv(distro, inner, cap);
    let out = wsl_run_collecting(&argv, std::process::Stdio::null()).await?;
    decode_wsl_base64(&out, inner, distro)
}

/// Shared decode for the two WSL read transports: status check plus the
/// whitespace-stripped base64 decode.
fn decode_wsl_base64(
    out: &std::process::Output,
    inner: &str,
    distro: &str,
) -> Result<Vec<u8>, ToolFailure> {
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
    // kill_on_drop reaps the child when the timeout drops the write+wait
    // future mid-flight.
    let out =
        tokio::time::timeout(WSL_TOOL_TIMEOUT, async {
            {
                let mut stdin = child.stdin.take().ok_or_else(|| {
                    ToolFailure::Execution("wsl.exe stdin unavailable".to_string())
                })?;
                stdin.write_all(content).await.map_err(|e| {
                    ToolFailure::Execution(format!("wsl.exe stdin write failed: {e}"))
                })?;
                stdin.shutdown().await.map_err(|e| {
                    ToolFailure::Execution(format!("wsl.exe stdin close failed: {e}"))
                })?;
                // Dropping the handle delivers EOF so `cat` can finish.
            }
            child
                .wait_with_output()
                .await
                .map_err(|e| ToolFailure::Execution(format!("wsl.exe wait failed: {e}")))
        })
        .await
        .map_err(|_| {
            ToolFailure::Execution(format!(
                "wsl.exe write timed out after {}s: {inner} (distro {distro})",
                WSL_TOOL_TIMEOUT.as_secs()
            ))
        })??;
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

/// WSL capped-read argv: only the first `cap` bytes are piped —
/// `wsl.exe -d <d> --exec sh -c 'head -c <cap> <path> | base64'`. A
/// multi-GB file must not ride the base64 transport for a paginated read.
fn wsl_read_prefix_argv(distro: &str, inner: &str, cap: usize) -> Vec<String> {
    vec![
        "wsl.exe".to_string(),
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        format!("head -c {cap} {} | base64", single_quote(inner)),
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
        // Images and edits read the whole file; the model-facing text read
        // is capped — only the file's head reaches memory and the wire.
        let cap = self.max_read_bytes;
        let bytes = read_bytes_capped(&path, cap).await?;
        let truncated = bytes.len() >= cap;
        if truncated {
            meta["truncated"] = serde_json::json!(true);
        }
        if let Some(mime) = image_mime(&ext) {
            let kb = bytes.len() / 1024;
            meta["size_kb"] = serde_json::json!(kb);
            // The read cap must stay above the image limit; if a custom cap
            // ever cut an image, reporting it too-large beats attaching a
            // half image.
            if truncated || bytes.len() > MAX_IMAGE_BYTES {
                return Ok(ToolOutcome {
                    images: Vec::new(),
                    output_for_model: format!(
                        "[image file: {display} ({kb} KB) — too large to attach (limit 4 MB)]"
                    ),
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
        let mut body = page.join("\n");
        if truncated {
            body.push_str(&format!(
                "\n[truncated: only the first {} MB of this file were read — the rest exists but is not shown]",
                cap / (1024 * 1024)
            ));
        }
        Ok(ToolOutcome {
            images: Vec::new(),
            output_for_model: truncate(body),
            meta: Some(meta),
        })
    }
}

/// Cap on one raw file read (`fs.read_raw_v1`): a larger file fails with
/// `too_large` instead of arriving truncated.
pub const MAX_RAW_READ_BYTES: usize = 8 * 1024 * 1024;

/// A failed raw file op: a FileError-style code plus a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFsError {
    /// `not_found`, `permission_denied`, `is_directory`, `invalid`,
    /// `too_large` or `unknown`.
    pub code: &'static str,
    pub message: String,
}

impl RawFsError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(path: &Path, e: &std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::IsADirectory => "is_directory",
            _ => "unknown",
        };
        Self::new(code, format!("{}: {e}", path.display()))
    }

    /// The wire form: `{"code", "message"}`.
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "code": self.code, "message": self.message })
    }
}

fn scoped_raw(
    workdir: &Path,
    extra_roots: &[std::path::PathBuf],
    path: &str,
) -> Result<std::path::PathBuf, RawFsError> {
    resolve_scoped_in(workdir, extra_roots, path).map_err(|e| match e {
        ToolFailure::InvalidInput(m) if m.starts_with("path not found") => {
            RawFsError::new("not_found", m)
        }
        other => RawFsError::new("invalid", other.to_string()),
    })
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let t = meta.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

fn kind_name(meta: &std::fs::Metadata) -> &'static str {
    if meta.is_file() {
        "file"
    } else if meta.is_dir() {
        "directory"
    } else {
        "other"
    }
}

/// `fs.stat_v1`: metadata of one scoped path, following symlinks.
/// `{"exists": false}` for a missing path, else `{"exists": true, "kind",
/// "size", "mtime_ms"}` with kind `file`, `directory` or `other`.
pub async fn stat_raw(
    workdir: &Path,
    extra_roots: &[std::path::PathBuf],
    path: &str,
) -> Result<Value, RawFsError> {
    let resolved = match scoped_raw(workdir, extra_roots, path) {
        Ok(p) => p,
        Err(e) if e.code == "not_found" => return Ok(serde_json::json!({ "exists": false })),
        Err(e) => return Err(e),
    };
    match tokio::fs::metadata(&resolved).await {
        Ok(meta) => Ok(serde_json::json!({
            "exists": true,
            "kind": kind_name(&meta),
            "size": meta.len(),
            "mtime_ms": mtime_ms(&meta),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(serde_json::json!({ "exists": false }))
        }
        Err(e) => Err(RawFsError::io(&resolved, &e)),
    }
}

/// `fs.read_raw_v1`: the exact bytes of one scoped regular file, base64
/// encoded, as `{"size", "mtime_ms", "data_b64"}`. A file over `max_bytes`
/// fails with `too_large`; nothing is truncated or re-encoded.
pub async fn read_raw(
    workdir: &Path,
    extra_roots: &[std::path::PathBuf],
    path: &str,
    max_bytes: usize,
) -> Result<Value, RawFsError> {
    let resolved = scoped_raw(workdir, extra_roots, path)?;
    let meta = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| RawFsError::io(&resolved, &e))?;
    if meta.is_dir() {
        return Err(RawFsError::new(
            "is_directory",
            format!("{}: is a directory", resolved.display()),
        ));
    }
    if !meta.is_file() {
        return Err(RawFsError::new(
            "invalid",
            format!("{}: not a regular file", resolved.display()),
        ));
    }
    let too_large = |size: u64| {
        RawFsError::new(
            "too_large",
            format!(
                "{}: {size} bytes exceeds the {max_bytes}-byte machine file transfer limit",
                resolved.display()
            ),
        )
    };
    if meta.len() > max_bytes as u64 {
        return Err(too_large(meta.len()));
    }
    let bytes = read_bytes_capped(&resolved, max_bytes.saturating_add(1))
        .await
        .map_err(|e| RawFsError::new("unknown", e.to_string()))?;
    if bytes.len() > max_bytes {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(serde_json::json!({
        "size": bytes.len(),
        "mtime_ms": mtime_ms(&meta),
        "data_b64": base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

pub struct WriteFile;

#[async_trait]
impl Tool for WriteFile {
    fn spec(&self) -> ToolSpec {
        protocol::api::client_tool_spec("write_file").expect("built-in write_file spec")
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
        // `encoding: base64` carries bytes a text file cannot: a downloaded
        // PDF, an image. Text stays text.
        let bytes = if args["encoding"].as_str() == Some("base64") {
            base64::engine::general_purpose::STANDARD
                .decode(content)
                .map_err(|e| ToolFailure::InvalidInput(format!("content is not valid base64: {e}")))?
        } else {
            content.as_bytes().to_vec()
        };
        write_bytes(&path, &bytes).await?;
        let n = bytes.len();
        Ok(ToolOutcome {
            images: Vec::new(),
            output_for_model: format!("wrote {n} bytes to {}", path.display()),
            meta: Some(serde_json::json!({
                "card": "diff",
                "path": path.display().to_string(),
            })),
        })
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
    fn write_file_base64_writes_the_bytes_a_text_frame_cannot_carry() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("guild-write-b64-{}", std::process::id()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            // A PDF header: bytes a JSON string would mangle.
            let bytes: Vec<u8> = vec![0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff];
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let out = WriteFile
                .run(
                    &dir,
                    serde_json::json!({ "path": "in/report.pdf", "content": encoded, "encoding": "base64" }),
                )
                .await
                .unwrap();
            assert!(out.output_for_model.contains("wrote 10 bytes"));
            let written = tokio::fs::read(dir.join("in/report.pdf")).await.unwrap();
            assert_eq!(written, bytes);
            // Text stays text.
            WriteFile
                .run(&dir, serde_json::json!({ "path": "notes.txt", "content": "hi" }))
                .await
                .unwrap();
            assert_eq!(
                tokio::fs::read(dir.join("notes.txt")).await.unwrap(),
                b"hi".to_vec()
            );
            let _ = tokio::fs::remove_dir_all(&dir).await;
        });
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
    fn wsl_read_prefix_argv_shapes() {
        assert_eq!(
            wsl_read_prefix_argv("Ubuntu", "/home/me/big.bin", 4096),
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu",
                "--exec",
                "sh",
                "-c",
                "head -c 4096 '/home/me/big.bin' | base64"
            ]
        );
        assert_eq!(
            wsl_read_prefix_argv("Ubuntu", "/home/a'b/f.txt", 8)[6],
            "head -c 8 '/home/a'\\''b/f.txt' | base64"
        );
    }

    #[test]
    fn capped_read_returns_only_the_prefix_and_run_reports_truncation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("guild-read-cap-{}", std::process::id()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            let path = dir.join("big.txt");
            let line = "x".repeat(99) + "\n";
            let full = line.repeat(300); // 30_000 bytes, cap 10_000
            tokio::fs::write(&path, &full).await.unwrap();

            let prefix = read_bytes_capped(&path, 10_000).await.unwrap();
            assert_eq!(prefix.len(), 10_000);
            assert_eq!(String::from_utf8_lossy(&prefix[..100]), &full[..100]);
            // Uncapped read is unchanged.
            assert_eq!(read_bytes(&path).await.unwrap(), full.as_bytes());

            // The tool surfaces the truncation to the model and in meta.
            let out = ReadFile {
                extra_read_roots: Vec::new(),
                max_read_bytes: 10_000,
            }
            .run(&dir, serde_json::json!({"path": "big.txt", "limit": 5}))
            .await
            .unwrap();
            assert!(out.meta.as_ref().unwrap()["truncated"].as_bool().unwrap());
            assert!(out.output_for_model.contains("[truncated:"));
            // Small files are not flagged.
            tokio::fs::write(dir.join("small.txt"), &b"tiny\n"[..])
                .await
                .unwrap();
            let out = ReadFile::default()
                .run(&dir, serde_json::json!({"path": "small.txt"}))
                .await
                .unwrap();
            assert!(out.meta.as_ref().unwrap().get("truncated").is_none());
            tokio::fs::remove_dir_all(&dir).await.ok();
        });
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

    fn decode(v: &Value) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(v["data_b64"].as_str().unwrap())
            .unwrap()
    }

    #[test]
    fn read_raw_returns_exact_bytes_past_the_model_read_limits() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("guild-read-raw-{}", std::process::id()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            // >2000 CRLF lines, >64 KB, no trailing newline.
            let mut text = (0..5000)
                .map(|i| format!("line {i} with some padding text"))
                .collect::<Vec<_>>()
                .join("\r\n");
            text.push_str("\r\nlast");
            assert!(text.len() > 64 * 1024);
            tokio::fs::write(dir.join("big.txt"), &text).await.unwrap();
            let out = read_raw(&dir, &[], "big.txt", MAX_RAW_READ_BYTES)
                .await
                .unwrap();
            assert_eq!(decode(&out), text.as_bytes());
            assert_eq!(out["size"], text.len());
            assert!(out["mtime_ms"].as_f64().unwrap() > 0.0);

            // Binary content round-trips as bytes, not a placeholder.
            let bin = [0xFFu8, 0xFE, 0x00, 0x01, b'\n'];
            tokio::fs::write(dir.join("b.bin"), bin).await.unwrap();
            let out = read_raw(&dir, &[], "b.bin", MAX_RAW_READ_BYTES)
                .await
                .unwrap();
            assert_eq!(decode(&out), bin);

            // Over the cap: an error, never a truncated payload.
            let err = read_raw(&dir, &[], "big.txt", 1024).await.unwrap_err();
            assert_eq!(err.code, "too_large");
            let err = read_raw(&dir, &[], "missing.txt", MAX_RAW_READ_BYTES)
                .await
                .unwrap_err();
            assert_eq!(err.code, "not_found");
            let err = read_raw(&dir, &[], ".", MAX_RAW_READ_BYTES)
                .await
                .unwrap_err();
            assert_eq!(err.code, "is_directory");
            let err = read_raw(&dir, &[], "../../etc/passwd", MAX_RAW_READ_BYTES)
                .await
                .unwrap_err();
            assert_eq!(err.code, "invalid");
            tokio::fs::remove_dir_all(&dir).await.ok();
        });
    }

    #[test]
    fn stat_raw_reports_kind_size_and_absence() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("guild-stat-raw-{}", std::process::id()));
            tokio::fs::create_dir_all(dir.join("sub")).await.unwrap();
            tokio::fs::write(dir.join("f.txt"), b"abc\r\n")
                .await
                .unwrap();
            let f = stat_raw(&dir, &[], "f.txt").await.unwrap();
            assert_eq!(f["exists"], true);
            assert_eq!(f["kind"], "file");
            assert_eq!(f["size"], 5);
            let d = stat_raw(&dir, &[], "sub").await.unwrap();
            assert_eq!(d["kind"], "directory");
            let missing = stat_raw(&dir, &[], "nope/deeper.txt").await.unwrap();
            assert_eq!(missing, serde_json::json!({"exists": false}));
            assert_eq!(
                stat_raw(&dir, &[], "../outside").await.unwrap_err().code,
                "invalid"
            );
            tokio::fs::remove_dir_all(&dir).await.ok();
        });
    }
}
