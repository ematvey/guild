//! Linux: manage the per-user daemon as a systemd **user unit** —
//! `guild daemon install` / `status` / `uninstall`. Other hosts spawn the
//! daemon from the GUI (unsupervised, gone at reboot); Linux hosts get
//! supervised boot persistence (`Restart=on-failure`, starts at login)
//! without a package. Idempotent: reinstalling rewrites the unit and
//! restarts the service under the current binary.

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
/// spaces parse; `daemon` is the run mode of the same binary.
pub fn unit_contents(bin: &Path) -> String {
    format!(
        "[Unit]\n\
         Description=Guild per-user daemon (shared engine, machine link)\n\
         \n\
         [Service]\n\
         ExecStart=\"{}\" daemon\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        bin.display()
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
             platform the GUI spawns and supervises the daemon itself"
        );
    }
    Ok(())
}

/// Installs (or upgrades) the unit and brings the daemon up under it.
pub fn install(linger: bool) -> anyhow::Result<()> {
    ensure_linux()?;
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
        // An unsupervised (GUI-spawned or hand-launched) daemon may own the
        // socket; retire it so the unit's daemon can bind.
        if crate::daemon::shutdown_running() {
            println!("retired the unsupervised daemon");
        }
        systemctl(&["enable", "--now", UNIT_NAME])?;
        println!(
            "installed {UNIT_NAME} (ExecStart \"{}\" daemon, enabled at login, Restart=on-failure)",
            bin.display()
        );
    }
    if linger {
        match Command::new("loginctl").arg("enable-linger").output() {
            Ok(o) if o.status.success() => println!("linger enabled (daemon runs without an active login session)"),
            other => println!(
                "note: loginctl enable-linger did not succeed ({:?}) — the daemon starts at login only",
                other.map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
            ),
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
        assert!(body.contains("Restart=on-failure"));
        assert!(body.contains("WantedBy=default.target"));
        assert!(body.starts_with("[Unit]"));
    }

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
