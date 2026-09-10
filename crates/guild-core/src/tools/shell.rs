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
        ToolSpec {
            name: "run_command".into(),
            description: "Run a shell command (sh -c) in the project directory. Non-zero exits are reported, not errors.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout_ms": {"type": "integer"},
                },
                "required": ["command"],
            }),
        }
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

        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
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
