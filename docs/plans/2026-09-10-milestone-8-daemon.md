# Guild Daemon Milestone (8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-app child engine with a single user-level daemon that survives client closure, is shared by all client windows and the CLI, and is the only component that talks to the cloud server with the session token.

**Architecture:** One `guild daemon` process per OS user holds the `Session` (auth, chat history, agent runs) in memory and listens on a per-user local socket (Unix domain socket on Linux/macOS, named pipe on Windows). The GUI, and every headless CLI verb except offline `verify`, attach to the daemon as line-delimited JSON-RPC clients — the exact protocol and framing already used over stdio. The GUI spawns the daemon detached on first connect and re-attaches if the daemon dies. Auth durability stays in `~/.config/guild/token.json`, now written only by the daemon.

**Tech Stack:** Rust workspace (tokio, serde_json), existing `protocol` JSON-RPC envelope, `guild-app-server` engine code, Tauri v2 GUI. New dependency: `tokio-util` (feature `io`, for `SyncIoBridge` on Windows named pipes).

**Spec:** `docs/specs/2026-09-09-guild-design.md` — §3.3 ("Sessions keep running when the window is closed or hidden") is the requirement this implements; §3.1 says "launches guild-app-server as a child process" and §6 defines the wire protocol. Task 6 amends §3.1 to say the GUI attaches to a daemon.

## Global Constraints

- Every wire message keeps the `protocol` field; `PROTOCOL_VERSION` stays `1` (`crates/protocol/src/rpc.rs`).
- One cloud route: only the daemon makes authenticated HTTP calls with the session token. Documented exception: the Tauri updater plugin in the GUI fetches `/api/v1/updates/latest.json` + release artifacts — that endpoint is public and unauthenticated (verified in `crates/server/src/http/releases.rs:215`), and the plugin requires in-GUI binary handling. No session token travels from the GUI.
- `~/.config/guild/token.json` (via `session_store`) stays the durable auth store; after Task 2 only the daemon reads/writes it. The GUI's `check_and_prepare_update` reads `base_url` from it (read-only local file read, not a cloud call) — allowed; flag for later cleanup.
- Desktop crate is not in `default-members` — always build it explicitly with `-p guild-desktop`.
- Keep the stdio JSON-RPC loop (`crates/app-server/src/main.rs` no-args branch) as a library/dev/test surface; it is no longer used by the shipped app after Task 5.
- New crates dependencies: only `tokio-util = { version = "0.7", default-features = false, features = ["io-util"] }` added to `crates/app-server/Cargo.toml` (workspace dep). Everything else already in the workspace.
- Windows cross-compilation must keep working: after each task, `cargo check -p guild-app-server --target x86_64-pc-windows-msvc` and `cargo check -p guild-app-server --target x86_64-pc-windows-gnu` must pass (targets are installed on this host).
- The daemon never exits on client disconnect, idle, or error other than `daemon.shutdown` (or an unrecoverable bind failure at startup). Agent runs continue to completion with zero attached clients.

## File Structure

- Modify: `crates/app-server/src/jsonrpc_loop.rs` — `Shared` state, `run_connection`, broadcast events, `daemon.hello`/`daemon.shutdown` dispatch entries.
- Modify: `crates/app-server/src/agent_session.rs` — `SessionHooks.events` and `AgentRun.events` become `tokio::sync::broadcast::Sender<Value>`.
- Create: `crates/app-server/src/daemon.rs` — socket path, client connect, detached spawn, accept loop, daemon lifecycle.
- Create: `crates/app-server/src/daemon_client.rs` — blocking CLI client (`DaemonClient`).
- Create: `crates/app-server/src/cli.rs` — shared headless verb implementations (`cmd_login`, `cmd_chat`, `cmd_publish`, `cmd_install`, `cmd_verify`), deduplicated from the two mains.
- Modify: `crates/app-server/src/main.rs` — add `daemon` subcommand; delegate CLI verbs to `cli.rs`.
- Modify: `crates/app-server/src/lib.rs` — register `daemon`, `daemon_client`, `cli` modules; add `tokio-util` dep in `Cargo.toml`.
- Create: `crates/app-server/tests/daemon.rs` — daemon integration tests.
- Modify: `apps/desktop/src-tauri/src/lib.rs` — GUI attaches to the daemon over the socket instead of spawning a child; Engine carries socket streams.
- Modify: `apps/desktop/src-tauri/src/main.rs` — add `daemon` subcommand (the GUI binary re-executes itself as daemon); later remove the `engine` branch.
- Modify: `apps/desktop/src-tauri/Cargo.toml` — tokio features if needed by attach code.
- Modify (docs): `docs/clients.md` §1 invocation table; `docs/specs/2026-09-09-guild-design.md` §3.1.
- Frontend (`apps/desktop/src/*.tsx`, `src/transport.ts`): **no changes** — `start_engine`, `rpc_request`, and `rpc-event` keep their names and shapes.

---

### Task 1: Shared engine state + broadcast events in `jsonrpc_loop`

Today `serve()` owns one `Session` and one client. Refactor so the state lives in a clonable `Shared` and a connection is a function over shared state. Behavior over a single connection must be identical (all existing tests keep passing).

**Files:**
- Modify: `crates/app-server/src/jsonrpc_loop.rs`
- Modify: `crates/app-server/src/agent_session.rs` (two field type changes)
- Modify: `crates/app-server/tests/agent_rpc.rs` (one test if event-ordering asserts break)

**Interfaces (produced for later tasks):**

