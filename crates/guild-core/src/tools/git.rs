//! Git tool: read-only operations (status, diff, log, branch). Write
//! operations go through approved `run_command` calls.

use super::{truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::Path;

pub struct GitTool;

const ALLOWED: [&str; 4] = ["status", "diff", "log", "branch"];

#[async_trait]
impl Tool for GitTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git".into(),
            description: format!(
                "Read-only git: subcommands {} (run via `git -C <project>`). Mutating git commands: use run_command with approval.",
                ALLOWED.join(", ")
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"subcommand": {"type": "string", "enum": ALLOWED}},
                "required": ["subcommand"],
            }),
        }
    }

    fn default_policy(&self) -> Approval {
        Approval::Allow
    }

    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let sub = args["subcommand"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing subcommand".into()))?;
        if !ALLOWED.contains(&sub) {
            return Err(ToolFailure::InvalidInput(format!(
                "subcommand {sub} is not read-only; use run_command instead"
            )));
        }
        let out = tokio::process::Command::new("git")
            .arg("-C")
            .arg(workdir)
            .arg(sub)
            .output()
            .await
            .map_err(|e| ToolFailure::Execution(format!("git spawn failed: {e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let mut body = stdout.into_owned();
        if !stderr.is_empty() {
            body.push_str("--- stderr ---\n");
            body.push_str(&stderr);
        }
        if !out.status.success() && body.trim().is_empty() {
            return Err(ToolFailure::Execution(format!(
                "git {sub} failed (no output)"
            )));
        }
        Ok(ToolOutcome {
            output_for_model: truncate(body),
            ui_summary: Some(format!("git {sub}")),
            diff: None,
        })
    }
}
