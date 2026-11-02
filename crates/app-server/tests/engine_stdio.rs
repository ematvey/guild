//! Client↔backend interop across the real process boundary — the same wire
//! the Tauri shell drives. Spawns the engine binary in its stdio JSON-RPC
//! mode (no args) and runs pairing → session.info against a hand-rolled
//! mock backend, asserting response correlation and session persistence
//! (isolated via XDG_CONFIG_HOME).
//!
//! No Tauri build, no webview, no display: `cargo test -p guild-app-server`.

use protocol::rpc::Request;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};

struct EngineProc {
    child: Child,
    stdin: ChildStdin,
    next_id: u64,
    replies: Arc<Mutex<Vec<(u64, Value)>>>,
    replies_rx: Receiver<Value>,
}

impl EngineProc {
    fn spawn() -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_guild-app-server"))
            .env(
                "XDG_CONFIG_HOME",
                std::env::temp_dir().join(format!("guild-interop-{}", std::process::id())),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn engine");
        let mut child = child;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");

        // Demux engine stdout exactly like the Tauri bridge does: responses
        // (have `id`, no `event`) correlate pending RPCs, server-push events
        // are drained (the loop must keep reading stdout or the child
        // blocks).
        let (reply_tx, reply_rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if v.get("event").is_some() {
                    continue;
                }
                if reply_tx.send(v).is_err() {
                    break;
                }
            }
        });

        Self {
            child,
            stdin,
            next_id: 0,
            replies: Arc::new(Mutex::new(Vec::new())),
            replies_rx: reply_rx,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let envelope = serde_json::to_string(&Request::new(id, method, params)).unwrap();
        writeln!(self.stdin, "{envelope}").expect("write to engine stdin");
        self.stdin.flush().expect("flush");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            // NB: take-and-remove under ONE explicit scope — an `if let`
            // scrutinee guard would stay alive through the success block
            // (edition 2021) and self-deadlock on the second lock.
            let matched = {
                let mut replies = self.replies.lock().unwrap();
                let pos = replies.iter().position(|(i, _)| *i == id);
                pos.map(|p| replies.remove(p))
            };
            if let Some((_, v)) = matched {
                if let Some(err) = v.get("error") {
                    return Err(err["message"].as_str().unwrap_or("engine error").into());
                }
                return Ok(v["result"].clone());
            }
            let v = self.recv_reply(deadline);
            let rid = v["id"].as_u64().expect("reply id");
            self.replies.lock().unwrap().push((rid, v));
        }
    }

    fn recv_reply(&self, deadline: std::time::Instant) -> Value {
        let now = std::time::Instant::now();
        assert!(now < deadline, "timed out waiting for engine reply");
        match self.replies_rx.recv_timeout(deadline - now) {
            Ok(v) => v,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("timed out waiting for engine reply")
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("engine stdout closed"),
        }
    }
}

impl Drop for EngineProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The full enrollment flow over the stdio wire: redeem a pairing code
/// through the engine's `pair` RPC against a mock backend, verify the
/// session (session.info) and its persistence, and confirm the persisted
/// token is the one the mock issued (the mock answers auth/me only for it).
#[tokio::test(flavor = "multi_thread")]
async fn engine_stdio_pair_flow() {
    use protocol::api::{PairResponse, UserInfo};
    let issued_token = "paired-token-1";
    let user = UserInfo {
        id: uuid::Uuid::now_v7(),
        email: "a@b.c".into(),
        org_id: uuid::Uuid::now_v7(),
        role: "member".into(),
        display_name: None,
        avatar_url: None,
        onboarded: true,
    };
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/v1/auth/pair"))
        .respond_with({
            let pair = PairResponse {
                token: issued_token.into(),
                user: user.clone(),
            };
            move |_: &wiremock::Request| {
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::to_value(&pair).unwrap())
            }
        })
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/api/v1/auth/me"))
        .and(wiremock::matchers::header(
            "authorization",
            format!("Bearer {issued_token}"),
        ))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"user": user})),
        )
        .mount(&server)
        .await;
    let base_url = server.uri();

    let mut engine = EngineProc::spawn();
    let res = engine
        .call(
            "pair",
            json!({"code": format!("g1|{}|{}", base_url, "a1b2c3")}),
        )
        .expect("pair");
    assert_eq!(res["user"]["email"], "a@b.c");

    let info = engine
        .call("session.info", json!({}))
        .expect("session.info");
    assert_eq!(info["base_url"], base_url);
    assert_eq!(info["email"], "a@b.c");

    // the persisted session carries exactly the token the mock issued
    let stored = std::fs::read_to_string(
        std::env::temp_dir()
            .join(format!("guild-interop-{}", std::process::id()))
            .join("guild")
            .join("token.json"),
    )
    .expect("session file written");
    let stored: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["base_url"], base_url);
    assert_eq!(stored["token"], issued_token);
    let client = reqwest::Client::new();
    let me = client
        .get(format!("{}/api/v1/auth/me", base_url))
        .bearer_auth(stored["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 200);
}

/// Unknown methods produce a correlated error, not a hang or a crash.
#[tokio::test(flavor = "multi_thread")]
async fn engine_stdio_unknown_method_is_correlated_error() {
    let mut engine = EngineProc::spawn();
    let err = engine.call("nope.method", json!({})).unwrap_err();
    assert!(err.contains("unknown method"), "got: {err}");
}

/// A request that carries an id but fails validation gets an error
/// response with that id, not an uncorrelated event.
#[tokio::test(flavor = "multi_thread")]
async fn engine_stdio_invalid_request_with_an_id_is_answered() {
    let mut engine = EngineProc::spawn();
    writeln!(
        engine.stdin,
        r#"{{"jsonrpc":"1.0","id":77,"method":"engine.hello"}}"#
    )
    .expect("write to engine stdin");
    engine.stdin.flush().expect("flush");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let reply = engine.recv_reply(deadline);
    assert_eq!(reply["id"], 77);
    assert_eq!(reply["error"]["code"], -32600, "got: {reply}");
}
