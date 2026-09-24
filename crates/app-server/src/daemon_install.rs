//! Linux: manage the per-user daemon as a systemd **user unit** —
//! `guild daemon install` / `status` / `uninstall`. The GUI hosts its
//! daemon in-process and defers to the unit while it is active (its socket
//! host parks; it reclaims when the unit stops); a headless Linux host gets
//! supervised boot persistence (`Restart=always`, starts at login) without
//! a package. Install retires any running daemon host — GUI or unsupervised
//! — and verifies the socket released before `enable --now`. Idempotent:
//! reinstalling rewrites the unit and restarts the service under the
//! current binary.

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
    unit_bin_with(std::env::var_os("HOME").map(PathBuf::from).as_deref(), &exe)
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

/// Test seam for [`unit_active`]: -1 = probe systemctl, 0/1 = forced answer
/// (CI hosts have no systemd user session).
static UNIT_ACTIVE_OVERRIDE: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// Forces [`unit_active`]'s answer (tests); `None` restores the probe.
pub fn set_unit_active_override(active: Option<bool>) {
    use std::sync::atomic::Ordering;
    UNIT_ACTIVE_OVERRIDE.store(active.map(i8::from).unwrap_or(-1), Ordering::SeqCst);
}

/// Whether the unit daemon owns (or is about to own) the daemon socket and
/// the machine link: `active`/`activating` both count — a unit that is
/// starting is about to bind, and rebinding under it would make its daemon
/// exit-and-restart against this process forever. Everything else (inactive,
/// failed, no systemd on the host) means the socket is up for grabs.
pub fn unit_active() -> bool {
    use std::sync::atomic::Ordering;
    match UNIT_ACTIVE_OVERRIDE.load(Ordering::SeqCst) {
        0 => return false,
        1 => return true,
        _ => {}
    }
    if std::env::consts::OS != "linux" {
        return false;
    }
    let state = match Command::new("systemctl")
        .arg("--user")
        .arg("is-active")
        .arg(UNIT_NAME)
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return false,
    };
    matches!(state.as_str(), "active" | "activating" | "reloading")
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

/// Confirms the socket's current owner speaks the daemon wire protocol —
/// the hello handshake is the identity check. A foreign process squatting
/// the endpoint is not retired.
fn verify_guild_daemon() -> anyhow::Result<()> {
    // Bounded handshake: a silent socket owner (hung daemon, squatter) must
    // fail fast instead of hanging install forever.
    crate::daemon::handshake_timed(std::time::Duration::from_secs(10))
}

