//! Local daemon (spec §3.3): one engine process per user, survives client
//! exit, the only route to the cloud server. Line-delimited JSON-RPC over a
//! per-user local socket. The GUI and CLI verbs attach as clients.
//!
//! Lifecycle: spawned on first client attach (detached), owns the session
//! and all agent runs, exits only on `daemon.shutdown` — which a
//! version-mismatched client invokes on attach.

use crate::jsonrpc_loop::{run_connection, Shared};
use anyhow::Context as _;
use sha2::Digest as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Test-only override for the daemon socket path.
// coherence:seam owner=@maintainer until=2027-01-31 reason="test hook redirects the daemon socket"
fn socket_override() -> Option<PathBuf> {
    std::env::var("GUILD_DAEMON_SOCKET").ok().map(PathBuf::from)
}

#[cfg(unix)]
pub fn socket_path() -> anyhow::Result<PathBuf> {
    if let Some(p) = socket_override() {
        return Ok(p);
    }
    let dir = match dirs::runtime_dir() {
        Some(d) => d.join("guild"),
        None => dirs::data_dir()
            .context("no runtime or data dir")?
            .join("guild"),
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
    if let Some(p) = socket_override() {
        return Ok(p);
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

/// Connect + handshake with a bounded wait for the hello response (unix).
/// The socket's owner may be a hung or silent process: a plain blocking
/// read never returns, and install's "hung process?" escape below it is
/// then unreachable. The timeout applies only to the handshake — it is
/// cleared again on the shared socket before the pair is returned, so a
/// long-lived reader never sees it.
#[cfg(unix)]
pub fn handshake_timed(timeout: std::time::Duration) -> anyhow::Result<()> {
    use std::os::unix::net::UnixStream;
    let path = socket_path()?;
    let s = UnixStream::connect(&path).with_context(|| format!("connect {}", path.display()))?;
    s.set_read_timeout(Some(timeout))
        .context("set handshake read timeout")?;
    // SO_RCVTIMEO is per-socket: every try_clone shares it, so this control
    // handle clears the timeout for whoever keeps the connection alive.
    let ctrl = s.try_clone()?;
    let pair = Pair(Box::new(s.try_clone()?), Box::new(s), None);
    let res = handshake_with(pair, None);
    let _ = ctrl.set_read_timeout(None);
    res.map(|_| ())
}

/// Connect + handshake with a bounded wait for the hello response
/// (Windows). A named pipe has no read timeout, so the handshake runs on a
/// worker thread and the caller stops waiting at `timeout`; a silent owner
/// leaves only that parked thread behind.
#[cfg(windows)]
pub fn handshake_timed(timeout: std::time::Duration) -> anyhow::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(try_connect().and_then(|pair| handshake_with(pair, None).map(|_| ())));
    });
    rx.recv_timeout(timeout)
        .map_err(|_| anyhow::anyhow!("daemon handshake timed out after {timeout:?}"))?
}