```rust
#[derive(Clone)]
pub struct Shared {
    pub session: Arc<Mutex<Session>>,
    /// Broadcast channel for protocol events (agent.*, chat.*). Every
    /// connected client receives every event. Capacity 256.
    pub events: tokio::sync::broadcast::Sender<Value>,
    /// Agent runs owned by the daemon (outlive any single client).
    /// tokio Mutex because we hold the guard across `.await` while draining.
    pub agents: Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,
    /// Set true by `daemon.shutdown`; the daemon's accept loop watches it.
    pub shutdown: Arc<tokio::sync::watch::Sender<bool>>,
}

impl Shared { pub fn new(session: Session) -> Self }

/// One client connection: reads requests, dispatches onto `shared`,
/// writes responses for THIS connection plus all broadcast events.
/// Returns the writer when the client disconnects (EOF) — never on error
/// conditions that should keep the daemon alive.
pub async fn run_connection<R: std::io::Read + Send + 'static, W: std::io::Write + Send + 'static>(
    shared: &Shared, reader: R, writer: W,
) -> anyhow::Result<W>;

/// Unchanged public signature — wraps Shared::new + run_connection, drains
/// the JoinSet, unwraps the Session. Used by tests and the stdio dev surface.
pub async fn serve<R, W>(reader: R, writer: W, session: Session) -> anyhow::Result<(Session, W)>;
```

- [ ] **Step 1: Write the failing test (two connections, one Shared)**

Append to `crates/app-server/tests/agent_rpc.rs` (mirrors its existing os-pipe harness):

```rust
/// Two connections over one Shared see each other's mutations and both
/// receive broadcast events. This is the property the daemon needs.
#[test]
fn two_connections_share_state_and_events() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    rt.block_on(async {
        let shared = jsonrpc_loop::Shared::new(Session::default());

        // One duplex pipe pair per connection: the server reads+writes `s`,
        // the test client holds the other end `c` (clone for its writer).
        let (sa, ca) = std::os::unix::net::UnixStream::pair().unwrap();
        let (sb, cb) = std::os::unix::net::UnixStream::pair().unwrap();
        let sa_read = sa.try_clone().unwrap();
        let c1 = tokio::task::spawn_blocking({
            let shared = shared.clone();
            move || {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(jsonrpc_loop::run_connection(&shared, sa_read, sa))
            }
        });
        let sb_read = sb.try_clone().unwrap();
        let c2 = tokio::task::spawn_blocking({
            let shared = shared.clone();
            move || {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(jsonrpc_loop::run_connection(&shared, sb_read, sb))
            }
        });

        // Clients: requests go to cb/cb via writeln; reader threads feed
        // parsed lines into mpsc channels for the assertions below.
    });
}
```

Harness note (concrete): for each connection, `writeln!` requests to the *write* end of the pipe pair and drain the paired *read* end with a `BufReader` on a `std::thread` that pushes parsed lines into a `std::sync::mpsc` channel (reuse the `Tee` + `collect_lines` patterns already in this file). Assert, in order:

1. Client A sends `agent.policy.set` `{tool: "run_command", policy: "allow"}` → gets a response with no `error`.
2. Client B sends `agent.policy.get` → response `result.overrides["run_command"] == "allow"` (shared `Session`).
3. Client A sends `agent.start` against the `scripted_provider()` mock (reuse the existing harness from the `agent_run_streams_events`-style test) → **both** A's and B's readers see the same `agent.text`/`agent.tool_call` event lines (broadcast fan-out).
4. Dropping A's write end (EOF) does not affect B: B still gets a response after A disconnects.

Run: `cargo test -p guild-app-server --test agent_rpc two_connections`
Expected: FAIL — `Shared` and `run_connection` don't exist yet.

- [ ] **Step 2: Implement `Shared` and `run_connection`**

In `jsonrpc_loop.rs`:

```rust
use tokio::sync::{broadcast, watch};

#[derive(Clone)]
pub struct Shared {
    pub session: Arc<Mutex<Session>>,
    pub events: broadcast::Sender<Value>,
    pub agents: Arc<Mutex<tokio::task::JoinSet<()>>>,
    pub shutdown: Arc<watch::Sender<bool>>,
}

impl Shared {
    pub fn new(session: Session) -> Self {
        let (events, _) = broadcast::channel(256);
        let (shutdown, _) = watch::channel(false);
        Self {
            session: Arc::new(Mutex::new(session)),
            events,
            agents: Arc::new(tokio::sync::Mutex::new(tokio::task::JoinSet::new())),
            shutdown: Arc::new(shutdown),
        }
    }
}
```

Move the body of the current `serve` loop into `run_connection` with a `select!` over requests and broadcast events (this is the one place the loop structure changes — events and requests interleave on the same ordered writer):

```rust
pub async fn run_connection<R, W>(shared: &Shared, reader: R, writer: W) -> anyhow::Result<W>
where R: std::io::Read + Send + 'static, W: std::io::Write + Send + 'static,
{
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<Incoming>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(reader);
        use std::io::BufRead;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() { continue; }
            if req_tx.send(line_to_incoming(&line)).is_err() { break; }
        }
    });

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer_thread = std::thread::spawn(move || {
        let mut w = writer;
        while let Some(v) = out_rx.blocking_recv() {
            let _ = writeln!(w, "{v}");
            let _ = w.flush();
        }
        w
    });

    let mut event_rx = shared.events.subscribe();
    let mut events_open = true;
    loop {
        tokio::select! {
            biased;
            inc = req_rx.recv() => match inc {
                None => break,
                Some(Incoming::Malformed(msg)) => {
                    let _ = out_tx.send(json!({
                        "protocol": PROTOCOL_VERSION, "event": "rpc.error",
                        "payload": {"message": msg},
                    }));
                }
                Some(Incoming::Request(req)) => {
                    // Sequential per connection (ordering for login → chat).
                    dispatch(shared.clone(), req, out_tx.clone()).await;
                }
            },
            ev = event_rx.recv(), if events_open => match ev {
                Ok(v) => { let _ = out_tx.send(v); }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => {
                    // sender dropped (only possible while Shared is being torn
                    // down in serve()): stop consuming events, keep serving
                    // requests until EOF
                    events_open = false;
                }
            },
        }
    }
    drop(out_tx);
    let writer = writer_thread.join().expect("writer thread");
    Ok(writer)
}
```

- [ ] **Step 3: Rewrite `dispatch` and tasks onto `Shared`**

Change signatures (bodies otherwise identical):

```rust
async fn dispatch(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>)
```

