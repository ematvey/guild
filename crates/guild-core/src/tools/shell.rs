//! Shell tool: run a command in the project dir (default policy: ask).
//!
//! WSL self-heal: WSL's interop binfmt (`WSLInterop` in binfmt_misc) goes
//! missing on systemd distros (microsoft/WSL#8843 family — wiped at boot by
//! systemd's binfmt_misc mount dance and not re-registered, and reaped
//! again by WSL's own session lifecycle). When the entry is absent, the
//! login-shell session (`bash -lc`) bootstrap dies with exit 127 and a
//! dash-style ENOEXEC fallback error ("…/wsl.exe: 1: MZ: not found") —
//! while non-login direct execs (`--exec base64 …`) still work. The shell
//! tool detects that exact signature, re-registers the entry via a root
//! non-login exec (which works precisely because it skips the broken
//! bootstrap), and retries the command once.

use super::{resolve_scoped, truncate, Approval, Tool, ToolFailure, ToolOutcome};
use async_trait::async_trait;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct RunCommand;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

/// The WSLInterop binfmt_misc registration. Matches what WSL itself writes
/// (magic `MZ`, interpreter `/init`, preserve-argv0 + fix-binary flags).
/// Proven sufficient on WSL 2.7.x: with this entry present, login-shell
/// sessions bootstrap again and the MZ failure disappears.
const WSL_INTEROP_SPEC: &str = ":WSLInterop:M::MZ::/init:PF";

/// Heal rate limit: at most one interop heal per this interval, so a
/// persistently-broken distro cannot turn every execute into a heal storm.
#[cfg(windows)]
const WSL_HEAL_MIN_INTERVAL: Duration = Duration::from_secs(30);

#[cfg(windows)]
static LAST_WSL_HEAL: std::sync::LazyLock<std::sync::Mutex<Option<std::time::Instant>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// The failure signature of a login-shell session whose WSL interop binfmt
/// is missing: exit 127 plus the shell's ENOEXEC fallback trying to run the
/// `wsl.exe` PE image as a script (first token `MZ`).
#[cfg(any(windows, test))]
fn is_interop_enoexec(exit_code: Option<i32>, stderr: &str) -> bool {
    exit_code == Some(127) && stderr.contains("MZ")
}

/// Repair argv: `wsl.exe -d <d> -u root --exec sh -c '<script>'`. Deliberately
/// NON-login direct exec — that transport keeps working while interop is
/// broken, which is what makes the repair possible from the outside. The
/// script mounts binfmt_misc if needed and registers only when absent.
#[cfg(any(windows, test))]
fn wsl_heal_argv(distro: &str) -> Vec<String> {
    vec![
        "wsl.exe".to_string(),
        "-d".to_string(),
        distro.to_string(),
        "-u".to_string(),
        "root".to_string(),
        "--exec".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        format!(
            "mountpoint -q /proc/sys/fs/binfmt_misc 2>/dev/null || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null; test -e /proc/sys/fs/binfmt_misc/WSLInterop || echo '{WSL_INTEROP_SPEC}' > /proc/sys/fs/binfmt_misc/register"
        ),
    ]
}

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

/// A spawn-ready wsl.exe child with the desktop guards (no console window,
/// killed and reaped when the future is dropped).
#[cfg(windows)]
fn wsl_child(argv: &[String]) -> tokio::process::Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = tokio::process::Command::new(&argv[0]);
    c.args(&argv[1..]);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Re-register the WSLInterop binfmt entry as root. Returns true when a heal
