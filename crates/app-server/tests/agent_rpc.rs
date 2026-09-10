use guild_app_server::jsonrpc_loop::{self, Session};
use serde_json::{json, Value};
use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Collision-proof loopback listener: skip ports referenced in /proc/net/tcp{,6}
/// (docker-proxy wildcard binds are invisible to bind(0) with SO_REUSEADDR).
async fn standalone_listener() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut ports = std::collections::HashSet::<u16>::new();
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines().skip(1) {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    if fields.len() > 1 {
                        if let Some(p) = fields[1].rsplit(':').next().and_then(|p| p.parse().ok()) {
                            ports.insert(p);
                        }
                    }
                }
            }
        }
        if !ports.contains(&port) {
            return listener;
        }
    }
}

fn collect_lines(buf: &[u8]) -> Vec<Value> {
    String::from_utf8(buf.to_vec())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn sse(body: &str) -> wiremock::ResponseTemplate {
    wiremock::ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body.to_string())
}

/// Writer that records bytes and mirrors COMPLETE lines to a channel, so the
/// test can observe events mid-run (like a real UI would).
#[derive(Clone)]
struct Tee {
    buf: Arc<Mutex<Vec<u8>>>,
    tx: std::sync::mpsc::Sender<String>,
    line_buf: Arc<Mutex<String>>,
}

impl std::io::Write for Tee {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.lock().unwrap().extend_from_slice(data);
        let mut pending = self.line_buf.lock().unwrap();
        pending.push_str(&String::from_utf8_lossy(data));
        while let Some(pos) = pending.find('\n') {
            let line: String = pending.drain(..=pos).collect();
            let _ = self.tx.send(line);
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Provider script: first call asks to run a command; second call concludes.
async fn scripted_provider() -> wiremock::MockServer {
    let server = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_moved = calls.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_req: &wiremock::Request| {
            let n = calls_moved.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                sse(concat!(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"cmd1\",\"function\":{\"name\":\"run_command\",\"arguments\":\"{\\\"command\\\":\\\"echo hello-from-tool\\\"}\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                    "data: [DONE]\n\n",
                ))
            } else {
                sse(concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"the command was denied\"}}]}\n\n",
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
                    "data: [DONE]\n\n",
                ))
            }
        })
        .mount(&server)
        .await;
    server
}

fn login_line(base_url: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "protocol": 1, "method": "login",
           "params": {"base_url": base_url, "email": "a@b.c", "password": "hunter226"}})
}