- `"login" => login_task(shared.session.clone(), req, out_tx).await` — unchanged otherwise.
- `"pair"` — same treatment as login.
- `"chat.send" => chat_send_task(shared.clone(), req, out_tx).await` — inside, replace the two `out_tx.send(event_value(...))` calls with `let _ = shared.events.send(event_value(...));`. The final `response_value` still goes to `out_tx`.
- `"models.list"`, `"tool.run"` — take `shared.session.clone()` as today.
- `"agent.start" => { let _ = shared.agents.lock().await.spawn(agent_start_task(shared.clone(), req, out_tx)); }`
- `"agent.approve"`, `"agent.policy.set"`, `"agent.policy.get"`, `"registry.publish"`, `"registry.install"` — `shared.session.clone()` as today; `registry_*` and `agent_approve` unchanged otherwise.
- `"daemon.hello"` — new (added in Task 2; put the match arm in now returning version+protocol so the wire method exists before any client uses it):

```rust
"daemon.hello" => {
    let _ = out_tx.send(response_value(req.id, Ok(Response::ok(
        req.id,
        json!({"version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION}),
    ))));
}
"daemon.shutdown" => {
    let _ = shared.shutdown.send(true);
    let _ = out_tx.send(response_value(req.id, Ok(Response::ok(req.id, json!({"ok": true})))));
}
```

`agent_start_task(shared: Shared, req, out_tx)`: the immediate `started` response stays on `out_tx`; build `AgentRun { events: shared.events.clone(), ... }` (drop the old `out_tx.clone()` for events).

In `agent_session.rs`, change exactly two field declarations and nothing else (send sites already discard results):

```rust
// SessionHooks
pub events: tokio::sync::broadcast::Sender<Value>,
// AgentRun
pub events: tokio::sync::broadcast::Sender<Value>,
```

- [ ] **Step 4: Keep `serve` working (tests + stdio surface)**

```rust
pub async fn serve<R, W>(reader: R, writer: W, session: Session) -> anyhow::Result<(Session, W)>
where R: std::io::Read + Send + 'static, W: std::io::Write + Send + 'static,
{
    let shared = Shared::new(session);
    let writer = run_connection(&shared, reader, writer).await?;
    // Let in-flight agent runs finish so their events are written (as before).
    // tokio Mutex: the guard is held across .await here.
    while shared.agents.lock().await.join_next().await.is_some() {}
    let session = match Arc::try_unwrap(shared.session) {
        Ok(m) => m.into_inner().expect("session lock"),
        Err(_) => anyhow::bail!("session references still alive"),
    };
    Ok((session, writer))
}
```

- [ ] **Step 5: Run the new test + the whole existing suite**

Run: `cargo test -p guild-app-server`
Expected: new test PASSES; all pre-existing tests in `roundtrip.rs` and `agent_rpc.rs` PASS unchanged (event delivery now rides the broadcast channel — same lines arrive at the same writer). If an agent_rpc test asserts on exact interleaving of the `started` response vs events and now sees different ordering, update that one assertion and note it in the commit message — ordering across two channels is inherently racy; the protocol treats responses and events as independent.

- [ ] **Step 6: Windows cross-check + commit**

Run: `cargo check -p guild-app-server --target x86_64-pc-windows-msvc`
Expected: PASS (pure tokio broadcast/watch — nothing platform-specific yet).

```bash
git add -A && git commit -m "app-server: shared engine state + broadcast events (daemon groundwork)"
```

---

### Task 2: Daemon core (Unix socket) + `daemon` subcommand

**Files:**
- Create: `crates/app-server/src/daemon.rs`
- Modify: `crates/app-server/src/lib.rs` (add `pub mod daemon;`)
- Modify: `crates/app-server/src/main.rs` (add `Some("daemon")` arm)
- Modify: `crates/app-server/Cargo.toml` (nothing yet — tokio `full` already covers `net`, `time`)
- Create: `crates/app-server/tests/daemon.rs`

**Interfaces (produced for later tasks):**

```rust
// crates/app-server/src/daemon.rs
/// One duplex connection to the daemon: (read half, write half).
pub struct Pair(pub Box<dyn std::io::Read + Send>, pub Box<dyn std::io::Write + Send>);

/// Where the daemon listens / clients connect. Honors GUILD_DAEMON_SOCKET.
pub fn socket_path() -> anyhow::Result<PathBuf>;            // unix: path; windows: pipe name string-as-path

/// Connect to an already-running daemon. Fails if none.
pub fn try_connect() -> anyhow::Result<Pair>;
pub fn try_connect_at(path: &Path) -> anyhow::Result<Pair>; // test seam

/// Spawn `bin daemon` fully detached (survives parent exit, own process group).
pub fn spawn_detached(bin: &Path) -> anyhow::Result<()>;

/// hello handshake over a fresh pair; a daemon of a different version is told
/// to shut down and this returns Err (caller respawns).
pub fn handshake(pair: Pair) -> anyhow::Result<Pair>;

/// Full blocking client flow: connect → spawn if missing → handshake.
pub fn attach(bin: &Path) -> anyhow::Result<Pair>;

/// Daemon main: bind (exit Ok if another daemon owns the endpoint), restore
/// session, accept loop forever until shutdown watch fires.
pub async fn run_daemon() -> anyhow::Result<()>;
pub async fn run_daemon_on(path: PathBuf, session: Session) -> anyhow::Result<()>; // test seam
```

- [ ] **Step 1: Write the failing test**

Create `crates/app-server/tests/daemon.rs` (whole file `#![cfg(unix)]`):