/// Asks a running daemon (any build) to exit via `daemon.shutdown`.
/// Returns true when a daemon was reachable and the request went out.
/// Used by daemon install (Linux) to retire an unsupervised daemon before
/// the systemd unit takes the socket.
pub fn shutdown_running() -> bool {
    use std::io::Write as _;
    let Ok(pair) = try_connect() else {
        return false;
    };
    let Pair(_, mut wr, _) = pair;
    let req = protocol::rpc::Request::new(1, "daemon.shutdown", serde_json::json!({}));
    if writeln!(wr, "{}", serde_json::to_string(&req).unwrap_or_default()).is_err() {
        return false;
    }
    let _ = wr.flush();
    drop(wr);
    // Poll for the socket to release instead of draining the connection —
    // a hung daemon must not hang the caller. The accept loop removes the
    // socket file on shutdown, so a fresh bind is never blocked.
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if try_connect().is_err() {
            break;
        }
    }
    true
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
    use std::io::{BufRead as _, BufReader};
    let Pair(rd, mut wr, raw) = pair;
    let mut rd = BufReader::new(rd);
    let req = protocol::rpc::Request::new(0, "daemon.hello", serde_json::json!({}));
    writeln!(wr, "{}", serde_json::to_string(&req)?)?;
    wr.flush()?;
    // The daemon broadcasts events to every connection, so during a live
    // stream the first frames on this fresh pair are events, not our hello
    // response — skip every frame until the id-0 response arrives.
    let hello;
    loop {
        let mut line = String::new();
        let n = rd.read_line(&mut line)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before the hello response");
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if v.get("event").is_some() || v.get("method").is_some() {
            continue;
        }
        if v.get("id").and_then(|i| i.as_u64()) == Some(0) {
            hello = Some(v);
            break;
        }
    }
    let v = hello.expect("hello response read above");
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
    // No spawn fallback: the single-process app hosts the socket itself; a
    // CLI verb without a running app fails instead of forking a headless
    // engine (docs/specs/2026-09-13-single-process-desktop.md). `bin` is
    // kept in the signature for callers that still pass it.
    let _ = bin;
    for _ in 0..10u8 {
        if let Ok(pair) = try_connect() {
            if let Ok(pair) = handshake_with(pair, expected_build) {
                return Ok(pair);
            }
            // stale version/build: the daemon was told to shut down; the app
            // hosting a current socket comes back shortly.
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    anyhow::bail!("Guild app is not running — start it first")
}

/// Daemon main: binds `socket_path()`, restores the persisted session, and
/// accepts until `daemon.shutdown`.
pub async fn run_daemon() -> anyhow::Result<()> {
    run_daemon_shared(
        socket_path()?,
        Shared::new(crate::jsonrpc_loop::restored_session().await?),
    )
    .await
}

/// Daemon accept loop over an explicit endpoint and a caller-built Shared.
/// The GUI hosts this with the SAME Shared its webview engine dispatches on:
/// login/pair/identify arrive on the webview surface and must reach the
/// machine link's watch channel in the same process — a second Shared here
/// would park the link until the next app start (the boot-time seed).
/// If another daemon already owns the endpoint, returns Ok immediately
/// (single instance — that owner runs the machine link). Runs until
/// `daemon.shutdown` flips the watch.
pub async fn run_daemon_shared(path: PathBuf, shared: Shared) -> anyhow::Result<()> {
    if try_connect_at(&path).is_ok() {
        return Ok(()); // another daemon owns the endpoint (and the link)
    }
    spawn_machine_link(&shared);
    // Every entry point owns a reaper for its host lifetime: without it,
    // completed agent runs accumulate in Shared.agents until shutdown.
    // host_shared_socket itself stays reaper-free — the reclaiming entry
    // manages a fresh reaper per host cycle instead.
    let reaper = spawn_reaper(&shared);
    let result = host_shared_socket(path, shared).await;
    reaper.abort();
    result
}

/// Poll cadence for the reclaim/park loops below.
const RECLAIM_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// How long a retired socket host holds off before attempting a reclaim:
/// `daemon install` runs retire → poll-free → `enable --now` within about
/// 3 s, and the grace keeps the GUI from winning the bind race against the
/// unit it just deferred to (the unit's daemon would otherwise exit-and-
/// restart against the GUI host forever).
const RECLAIM_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// The GUI's socket host, for the whole process lifetime: it owns the CLI
/// socket and the machine link exactly while it hosts. Cycle:
///
/// 1. `guild-daemon.service` active/activating → park (no bind, no link —
///    the unit owns the executor); a unit stop (uninstall, daemon death)
///    ends the park.
/// 2. Another daemon owns the socket → park until it releases it.
/// 3. Bind, spawn the machine link, and host until `daemon.shutdown`
///    retires the host (install, or a stale-build client) — the link is
///    torn down with it. Then a short grace against the installer's
///    retire→enable window, and the cycle repeats.
///
/// The shared shutdown flag latches on retirement; the engine lives on in
/// this process (the webview keeps dispatching), so each new host cycle
/// relatches it to false before hosting again.
pub async fn run_daemon_shared_reclaiming(path: PathBuf, shared: Shared) -> anyhow::Result<()> {
    // One live link + watcher pair at a time, tied to HOSTING, not to cycle
    // attempts: the link is spawned when this process starts hosting and
    // torn down when it parks or retires. A failed host cycle (a bind race,
    // an accept error) must neither respawn nor tear the link down — the
    // link is independent of the CLI socket. The old shape (abort + respawn
    // every cycle) turned a persistently failing bind into a link kill per
    // cycle: with the Windows pipe bind broken (os error 87, 2026-09-23 →
    // 09-29) every Windows machine's link died within a second of
    // connecting, forever — Windows machines permanently offline.
    let mut link_cycle: Option<(
        tokio::task::JoinHandle<()>,
        tokio::task::JoinHandle<()>,
        tokio::task::JoinHandle<()>,
    )> = None;
    let teardown = |link_cycle: &mut Option<(
        tokio::task::JoinHandle<()>,
        tokio::task::JoinHandle<()>,
        tokio::task::JoinHandle<()>,
    )>| {
        if let Some((link, watcher, reaper)) = link_cycle.take() {
            link.abort();
            watcher.abort();
            reaper.abort();
        }
    };
    loop {
        // Park while the unit or another daemon owns the executor — the
        // owner runs the link, so ours goes down for the park's duration.
        if crate::daemon_install::unit_active() || try_connect_at(&path).is_ok() {
            teardown(&mut link_cycle);
            while crate::daemon_install::unit_active() || try_connect_at(&path).is_ok() {
                tokio::time::sleep(RECLAIM_POLL).await;
            }
        }
        if *shared.shutdown.borrow() {
            // This host was retired (shutdown latched): hold off through the
            // installer's retire→enable window before reclaiming.
            tokio::time::sleep(RECLAIM_GRACE).await;
            if crate::daemon_install::unit_active() || try_connect_at(&path).is_ok() {
                continue;
            }
            let _ = shared.shutdown.send(false);
        }
        if link_cycle.is_none() {
            link_cycle = {
                let (link, watcher) = spawn_machine_link(&shared);
                Some((link, watcher, spawn_reaper(&shared)))
            };
        }
        match host_shared_socket(path.clone(), shared.clone()).await {
            Ok(()) => {
                // A hosted spell ended (daemon.shutdown retire): the link
                // goes with the socket; the reclaim cycle respawns both.
                teardown(&mut link_cycle);
            }
            Err(e) => {
                // The bind failed; keep the link and the reaper alive and
                // retry the host. Respawning here was the 2026-09-23
                // allocation storm; tearing down here kept every link dead
                // while the bind kept failing.
                crate::dtrace::dtrace(&format!("daemon host cycle failed: {e}"));
                eprintln!("guild: daemon host cycle failed: {e}");
                tokio::time::sleep(RECLAIM_POLL).await;
            }
        }
    }
}

/// Spawns the machine-link task (seeded from the session's persisted
/// identity) and the token.json watcher. One call per host cycle: the link
/// and the watcher exist exactly while this process hosts the CLI socket —
/// the socket owner runs the link, nobody else does. The caller must abort
/// the returned handles before the next cycle's spawn: a failed host cycle
/// otherwise leaks the pair, and the leaked link tasks retry forever.
fn spawn_machine_link(
    shared: &Shared,
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    // One supervisor runs one link task per live workspace (fed by the
    // registry's spawn feed); the token.json watcher re-seeds the ACTIVE
    // session from auth performed by another process.
    let supervisor = tokio::spawn(crate::machine_link::run_link_supervisor(
        shared.clone(),
        shared
            .link_spawn_rx
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| tokio::sync::mpsc::unbounded_channel().1),
    ));
    // Auth performed by another process (the GUI while a unit daemon owns
    // the link, or a CLI verb) lands only in token.json: the watcher
    // re-seeds the active workspace's link config from it, sign-out included.
    let watcher = match crate::session_store::store_watch_path() {
        Ok(path) => {
            let watcher_shared = shared.clone();
            Some(tokio::spawn(crate::machine_link::watch_token_store(
                path,
                watcher_shared.session.clone(),
                watcher_shared.links.clone(),
                shared.shutdown.subscribe(),
                std::time::Duration::from_secs(1),
            )))
        }
        Err(_) => None,
    };
    shared.publish_machine_link();
    (
        supervisor,
        watcher.unwrap_or_else(|| tokio::spawn(std::future::pending())),
    )
}

