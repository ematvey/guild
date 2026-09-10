//! Local daemon (spec §3.3): one engine process per user, survives client
//! exit, the only route to the cloud server. Line-delimited JSON-RPC over a
//! per-user local socket. The GUI and CLI verbs attach as clients.
//!
//! Lifecycle: spawned on first client attach (detached), owns the session
//! and all agent runs, exits only on `daemon.shutdown` — which a
//! version-mismatched client invokes on attach.

use crate::jsonrpc_loop::{run_connection, Session, Shared};
use anyhow::Context as _;
use sha2::Digest as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};

#[cfg(unix)]
pub fn socket_path() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("GUILD_DAEMON_SOCKET") {
        return Ok(PathBuf::from(p));
    }
    let dir = match dirs::runtime_dir() {
        Some(d) => d.join("guild"),
        None => dirs::data_dir().context("no runtime or data dir")?.join("guild"),
    };
    Ok(dir.join("daemon.sock"))
}

/// Pure suffix for the Windows pipe name (testable on any host).
#[cfg_attr(not(windows), allow(dead_code))]
fn user_pipe_suffix(user: &str) -> String {
    sha2::Sha256::digest(user.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(windows)]
pub fn socket_path() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("GUILD_DAEMON_SOCKET") {
        return Ok(PathBuf::from(p));
    }
    let user = std::env::var("USERNAME").unwrap_or_default();
    Ok(PathBuf::from(format!(
        r"\\.\pipe\guild-daemon-{}",
        user_pipe_suffix(&user)
    )))
}

/// One duplex connection to the daemon: (read half, write half).
pub struct Pair(pub Box<dyn std::io::Read + Send>, pub Box<dyn std::io::Write + Send>);

#[cfg(unix)]
pub fn try_connect_at(path: &Path) -> anyhow::Result<Pair> {
    let s = std::os::unix::net::UnixStream::connect(path)
        .with_context(|| format!("connect {}", path.display()))?;
    Ok(Pair(Box::new(s.try_clone()?), Box::new(s)))
}

#[cfg(windows)]
pub fn try_connect_at(path: &Path) -> anyhow::Result<Pair> {
    use std::fs::OpenOptions;
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("connect {}", path.display()))?;
    Ok(Pair(Box::new(f.try_clone()?), Box::new(f)))
}

pub fn try_connect() -> anyhow::Result<Pair> {
    try_connect_at(&socket_path()?)
}

/// Spawn `bin daemon` fully detached: own process group, no inherited stdio,
/// so it survives the parent's exit.
pub fn spawn_detached(bin: &Path) -> anyhow::Result<()> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(bin);
    cmd.arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().context("spawn daemon")?;
    Ok(())
}

/// hello handshake over a fresh pair; a daemon of a different build version
/// is told to shut down and the caller gets an Err (it respawns a current
/// daemon). Reads byte-wise (no BufReader) so no bytes past the newline are
/// lost to a dropped buffer — other clients' events may follow immediately.
pub fn handshake(pair: Pair) -> anyhow::Result<Pair> {
    use std::io::Read as _;
    let Pair(mut rd, mut wr) = pair;
    let req = protocol::rpc::Request::new(0, "daemon.hello", serde_json::json!({}));
    writeln!(wr, "{}", serde_json::to_string(&req)?)?;
    wr.flush()?;
    let mut line = Vec::new();
    for b in rd.by_ref().bytes() {
        let b = b?;
        if b == b'\n' {
            break;
        }
        line.push(b);
    }
    let v: serde_json::Value = serde_json::from_slice(&line)?;
    let daemon_version = v["result"]["version"].as_str().unwrap_or("");
    if daemon_version != env!("CARGO_PKG_VERSION") {
        let req = protocol::rpc::Request::new(1, "daemon.shutdown", serde_json::json!({}));
        let _ = writeln!(wr, "{}", serde_json::to_string(&req)?);
        anyhow::bail!(
            "daemon version {daemon_version} != {}",
            env!("CARGO_PKG_VERSION")
        );
    }
    Ok(Pair(rd, wr))
}