```rust
#![cfg(unix)]
use guild_app_server::daemon::{try_connect_at, run_daemon_on};
use guild_app_server::jsonrpc_loop::{Session, Shared};
use protocol::rpc::Request;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

fn temp_socket() -> PathBuf {
    std::env::temp_dir().join(format!("guild-daemon-test-{}.sock", std::process::id()))
}

fn req(id: u64, method: &str, params: Value) -> String {
    serde_json::to_string(&Request::new(id, method, params)).unwrap()
}

struct Client { reader: BufReader<UnixStream>, stream: UnixStream, next: u64 }

impl Client {
    fn connect(path: &PathBuf) -> Self {
        let s = UnixStream::connect(path).unwrap();
        Self { reader: BufReader::new(s.try_clone().unwrap()), stream: s, next: 1 }
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next; self.next += 1;
        writeln!(self.stream, "{}", req(id, method, params)).unwrap();
        loop {
            let mut line = String::new();
            self.reader.read_line(&mut line).unwrap();
            let v: Value = serde_json::from_str(line.trim()).unwrap();
            if v.get("event").is_some() { continue; }          // broadcast event
            if v["id"].as_u64() == Some(id) { return v; }      // our response
        }
    }
    fn next_event(&mut self, name: &str) -> Value {
        loop {
            let mut line = String::new();
            self.reader.read_line(&mut line).unwrap();
            let v: Value = serde_json::from_str(line.trim()).unwrap();
            if v["event"] == name { return v; }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_binds_shares_survives_and_shuts_down() {
    let path = temp_socket();
    let _ = std::fs::remove_file(&path);

    let shared = Shared::new(Session::default());
    let dpath = path.clone();
    let daemon = tokio::spawn(async move { run_daemon_on(dpath, Session::default()).await });

    // wait for the endpoint to accept
    let mut a = None;
    for _ in 0..100 {
        if try_connect_at(&path).is_ok() {
            // wrap back into a Client for assertions
            a = Some(Client::connect(&path));
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut a = a.expect("daemon reachable");

    // 1. hello reports version + protocol
    let hello = a.call("daemon.hello", json!({}));
    assert_eq!(hello["result"]["protocol"], 1);
    assert!(hello["result"]["version"].is_string());

    // 2. shared state: A mutates, B observes
    let mut b = Client::connect(&path);
    a.call("agent.policy.set", json!({"tool": "run_command", "policy": "allow"}));
    let got = b.call("agent.policy.get", json!({}));
    assert_eq!(got["result"]["overrides"]["run_command"], "allow");

    // 3. client disconnect leaves the daemon (and B) working
    drop(a);
    let got = b.call("agent.policy.get", json!({}));
    assert!(got.get("error").is_none());

    // 4. a second bind on the same endpoint exits quietly (single instance)
    let r = run_daemon_on(path.clone(), Session::default()).await;
    assert!(r.is_ok(), "second daemon must exit Ok, not bind");

    // 5. shutdown: client-issued, daemon task ends
    b.call("daemon.shutdown", json!({}));
    tokio::time::timeout(Duration::from_secs(5), daemon).await.unwrap().unwrap().unwrap();
    let _ = std::fs::remove_file(&path);
}
```

Note on step 4: `run_daemon_on` takes a `Session` (by value), not `Shared` — adjust the sketch: `run_daemon_on(path.clone(), Session::default())`. The important assertion is it returns quickly with `Ok` because the endpoint is owned by the first daemon.

Run: `cargo test -p guild-app-server --test daemon`
Expected: FAIL — module `daemon` doesn't exist.

- [ ] **Step 2: Implement `daemon.rs`**

```rust
//! Local daemon (spec §3.3): one engine process per user, survives client
//! exit, the only route to the cloud server. Line-delimited JSON-RPC over a
//! per-user local socket. The GUI and CLI verbs attach as clients.

use crate::jsonrpc_loop::{run_connection, Shared};
use anyhow::Context as _;
use sha2::Digest as _;
use std::io::{BufRead, BufReader};
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
    Ok(PathBuf::from(format!(r"\\.\pipe\guild-daemon-{}", user_pipe_suffix(&user))))
}

/// One duplex connection: (read half, write half).
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
    let f = OpenOptions::new().read(true).write(true).open(path)
        .with_context(|| format!("connect {}", path.display()))?;
    Ok(Pair(Box::new(f.try_clone()?), Box::new(f)))
}

pub fn try_connect() -> anyhow::Result<Pair> {
    try_connect_at(&socket_path()?)
}

pub fn spawn_detached(bin: &Path) -> anyhow::Result<()> {
    use std::process::{Command, Stdio};
    let cmd = Command::new(bin).arg("daemon")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0).spawn().context("spawn daemon")?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn().context("spawn daemon")?;
    }
    Ok(())
}

/// hello handshake; a daemon with a different build version is told to shut
/// down and the caller gets an Err so it can respawn a current daemon.
/// Reads byte-wise (no BufReader) so no bytes past the newline are lost to
/// a dropped buffer — other clients' events may follow immediately.
pub fn handshake(pair: Pair) -> anyhow::Result<Pair> {
    use std::io::Read as _;
    let Pair(mut rd, mut wr) = pair;
    let req = protocol::rpc::Request::new(0, "daemon.hello", serde_json::json!({}));
    writeln!(wr, "{}", serde_json::to_string(&req)?)?;
    wr.flush()?;
    let mut line = Vec::new();
    for b in rd.by_ref().bytes() {
        let b = b?;
        if b == b'\n' { break; }
        line.push(b);
    }
    let v: serde_json::Value = serde_json::from_slice(&line)?;
    let daemon_version = v["result"]["version"].as_str().unwrap_or("");
    if daemon_version != env!("CARGO_PKG_VERSION") {
        let req = protocol::rpc::Request::new(1, "daemon.shutdown", serde_json::json!({}));
        let _ = writeln!(wr, "{}", serde_json::to_string(&req)?);
        anyhow::bail!("daemon version {daemon_version} != {}", env!("CARGO_PKG_VERSION"));
    }
    Ok(Pair(rd, wr))
}

/// Blocking full flow for any client (GUI calls it via spawn_blocking).
pub fn attach(bin: &Path) -> anyhow::Result<Pair> {
    for attempt in 0..2u8 {
        if let Ok(pair) = try_connect() {
            match handshake(pair) {
                Ok(pair) => return Ok(pair),
                Err(_) => { /* stale version: daemon shutting down, respawn */ }
            }
        }
        if attempt == 0 {
            spawn_detached(bin)?;
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Ok(pair) = try_connect() {
                    if let Ok(pair) = handshake(pair) { return Ok(pair); }
                }
            }
        }
    }
    anyhow::bail!("daemon did not start")
}

/// Daemon accept loop. Binds `path`; if another daemon already owns it,
/// returns Ok immediately (single instance). Runs until `daemon.shutdown`.
pub async fn run_daemon() -> anyhow::Result<()> {
    run_daemon_on(socket_path()?, crate::jsonrpc_loop::restored_session().await?).await
}

pub async fn run_daemon_on(path: PathBuf, session: crate::jsonrpc_loop::Session) -> anyhow::Result<()> {
    if try_connect_at(&path).is_ok() {
        return Ok(()); // another daemon owns the endpoint
    }
    #[cfg(unix)]
    let listener = {
        // stale socket from a killed daemon
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        tokio::net::UnixListener::bind(&path).context("bind daemon socket")?
    };

    let shared = Shared::new(session);
    let mut shutdown_rx = shared.shutdown.subscribe();

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
    anyhow::bail!("windows daemon transport lands in Task 3")
}
```

