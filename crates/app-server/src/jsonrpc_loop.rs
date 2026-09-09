//! JSON-RPC stdio loop — async, so agent runs and approvals proceed
//! concurrently (spec §3.2, §6). The UI-facing surface of the local engine.
//!
//! Methods: `login`, `chat.send` (plain chat), `agent.start`, `agent.approve`,
//! `agent.policy.set`, `agent.policy.get`. Streaming arrives as events.

use crate::agent_session::{AgentRun, PendingApprovals};
use crate::cloud::{collect_turn, CloudClient};
use crate::session_store::{save, StoredSession};
use anyhow::Context as _;
use guild_core::agent::policy::ApprovalPolicy;
use guild_core::tools::{Approval, ToolRegistry};
use protocol::api::Message;
use protocol::rpc::{Event, Request, Response, RpcError, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Default)]
pub struct Session {
    pub cloud: Option<CloudClient>,
    pub email: Option<String>,
    pub model: String,
    pub chat_id: Option<Uuid>,
    pub project_dir: Option<PathBuf>,
    /// Local working history; tool messages sync to the server after runs.
    pub messages: Vec<Message>,
    pub policy: ApprovalPolicy,
    pub pending: PendingApprovals,
}

enum Incoming {
    Request(Request),
    Malformed(String),
}

fn line_to_incoming(line: &str) -> Incoming {
    match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) if req.is_valid() => Incoming::Request(req),
        Ok(_) => Incoming::Malformed("bad jsonrpc/protocol fields".into()),
        Err(e) => Incoming::Malformed(format!("unparseable line: {e}")),
    }
}

fn response_value(id: u64, resp: anyhow::Result<Response>) -> Value {
    match resp {
        Ok(r) => serde_json::to_value(r).expect("response serializes"),
        Err(e) => serde_json::to_value(Response::err(
            id,
            RpcError::new(RpcError::APP_BASE, e.to_string()),
        ))
        .expect("error response serializes"),
    }
}

fn event_value(event: &str, payload: Value) -> Value {
    serde_json::to_value(Event::new(event, payload)).expect("event serializes")
}

/// Reads requests until EOF, handles them, writes responses/events to the
/// writer. Returns the (mutated) session and the writer back.
pub async fn serve<R, W>(reader: R, writer: W, session: Session) -> anyhow::Result<(Session, W)>
where
    R: std::io::Read + Send + 'static,
    W: std::io::Write + Send + 'static,
{
    // Reader thread → request channel (unbounded send is sync-safe).
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<Incoming>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(reader);
        use std::io::BufRead;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if req_tx.send(line_to_incoming(&line)).is_err() {
                break;
            }
        }
    });

    // Single ordered writer: responses and events both flow through here.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer_thread = std::thread::spawn(move || {
        let mut w = writer;
        while let Some(v) = out_rx.blocking_recv() {
            let _ = writeln!(w, "{v}");
            let _ = w.flush();
        }
        w
    });

    let session = Arc::new(Mutex::new(session));
    let mut agents: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();

    loop {
        match req_rx.recv().await {
            None => break,
            Some(Incoming::Malformed(msg)) => {
                let _ = out_tx.send(json!({
                    "protocol": PROTOCOL_VERSION, "event": "rpc.error",
                    "payload": {"message": msg},
                }));
            }
            Some(Incoming::Request(req)) => {
                // Sequential handling preserves ordering for dependent
                // calls (login before chat.send); only agent runs go to
                // the background.
                dispatch(session.clone(), req, out_tx.clone(), &mut agents).await;
            }
        }
    }
    // Let in-flight agent runs finish so their events are written.
    while agents.join_next().await.is_some() {}
    drop(out_tx); // closes the writer channel
    let writer = writer_thread.join().expect("writer thread");
    let session = match Arc::try_unwrap(session) {
        Ok(m) => m.into_inner().expect("session lock"),
        Err(_) => anyhow::bail!("session references still alive"),
    };
    Ok((session, writer))
}

