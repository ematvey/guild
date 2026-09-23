//! Daemon integration tests (plan milestone-8, Task 2): bind/single-instance,
//! shared state across connections, survival across client disconnects,
//! hello handshake, client-issued shutdown.

#![cfg(unix)]
use guild_app_server::daemon::{
    run_daemon_shared, run_daemon_shared_reclaiming, try_connect_at, Pair,
};
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

/// Distinct from temp_socket(): the attach test runs in parallel with the
/// daemon loop test in the same process, and paths must not collide (a
/// single-instance daemon on the shared path would kill the sibling's child).
/// Serializes the attach tests: they mutate GUILD_DAEMON_SOCKET, and plain
/// `cargo test` runs tests as threads of one process.
static ATTACH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Point the spawned daemon's token.json watcher at a path that never
/// exists, so it stays inert (every host-spawning test does this; any
/// concurrent value is equally inert, so the parallel env writes are safe).
fn inert_token_store(dir: &std::path::Path) {
    std::env::set_var("GUILD_TOKEN_PATH", dir.join("token.json"));
}

fn temp_socket_attach() -> PathBuf {
    std::env::temp_dir().join(format!(
        "guild-daemon-attach-test-{}.sock",
        std::process::id()
    ))
}

fn req(id: u64, method: &str, params: Value) -> String {
    serde_json::to_string(&Request::new(id, method, params)).unwrap()
}

/// attach() no longer spawns anything: with no app hosting the socket it
/// fails with a clear "start the app" error (single-process spec).
#[test]
fn attach_fails_cleanly_without_the_app() {
    let _env = ATTACH_LOCK.lock().unwrap();
    let path = temp_socket_attach();
    let _ = std::fs::remove_file(&path);
    std::env::set_var("GUILD_DAEMON_SOCKET", &path);
    let err = guild_app_server::daemon::attach(std::path::Path::new(env!(
        "CARGO_BIN_EXE_guild-app-server"
    )))
    .err()
    .expect("nothing hosts the socket");
    assert!(err.to_string().contains("not running"), "{err}");
    std::env::remove_var("GUILD_DAEMON_SOCKET");
}