/// Reaps finished agent runs so the JoinSet doesn't grow unbounded, then
/// runs the accept loop for this platform until shutdown.
/// Reaps finished agent runs so the JoinSet doesn't grow unbounded. One
/// reaper per host cycle: the caller aborts it with the link/watcher pair
/// before the next cycle's spawn — a failed host cycle must not leave a
/// reaper behind.
fn spawn_reaper(shared: &Shared) -> tokio::task::JoinHandle<()> {
    let agents = shared.agents.clone();
    let mut reaper_shutdown = shared.shutdown.subscribe();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {}
                _ = reaper_shutdown.changed() => {
                    if *reaper_shutdown.borrow_and_update() {
                        return;
                    }
                }
            }
            let mut guard = agents.lock().await;
            while guard.try_join_next().is_some() {}
        }
    })
}

async fn host_shared_socket(path: PathBuf, shared: Shared) -> anyhow::Result<()> {
    let shutdown_rx = shared.shutdown.subscribe();

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
    // Named pipes need one pre-created server instance per pending client:
    // create instance N, await its connect, create instance N+1, serve N.
    let pipe_name = path.to_string_lossy().into_owned();
    let mut server = create_pipe_server_instance(&pipe_name, true)?;
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
                match create_pipe_server_instance(&pipe_name, false) {
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

/// One listening pipe instance, created with an explicit DACL limiting
/// access to the current user + SYSTEM. The default pipe DACL grants
/// Everyone read access, which on multi-user hosts turns the event stream
/// (deltas, tool output) into a cross-user eavesdrop channel for any local
/// account — the pipe name is derivable from the username. Tokio's
/// ServerOptions cannot carry a security descriptor, so the raw
/// CreateNamedPipeW call mirrors its defaults (duplex byte mode, overlapped,
/// unlimited instances, 64 KiB buffers, remote clients rejected) and the
/// handle is adopted as a tokio server. `first` sets
/// FILE_FLAG_FIRST_PIPE_INSTANCE so the first instance cannot lose the pipe
/// name to a squatter.
#[cfg(windows)]
fn create_pipe_server_instance(
    pipe_name: &str,
    first: bool,
) -> anyhow::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::NamedPipeServer;
    use windows_sys::Win32::Foundation::{LocalFree, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    // P = protected DACL (no inherited ACEs); GA = generic all, for the
    // creating user's SID and for SYSTEM only.
    let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", current_user_sid()?);
    let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
    let mut psd: PSID = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            windows_sys::Win32::Security::Authorization::SDDL_REVISION_1,
            &mut psd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || psd.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd as *mut SECURITY_DESCRIPTOR as *mut core::ffi::c_void,
        bInheritHandle: 0,
    };
    let name_wide: Vec<u16> = pipe_name.encode_utf16().chain(std::iter::once(0)).collect();
    // PIPE_REJECT_REMOTE_CLIENTS is a dwPipeMode flag: in dwOpenMode the bit
    // is unassigned and CreateNamedPipeW rejects the whole call with
    // ERROR_INVALID_PARAMETER (87) — every Windows pipe host failed to bind
    // until this moved (2026-09-29), and the host cycle churned the machine
    // link every second (Windows machines permanently offline).
    let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    let handle = unsafe {
        CreateNamedPipeW(
            name_wide.as_ptr(),
            open_mode,
            pipe_mode,
            PIPE_UNLIMITED_INSTANCES,
            65536,
            65536,
            0,
            &sa,
        )
    };
    unsafe { LocalFree(psd as *mut _) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { NamedPipeServer::from_raw_handle(handle) }?)
}

/// The current process token's user SID in SDDL string form — the DACL's
/// grantee. Fails closed: no SID means no pipe instance is created.
#[cfg(windows)]
fn current_user_sid() -> anyhow::Result<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let result: anyhow::Result<String> = (|| {
            // First call with no buffer returns the required size.
            let mut len: u32 = 0;
            let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            if len == 0 {
                anyhow::bail!("token user info: no size returned");
            }
            let mut buf = vec![0u8; len as usize];
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                len,
                &mut len,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            let tu = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut sid_str: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(tu.User.Sid as PSID, &mut sid_str) == 0 || sid_str.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut out = String::new();
            let mut i = 0usize;
            while *sid_str.add(i) != 0 {
                out.push(char::from_u32(u32::from(*sid_str.add(i))).unwrap_or('\u{FFFD}'));
                i += 1;
            }
            LocalFree(sid_str as *mut _);
            Ok(out)
        })();
        CloseHandle(token);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::user_pipe_suffix;

    #[test]
    fn pipe_suffix_is_stable_hex() {
        let s = user_pipe_suffix("alice");
        assert_eq!(s.len(), 16);
        assert_eq!(s, user_pipe_suffix("alice"));
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

#[cfg(test)]
mod entry_reaper_tests {
    use super::*;
    use crate::jsonrpc_loop::Shared;

    /// Shared shape for a daemon entry: every completed agent run the
    /// reaper must drain lands in `agents`.
    async fn drive_entry_reaping(
        entry: fn(
            PathBuf,
            Shared,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send>,
        >,
    ) {
        let path = std::env::temp_dir().join(format!(
            "guild-reap-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7().simple()
        ));
        let shared = Shared::new(Default::default());
        let daemon = tokio::spawn(entry(path.clone(), shared.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Three agent tasks that finish immediately: without a reaper they
        // stay in the JoinSet forever.
        {
            let mut agents = shared.agents.lock().await;
            for _ in 0..3 {
                agents.spawn(async {});
            }
        }
        // One reaper cadence (10 s) plus margin.
        tokio::time::sleep(std::time::Duration::from_secs(12)).await;
        {
            let mut agents = shared.agents.lock().await;
            assert!(
                agents.try_join_next().is_none(),
                "the daemon entry's reaper drained the completed agent tasks"
            );
        }
        shared.shutdown.send(true).ok();
        daemon.abort();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn the_ordinary_daemon_entry_reaps_completed_agent_tasks() {
        drive_entry_reaping(|p, s| Box::pin(async move { run_daemon_shared(p, s).await })).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_reclaiming_daemon_entry_reaps_completed_agent_tasks() {
        // This dev box runs a live guild-daemon unit; the reclaiming entry
        // would wait for it to retire forever. The override pins the probe.
        crate::daemon_install::set_unit_active_override(Some(false));
        drive_entry_reaping(|p, s| {
            Box::pin(async move { run_daemon_shared_reclaiming(p, s).await })
        })
        .await;
        crate::daemon_install::set_unit_active_override(None);
    }
}
