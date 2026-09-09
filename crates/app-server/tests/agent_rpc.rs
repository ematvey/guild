use guild_app_server::jsonrpc_loop::{self, Session};
use serde_json::{json, Value};
use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
    let server = wiremock::MockServer::start().await;
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
