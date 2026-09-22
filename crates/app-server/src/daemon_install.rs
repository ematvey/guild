//! Linux: manage the per-user daemon as a systemd **user unit** —
//! `guild daemon install` / `status` / `uninstall`. The GUI hosts its
//! daemon in-process (gone when the app exits); a headless Linux host gets
//! supervised boot persistence (`Restart=always`, starts at login) without
//! a package. Install refuses while a daemon is reachable — see the
//! single-process note in [`install`]. Idempotent: reinstalling rewrites
//! the unit and restarts the service under the current binary.

use anyhow::Context as _;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const UNIT_NAME: &str = "guild-daemon.service";

fn systemd_user_dir() -> anyhow::Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("no config dir")?
        .join("systemd/user"))
}

/// The binary the unit should run: prefer the stable launcher symlink
/// (`~/.local/bin/<exe name>`) when it resolves to this exact binary —
/// symlink-repoint upgrades then follow without reinstalling the unit.
/// Otherwise pin this binary's canonical path.
fn unit_bin_with(home: Option<&Path>, exe: &Path) -> anyhow::Result<PathBuf> {
    let real = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    if let Some(home) = home {
        let name = real.file_name().context("exe has no file name")?;
        let launcher = home.join(".local/bin").join(name);
        if std::fs::canonicalize(&launcher).is_ok_and(|p| p == real) {
            return Ok(launcher);
        }
    }
    Ok(real)
}

fn unit_bin() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe().context("no current exe")?;
    unit_bin_with(
        std::env::var_os("HOME").map(PathBuf::from).as_deref(),
        &exe,
    )
}

/// The unit file body. The ExecStart path is double-quoted so paths with
/// spaces parse, and `%` is escaped as `%%` so systemd's specifier
/// expansion leaves the path intact; `daemon` is the run mode of the same
/// binary. Restart=always with a 5 s pause: a clean shutdown (a
/// stale-build client telling the daemon to exit) must not leave the
/// executor down — the unit re-spawns whatever binary the ExecStart now
/// resolves to, and a symlink-repoint upgrade converges on the next
/// restart.
pub fn unit_contents(bin: &Path) -> String {
    format!(
        "[Unit]\n\
         Description=Guild per-user daemon (shared engine, machine link)\n\
         \n\
         [Service]\n\
         ExecStart=\"{}\" daemon\n\
         Restart=always\n\
         RestartSec=5s\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        bin.display().to_string().replace('%', "%%"),
    )
}

fn systemctl(args: &[&str]) -> anyhow::Result<String> {
    let out = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .context("systemctl --user failed (no systemd user session on this host?)")?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        anyhow::bail!(
            "systemctl --user {} failed: {}",
            args.join(" "),
            text.trim()
        );
    }
    Ok(text.trim().to_string())
}