async fn dispatch(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
    agents: &mut tokio::task::JoinSet<()>,
) {
    match req.method.as_str() {
        "login" => login_task(session, req, out_tx).await,
        "chat.send" => chat_send_task(session, req, out_tx).await,
        "agent.start" => {
            let _ = agents.spawn(agent_start_task(session, req, out_tx));
        }
        "agent.approve" => {
            tokio::spawn(agent_approve(session, req, out_tx));
        }
        "agent.policy.set" => policy_set(session, req, out_tx),
        "agent.policy.get" => policy_get(session, req, out_tx),
        other => {
            let _ = out_tx.send(response_value(
                req.id,
                Err(anyhow::anyhow!("unknown method {other}")),
            ));
        }
    }
}

fn param<'a>(req: &'a Request, key: &str) -> anyhow::Result<&'a str> {
    req.params[key].as_str().context(format!("missing {key}"))
}

async fn login_task(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let base_url = param(&req, "base_url")?.to_string();
        let email = param(&req, "email")?.to_string();
        let password = param(&req, "password")?.to_string();
        let (token, user) = CloudClient::login(&base_url, &email, &password).await?;
        {
            let mut s = session.lock().unwrap();
            s.cloud = Some(CloudClient {
                base_url: base_url.clone(),
                token: token.clone(),
            });
            s.email = Some(user.email.clone());
        }
        let path = crate::session_store::default_path()?;
        save(&path, &StoredSession { base_url, token })?;
        Ok(Response::ok(req.id, json!({"ok": true, "user": user})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

async fn chat_send_task(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let text = param(&req, "text")?.to_string();
        let (cloud, existing_chat, model) = {
            let mut s = session.lock().unwrap();
            let cloud = s.cloud.clone().context("not logged in — call login first")?;
            if s.model.is_empty() {
                s.model = req.params["model"].as_str().unwrap_or("gpt-4o-mini").to_string();
            }
            (cloud, s.chat_id, s.model.clone())
        };
        let chat_id = match existing_chat {
            Some(c) => c,
            None => {
                let c = cloud.create_chat(None).await?;
                session.lock().unwrap().chat_id = Some(c);
                c
            }
        };
        let stream = cloud.chat_stream(chat_id, &model, &[Message::user(text.clone())]).await?;
        let (full_text, done) = collect_turn(stream).await?;
        {
            let mut s = session.lock().unwrap();
            s.messages.push(Message::user(text));
            s.messages.push(Message {
                role: "assistant".into(),
                content: full_text.clone(),
                tool_calls: None,
                tool_call_id: None,
            });
        }
        let _ = out_tx.send(event_value("chat.delta", json!({"content": full_text})));
        let (message_id, cost_usd, tokens_in, tokens_out) = match done {
            Some(protocol::api::StreamEvent::Done { message_id, cost_usd, tokens_in, tokens_out }) => {
                (message_id, cost_usd, tokens_in, tokens_out)
            }
            _ => anyhow::bail!("stream ended without done event"),
        };
        let _ = out_tx.send(event_value(
            "chat.done",
            json!({"message_id": message_id, "cost_usd": cost_usd, "tokens_in": tokens_in, "tokens_out": tokens_out}),
        ));
        Ok(Response::ok(
            req.id,
            json!({"chat_id": chat_id, "message_id": message_id, "cost_usd": cost_usd, "tokens_in": tokens_in, "tokens_out": tokens_out}),
        ))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

/// Starts an agent run in the background: creates the chat if needed,
/// responds immediately with `started`, streams progress as events.
async fn agent_start_task(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    // (cloud, existing chat, project dir, model, history, policy, pending approvals)
    type AgentPrep = (
        CloudClient,
        Option<Uuid>,
        PathBuf,
        String,
        Vec<Message>,
        ApprovalPolicy,
        PendingApprovals,
    );
    let prep = || -> anyhow::Result<AgentPrep> {
        let mut s = session.lock().unwrap();
        let cloud = s
            .cloud
            .clone()
            .context("not logged in — call login first")?;
        if let Some(d) = req.params["project_dir"].as_str() {
            s.project_dir = Some(PathBuf::from(d));
        }
        let project_dir = s
            .project_dir
            .clone()
            .context("missing project_dir — pass it in agent.start params")?;
        if let Some(m) = req.params["model"].as_str() {
            s.model = m.to_string();
        }
        if s.model.is_empty() {
            s.model = "gpt-4o-mini".into();
        }
        let prompt = param(&req, "prompt")?.to_string();
        let mut history = s.messages.clone();
        history.push(Message::user(prompt));
        Ok((
            cloud,
            s.chat_id,
            project_dir,
            s.model.clone(),
            history,
            s.policy.clone(),
            s.pending.clone(),
        ))
    };
    let (cloud, chat_id_opt, project_dir, model, history, policy, pending) = match prep() {
        Ok(p) => p,
        Err(e) => {
            let _ = out_tx.send(response_value(req.id, Err(e)));
            return;
        }
    };

    // ensure chat exists
    let chat_id = match chat_id_opt {
        Some(c) => c,
        None => match cloud.create_chat(Some("agent")).await {
            Ok(c) => {
                session.lock().unwrap().chat_id = Some(c);
                c
            }
            Err(e) => {
                let _ = out_tx.send(response_value(
                    req.id,
                    Err(anyhow::anyhow!("chat create failed: {e}")),
                ));
                return;
            }
        },
    };
    let _ = out_tx.send(
        serde_json::to_value(Response::ok(
            req.id,
            json!({"started": true, "chat_id": chat_id}),
        ))
        .unwrap(),
    );

    // run the agent loop; events stream through out_tx
    let run = AgentRun {
        cloud: cloud.clone(),
        chat_id,
        project_dir,
        model,
        system: None, // skills index lands in Task 7
        history,
        policy,
        events: out_tx.clone(),
        pending,
    };
    let updated = run
        .spawn(ToolRegistry::builtins())
        .await
        .unwrap_or_default();

    session.lock().unwrap().messages = updated;
}

/// Resolves a pending approval. Polls briefly so an approve that races the
/// registration (UI sends immediately after the event) still lands.
async fn agent_approve(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let request_id = match param(&req, "request_id") {
        Ok(r) => r.to_string(),
        Err(e) => {
            let _ = out_tx.send(response_value(req.id, Err(e)));
            return;
        }
    };
    let decision = match param(&req, "decision") {
        Ok("approve") => guild_core::agent::ApprovalDecision::Approve,
        Ok("deny") => guild_core::agent::ApprovalDecision::Deny {
            reason: req.params["reason"]
                .as_str()
                .unwrap_or("denied")
                .to_string(),
        },
        Ok(other) => {
            let _ = out_tx.send(response_value(
                req.id,
                Err(anyhow::anyhow!("unknown decision {other}")),
            ));
            return;
        }
        Err(e) => {
            let _ = out_tx.send(response_value(req.id, Err(e)));
            return;
        }
    };
    let mut sender = None;
    for _ in 0..100 {
        sender = session
            .lock()
            .unwrap()
            .pending
            .lock()
            .unwrap()
            .remove(&request_id);
        if sender.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let result = match sender {
        Some(tx) => match tx.send(decision) {
            Ok(()) => Ok(Response::ok(req.id, json!({}))),
            Err(_) => Err(anyhow::anyhow!("approval already resolved")),
        },
        None => Err(anyhow::anyhow!("no such pending approval: {request_id}")),
    };
    let _ = out_tx.send(response_value(req.id, result));
}

fn policy_set(session: Arc<Mutex<Session>>, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = (|| {
        let tool = param(&req, "tool")?.to_string();
        let policy: Approval = serde_json::from_value(req.params["policy"].clone())
            .context("policy must be allow|ask|never")?;
        session
            .lock()
            .unwrap()
            .policy
            .overrides
            .insert(tool, policy);
        Ok(Response::ok(req.id, json!({})))
    })();
    let _ = out_tx.send(response_value(req.id, result));
}

fn policy_get(session: Arc<Mutex<Session>>, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let policy = session.lock().unwrap().policy.clone();
    let _ = out_tx.send(
        serde_json::to_value(Response::ok(req.id, serde_json::to_value(&policy).unwrap())).unwrap(),
    );
}
