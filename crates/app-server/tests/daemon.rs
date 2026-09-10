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
fn temp_socket_attach() -> PathBuf {
    std::env::temp_dir().join(format!("guild-daemon-attach-test-{}.sock", std::process::id()))
}

fn req(id: u64, method: &str, params: Value) -> String {
    serde_json::to_string(&Request::new(id, method, params)).unwrap()
}

/// attach() must spawn the daemon binary when none is running, handshake
/// with it, and leave it alive (survives client exit).
#[test]
fn attach_spawns_and_survives_client_exit() {
    let path = temp_socket_attach();
    let _ = std::fs::remove_file(&path);
    std::env::set_var("GUILD_DAEMON_SOCKET", &path);

    let pair = guild_app_server::daemon::attach(std::path::Path::new(env!("CARGO_BIN_EXE_guild-app-server")))
        .expect("attach spawns and handshakes");
    let Pair(mut rd, mut wr) = pair;

    // use the connection, then drop it — the daemon must keep running
    writeln!(wr, "{}", req(1, "daemon.hello", json!({}))).unwrap();
    wr.flush().unwrap();
    let mut line = Vec::new();
    for b in rd.by_ref().bytes() {
        let b = b.unwrap();
        if b == b'\n' {
            break;
        }
        line.push(b);
    }
    let hello: Value = serde_json::from_slice(&line).unwrap();
    assert!(hello["result"]["version"].is_string());
    drop(rd);
    drop(wr);
    std::thread::sleep(Duration::from_millis(200));
    assert!(try_connect_at(&path).is_ok(), "daemon outlives its client");

    // clean up the spawned daemon via shutdown
    let pair = try_connect_at(&path).unwrap();
    let Pair(mut rd, mut wr) = pair;
    writeln!(wr, "{}", req(1, "daemon.shutdown", json!({}))).unwrap();
    wr.flush().unwrap();
    let mut line = Vec::new();
    for b in rd.by_ref().bytes() {
        let b = b.unwrap();
        if b == b'\n' {
            break;
        }
        line.push(b);
    }
    let _ = rd.read_to_end(&mut Vec::new());
    for _ in 0..50 {
        if !path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!path.exists(), "daemon removes its socket on shutdown");
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
        eprintln!("CLIENT CALL {method} id={id}");
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
    eprintln!("daemon finished? {}", daemon.is_finished());
    let mut b = Client::connect(&path);
    eprintln!("connected B; daemon finished? {}", daemon.is_finished());
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
    tokio::time::timeout(Duration::from_secs(5), daemon)
        .await
        .expect("daemon ends after shutdown")
        .expect("daemon task")
        .expect("daemon result");
    let _ = std::fs::remove_file(&path);
}