/// attach() succeeds against the app-hosted socket, and the host outlives a
/// client disconnect (the GUI process keeps running with the window closed).
#[test]
fn attach_uses_the_app_hosted_socket() {
    let _env = ATTACH_LOCK.lock().unwrap();
    let path = temp_socket_attach();
    let _ = std::fs::remove_file(&path);
    std::env::set_var("GUILD_DAEMON_SOCKET", &path);
    inert_token_store(&path.parent().unwrap().to_path_buf());

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let dpath = path.clone();
    rt.spawn(async move { run_daemon_shared(dpath, Shared::new(Session::default())).await });
    for _ in 0..100 {
        if try_connect_at(&path).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut c = {
        let mut c = None;
        for _ in 0..100 {
            if try_connect_at(&path).is_ok() {
                c = Some(Client::connect(&path));
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        c.expect("host reachable")
    };
    let hello = c.call("daemon.hello", json!({}));
    assert!(hello["result"]["version"].is_string());
    // client exits; the host keeps the endpoint
    drop(c);
    std::thread::sleep(Duration::from_millis(200));
    assert!(try_connect_at(&path).is_ok(), "host outlives its client");

    // clean up the host via shutdown. Unlike the old child-process daemon,
    // the in-process host does not exit on shutdown — it only closes the
    // listener and removes the socket, so no EOF is readable here.
    let pair = try_connect_at(&path).unwrap();
    let Pair(_rd, mut wr, _) = pair;
    writeln!(wr, "{}", req(1, "daemon.shutdown", json!({}))).unwrap();
    wr.flush().unwrap();
    drop(wr);
    for _ in 0..50 {
        if !path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!path.exists(), "host removes its socket on shutdown");
    std::env::remove_var("GUILD_DAEMON_SOCKET");
}

struct Client {
    reader: BufReader<UnixStream>,
    stream: UnixStream,
    next: u64,
}

impl Client {
    fn connect(path: &PathBuf) -> Self {
        let s = UnixStream::connect(path).unwrap();
        Self {
            reader: BufReader::new(s.try_clone().unwrap()),
            stream: s,
            next: 1,
        }
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        writeln!(self.stream, "{}", req(id, method, params)).unwrap();
        loop {
            let mut line = String::new();
            self.reader.read_line(&mut line).unwrap();
            let v: Value = serde_json::from_str(line.trim()).unwrap();
            if v.get("event").is_some() {
                continue; // broadcast event
            }
            if v["id"].as_u64() == Some(id) {
                return v; // our response
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_binds_shares_survives_and_shuts_down() {
    let path = temp_socket();
    let _ = std::fs::remove_file(&path);
    inert_token_store(&path.parent().unwrap().to_path_buf());

    let dpath = path.clone();
    let daemon =
        tokio::spawn(
            async move { run_daemon_shared(dpath, Shared::new(Session::default())).await },
        );

    // wait for the endpoint to accept
    let mut a = None;
    for _ in 0..100 {
        if try_connect_at(&path).is_ok() {
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
    a.call(
        "agent.policy.set",
        json!({"tool": "execute", "policy": "allow"}),
    );
    let got = b.call("agent.policy.get", json!({}));
    assert_eq!(got["result"]["overrides"]["execute"], "allow");

    // 3. client disconnect leaves the daemon (and B) working
    drop(a);
    let got = b.call("agent.policy.get", json!({}));
    assert!(got.get("error").is_none());

    // 4. a second bind on the same endpoint exits quietly (single instance)
    let r = run_daemon_shared(path.clone(), Shared::new(Session::default())).await;
    assert!(r.is_ok(), "second daemon must exit Ok, not bind");

    // 5. shutdown: client-issued, daemon task ends
    b.call("daemon.shutdown", json!({}));
    tokio::time::timeout(Duration::from_secs(5), daemon)
        .await
        .expect("daemon ends after shutdown")
        .expect("daemon task")
        .expect("daemon result");
    let _ = std::fs::remove_file(&path);
}

/// Regression (review round 1 auth-propagation gap): the GUI host owns the
/// CLI socket and the machine link exactly while it hosts. It must wait
/// (no bind, no link) while another daemon owns the endpoint, take over
/// when that owner retires, PARK (no rebind, no link) while the systemd
/// unit is active — install's retirement hands the socket to the unit —
/// and reclaim + relink when the unit stops.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reclaiming_host_parks_while_the_unit_is_active_and_relinks_when_it_stops() {
    let dir = std::env::temp_dir().join(format!("guild-daemon-reclaim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("reclaim.sock");
    let _ = std::fs::remove_file(&path);
    inert_token_store(&dir);
    guild_app_server::daemon_install::set_unit_active_override(Some(false));

    // First daemon owns the endpoint.
    let dpath = path.clone();
    let first =
        tokio::spawn(
            async move { run_daemon_shared(dpath, Shared::new(Session::default())).await },
        );
    let mut a = None;
    for _ in 0..100 {
        if try_connect_at(&path).is_ok() {
            a = Some(Client::connect(&path));
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut a = a.expect("first daemon reachable");

    // The second host (the GUI's) waits instead of giving up: while the
    // endpoint is owned it must NOT bind, and the first daemon keeps
    // serving.
    let dpath2 = path.clone();
    let second = tokio::spawn(async move {
        run_daemon_shared_reclaiming(dpath2, Shared::new(Session::default())).await
    });
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(
        a.call("daemon.hello", serde_json::json!({}))["result"]["version"].is_string(),
        "the owner must keep serving while the waiter waits"
    );

    // Retire the first daemon: the waiter must bind and take over.
    a.call("daemon.shutdown", serde_json::json!({}));
    tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("first daemon ends after shutdown")
        .expect("first daemon task")
        .expect("first daemon result");

    let mut b = wait_for_host(&path)
        .await
        .expect("the reclaiming host must take over");

    // The unit comes up and install retires the GUI's host: it must park —
    // no rebind while the unit is active, even past the reclaim grace.
    guild_app_server::daemon_install::set_unit_active_override(Some(true));
    b.call("daemon.shutdown", serde_json::json!({}));
    tokio::time::timeout(Duration::from_secs(5), async {
        while path.exists() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("host releases the socket on shutdown");
    tokio::time::sleep(Duration::from_millis(4500)).await;
    assert!(
        try_connect_at(&path).is_err(),
        "the GUI host must not rebind while the unit is active"
    );

    // The unit stops (uninstall or daemon death): the GUI host reclaims
    // the socket and hosts again.
    guild_app_server::daemon_install::set_unit_active_override(Some(false));
    let mut c = tokio::time::timeout(Duration::from_secs(15), wait_for_host(&path))
        .await
        .expect("reclaim after the unit stop")
        .expect("reclaimed host reachable");
    assert!(
        c.call("daemon.hello", serde_json::json!({}))["result"]["protocol"].as_u64() == Some(1),
        "the reclaimed host is a full daemon"
    );

    // Retire once more for cleanup: the host parks again (unit "active"),
    // and dies with the test runtime — it never exits on shutdown.
    guild_app_server::daemon_install::set_unit_active_override(Some(true));
    c.call("daemon.shutdown", serde_json::json!({}));
    tokio::time::timeout(Duration::from_secs(5), async {
        while path.exists() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("host releases the socket on shutdown");
    guild_app_server::daemon_install::set_unit_active_override(None);
    // GUILD_TOKEN_PATH stays set (inert) for the process lifetime — other
    // host-spawning tests in this binary rely on any value being safe.
    let _ = std::fs::remove_dir_all(&dir);
    drop(second);
}

/// Polls until a daemon answers hello on `path`.
async fn wait_for_host(path: &PathBuf) -> Option<Client> {
    for _ in 0..200 {
        if try_connect_at(path).is_ok() {
            let mut c = Client::connect(path);
            let hello = c.call("daemon.hello", serde_json::json!({}));
            if hello["result"]["protocol"].as_u64() == Some(1) {
                return Some(c);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

/// Regression: the daemon broadcasts events to all connections, so a fresh
/// connection can receive an event before its hello response. The handshake
/// must skip event frames instead of declaring a protocol mismatch (which
/// used to shut down a daemon serving another client).
#[test]
fn handshake_skips_leading_event_frames() {
    let dir = std::env::temp_dir().join(format!(
        "guild-daemon-hs-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("hs.sock");
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let handle = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut w = conn.try_clone().unwrap();
        // simulate a live broadcast racing the handshake
        let event = protocol::rpc::Event::new("stream.delta", json!({"content": "x"}));
        writeln!(w, "{}", serde_json::to_string(&event).unwrap()).unwrap();
        w.flush().unwrap();
        let resp = protocol::rpc::Response::ok(
            0,
            json!({"protocol": protocol::rpc::PROTOCOL_VERSION, "version": "t", "build": "t"}),
        );
        writeln!(w, "{}", serde_json::to_string(&resp).unwrap()).unwrap();
        w.flush().unwrap();
        // keep the connection open until the client is done reading
        std::thread::sleep(Duration::from_millis(300));
    });
    let conn = std::os::unix::net::UnixStream::connect(&sock).unwrap();
    let pair = Pair(Box::new(conn.try_clone().unwrap()), Box::new(conn), None);
    let pair = guild_app_server::daemon::handshake(pair).expect("handshake survives the event");
    drop(pair);
    handle.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