/// Success-valued systemctl probe (is-active/is-enabled return nonzero for
/// "no" — a failure, not an error).
fn systemctl_ok(args: &[&str]) -> bool {
    Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ensure_linux() -> anyhow::Result<()> {
    if std::env::consts::OS != "linux" {
        anyhow::bail!(
            "daemon install is Linux-only (systemd user units); on this \
             platform the GUI hosts the daemon in-process and there is no \
             unit to install"
        );
    }
    Ok(())
}

/// Polls the daemon socket until it reaches `want_reachable` (or the poll
/// budget ends). "Free" is `try_connect().is_err()`: a retired daemon's
/// accept loop removes the socket file, so a failed connect is the release
/// signal.
fn poll_socket_state(want_reachable: bool, polls: u32, delay: std::time::Duration) -> bool {
    for _ in 0..polls {
        if crate::daemon::try_connect().is_ok() == want_reachable {
            return true;
        }
        std::thread::sleep(delay);
    }
    crate::daemon::try_connect().is_ok() == want_reachable
}

/// Installs (or upgrades) the unit and brings the daemon up under it.
pub fn install(linger: bool) -> anyhow::Result<()> {
    ensure_linux()?;
    // The GUI hosts the daemon in-process (single-process model): with a
    // unit daemon owning the socket, a fresh pair from the webview would
    // publish the link config on the GUI's in-process watch channel only —
    // the unit daemon never learns of it and pairing silently stops
    // registering the machine. Refuse while a daemon is reachable; install
    // stays headless-only until auth RPCs route to the owning daemon (see
    // PLAN.md).
    if crate::daemon::try_connect().is_ok() {
        anyhow::bail!(
            "a Guild app is already running and hosts the daemon in-process; \
             quit it (close the window or `pkill -x Guild`), then rerun \
             `Guild daemon install`. Installing while a GUI is running would \
             break pair → machine-link propagation; install is headless-only \
             for now"
        );
    }
    let bin = unit_bin()?;
    let unit_path = systemd_user_dir()?.join(UNIT_NAME);
    std::fs::create_dir_all(unit_path.parent().context("unit dir")?)?;
    std::fs::write(&unit_path, unit_contents(&bin))?;
    systemctl(&["daemon-reload"])?;
    if systemctl_ok(&["is-active", UNIT_NAME]) {
        systemctl(&["restart", UNIT_NAME])?;
        println!(
            "restarted {UNIT_NAME} under the rewritten unit (ExecStart {})",
            bin.display()
        );
    } else {
        // An unsupervised (hand-launched) daemon may have taken the socket in
        // a race with the check above; retire it, and require the socket to
        // actually stop accepting before enable --now — a hung daemon would
        // otherwise leave the unit's daemon unable to bind (it exits cleanly
        // on a taken endpoint) with nothing running while install reports
        // success.
        if crate::daemon::shutdown_running() {
            println!("retired the unsupervised daemon");
        }
        if !poll_socket_state(false, 20, std::time::Duration::from_millis(100)) {
            crate::daemon::shutdown_running();
            if !poll_socket_state(false, 20, std::time::Duration::from_millis(100)) {
                anyhow::bail!(
                    "a daemon still owns the socket after the retire request \
                     (hung process?) — not enabling {UNIT_NAME}; kill it and \
                     rerun install"
                );
            }
        }
        systemctl(&["enable", "--now", UNIT_NAME])?;
        // The daemon must actually be up: systemd reports success even when
        // the started process exits immediately.
        if !poll_socket_state(true, 50, std::time::Duration::from_millis(100)) {
            anyhow::bail!(
                "{UNIT_NAME} is enabled but the daemon did not become \
                 reachable within 5 s — check `journalctl --user -u {UNIT_NAME}`"
            );
        }
        println!(
            "installed {UNIT_NAME} (ExecStart \"{}\" daemon, enabled at login, Restart=always)",
            bin.display()
        );
    }
    if linger {
        match Command::new("loginctl").arg("enable-linger").output() {
            Ok(o) if o.status.success() => println!("linger enabled (daemon runs without an active login session)"),
            other => {
                let detail = match other {
                    Ok(o) => String::from_utf8_lossy(&o.stderr).trim().to_string(),
                    Err(e) => e.to_string(),
                };
                let detail = if detail.is_empty() {
                    "no error output".to_string()
                } else {
                    detail
                };
                println!(
                    "note: loginctl enable-linger did not succeed: {detail} — the daemon starts at login only"
                );
            }
        }
    }
    Ok(())
}

/// Stops and removes the unit.
pub fn uninstall() -> anyhow::Result<()> {
    ensure_linux()?;
    let _ = systemctl(&["disable", "--now", UNIT_NAME]);
    let unit_path = systemd_user_dir()?.join(UNIT_NAME);
    let removed = std::fs::remove_file(&unit_path).is_ok();
    let _ = systemctl(&["daemon-reload"]);
    if crate::daemon::shutdown_running() {
        println!("stopped the running daemon");
    }
    println!("uninstalled {UNIT_NAME} (unit file removed: {removed})");
    Ok(())
}

/// Prints the install state: unit path, active/enabled flags, ExecStart.
pub fn status() -> anyhow::Result<()> {
    let unit_path = systemd_user_dir()?.join(UNIT_NAME);
    println!("unit: {}", unit_path.display());
    println!("unit file present: {}", unit_path.exists());
    if std::env::consts::OS == "linux" {
        println!(
            "active: {}  enabled: {}",
            systemctl_ok(&["is-active", UNIT_NAME]),
            systemctl_ok(&["is-enabled", UNIT_NAME])
        );
    }
    if let Ok(body) = std::fs::read_to_string(&unit_path) {
        for line in body.lines() {
            if let Some(exec) = line.strip_prefix("ExecStart=") {
                println!("ExecStart: {exec}");
            }
        }
    }
    println!("daemon reachable: {}", crate::daemon::try_connect().is_ok());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_contents_has_restart_and_quoted_execstart() {
        let body = unit_contents(Path::new("/opt/guild dir/guild"));
        assert!(body.contains("ExecStart=\"/opt/guild dir/guild\" daemon"));
        assert!(body.contains("Restart=always"));
        assert!(body.contains("RestartSec=5s"));
        assert!(body.contains("WantedBy=default.target"));
        assert!(body.starts_with("[Unit]"));
    }

    #[test]
    fn unit_contents_escapes_percent_in_the_execstart_path() {
        let body = unit_contents(Path::new("/opt/gu%ld/guild"));
        assert!(body.contains("ExecStart=\"/opt/gu%%ld/guild\" daemon"));
        // Exactly one escaped pair: no unescaped % specifier remains.
        assert_eq!(body.matches('%').count(), 2);
    }

    /// Serializes env mutation (GUILD_DAEMON_SOCKET) across the tests in
    /// this binary, which run as parallel threads.
    #[cfg(unix)]
    static SOCKET_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Retirement is verified before enable --now: the socket must actually
    /// stop accepting, and the installed daemon must actually come up.
    #[cfg(unix)]
    #[test]
    fn poll_socket_state_tracks_the_live_daemon_socket() {
        let _guard = SOCKET_LOCK.lock().unwrap();
        let path =
            std::env::temp_dir().join(format!("guild-dinst-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("GUILD_DAEMON_SOCKET", &path);
        // Nothing listens: the socket is free immediately.
        assert!(poll_socket_state(false, 2, std::time::Duration::from_millis(10)));
        assert!(!poll_socket_state(true, 2, std::time::Duration::from_millis(10)));
        // A live listener keeps accepting through the whole poll window.
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        assert!(!poll_socket_state(false, 2, std::time::Duration::from_millis(10)));
        assert!(poll_socket_state(true, 2, std::time::Duration::from_millis(10)));
        drop(listener);
        let _ = std::fs::remove_file(&path);
        std::env::remove_var("GUILD_DAEMON_SOCKET");
    }

    #[cfg(unix)]
    #[test]
    fn unit_bin_prefers_launcher_symlink_resolving_to_the_same_binary() {
        let tmp = std::env::temp_dir().join(format!("guild-dinst-{}", std::process::id()));
        let real = tmp.join("opt/usr/bin/guild");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, b"binary").unwrap();
        let launcher = tmp.join("home/.local/bin/guild");
        std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &launcher).unwrap();
        // Same binary via the launcher: prefer the launcher path.
        let picked = unit_bin_with(Some(&tmp.join("home")), &real).unwrap();
        assert_eq!(picked, launcher);
        // No launcher for a different binary: pin its real path.
        let other = tmp.join("opt/other-guild");
        std::fs::write(&other, b"binary").unwrap();
        let picked = unit_bin_with(Some(&tmp.join("home")), &other).unwrap();
        assert_eq!(picked, other);
        // No home: pin the real path.
        let picked = unit_bin_with(None, &real).unwrap();
        assert_eq!(picked, real);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
