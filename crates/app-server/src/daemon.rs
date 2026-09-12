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

/// One duplex connection to the daemon: (read half, write half, raw read
/// handle). The raw handle exists only on Windows: the GUI's reader thread
/// needs PeekNamedPipe there because a blocking read on a duplicated
/// synchronous pipe handle parks the file object's I/O lock and starves the
/// concurrent writer (the original first-rpc deadlock).
pub struct Pair(
    pub Box<dyn std::io::Read + Send>,
    pub Box<dyn std::io::Write + Send>,
    pub Option<isize>,
);

/// Line reader safe to run concurrently with a writer on the same pipe.
/// Windows path polls with PeekNamedPipe (never parks the file object lock)
/// and only consumes bytes already available; Unix path is a plain blocking
/// read_line (separate fds, no serialization).
#[cfg(unix)]
pub fn try_connect_at(path: &Path) -> anyhow::Result<Pair> {
    let s = std::os::unix::net::UnixStream::connect(path)
        .with_context(|| format!("connect {}", path.display()))?;
    Ok(Pair(Box::new(s.try_clone()?), Box::new(s), None))
}

#[cfg(windows)]
pub fn try_connect_at(path: &Path) -> anyhow::Result<Pair> {
    use std::fs::OpenOptions;
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("connect {}", path.display()))?;
    let rd = f.try_clone()?;
    // Peek must use the READ half's own handle: the inbound queue is what we
    // poll, and using the write half's handle left the client blind to
    // responses in situ (the daemon wrote them; the client never saw them).
    use std::os::windows::io::AsRawHandle;
    let raw = rd.as_raw_handle() as isize;
    Ok(Pair(Box::new(rd), Box::new(f), Some(raw)))
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

/// hello handshake over a fresh pair; a daemon speaking a different wire
/// protocol is told to shut down and the caller gets an Err (it respawns a
/// current daemon). The crate version is informational only — the tauri
/// client and the app-server version independently (GUI 0.3.x vs workspace
/// 0.2.0), so comparing crate versions here broke every attach after any
/// version bump. Reads byte-wise (no BufReader) so no bytes past the newline
/// are lost to a dropped buffer — other clients' events may follow
/// immediately.
pub fn handshake(pair: Pair) -> anyhow::Result<Pair> {
    handshake_with(pair, None)
}

/// Like `handshake`, but also verifies the daemon's build identity: a daemon
/// from a different build than the client's own binary is told to shut down
/// so the caller respawns a current one. This is what makes app upgrades
/// safe: a leftover background daemon of the previous install can never
/// serve the new client (its rpc/timeout fixes would be missing). `None`
/// skips the check (tests, CLI tools against foreign daemons).
pub fn handshake_with(pair: Pair, expected_build: Option<&str>) -> anyhow::Result<Pair> {
    use std::io::{BufReader, Read as _};
    let Pair(rd, mut wr, raw) = pair;
    let mut rd = BufReader::new(rd);
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
    let daemon_protocol = v["result"]["protocol"].as_u64().unwrap_or(0);
    if daemon_protocol != u64::from(protocol::rpc::PROTOCOL_VERSION) {
        let req = protocol::rpc::Request::new(1, "daemon.shutdown", serde_json::json!({}));
        let _ = writeln!(wr, "{}", serde_json::to_string(&req)?);
        anyhow::bail!(
            "daemon protocol {daemon_protocol} != {}",
            protocol::rpc::PROTOCOL_VERSION
        );
    }
    if let Some(expected) = expected_build {
        let daemon_build = v["result"]["build"].as_str().unwrap_or("");
        if daemon_build != expected {
            let req = protocol::rpc::Request::new(1, "daemon.shutdown", serde_json::json!({}));
            let _ = writeln!(wr, "{}", serde_json::to_string(&req)?);
            anyhow::bail!(
                "daemon build mismatch (running {daemon_build}, expected {expected}) — a \"Guild\" background service from an older install is still running and was asked to exit; reopen the app (or quit the old one in Task Manager / Activity Monitor) and pair again"
            );
        }
    }
    Ok(Pair(Box::new(rd), wr, raw))
}

/// Full blocking client flow: connect → (spawn detached + wait) → handshake.
/// Used by the GUI (via spawn_blocking) and the CLI verbs. Enforces the
/// build identity: a daemon from a different build is shut down and
/// replaced by one spawned from this binary.
pub fn attach(bin: &Path) -> anyhow::Result<Pair> {
    attach_with(bin, Some(protocol::rpc::BUILD_ID))
}