(`into_std` on a tokio `UnixStream` puts it back into blocking mode — both halves then work from the blocking thread, which is what `run_connection`'s reader/writer threads expect.)

- [ ] **Step 3: Wire the subcommand**

`crates/app-server/src/main.rs`:

```rust
Some("daemon") => {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    rt.block_on(guild_app_server::daemon::run_daemon())?;
    Ok(())
}
```

Also add `pub mod daemon;` to `crates/app-server/src/lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p guild-app-server`
Expected: `daemon_binds_shares_survives_and_shuts_down` PASSES; suite stays green.

- [ ] **Step 5: Cross-compile check + commit**

Run: `cargo check -p guild-app-server --target x86_64-pc-windows-msvc && cargo check -p guild-app-server --target x86_64-pc-windows-gnu`
Expected: PASS — the windows accept loop is a stub (`bail!`) in this task; Task 3 fills it in.

```bash
git add -A && git commit -m "app-server: local daemon over unix socket, single-instance, shutdown"
```

---

### Task 3: Windows named-pipe daemon transport

**Files:**
- Modify: `crates/app-server/src/daemon.rs`
- Modify: `crates/app-server/Cargo.toml` (add `tokio-util`)

**Interfaces:** same `run_daemon_on` signature on Windows; `Pair` unchanged.

- [ ] **Step 1: Add the dependency**

`crates/app-server/Cargo.toml`:

```toml
tokio-util = { version = "0.7", default-features = false, features = ["io-util"] }
```

- [ ] **Step 2: Implement the Windows accept loop**

In `daemon.rs`, replace the Task-2 `#[cfg(windows)]` bail with the real loop. Windows named pipes need one server instance pre-created per pending client; the pattern is: create instance N, await its connect, create instance N+1, serve N.

```rust
#[cfg(windows)]
async fn windows_accept_loop(path: &Path, shared: Shared, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) -> anyhow::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let pipe_name = path.to_string_lossy().into_owned();
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&pipe_name)?;
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() { return Ok(()); }
            }
            connected = server.connect() => {
                connected.context("daemon pipe connect")?;
                let client = server;
                server = ServerOptions::new().create(&pipe_name)?; // next pending client
                let shared = shared.clone();
                tokio::task::spawn_blocking(move || {
                    let rt = tokio::runtime::Handle::current();
                    let (rd, wr) = tokio::io::split(client);
                    let rd = tokio_util::io::SyncIoBridge::new(rd);
                    let wr = tokio_util::io::SyncIoBridge::new(wr);
                    let _ = rt.block_on(run_connection(&shared, rd, wr));
                });
            }
        }
    }
}
```

And in `run_daemon_on`, dispatch per-OS:

```rust
#[cfg(windows)]
return windows_accept_loop(&path, shared, shutdown_rx).await;
#[cfg(unix)]
{ /* the Task-2 unix loop */ }
```

Restructure so `shared` + `shutdown_rx` are created before the OS split (they already are in the Task-2 code — just move the unix loop into `unix_accept_loop(path, shared, shutdown_rx)` mirroring the windows function).

- [ ] **Step 3: Verify (no runnable Windows host — compile gates only)**

Run:
- `cargo check -p guild-app-server --target x86_64-pc-windows-msvc`
- `cargo check -p guild-app-server --target x86_64-pc-windows-gnu`
- `cargo test -p guild-app-server` (linux suite must stay green)

Expected: all PASS. Additionally test the pure suffix logic on linux by keeping `user_pipe_suffix` un-gated with a unit test at the bottom of `daemon.rs`:

```rust
#[test]
fn pipe_suffix_is_stable_hex() {
    let s = user_pipe_suffix("maintainer");
    assert_eq!(s.len(), 16);
    assert_eq!(s, user_pipe_suffix("maintainer"));
}
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "app-server: windows named-pipe daemon transport"
```

---

### Task 4: GUI attaches to the daemon (no more child engine)

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs` (add `daemon` subcommand)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `tokio-util` + tokio `rt` bits if the compiler asks)

**Interfaces (consumed from Task 2):** `guild_app_server::daemon::{Pair, attach, spawn_detached, socket_path}`, `guild_app_server::daemon::run_daemon()`.

The frontend needs **no changes**: `start_engine`, `rpc_request`, `rpc-event` keep names/shapes.

- [ ] **Step 1: `Engine` over a socket pair**

In `lib.rs`, replace the `Engine` struct and `spawn_engine` with:

```rust
pub struct Engine {
    stdin: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    responses: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
}

/// Attaches to (or spawns) the daemon and builds the Engine from the pair.
pub async fn attach_engine(app: &AppHandle) -> Result<Arc<Engine>, String> {
    let bin = std::env::var("GUILD_DAEMON_BIN").unwrap_or_else(|_| {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "guild".to_string())
    });
    // daemon::attach is fully blocking — keep it off the async reactor
    let pair = tokio::task::spawn_blocking(move || {
        guild_app_server::daemon::attach(std::path::Path::new(&bin))
    })
    .await
    .map_err(|e| format!("attach join: {e}"))?
    .map_err(|e| format!("daemon attach failed: {e}"))?;

    let Pair(read, write) = pair;
    let engine = Arc::new(Engine {
        stdin: Arc::new(Mutex::new(write)),
        responses: Arc::new(Mutex::new(HashMap::new())),
    });

    // Reader thread: same demux as before, plus EOF → engine cleared so the
    // next start_engine re-attaches (daemon crash recovery).
    let responses = engine.responses.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(read);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            match parse_line(&line) {
                Some(EngineLine::Response { id, value }) => {
                    if let Some(sender) = responses.lock().unwrap().remove(&id) {
                        let _ = sender.send(value);
                    }
                }
                Some(EngineLine::Event(ev)) => { let _ = app_handle.emit("rpc-event", ev); }
                None => { /* same rpc.error emit as today */ }
            }
        }
        // daemon gone: drop our handle; UI requests fail until it returns
        let state: State<EngineState> = app_handle.state();
        *state.engine.lock().unwrap() = None;
        let _ = app_handle.emit("rpc-event", serde_json::json!({
            "protocol": 1, "event": "rpc.error",
            "payload": {"message": "daemon connection lost"},
        }));
    });
    Ok(engine)
}
```

- [ ] **Step 2: `start_engine` calls `attach_engine`; `rpc_request` self-heals**

```rust
#[tauri::command]
pub async fn start_engine(state: State<'_, EngineState>) -> Result<(), String> {
    let handle = state.handle.lock().unwrap().clone().expect("app handle set at setup");
    let mut guard = state.engine.lock().unwrap();
    if guard.is_none() {
        *guard = Some(attach_engine(&handle).await?);
    }
    Ok(())
}
```

In `rpc_request`, on the write-failure path also clear the engine so the next `start_engine` re-attaches:

```rust
Err(e) => {
    engine.responses.lock().unwrap().remove(&id);
    *state.engine.lock().unwrap() = None;   // add: state is already a param
    Err(format!("engine write failed: {e}"))
}
```

(`rpc_request` needs the `state: State<'_, EngineState>` param it already has — just use it in the error branch.)