fn isolate_config(tag: &str) {
    let tmp = std::env::temp_dir().join(format!("guild-agent-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &tmp);
}

// Ignored: the gateway routes agent chat through the Restate ChatRunner
// workflow, but test_support points restate_url at a placeholder — these tests
// hang (approval never arrives) or fail (no tool_result). Un-ignore once test
// support embeds a Restate runtime for ChatRunner.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_start_streams_tool_flow_with_approval_deny() {
    eprintln!("[test] start");
    let fake = scripted_provider().await;
    eprintln!("[test] provider up");
    let srv = guild_server::test_support::serve_full().await;
    eprintln!("[test] stack up");
    let master = srv.state.config.master_key().unwrap();
    srv.store()
        .gateway()
        .upsert_provider_key(srv.org_id, "openai", &fake.uri(), "sk-test", &master)
        .await
        .unwrap();
    eprintln!("[test] key seeded");

    let project = std::env::temp_dir().join(format!("guild-agent-proj-{}", std::process::id()));
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("README.md"), "scratch").unwrap();
    isolate_config("deny");

    let (pipe_r, mut pipe_w) = std::io::pipe().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tee = Tee {
        buf: Arc::new(Mutex::new(Vec::new())),
        tx,
        line_buf: Arc::new(Mutex::new(String::new())),
    };

    // Prelude goes through the pipe itself; the approver gets its own clone
    // and closes it after acting, so the engine eventually sees EOF.
    for r in [
        login_line(&srv.base_url),
        json!({"jsonrpc": "2.0", "id": 2, "protocol": 1, "method": "agent.start",
               "params": {"project_dir": project.to_str().unwrap(), "prompt": "run the command", "model": "gpt-test"}}),
    ] {
        pipe_w.write_all(format!("{r}\n").as_bytes()).unwrap();
    }
    pipe_w.flush().unwrap();
    let mut approver_w = pipe_w.try_clone().unwrap();
    drop(pipe_w); // prelude writer no longer needed

    // Approver: watch events; when an approval request arrives, deny it.
    let approver = std::thread::spawn(move || {
        while let Ok(line) = rx.recv() {
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if v.get("event").and_then(|e| e.as_str()) == Some("agent.approval_request") {
                let rid = v["payload"]["request_id"].as_str().unwrap().to_string();
                let line = json!({"jsonrpc": "2.0", "id": 3, "protocol": 1, "method": "agent.approve",
                                  "params": {"request_id": rid, "decision": "deny", "reason": "no"}});
                approver_w
                    .write_all(format!("{line}\n").as_bytes())
                    .unwrap();
                approver_w.flush().unwrap();
                break; // close the approver's writer clone
            }
        }
    });

    let (session, writer) = jsonrpc_loop::serve(pipe_r, tee, Session::default())
        .await
        .unwrap();
    let msgs = collect_lines(&writer.buf.lock().unwrap());
    drop(writer); // releases the tee sender so the approver's channel closes
    approver.join().unwrap();
    let _ = session;

    // started response
    let started = msgs
        .iter()
        .find(|m| m.get("id") == Some(&json!(2)))
        .expect("agent.start response");
    assert_eq!(started["result"]["started"], true);
    let chat_id = started["result"]["chat_id"].as_str().unwrap();

    // event sequence: tool_call, approval_request, tool_result(denied), text, done
    let events: Vec<&Value> = msgs.iter().filter(|m| m.get("event").is_some()).collect();
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"agent.tool_call"), "{kinds:?}");
    assert!(kinds.contains(&"agent.approval_request"), "{kinds:?}");
    assert!(kinds.contains(&"agent.tool_result"), "{kinds:?}");
    assert!(kinds.contains(&"agent.done"), "{kinds:?}");

    let denied = events
        .iter()
        .find(|e| e["event"] == "agent.tool_result")
        .unwrap();
    assert!(denied["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("denied by user"));

    let final_text = events
        .iter()
        .filter(|e| e["event"] == "agent.text")
        .map(|e| e["payload"]["content"].as_str().unwrap())
        .collect::<String>();
    assert_eq!(final_text, "the command was denied");

    // durable record: user, assistant(tool_calls), tool, assistant
    let chat: uuid::Uuid = chat_id.parse().unwrap();
    let rec = srv
        .store()
        .chats()
        .list_messages(srv.org_id, chat)
        .await
        .unwrap();
    let roles: Vec<&str> = rec.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(
        roles,
        vec!["user", "assistant", "tool", "assistant"],
        "{rec:?}"
    );
    assert!(rec[1].tool_calls.is_some());
    assert!(rec[2].tool_call_id.is_some());

    std::fs::remove_dir_all(&project).ok();
}

// See the ignore note on agent_start_streams_tool_flow_with_approval_deny.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_never_skips_approval_entirely() {
    let fake = scripted_provider().await;
    let srv = guild_server::test_support::serve_full().await;
    let master = srv.state.config.master_key().unwrap();
    srv.store()
        .gateway()
        .upsert_provider_key(srv.org_id, "openai", &fake.uri(), "sk-test", &master)
        .await
        .unwrap();

    let project = std::env::temp_dir().join(format!("guild-agent-pol-{}", std::process::id()));
    std::fs::create_dir_all(&project).unwrap();
    isolate_config("never");

    let (pipe_r, mut pipe_w) = std::io::pipe().unwrap();
    let (tx, _rx) = std::sync::mpsc::channel::<String>();
    let tee = Tee {
        buf: Arc::new(Mutex::new(Vec::new())),
        tx,
        line_buf: Arc::new(Mutex::new(String::new())),
    };

    for r in [
        login_line(&srv.base_url),
        json!({"jsonrpc": "2.0", "id": 4, "protocol": 1, "method": "agent.policy.set",
               "params": {"tool": "run_command", "policy": "never"}}),
        json!({"jsonrpc": "2.0", "id": 2, "protocol": 1, "method": "agent.start",
               "params": {"project_dir": project.to_str().unwrap(), "prompt": "run the command", "model": "gpt-test"}}),
    ] {
        pipe_w.write_all(format!("{r}\n").as_bytes()).unwrap();
    }
    pipe_w.flush().unwrap();
    drop(pipe_w); // no approvals expected — close the pipe

    let (_session, writer) = jsonrpc_loop::serve(pipe_r, tee, Session::default())
        .await
        .unwrap();
    let msgs = collect_lines(&writer.buf.lock().unwrap());

    let events: Vec<&Value> = msgs.iter().filter(|m| m.get("event").is_some()).collect();
    assert!(
        !events
            .iter()
            .any(|e| e["event"] == "agent.approval_request"),
        "never-policy must not ask"
    );
    let denied = events
        .iter()
        .find(|e| e["event"] == "agent.tool_result")
        .expect("tool result");
    assert!(denied["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("disabled by policy"));
    std::fs::remove_dir_all(&project).ok();
}

// ===== Task 1: two connections over one Shared (daemon groundwork) =====

/// Fake org-gateway: covers exactly the CloudClient endpoints the agent path
/// touches (login, create chat, scripted completion stream, tool-message
/// sink), so agent runs are hermetic without a Restate runtime. Frames are
/// gateway StreamEvents (not raw provider chunks) — the same wire
/// CloudClient::stream_completion parses.
async fn fake_cloud() -> wiremock::MockServer {
    let server = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/v1/auth/login"))
        .respond_with(move |_req: &wiremock::Request| {
            wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "token": "fake-token",
                "user": {"id": uuid::Uuid::now_v7(), "email": "a@b.c",
                         "org_id": uuid::Uuid::now_v7(), "role": "admin"},
            }))
        })
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/v1/chats"))
        .respond_with(move |_req: &wiremock::Request| {
            wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "id": uuid::Uuid::now_v7(), "org_id": uuid::Uuid::now_v7(),
                "user_id": uuid::Uuid::now_v7(), "created_at": "2026-01-01T00:00:00Z",
            }))
        })
        .mount(&server)
        .await;
    // Completion stream: call 1 requests a tool, call 2 concludes in text.
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_moved = calls.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/v1/gateway/chat"))
        .respond_with(move |_req: &wiremock::Request| {
            let n = calls_moved.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                sse(concat!(
                    "data: {\"type\":\"tool_call_done\",\"call\":{\"id\":\"cmd1\",\"name\":\"run_command\",\"arguments\":{\"command\":\"echo hello-from-tool\"}}}\n\n",
                ))
            } else {
                sse(concat!(
                    "data: {\"type\":\"delta\",\"content\":\"all done\"}\n\n",
                    "data: {\"type\":\"done\",\"message_id\":\"00000000-0000-0000-0000-000000000000\",\"cost_usd\":0.1,\"tokens_in\":5,\"tokens_out\":2}\n\n",
                ))
            }
        })
        .mount(&server)
        .await;
    // Tool-result sink (fire and forget for the fake).
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path_regex(r"^/api/v1/chats/.+/messages$"))
        .respond_with(move |_req: &wiremock::Request| wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    server
}