/// `attach` with an explicit build-expectation override (None = accept any
/// daemon speaking the current protocol — used by tests).
pub fn attach_with(bin: &Path, expected_build: Option<&str>) -> anyhow::Result<Pair> {
    for attempt in 0..2u8 {
        if let Ok(pair) = try_connect() {
            if let Ok(pair) = handshake_with(pair, expected_build) {
                return Ok(pair);
            }
            // stale version/build: daemon shutting down, respawn below
        }
        if attempt == 0 {
            spawn_detached(bin)?;
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Ok(pair) = try_connect() {
                    if let Ok(pair) = handshake_with(pair, expected_build) {
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
        crate::dtrace::dtrace("accept: waiting for client (listening instance ready)");
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow_and_update() {
                    crate::dtrace::dtrace("accept: shutdown signal, exiting");
                    return Ok(());
                }
            }
            connected = server.connect() => {
                connected.context("daemon pipe connect")?;
                crate::dtrace::dtrace("accept: client connected to instance");
                let client = server;
                match ServerOptions::new().create(&pipe_name) {
                    Ok(s) => {
                        crate::dtrace::dtrace("accept: next listening instance created");
                        server = s;
                    }
                    Err(e) => {
                        crate::dtrace::dtrace(&format!("accept: FAILED to create next instance: {e} (serving current client with no new listener)"));
                        return Err(e.into());
                    }
                }
                let shared = shared.clone();
                tokio::task::spawn_blocking(move || {
                    crate::dtrace::dtrace("conn: run_connection starting (spawn_blocking)");
                    let rt = tokio::runtime::Handle::current();
                    let (rd, wr) = tokio::io::split(client);
                    // SyncIoBridge bridges the async halves to the std
                    // Read/Write that run_connection's threads expect.
                    let rd = tokio_util::io::SyncIoBridge::new(rd);
                    let wr = tokio_util::io::SyncIoBridge::new(wr);
                    let _ = rt.block_on(run_connection(&shared, rd, wr));
                    crate::dtrace::dtrace("conn: run_connection returned");
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

/// Line reader that may run concurrently with a writer on the same pipe.
/// See [`Pair`] for why the Windows path peeks instead of blocking.
pub struct LineReader {
    inner: std::io::BufReader<Box<dyn std::io::Read + Send>>,
    /// Raw descriptor for the Windows PeekNamedPipe path; unused on Unix.
    #[cfg_attr(not(windows), allow(dead_code))]
    raw: Option<isize>,
}

impl LineReader {
    pub fn new(read: Box<dyn std::io::Read + Send>, raw: Option<isize>) -> Self {
        Self {
            inner: std::io::BufReader::new(read),
            raw,
        }
    }

    /// Reads one line into `out` (without the newline). Ok(false) = EOF.
    pub fn read_line(&mut self, out: &mut String) -> std::io::Result<bool> {
        #[cfg(windows)]
        if let Some(h) = self.raw {
            out.clear();
            loop {
                // Fast path: bytes already buffered by a previous peek.
                {
                    let buf = self.inner.buffer();
                    if !buf.is_empty() {
                        match buf.iter().position(|&b| b == b'\n') {
                            Some(pos) => {
                                out.push_str(&String::from_utf8_lossy(&buf[..pos]));
                                self.inner.consume(pos + 1);
                                return Ok(true);
                            }
                            None => {
                                out.push_str(&String::from_utf8_lossy(buf));
                                let n = buf.len();
                                self.inner.consume(n);
                            }
                        }
                    }
                }
                if peek_available(h)? == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    continue;
                }
                // Data is available, so fill_buf returns without blocking.
                let buf = self.inner.fill_buf()?;
                if buf.is_empty() {
                    return Ok(false); // EOF
                }
                let n = buf.len();
                out.push_str(&String::from_utf8_lossy(buf));
                self.inner.consume(n);
            }
        }
        use std::io::BufRead as _;
        let n = self.inner.read_line(out)?;
        Ok(n != 0)
    }
}

#[cfg(windows)]
fn peek_available(raw: isize) -> std::io::Result<u32> {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    let mut avail: u32 = 0;
    let ok = unsafe {
        PeekNamedPipe(
            raw as HANDLE,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut avail,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(avail)
}

/// Test/experiment seam: peek the inbound queue via a raw handle.
#[cfg(windows)]
pub fn peek_available_pub(raw: isize) -> u32 {
    peek_available(raw).unwrap_or(u32::MAX)
}
#[cfg(not(windows))]
pub fn peek_available_pub(_raw: isize) -> u32 {
    0
}

/// Windows-only: the pipe path as a string for tokio's async named-pipe
/// client (the GUI uses the tokio client; std handles deadlock under
/// concurrent read+write on this platform).
#[cfg(windows)]
pub fn client_pipe_path() -> anyhow::Result<String> {
    Ok(socket_path()?.to_string_lossy().into_owned())
}