- [ ] **Step 3: `daemon` subcommand in the GUI binary**

`apps/desktop/src-tauri/src/main.rs` (the GUI re-executes itself, so this binary must also serve daemon mode):

```rust
Some("daemon") => {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    rt.block_on(guild_app_server::daemon::run_daemon())?;
    Ok(())
}
```

Keep the `engine` branch for now (removed in Task 6).

- [ ] **Step 4: Build + verify**

Run: `cargo check -p guild-desktop`
Expected: PASS.

Manual verification (this box, dev build):

```bash
GUILD_APP_SERVER_BIN= cargo run -p guild-desktop   # or the dev tauri flow
```

1. Launch the app → log in (pair or manual). 
2. Quit the app. `ps -ef | grep 'guild.*daemon'` (or `ss -xl | grep guild`) shows the daemon still running.
3. Relaunch the app → still logged in (session restored by the daemon, no pairing screen).
4. Launch a second window/instance → both share the session (log out in one? — no: just verify `session.info` returns the same email in both).
5. Kill the daemon (`guild daemon` PID via `ss -xp`), then click something that issues an RPC → error surfaces; relaunch or re-click triggers re-attach via `start_engine`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "desktop: attach to a surviving shared daemon instead of a child engine"
```

---

### Task 5: CLI verbs through the daemon (one cloud route)

**Files:**
- Create: `crates/app-server/src/daemon_client.rs`
- Create: `crates/app-server/src/cli.rs`
- Modify: `crates/app-server/src/lib.rs` (register modules)
- Modify: `crates/app-server/src/main.rs` (delegate verbs, drop direct CloudClient use)
- Modify: `apps/desktop/src-tauri/src/main.rs` (delegate verbs to `cli.rs`)

**Interfaces (consumed from Task 2):** `daemon::attach(bin) -> Pair`.

- [ ] **Step 1: Write the failing test for the client demux**

In `daemon_client.rs` bottom (unit test, in-crate):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// call_streaming separates responses for the request id from broadcast
    /// events, in order, and errors surface as Err.
    #[test]
    fn demux_responses_and_events() {
        let (server_side, client_side) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut writer_side = server_side.try_clone().unwrap();
        let mut client = DaemonClient::from_pair(Pair(Box::new(client_side), Box::new(server_side)));
        let t = std::thread::spawn(move || {
            // an unrelated event, then our response, then another event
            writeln!(writer_side, r#"{{"protocol":1,"event":"chat.delta","payload":{{"content":"hi"}}}}"#).unwrap();
            writeln!(writer_side, r#"{{"jsonrpc":"2.0","id":0,"protocol":1,"result":{{"ok":true}}}}"#).unwrap();
            writeln!(writer_side, r#"{{"protocol":1,"event":"chat.done","payload":{{}}}}"#).unwrap();
        });
        let mut events = Vec::new();
        let res = client.call_streaming("chat.send", serde_json::json!({"text": "x"}), |ev| events.push(ev)).unwrap();
        t.join().unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(events.len(), 1); // response arrives first (id 0), events after are drained by... 
        // NOTE: call_streaming returns at the response; the trailing event is
        // read by the NEXT call. Assert exactly that below.
        let mut seen = Vec::new();
        let _ = client.call_streaming("agent.policy.get", serde_json::json!({}), |ev| seen.push(ev)).ok();
        assert_eq!(seen[0]["event"], "chat.done");
    }
}
```

Deliverable shape: because `call_streaming` returns at its response, the trailing `chat.done` is only observed by a subsequent call — the test above encodes that contract explicitly so the executor doesn't "fix" it into buffering. For CLI `cmd_chat` the final `chat.done` MUST be observed before printing the reply — so `call_streaming` grows a `wait_for_done: Option<&str>` variant OR `cmd_chat` uses a dedicated `call_until_event(method, params, done_event)` that keeps reading past its response until the named event arrives, then returns both. Define in the plan:

