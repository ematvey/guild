//! Client↔backend interop across the real process boundary — the same wire
//! the Tauri shell drives. Spawns the engine binary in its stdio JSON-RPC
//! mode (no args) and runs login → chat → session.info against a real
//! guild-server, asserting response correlation, event streaming, and
//! session persistence (isolated via XDG_CONFIG_HOME).
//!
//! No Tauri build, no webview, no display: `cargo test -p guild-app-server`.

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
    events: Receiver<Value>,
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
        // (have `id`, no `event`) correlate pending RPCs, everything else is
        // a server-push event.
        let (event_tx, event_rx) = channel();
        let (reply_tx, reply_rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if v.get("event").is_some() {
                    if event_tx.send(v).is_err() {
                        break;
                    }
                } else if reply_tx.send(v).is_err() {
                    break;
                }
            }
        });

        Self {
            child,
            stdin,
            next_id: 0,
            replies: Arc::new(Mutex::new(Vec::new())),
            events: event_rx,
            replies_rx: reply_rx,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let envelope = json!({
            "jsonrpc": "2.0", "id": id, "protocol": 1,
            "method": method, "params": params,
        });
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

    fn wait_event(&self, name: &str, timeout: std::time::Duration) -> Value {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                panic!("timed out waiting for event {name}");
            }
            match self.events.recv_timeout(deadline - now) {
                Ok(v) if v["event"] == name => return v,
                Ok(_) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for event {name}")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("engine stdout closed")
                }
            }
        }
    }

    fn drain_events(&self) {
        while self.events.try_recv().is_ok() {}
    }
}

impl Drop for EngineProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// login → chat.send → events → session.info, against a real server.
// Ignored: chat.send goes through the gateway → Restate ChatRunner, and
// test_support points restate_url at a placeholder. Un-ignore together with
// the agent_rpc tests once tests embed a Restate runtime.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test(flavor = "multi_thread")]
async fn engine_stdio_interop() {
    let srv = guild_server::test_support::serve_full().await;
    let mut engine = EngineProc::spawn();

    // login (persists the session under the isolated XDG_CONFIG_HOME)
    let res = engine
        .call(
            "login",
            json!({"base_url": srv.base_url, "email": "a@b.c", "password": "hunter226"}),
        )
        .expect("login");
    assert_eq!(res["user"]["email"], "a@b.c");

    // chat.send: correlated reply + streamed chat.delta/chat.done events
    let res = engine
        .call("chat.send", json!({"text": "greet", "model": srv.model}))
        .expect("chat.send");
    assert!(res["chat_id"].is_string());
    assert!(res["cost_usd"].as_f64().unwrap() > 0.0);
    assert_eq!(res["tokens_in"], 5);

    let delta = engine.wait_event("chat.delta", std::time::Duration::from_secs(30));
    assert_eq!(delta["payload"]["content"], "hi there");
    let done = engine.wait_event("chat.done", std::time::Duration::from_secs(30));
    assert!(done["payload"]["tokens_out"].as_i64().unwrap() > 0);

    // session.info reflects the login (same surface the GUI reads)
    let res = engine
        .call("session.info", json!({}))
        .expect("session.info");
    assert_eq!(res["email"], "a@b.c");
    assert_eq!(res["base_url"], srv.base_url);

    // session persisted to the isolated config dir (what a restarted GUI loads)
    let cfg = std::env::temp_dir().join(format!("guild-interop-{}", std::process::id()));
    let token_path = cfg.join("guild").join("token.json");
    let stored = std::fs::read_to_string(&token_path).expect("session file written");
    let stored: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["base_url"], srv.base_url);
    assert!(!stored["token"].as_str().unwrap().is_empty());

    engine.drain_events();
}

/// The full enrollment flow over the stdio wire: create a pairing token via
/// the HTTP API, redeem it through the engine's `pair` RPC, verify the
/// session (session.info) and its persistence.
#[tokio::test(flavor = "multi_thread")]
async fn engine_stdio_pair_flow() {
    let srv = guild_server::test_support::serve_full().await;
    // token issued to the bootstrapped admin at store level
    let created = srv
        .store()
        .pairing()
        .create(srv.org_id, srv.user_id, 30)
        .await
        .unwrap();

    let mut engine = EngineProc::spawn();
    let res = engine
        .call(
            "pair",
            json!({"code": format!("g1|{}|{}", srv.base_url, created.secret)}),
        )
        .expect("pair");
    assert_eq!(res["user"]["email"], "a@b.c");

    let info = engine
        .call("session.info", json!({}))
        .expect("session.info");
    assert_eq!(info["base_url"], srv.base_url);
    assert_eq!(info["email"], "a@b.c");

    // the redeemed session actually authenticates against the server
    let stored = std::fs::read_to_string(
        std::env::temp_dir()
            .join(format!("guild-interop-{}", std::process::id()))
            .join("guild")
            .join("token.json"),
    )
    .expect("session file written");
    let stored: Value = serde_json::from_str(&stored).unwrap();
    let client = reqwest::Client::new();
    let me = client
        .get(format!("{}/api/v1/auth/me", srv.base_url))
        .bearer_auth(stored["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 200);
}

/// Unknown methods produce a correlated error, not a hang or a crash.
#[tokio::test(flavor = "multi_thread")]
async fn engine_stdio_unknown_method_is_correlated_error() {
    let _srv = guild_server::test_support::serve_full().await;
    let mut engine = EngineProc::spawn();
    let err = engine.call("nope.method", json!({})).unwrap_err();
    assert!(err.contains("unknown method"), "got: {err}");
}

/// skills.prepare_turn expands `/name` mentions with the SKILL.md body and
/// renders the index — the web-chat counterpart of the engine's send
/// expansion. Skills come from the requested project dir's legacy scope
/// (`.guild/skills`), isolated from the real home via XDG_CONFIG_HOME.
#[tokio::test]
async fn engine_stdio_skills_prepare_turn_expands_mentions() {
    let _srv = guild_server::test_support::serve_full().await;
    let tmp = std::env::temp_dir().join(format!("guild-skills-{}", std::process::id()));
    let skill_dir = tmp.join(".guild/skills/deploy-check");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: deploy-check\ndescription: verify a deploy\n---\n\nRun the deploy checklist.",
    )
    .unwrap();
    let mut engine = EngineProc::spawn();
    let res = engine
        .call(
            "skills.prepare_turn",
            json!({ "prompt": "/deploy-check please", "project_dir": tmp.to_string_lossy() }),
        )
        .expect("prepare_turn reply");
    let expanded = res["prompt"].as_str().unwrap();
    assert!(expanded.starts_with("/deploy-check please\n\n---\nInvoked skills"), "{expanded}");
    assert!(expanded.contains("### Skill: deploy-check ("));
    assert!(expanded.contains("Run the deploy checklist."));
    assert!(res["index"].as_str().unwrap().contains("deploy-check"));
    let _ = std::fs::remove_dir_all(&tmp);
}