/// was attempted and the repair exec reported success. Rate-limited.
#[cfg(windows)]
async fn wsl_heal_interop(distro: &str) -> bool {
    {
        let last = LAST_WSL_HEAL.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < WSL_HEAL_MIN_INTERVAL {
                return false;
            }
        }
    }
    let argv = wsl_heal_argv(distro);
    let child = wsl_child(&argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let ok = match child {
        Ok(child) => tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
            .await
            .ok()
            .and_then(|r| r.ok())
            .map(|o| o.status.success())
            .unwrap_or(false),
        Err(_) => false,
    };
    if ok {
        *LAST_WSL_HEAL.lock().unwrap() = Some(std::time::Instant::now());
    }
    ok
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
        // WSL context for the self-heal retry: (distro, inner cwd), present
        // only when this command runs through wsl.exe.
        #[cfg(windows)]
        let mut wsl_ctx: Option<(String, String)> = None;
        #[cfg(windows)]
        let mut cmd = {
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
                    let argv = wsl_shell_argv(distro, &cd, &command);
                    wsl_ctx = Some((distro.clone(), cd));
                    let mut w = tokio::process::Command::new(&argv[0]);
                    w.args(&argv[1..]);
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

        // WSL self-heal: on the interop-ENOEXEC signature, repair the binfmt
        // entry and run the command once more. The first attempt never ran
        // the command (its session bootstrap died before exec), so a retry
        // has no double-execution risk.
        #[cfg(windows)]
        let (out, healed) = match &wsl_ctx {
            Some((distro, cd))
                if is_interop_enoexec(out.status.code(), &String::from_utf8_lossy(&out.stderr)) =>
            {
                if wsl_heal_interop(distro).await {
                    let argv = wsl_shell_argv(distro, cd, &command);
                    let retry = wsl_child(&argv)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .kill_on_drop(true)
                        .spawn();
                    match retry {
                        Ok(child) => {
                            let retried = tokio::time::timeout(
                                Duration::from_millis(timeout_ms),
                                child.wait_with_output(),
                            )
                            .await
                            .map_err(|_| {
                                ToolFailure::Execution(format!(
                                    "command timed out after {timeout_ms}ms: {command}"
                                ))
                            })?
                            .map_err(|e| ToolFailure::Execution(format!("wait failed: {e}")))?;
                            (retried, true)
                        }
                        // Keep the original failure if the heal child itself
                        // could not spawn.
                        Err(_) => (out, false),
                    }
                } else {
                    (out, false)
                }
            }
            _ => (out, false),
        };
        #[cfg(not(windows))]
        let healed = false;

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
            meta: Some({
                let mut m = serde_json::json!({
                    "card": "terminal",
                    "exit_code": out.status.code().unwrap_or(-1),
                });
                if healed {
                    m["wsl_interop_healed"] = serde_json::json!(true);
                }
                m
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interop_enoexec_signature() {
        assert!(is_interop_enoexec(
            Some(127),
            "/mnt/c/Users/e/AppData/Local/Microsoft/WindowsApps/wsl.exe: 1: MZ: not found\n"
        ));
        assert!(is_interop_enoexec(
            Some(127),
            "/mnt/c/.../wsl.exe: line 1: MZ: command not found\n"
        ));
        // Not the interop signature: wrong exit code, no MZ marker, or a
        // plain command-not-found.
        assert!(!is_interop_enoexec(Some(0), "MZ"));
        assert!(!is_interop_enoexec(Some(2), "MZ missing"));
        assert!(!is_interop_enoexec(Some(127), "bash: foo: command not found"));
    }

    #[test]
    fn wsl_heal_argv_shape() {
        let argv = wsl_heal_argv("archlinux");
        assert_eq!(&argv[..6], &["wsl.exe", "-d", "archlinux", "-u", "root", "--exec"]);
        assert_eq!(&argv[6..8], &["sh", "-c"]);
        let script = &argv[8];
        // Registers only when absent; the spec travels quoted.
        assert!(script.starts_with("mountpoint -q /proc/sys/fs/binfmt_misc"));
        assert!(script.contains("test -e /proc/sys/fs/binfmt_misc/WSLInterop || echo '"));
        assert!(script.contains(WSL_INTEROP_SPEC));
        // Never a login shell: the heal must work while the login bootstrap
        // itself is broken.
        assert!(!script.contains("-lc"));
    }

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