```rust
/// Returns (response, all events seen up to and including `stop_event`).
pub fn call_until_event(&mut self, method: &str, params: Value, stop_event: &str)
    -> anyhow::Result<(Value, Vec<Value>)>;
```

Test asserts: response returned; last event in the vec is `chat.done`; `chat.delta` content "hi" is in the vec.

Run: `cargo test -p guild-app-server daemon_client`
Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Implement `daemon_client.rs`**

```rust
//! Blocking client for the local daemon — every headless CLI verb goes
//! through it so the daemon is the only cloud route (spec §3.3).

use crate::daemon::{attach, Pair};
use anyhow::Context as _;
use protocol::rpc::Request;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

pub struct DaemonClient {
    reader: BufReader<Box<dyn std::io::Read + Send>>,
    writer: Box<dyn std::io::Write + Send>,
    next_id: u64,
}

impl DaemonClient {
    pub fn from_pair(pair: Pair) -> Self {
        let Pair(rd, wr) = pair;
        Self { reader: BufReader::new(rd), writer: wr, next_id: 0 }
    }

    pub fn attach(bin: &Path) -> anyhow::Result<Self> {
        Ok(Self::from_pair(attach(bin)?))
    }

    fn write_req(&mut self, id: u64, method: &str, params: &Value) -> anyhow::Result<()> {
        writeln!(self.writer, "{}", serde_json::to_string(&Request::new(id, method, params.clone()))?)?;
        self.writer.flush()?;
        Ok(())
    }

    /// One line: returns None on EOF.
    fn read_line(&mut self) -> anyhow::Result<Option<Value>> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)?;
        if n == 0 { return Ok(None); }
        Ok(Some(serde_json::from_str(line.trim())?))
    }

    pub fn call(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.call_streaming(method, params, |_| {})
    }

    /// Sends the request; pumps events to `on_event`; returns when the
    /// response for this request id arrives (events keep flowing for later
    /// calls to drain — see call_until_event when you need a trailing event).
    pub fn call_streaming(&mut self, method: &str, params: Value, mut on_event: impl FnMut(Value)) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_req(id, method, &params)?;
        loop {
            let v = self.read_line()?.context("daemon closed the connection")?;
            if v.get("event").is_some() { on_event(v); continue; }
            if v["id"].as_u64() == Some(id) {
                return match v.get("error") {
                    Some(err) => Err(anyhow::anyhow!(err["message"].as_str().unwrap_or("rpc error").to_string())),
                    None => Ok(v["result"].clone()),
                };
            }
            // a response for an older id can't happen on a private connection;
            // treat one as an event-shaped surprise and surface it loudly
            anyhow::bail!("unexpected response id {} for request {id}", v["id"]);
        }
    }

    /// Like call_streaming but keeps reading past the response until
    /// `stop_event` arrives; returns (response, events in arrival order).
    pub fn call_until_event(&mut self, method: &str, params: Value, stop_event: &str)
        -> anyhow::Result<(Value, Vec<Value>)>
    {
        let id = self.next_id;
        self.next_id += 1;
        self.write_req(id, method, &params)?;
        let mut events = Vec::new();
        let response = loop {
            let v = self.read_line()?.context("daemon closed the connection")?;
            if v.get("event").is_some() { events.push(v); continue; }
            if v["id"].as_u64() == Some(id) {
                break match v.get("error") {
                    Some(err) => Err(anyhow::anyhow!(err["message"].as_str().unwrap_or("rpc error").to_string())),
                    None => Ok(v["result"].clone()),
                };
            }
        };
        let response = response?;
        while events.last().map(|v| v["event"].as_str() != Some(stop_event)).unwrap_or(true) {
            let v = self.read_line()?.with_context(|| format!("daemon closed before {stop_event}"))?;
            if v.get("event").is_some() { events.push(v); }
        }
        Ok((response, events))
    }
}
```

- [ ] **Step 3: Move the verbs into `cli.rs`, both mains delegate**

Create `crates/app-server/src/cli.rs` — move `cmd_login`, `cmd_chat`, `cmd_publish`, `cmd_install`, `cmd_verify`, `flag`, from `crates/app-server/src/main.rs`, rewritten on `DaemonClient`:

```rust
//! Headless CLI verbs. All cloud-touching verbs go through the daemon.

use crate::daemon_client::DaemonClient;
use anyhow::Context as _;
use serde_json::json;
use std::path::PathBuf;

pub fn flag(args: &[String], name: &str) -> anyhow::Result<String> {
    let pos = args.iter().position(|a| a == name).context(format!("missing {name}"))?;
    args.get(pos + 1).cloned().context(format!("{name} needs a value"))
}

/// The daemon should be a copy of this very binary (single-binary design).
fn this_bin() -> anyhow::Result<PathBuf> {
    std::env::current_exe().context("no current exe")
}

pub fn cmd_login(args: &[String]) -> anyhow::Result<()> {
    let url = flag(args, "--url")?;
    let email = flag(args, "--email")?;
    let password = flag(args, "--password")?;
    let mut client = DaemonClient::attach(&this_bin()?)?;
    let res = client.call("login", json!({"base_url": url, "email": email, "password": password}))?;
    println!("logged in as {}", res["user"]["email"].as_str().unwrap_or("?"));
    Ok(())
}

pub fn cmd_chat(args: &[String]) -> anyhow::Result<()> {
    let text = args.last().context("missing prompt text")?.clone();
    let model = flag(args, "--model").unwrap_or_else(|_| "gpt-4o-mini".into());
    let mut client = DaemonClient::attach(&this_bin()?)?;
    let (res, events) = client.call_until_event("chat.send", json!({"text": text, "model": model}), "chat.done")?;
    for ev in &events {
        if ev["event"] == "chat.delta" {
            if let Some(c) = ev["payload"]["content"].as_str() { print!("{c}"); }
        }
    }
    println!();
    if let Some(cost) = res["cost_usd"].as_f64() {
        eprintln!("cost ${cost:.6} ({} in / {} out)", res["tokens_in"], res["tokens_out"]);
    }
    Ok(())
}

pub fn cmd_publish(args: &[String]) -> anyhow::Result<()> {
    let kind = flag(args, "--kind")?;
    let dir = flag(args, "--dir")?;
    let version = flag(args, "--version")?;
    let mut client = DaemonClient::attach(&this_bin()?)?;
    let res = client.call("registry.publish", json!({"kind": kind, "dir": dir, "version": version}))?;
    println!("published {} {} {}", kind, res["slug"].as_str().unwrap_or("?"), res["version"].as_str().unwrap_or("?"));
    Ok(())
}

pub fn cmd_install(args: &[String]) -> anyhow::Result<()> {
    let slug = flag(args, "--slug")?;
    let version = flag(args, "--version").ok();
    let project = flag(args, "--project")?;
    let mut client = DaemonClient::attach(&this_bin()?)?;
    let res = client.call("registry.install", json!({"slug": slug, "version": version, "project_dir": project}))?;
    println!("installed {} -> {}", res["name"].as_str().unwrap_or("?"), res["path"].as_str().unwrap_or("?"));
    Ok(())
}

// cmd_verify: move verbatim from main.rs — offline ed25519, no daemon, no cloud.
pub fn cmd_verify(args: &[String]) -> anyhow::Result<()> { /* body copied unchanged from crates/app-server/src/main.rs cmd_verify */ }
```

