//! Daemon integration tests (plan milestone-8, Task 2): bind/single-instance,
//! shared state across connections, survival across client disconnects,
//! hello handshake, client-issued shutdown.

#![cfg(unix)]
use guild_app_server::daemon::{run_daemon_on, try_connect_at, Pair};
use guild_app_server::jsonrpc_loop::Session;
use protocol::rpc::Request;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
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

fn temp_socket_attach() -> PathBuf {
    std::env::temp_dir().join(format!("guild-daemon-attach-test-{}.sock", std::process::id()))
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
    let err = guild_app_server::daemon::attach(std::path::Path::new(
        env!("CARGO_BIN_EXE_guild-app-server"),
    ))
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

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let dpath = path.clone();
    rt.spawn(async move { run_daemon_on(dpath, Session::default()).await });
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

    let dpath = path.clone();
    let daemon = tokio::spawn(async move { run_daemon_on(dpath, Session::default()).await });

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
    a.call("agent.policy.set", json!({"tool": "execute", "policy": "allow"}));
    let got = b.call("agent.policy.get", json!({}));
    assert_eq!(got["result"]["overrides"]["execute"], "allow");

    // 3. client disconnect leaves the daemon (and B) working
    drop(a);
    let got = b.call("agent.policy.get", json!({}));
    assert!(got.get("error").is_none());

    // 4. a second bind on the same endpoint exits quietly (single instance)
    let r = run_daemon_on(path.clone(), Session::default()).await;
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
    let pair = Pair(
        Box::new(conn.try_clone().unwrap()),
        Box::new(conn),
        None,
    );
    let pair = guild_app_server::daemon::handshake(pair).expect("handshake survives the event");
    drop(pair);
    handle.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