/// Full blocking client flow: connect → (spawn detached + wait) → handshake.
/// Used by the GUI (via spawn_blocking) and the CLI verbs.
pub fn attach(bin: &Path) -> anyhow::Result<Pair> {
    for attempt in 0..2u8 {
        if let Ok(pair) = try_connect() {
            if let Ok(pair) = handshake(pair) {
                return Ok(pair);
            }
            // stale version: daemon shutting down, respawn below
        }
        if attempt == 0 {
            spawn_detached(bin)?;
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Ok(pair) = try_connect() {
                    if let Ok(pair) = handshake(pair) {
                        return Ok(pair);
                    }
                }
            }
        }
    }
    anyhow::bail!("daemon did not start")
}

/// Daemon main: binds `socket_path()`, restores the persisted session, and
/// accepts until `daemon.shutdown`.
pub async fn run_daemon() -> anyhow::Result<()> {
    run_daemon_on(socket_path()?, crate::jsonrpc_loop::restored_session().await?).await
}

/// Daemon accept loop over an explicit endpoint (test seam). If another
/// daemon already owns the endpoint, returns Ok immediately (single
/// instance). Runs until `daemon.shutdown` flips the watch.
pub async fn run_daemon_on(path: PathBuf, session: Session) -> anyhow::Result<()> {
    if try_connect_at(&path).is_ok() {
        return Ok(()); // another daemon owns the endpoint
    }

    let shared = Shared::new(session);
    let shutdown_rx = shared.shutdown.subscribe();

    // Reap finished agent runs so the JoinSet doesn't grow unbounded.
    {
        let agents = shared.agents.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                let mut guard = agents.lock().await;
                while guard.try_join_next().is_some() {}
            }
        });
    }

    #[cfg(unix)]
    return unix_accept_loop(&path, shared, shutdown_rx).await;
    #[cfg(windows)]
    return windows_accept_loop(&path, shared, shutdown_rx).await;
}

#[cfg(unix)]
async fn unix_accept_loop(
    path: &Path,
    shared: Shared,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    // stale socket from a killed daemon
    let _ = std::fs::remove_file(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    let listener = tokio::net::UnixListener::bind(path).context("bind daemon socket")?;
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow_and_update() {
                    let _ = std::fs::remove_file(path);
                    return Ok(());
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("daemon accept")?;
                let shared = shared.clone();
                tokio::task::spawn_blocking(move || {
                    let rt = tokio::runtime::Handle::current();
                    let std_stream = match stream.into_std() {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    // into_std does NOT clear O_NONBLOCK; a blocking read on a
                    // nonblocking fd returns EAGAIN whenever no data is
                    // buffered, which lines() would treat as EOF.
                    if std_stream.set_nonblocking(false).is_err() {
                        return;
                    }
                    let dup = std_stream.try_clone().expect("dup socket");
                    let _ = rt.block_on(run_connection(&shared, dup, std_stream));
                });
            }
        }
    }
}

#[cfg(windows)]
async fn windows_accept_loop(
    path: &Path,
    shared: Shared,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // Named pipes need one pre-created server instance per pending client:
    // create instance N, await its connect, create instance N+1, serve N.
    let pipe_name = path.to_string_lossy().into_owned();
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)?;
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow_and_update() {
                    return Ok(());
                }
            }
            connected = server.connect() => {
                connected.context("daemon pipe connect")?;
                let client = server;
                server = ServerOptions::new().create(&pipe_name)?; // next client
                let shared = shared.clone();
                tokio::task::spawn_blocking(move || {
                    let rt = tokio::runtime::Handle::current();
                    let (rd, wr) = tokio::io::split(client);
                    // SyncIoBridge bridges the async halves to the std
                    // Read/Write that run_connection's threads expect.
                    let rd = tokio_util::io::SyncIoBridge::new(rd);
                    let wr = tokio_util::io::SyncIoBridge::new(wr);
                    let _ = rt.block_on(run_connection(&shared, rd, wr));
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::user_pipe_suffix;

    #[test]
    fn pipe_suffix_is_stable_hex() {
        let s = user_pipe_suffix("maintainer");
        assert_eq!(s.len(), 16);
        assert_eq!(s, user_pipe_suffix("maintainer"));
    }
}