Both mains delegate:

```rust
// crates/app-server/src/main.rs and apps/desktop/src-tauri/src/main.rs
Some("login") => guild_app_server::cli::cmd_login(&args[1..]),
Some("chat") => guild_app_server::cli::cmd_chat(&args[1..]),
Some("publish") => guild_app_server::cli::cmd_publish(&args[1..]),
Some("install") => guild_app_server::cli::cmd_install(&args[1..]),
Some("verify") => guild_app_server::cli::cmd_verify(&args[1..]),
```

Delete the now-dead per-main implementations and their unused imports (`CloudClient`, `collect_turn`, `session_store`, `registry_client` uses in mains).

- [ ] **Step 4: Verify**

Run: `cargo test -p guild-app-server && cargo check -p guild-app-server --target x86_64-pc-windows-msvc && cargo check -p guild-desktop`
Expected: all PASS.

Manual: with the daemon running from Task 4, run `Guild login --url ... --email ... --password ...` against the dev server → "logged in as …"; `Guild chat --model gpt-4o-mini "hi"` → reply + cost; the daemon did the HTTP, not the CLI (verify: `ss -tnp | grep 18080` during the call shows the daemon PID as the peer, not the CLI PID).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "app-server/desktop: CLI verbs as daemon clients; one cloud route"
```

---

### Task 6: Remove the `engine` mode + docs

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs` (delete `Some("engine")` branch and `GUILD_APP_SERVER_BIN` mention if referenced)
- Modify: `docs/clients.md` §1 table
- Modify: `docs/specs/2026-09-09-guild-design.md` §3.1

- [ ] **Step 1: Remove the engine branch**

`rg -n '"engine"' apps/desktop/src-tauri/src/main.rs` — delete the arm and its comment. Confirm nothing else references it: `rg -n '"engine"|GUILD_APP_SERVER_BIN' apps crates docs` — `GUILD_APP_SERVER_BIN` is referenced in `apps/desktop/src-tauri/src/lib.rs` (old spawn path already removed in Task 4) and possibly in dev scripts/docs; replace dev docs mention with `GUILD_DAEMON_BIN`. Keep `crates/app-server/src/main.rs` no-arg stdio branch (dev/test surface, note it in a comment).

- [ ] **Step 2: Update `docs/clients.md` §1 table**

Replace the table with:

| Invocation | Behaviour |
|---|---|
| `Guild` (no args) | GUI (Tauri window); attaches to the per-user daemon (spawns it detached if missing) |
| `Guild daemon` | the per-user daemon: shared engine, survives client exit, the only session-token route to the server |
| `Guild login --url U --email E --password P` | CLI verb via the daemon; daemon persists the session to `~/.config/guild/token.json` |
| `Guild chat --model M "text"` | CLI verb via the daemon |
| `Guild publish --kind K --dir D --version V` | CLI verb via the daemon |
| `Guild install --slug S [--project P]` | CLI verb via the daemon |
| `Guild verify --file F --sig SIG --key KEY` | offline ed25519 verification (no daemon, no network) |

Plus a sentence: "The daemon's lifecycle: spawned on first client attach, owns the session and all agent runs, survives client closure, exits only on `daemon.shutdown` (version-mismatched clients invoke this on attach)."

- [ ] **Step 3: Amend spec §3.1**

In `docs/specs/2026-09-09-guild-design.md`, replace the sentence "Launches guild-app-server as a child process and connects over JSON-RPC on stdio." with:

"Attaches to the per-user guild daemon over a local socket (spawns it detached on first use); JSON-RPC line protocol per §6. The daemon survives window closure (§3.3)."

Add a dated note under the amendment (e.g. `> 2026-09-10: changed from child-process engine to a surviving per-user daemon — milestone-8 plan`). Keep the "offer to keep running sessions alive on window close" line removed/superseded — sessions now always survive; note that too.

- [ ] **Step 4: Full gate + commit**

Run:
- `cargo test -p guild-app-server`
- `cargo check -p guild-app-server --target x86_64-pc-windows-msvc && cargo check -p guild-app-server --target x86_64-pc-windows-gnu && cargo check -p guild-app-server --target aarch64-apple-darwin`
- `cargo check -p guild-desktop`

Expected: all PASS.

```bash
git add -A && git commit -m "guild: daemon is the only engine mode; docs updated"
```

---

## Known open items (not in this milestone — record, don't build)

- The GUI updater reads `base_url` from `token.json` directly (read-only); a future `updates.check` RPC would remove even that read.
- Idle daemon lifetime is unbounded; a `--idle-exit SECS` option can come later if users ask.
- Multi-window event mirroring: every window sees every event (broadcast semantics) — fine for a single-user product; per-chat routing is a later concern.
- The daemon holds chat history in memory only (unchanged from today); server-side history sync remains the durability story.
