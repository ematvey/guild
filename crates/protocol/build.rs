//! Build identity for the wire handshake: every binary in the workspace
//! embeds the same GUILD_BUILD_ID (git commit at build time), so a client
//! can tell whether a running daemon was spawned from the current build or
//! is a stale leftover of an older install.
//!
//! The build script reruns whenever the protocol or app-server sources
//! change — the two crates whose behavior the handshake cares about — so
//! daemon-side fixes always produce a new identity, while pure frontend
//! releases keep the daemon compatible and reuse it.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../app-server/src");
    println!("cargo:rerun-if-changed=../app-server/Cargo.toml");
    println!("cargo:rerun-if-changed=build.rs");
    let id = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            // no git (tarball build): fall back to the build moment so two
            // different builds still get different identities
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_else(|_| "unknown".into())
        });
    println!("cargo:rustc-env=GUILD_BUILD_ID={id}");
}
