//! Shell tool: run a command in the project dir (default policy: ask).

use super::{resolve_scoped, truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct RunCommand;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

/// WSL shell argv (spec §4): `wsl.exe -d <distro> --cd <inner> --exec bash
/// -lc <cmd>`. `--exec` hands the argv straight to bash — no intermediate
/// shell between wsl.exe and the wrapper; `-lc` loads the profile so the
/// distro's PATH (nvm/cargo/…) is present; the distro default user runs it
/// (never `-u`). `inner` is the Linux path from `workspace::to_inner`.
#[cfg(any(windows, test))]
fn wsl_shell_argv(distro: &str, inner: &str, command: &str) -> Vec<String> {
    vec![
        "wsl.exe".to_string(),
        "-d".to_string(),
        distro.to_string(),
        "--cd".to_string(),
        inner.to_string(),
        "--exec".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        command.to_string(),
    ]
}

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
        let cwd: Option<PathBuf> = match args["cwd"].as_str() {
            Some(c) => Some(resolve_scoped(workdir, c)?),
            None => None,
        };
        let timeout_ms = args["timeout_ms"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);

        // Shell selection: sh on Unix; on Windows cmd /c for native folders
        // and wsl.exe for `\\wsl.localhost\<d>\…` workdirs (this binary runs
        // on the user's desktop, not only on servers).
        #[cfg(unix)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg(&command);
            c.current_dir(cwd.as_deref().unwrap_or(workdir));
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            // The host is a GUI-subsystem process: without this, Windows
            // allocates a fresh console for each child (cmd.exe or wsl.exe)
            // and a window flashes on the user's desktop per command.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            use super::workspace::{self, WorkspaceKind};
            let mut c = match workspace::classify(workdir) {
                WorkspaceKind::Wsl { ref distro } => {
                    let base = workspace::to_inner(workdir).ok_or_else(|| {
                        ToolFailure::InvalidInput(format!(
                            "bad WSL workdir: {}",
                            workdir.display()
                        ))
                    })?;
                    let cd = match &cwd {
                        Some(p) => workspace::to_inner(p).ok_or_else(|| {
                            ToolFailure::InvalidInput(format!("bad WSL cwd: {}", p.display()))
                        })?,
                        None => base,
                    };
                    let mut w = tokio::process::Command::new("wsl.exe");
                    for a in wsl_shell_argv(distro, &cd, &command) {
                        w.arg(a);
                    }
                    w
                }
                _ => {
                    let mut w = tokio::process::Command::new("cmd");
                    w.arg("/c").arg(&command);
                    w.current_dir(cwd.as_deref().unwrap_or(workdir));
                    w
                }
            };
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        let child = cmd
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
            artifact: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_shell_argv_shape() {
        assert_eq!(
            wsl_shell_argv("Ubuntu", "/home/me/proj", "ls -la"),
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu",
                "--cd",
                "/home/me/proj",
                "--exec",
                "bash",
                "-lc",
                "ls -la",
            ]
        );
    }

    #[test]
    fn wsl_shell_argv_keeps_command_verbatim() {
        // The command travels as a single argv element — quotes and all;
        // nothing between wsl.exe and bash escapes it.
        let argv = wsl_shell_argv("Ubuntu", "/w", r#"echo "a b" && ls 'x'"#);
        assert_eq!(argv.last().unwrap(), r#"echo "a b" && ls 'x'"#);
    }

    #[test]
    fn wsl_shell_argv_paths_with_spaces_and_quotes() {
        let argv = wsl_shell_argv("Debian", "/home/o'brien/note two", "pwd");
        assert_eq!(&argv[2], "Debian");
        assert_eq!(&argv[4], "/home/o'brien/note two");
        assert_eq!(&argv[6], "bash");
        assert_eq!(&argv[7], "-lc");
    }
}
