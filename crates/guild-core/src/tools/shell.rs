//! Shell tool: run a command in the project dir (default policy: ask).

use super::{truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub struct RunCommand;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

#[async_trait]
impl Tool for RunCommand {
    fn spec(&self) -> ToolSpec {
        protocol::api::client_tool_spec("execute").expect("built-in execute spec")
    }

    fn default_policy(&self) -> Approval {
        Approval::Ask
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let command = args["command"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing command".into()))?
            .to_string();
        let cwd = match args["cwd"].as_str() {
            Some(c) => super::resolve_scoped(workdir, c)?,
            None => workdir.to_path_buf(),
        };
        let timeout_ms = args["timeout_ms"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);

        // Shell selection: sh on Unix, cmd /c on Windows clients (this
        // binary runs on the user's desktop, not only on servers).
        #[cfg(unix)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg(&command);
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/c").arg(&command);
            c
        };
        #[cfg(windows)]
        {
            // The host is a GUI-subsystem process: without this, Windows
            // allocates a fresh console for each cmd.exe and a window
            // flashes on the user's desktop per command.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd
            .current_dir(&cwd)
            // stdin is pinned to null so interactive prompts (e.g. bare
            // `date`) read EOF instead of hanging until the timeout.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // On timeout the wait future is dropped with the child inside:
            // kill_on_drop reaps it instead of leaking an orphan process.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ToolFailure::Execution(format!("spawn failed: {e}")))?;

        let out = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
            .await
            .map_err(|_| {
                ToolFailure::Execution(format!("command timed out after {timeout_ms}ms: {command}"))
            })?
            .map_err(|e| ToolFailure::Execution(format!("wait failed: {e}")))?;

        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let mut output = format!("exit code: {}\n", out.status.code().unwrap_or(-1));
        if !stdout.is_empty() {
            output.push_str("--- stdout ---\n");
            output.push_str(&stdout);
        }
        if !stderr.is_empty() {
            output.push_str("--- stderr ---\n");
            output.push_str(&stderr);
        }
        Ok(ToolOutcome {
            images: Vec::new(),
            output_for_model: truncate(output),
            ui_summary: Some(format!("$ {command}")),
            diff: None,
            meta: Some(serde_json::json!({
                "card": "terminal",
                "exit_code": out.status.code().unwrap_or(-1),
            })),
        })
    }
}