/// First Value matching a predicate, from the buffered lines then the live
/// channel, with a deadline.
fn wait_matching<F>(
    rx: &std::sync::mpsc::Receiver<Value>,
    seen: &mut Vec<Value>,
    mut pred: F,
    what: &str,
) -> Value
where
    F: FnMut(&Value) -> bool,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Some(v) = seen.iter().find(|v| pred(v)) {
            return v.clone();
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            panic!("timed out waiting for {what}; seen: {seen:?}");
        }
        match rx.recv_timeout(deadline - now) {
            Ok(v) => seen.push(v),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("timed out waiting for {what}; seen: {seen:?}")
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("reader closed while waiting for {what}")
            }
        }
    }
}

fn wait_response(
    rx: &std::sync::mpsc::Receiver<Value>,
    seen: &mut Vec<Value>,
    id: u64,
) -> Value {
    wait_matching(rx, seen, |v| v.get("id") == Some(&json!(id)), &format!("response {id}"))
}

fn wait_event(
    rx: &std::sync::mpsc::Receiver<Value>,
    seen: &mut Vec<Value>,
    event: &str,
) -> Value {
    wait_matching(rx, seen, |v| v.get("event").and_then(|e| e.as_str()) == Some(event), event)
}

/// Two connections over one Shared see each other's mutations and both
/// receive broadcast events. This is the property the daemon needs.
#[test]
fn two_connections_share_state_and_events() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let shared = jsonrpc_loop::Shared::new(Session::default());

        // One duplex pipe pair per connection: run_connection owns `s_*`
        // (read half cloned for its reader thread), the test client holds
        // the other end `c_*` (read half cloned for its reader thread).
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

        // Reader threads feed parsed lines into channels for the assertions.
        let (a_tx, a_rx) = std::sync::mpsc::channel::<Value>();
        let ca_read = ca.try_clone().unwrap();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(ca_read).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if a_tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        let (b_tx, b_rx) = std::sync::mpsc::channel::<Value>();
        let cb_read = cb.try_clone().unwrap();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(cb_read).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if b_tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });

        let send = |w: &std::os::unix::net::UnixStream, v: &Value| {
            use std::io::Write as _;
            let mut w = w;
            w.write_all(format!("{v}\n").as_bytes()).unwrap();
            w.flush().unwrap();
        };

        isolate_config("shared-two-conn");
        let cloud = fake_cloud().await;

        let mut seen_a = Vec::new();
        let mut seen_b = Vec::new();

        // login on A so agent.start finds a cloud client
        send(&ca, &json!({"jsonrpc": "2.0", "id": 1, "protocol": 1, "method": "login",
             "params": {"base_url": cloud.uri(), "email": "a@b.c", "password": "hunter226"}}));
        let resp = wait_response(&a_rx, &mut seen_a, 1);        assert!(resp.get("error").is_none(), "{resp}");

        // 1. A sets a policy override
        send(&ca, &json!({"jsonrpc": "2.0", "id": 2, "protocol": 1, "method": "agent.policy.set",
             "params": {"tool": "run_command", "policy": "allow"}}));
        let resp = wait_response(&a_rx, &mut seen_a, 2);
        assert!(resp.get("error").is_none(), "{resp}");

        // 2. B reads it back — same Shared, same Session
        send(&cb, &json!({"jsonrpc": "2.0", "id": 3, "protocol": 1,
             "method": "agent.policy.get", "params": {}}));
        let resp = wait_response(&b_rx, &mut seen_b, 3);
        assert_eq!(resp["result"]["overrides"]["run_command"], "allow", "{resp}");

        // 3. A starts an agent run; BOTH readers see the same event lines
        //    (broadcast fan-out, not per-connection plumbing).
        let project = std::env::temp_dir().join(format!("guild-shared-proj-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();
        send(&ca, &json!({"jsonrpc": "2.0", "id": 4, "protocol": 1, "method": "agent.start",
             "params": {"project_dir": project.to_str().unwrap(), "prompt": "run the command", "model": "gpt-test"}}));
        let resp = wait_response(&a_rx, &mut seen_a, 4);
        assert_eq!(resp["result"]["started"], true, "{resp}");

        for (rx, seen) in [(&a_rx, &mut seen_a), (&b_rx, &mut seen_b)] {
            let tc = wait_event(rx, seen, "agent.tool_call");
            assert_eq!(tc["payload"]["name"], "run_command", "{tc}");
            let text = wait_event(rx, seen, "agent.text");
            assert_eq!(text["payload"]["content"], "all done", "{text}");
            wait_event(rx, seen, "agent.done");
        }

        // 4. A disconnects (EOF); B keeps working over the same Shared.
        // NB: shutdown(Both), not just drop — the client reader thread still
        // holds a clone of this end, and a socketpair only signals EOF when
        // the whole end is shut down.
        ca.shutdown(std::net::Shutdown::Both).unwrap();
        drop(ca);
        c1.await.unwrap().expect("A's connection ends cleanly on EOF");
        send(&cb, &json!({"jsonrpc": "2.0", "id": 5, "protocol": 1,
             "method": "session.info", "params": {}}));
        let resp = wait_response(&b_rx, &mut seen_b, 5);
        assert!(resp.get("error").is_none(), "{resp}");
        assert_eq!(resp["result"]["email"], "a@b.c");

        cb.shutdown(std::net::Shutdown::Both).unwrap();
        drop(cb);
        c2.await.unwrap().expect("B's connection ends cleanly");
        std::fs::remove_dir_all(&project).ok();
    });
}