/// Installs (or upgrades) the unit and brings the daemon up under it.
pub fn install(linger: bool) -> anyhow::Result<()> {
    ensure_linux()?;
    let bin = unit_bin()?;
    let unit_path = systemd_user_dir()?.join(UNIT_NAME);
    std::fs::create_dir_all(unit_path.parent().context("unit dir")?)?;
    std::fs::write(&unit_path, unit_contents(&bin))?;
    systemctl(&["daemon-reload"])?;
    if unit_active() {
        systemctl(&["restart", UNIT_NAME])?;
        println!(
            "restarted {UNIT_NAME} under the rewritten unit (ExecStart {})",
            bin.display()
        );
    } else {
        // A GUI app (in-process host) or an unsupervised hand-launched
        // daemon may own the socket: the handshake verifies the owner is a
        // Guild daemon, then daemon.shutdown retires its socket host. The
        // GUI's host task defers to the unit from now on (it parks and
        // reclaims when the unit stops); auth stays propagated either way —
        // the daemon watches token.json, so a fresh pair or sign-out in the
        // GUI reaches the link whoever owns it.
        if crate::daemon::try_connect().is_ok() {
            verify_guild_daemon()?;
            if crate::daemon::shutdown_running() {
                println!(
                    "retired the running daemon (its host defers to {UNIT_NAME} while the unit is active)"
                );
            }
        }
        // Require the socket to actually stop accepting before enable --now
        // — a hung daemon would otherwise leave the unit's daemon unable to
        // bind (it exits cleanly on a taken endpoint) with nothing running
        // while install reports success.
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
            Ok(o) if o.status.success() => {
                println!("linger enabled (daemon runs without an active login session)")
            }
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
        let path = std::env::temp_dir().join(format!("guild-dinst-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("GUILD_DAEMON_SOCKET", &path);
        // Nothing listens: the socket is free immediately.
        assert!(poll_socket_state(
            false,
            2,
            std::time::Duration::from_millis(10)
        ));
        assert!(!poll_socket_state(
            true,
            2,
            std::time::Duration::from_millis(10)
        ));
        // A live listener keeps accepting through the whole poll window.
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        assert!(!poll_socket_state(
            false,
            2,
            std::time::Duration::from_millis(10)
        ));
        assert!(poll_socket_state(
            true,
            2,
            std::time::Duration::from_millis(10)
        ));
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

    /// The unit-active probe's test seam: a forced answer short-circuits
    /// the systemctl call (CI hosts have no systemd user session).
    #[test]
    fn unit_active_override_short_circuits_the_probe() {
        set_unit_active_override(Some(true));
        assert!(unit_active());
        set_unit_active_override(Some(false));
        assert!(!unit_active());
        set_unit_active_override(None);
        // Back to probing: on this host (likely no systemd user session, or
        // no unit installed) the answer is well-defined but not asserted —
        // the override is what tests pin.
        let _ = unit_active();
    }

    /// Install's precondition: the socket owner must be a Guild daemon —
    /// the hello handshake is the identity check; a silent squatter is
    /// refused (and not retired).
    #[cfg(unix)]
    #[test]
    fn verify_guild_daemon_accepts_a_handshaking_owner_and_refuses_a_silent_one() {
        use std::io::{BufRead, BufReader, Write};
        let dir = std::env::temp_dir().join(format!("guild-dinst-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("verify.sock");
        let _guard = SOCKET_LOCK.lock().unwrap();
        std::env::set_var("GUILD_DAEMON_SOCKET", &path);

        let server = |listener: std::os::unix::net::UnixListener, speak_hello: bool| {
            std::thread::spawn(move || {
                let (conn, _) = listener.accept().unwrap();
                let mut rd = BufReader::new(conn.try_clone().unwrap());
                let mut w = conn;
                let mut line = String::new();
                rd.read_line(&mut line).unwrap();
                if speak_hello {
                    let resp = protocol::rpc::Response::ok(
                        0,
                        serde_json::json!({
                            "protocol": protocol::rpc::PROTOCOL_VERSION,
                            "version": "t",
                            "build": "t"
                        }),
                    );
                    writeln!(w, "{}", serde_json::to_string(&resp).unwrap()).unwrap();
                }
                // hold the connection open until the client gives up reading
                std::thread::sleep(std::time::Duration::from_millis(300));
            })
        };

        // A daemon speaking the current protocol verifies.
        let l1 = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let h = server(l1, true);
        assert!(verify_guild_daemon().is_ok());
        h.join().unwrap();

        // A silent squatter (never answers hello) does not.
        let _ = std::fs::remove_file(&path); // the closed listener leaves the socket file
        let l2 = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let h = server(l2, false);
        assert!(verify_guild_daemon().is_err());
        h.join().unwrap();

        let _ = std::fs::remove_file(&path);
        std::env::remove_var("GUILD_DAEMON_SOCKET");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A socket owner that accepts but never answers AND never closes must
    /// not hang the handshake: the bounded wait returns an error, which is
    /// what makes install's "hung process?" escape reachable.
    #[cfg(unix)]
    #[test]
    fn a_silent_socket_owner_cannot_hang_the_handshake_forever() {
        let dir = std::env::temp_dir().join(format!("guild-dinst-silent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("silent.sock");
        let _guard = SOCKET_LOCK.lock().unwrap();
        std::env::set_var("GUILD_DAEMON_SOCKET", &path);
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let h = std::thread::spawn(move || {
            let (conn, _) = l.accept().unwrap();
            // hold the connection open, never answer, never close
            std::thread::sleep(std::time::Duration::from_millis(3_000));
            drop(conn);
        });
        let started = std::time::Instant::now();
        let res = crate::daemon::handshake_timed(std::time::Duration::from_millis(500));
        assert!(res.is_err(), "a silent owner must fail the handshake");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "the bounded wait must not block on the (still silent) peer"
        );
        h.join().unwrap();
        std::env::remove_var("GUILD_DAEMON_SOCKET");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
