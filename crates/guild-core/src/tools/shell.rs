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

// Retain at most this much per pipe while continuing to drain the child.
const MAX_PIPE_BYTES: usize = 64 * 1024;

async fn collect_pipe(mut pipe: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        let retain = n.min(MAX_PIPE_BYTES.saturating_sub(kept.len()));
        kept.extend_from_slice(&buffer[..retain]);
        truncated |= retain < n;
    }
    if truncated {
        kept.extend_from_slice(b"\n[output truncated]\n");
    }
    Ok(kept)
}

#[cfg(unix)]
struct ProcessTree(i32);
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // This execution owns a fresh process group; descendants retaining
        // the pipes must not survive timeout or cancellation of the future.
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn process_tree(child: &tokio::process::Child) -> std::io::Result<ProcessTree> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let guard = ProcessTree(job);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(job, child.raw_handle().unwrap() as _) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        // The child starts suspended, so it cannot create descendants before
        // joining the job. std/Tokio do not expose the primary thread handle.
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let resumed = (|| {
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut found = false;
            let mut next = Thread32First(snapshot, &mut entry);
            while next != 0 {
                if Some(entry.th32OwnerProcessID) == child.id() {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if thread.is_null() {
                        return Err(std::io::Error::last_os_error());
                    }
                    let result = ResumeThread(thread);
                    let error = std::io::Error::last_os_error();
                    CloseHandle(thread);
                    if result == u32::MAX {
                        return Err(error);
                    }
                    found = true;
                }
                next = Thread32Next(snapshot, &mut entry);
            }
            if !found {
                return Err(std::io::Error::other("suspended child thread not found"));
            }
            Ok(())
        })();
        CloseHandle(snapshot);
        resumed?;
        Ok(guard)
    }
}

async fn run_bounded(
    cmd: &mut tokio::process::Command,
    timeout_ms: u64,
) -> Result<std::process::Output, ToolFailure> {
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(
        windows_sys::Win32::System::Threading::CREATE_SUSPENDED
            | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
    );
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ToolFailure::Execution(format!("spawn failed: {e}")))?;
    #[cfg(unix)]
    let tree = ProcessTree(child.id().expect("spawned child id") as i32);
    #[cfg(windows)]
    let tree = process_tree(&child)
        .map_err(|e| ToolFailure::Execution(format!("process job failed: {e}")))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        tokio::try_join!(child.wait(), collect_pipe(stdout), collect_pipe(stderr))
    })
    .await;
    drop(tree);
    match result {
        Ok(Ok((status, stdout, stderr))) => Ok(std::process::Output {
            status,
            stdout,
            stderr,
        }),
        Ok(Err(e)) => {
            let _ = child.kill().await;
            Err(ToolFailure::Execution(format!("wait failed: {e}")))
        }
        Err(_) => {
            let _ = child.kill().await;
            Err(ToolFailure::Execution(format!(
                "command timed out after {timeout_ms}ms"
            )))
        }
    }
}

/// The WSLInterop binfmt_misc registration. Matches what WSL itself writes
/// (magic `MZ`, interpreter `/init`, preserve-argv0 + fix-binary flags).
/// Proven sufficient on WSL 2.7.x: with this entry present, login-shell
/// sessions bootstrap again and the MZ failure disappears.
#[cfg(any(windows, test))]
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
/// `wsl.exe` PE image as a script. Both real shapes name `wsl.exe` and put
/// `MZ` in the command-not-found slot — dash: `…/wsl.exe: 1: MZ: not
/// found`, bash: `…/wsl.exe: line 1: MZ: command not found`. A bare `MZ`
/// mention is NOT enough: a command that genuinely ran, exited 127, and
/// printed `MZ` must not trigger the retry (it would run twice).
#[cfg(any(windows, test))]
fn is_interop_enoexec(exit_code: Option<i32>, stderr: &str) -> bool {
    exit_code == Some(127)
        && stderr.contains("wsl.exe")
        && (stderr.contains("MZ: not found") || stderr.contains("MZ: command not found"))
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

/// Enforce the timeout inside the Linux namespace too: killing wsl.exe
/// alone does not reliably terminate its distro-side descendants.
#[cfg(windows)]
fn wsl_timed_shell_argv(distro: &str, inner: &str, command: &str, timeout_ms: u64) -> Vec<String> {
    let mut argv = wsl_shell_argv(distro, inner, command);
    argv.splice(
        6..6,
        [
            "timeout".into(),
            "--kill-after=1s".into(),
            format!("{}s", (timeout_ms as f64 / 1000.0).max(0.001)),
        ],
    );
    argv
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
                        ToolFailure::InvalidInput(format!("bad WSL workdir: {}", workdir.display()))
                    })?;
                    let cd = match &cwd {
                        Some(p) => workspace::to_inner(p).ok_or_else(|| {
                            ToolFailure::InvalidInput(format!("bad WSL cwd: {}", p.display()))
                        })?,
                        None => base,
                    };
                    let argv = wsl_timed_shell_argv(distro, &cd, &command, timeout_ms);
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
        let out = run_bounded(&mut cmd, timeout_ms).await?;

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
                    let argv = wsl_timed_shell_argv(distro, cd, &command, timeout_ms);
                    let retried = run_bounded(&mut wsl_child(&argv), timeout_ms).await?;
                    (retried, true)
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

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_output_drains_both_pipes_and_timeout_kills_descendants() {
        let mut noisy = tokio::process::Command::new("sh");
        noisy.args([
            "-c",
            "head -c 300000 /dev/zero; head -c 300000 /dev/zero >&2",
        ]);
        let out = run_bounded(&mut noisy, 5000).await.unwrap();
        assert!(out.stdout.len() <= MAX_PIPE_BYTES + 32);
        assert!(out.stderr.len() <= MAX_PIPE_BYTES + 32);
        assert!(out.stdout.ends_with(b"[output truncated]\n"));
        let marker = std::env::temp_dir().join(format!("guild-timeout-{}", uuid::Uuid::now_v7()));
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(format!(
            "(sleep 0.3; echo survived > '{}') & wait",
            marker.display()
        ));
        assert!(run_bounded(&mut cmd, 80).await.is_err());
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!marker.exists(), "descendant survived timeout");
    }

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
        // Not the interop signature: wrong exit code, no wsl.exe/MZ pairing,
        // a plain command-not-found, or a command that ran and merely
        // printed MZ in its own output.
        assert!(!is_interop_enoexec(Some(0), "MZ"));
        assert!(!is_interop_enoexec(Some(2), "MZ missing"));
        assert!(!is_interop_enoexec(
            Some(127),
            "bash: foo: command not found"
        ));
        assert!(!is_interop_enoexec(
            Some(127),
            "MZ file header checked — tool exited 127 on its own"
        ));
        assert!(!is_interop_enoexec(
            Some(127),
            "wsl.exe: 1: mkfs: not found\nMZ somewhere else"
        ));
    }

    #[test]
    fn wsl_heal_argv_shape() {
        let argv = wsl_heal_argv("archlinux");
        assert_eq!(
            &argv[..6],
            &["wsl.exe", "-d", "archlinux", "-u", "root", "--exec"]
        );
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
