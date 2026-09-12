//! JSON-RPC stdio loop — async, so agent runs and approvals proceed
//! concurrently (spec §3.2, §6). The UI-facing surface of the local engine.
//!
//! Methods: `login`, `chat.send` (plain chat), `agent.start`, `agent.approve`,
//! `agent.policy.set`, `agent.policy.get`. Streaming arrives as events.

use crate::agent_session::{AgentRun, PendingApprovals};
use crate::cloud::{collect_turn, CloudClient, CloudError};
use crate::session_store::{save, StoredSession};
use anyhow::Context as _;
use guild_core::agent::policy::ApprovalPolicy;
use guild_core::tools::{Approval, ToolRegistry};
use protocol::api::Message;
use protocol::rpc::{Event, Request, Response, RpcError, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};
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

/// Engine state shared by every client connection (daemon groundwork):
/// one Session, one event fan-out, one agent JoinSet, one shutdown flag.
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

/// Restores a persisted session (token.json) into a fresh Session, so an
/// app restart or a GUI engine re-spawn keeps auth. A dead token is
/// dropped, a transient network failure is not.
pub async fn restored_session() -> anyhow::Result<Session> {
    let mut session = Session::default();
    if let Some(stored) = crate::session_store::load(&crate::session_store::default_path()?) {
        let cloud = CloudClient {
            base_url: stored.base_url.clone(),
            token: stored.token,
        };
        match cloud.me().await {
            Ok(user) => {
                session.email = Some(user.email.clone());
                session.cloud = Some(cloud.clone());
                // upgrade old stores that lacked the email
                if stored.email.is_none() {
                    crate::session_store::save(
                        &crate::session_store::default_path()?,
                        &crate::session_store::StoredSession {
                            base_url: stored.base_url,
                            token: cloud.token,
                            email: Some(user.email),
                        },
                    )?;
                }
            }
            Err(CloudError::Unauthorized) => {
                let _ = crate::session_store::clear(&crate::session_store::default_path()?);
            }
            Err(_) => {
                // offline or server briefly down: keep the token
                session.cloud = Some(cloud);
                session.email = stored.email;
            }
        }
    }
    anyhow::Ok(session)
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
/// writer. Returns the (mutated) session and the writer back. Thin wrapper:
/// one Shared, one connection.
pub async fn serve<R, W>(reader: R, writer: W, session: Session) -> anyhow::Result<(Session, W)>
where
    R: std::io::Read + Send + 'static,
    W: std::io::Write + Send + 'static,
{
    let shared = Shared::new(session);
    let mut writer = run_connection(&shared, reader, writer).await?;
    // The client has EOF'd; in-flight agent runs must still get their
    // events written (as the pre-refactor serve() did). run_connection
    // forwards the events its own subscriber buffered around EOF (its join
    // blocks until the agent tasks finish). Subscribing here as well,
    // BEFORE draining, covers any run still alive past run_connection, so
    // its events are buffered instead of dropped; drain the JoinSet, then
    // forward whatever was buffered to the writer.
    let mut event_rx = shared.events.subscribe();
    // tokio Mutex: the guard is held across .await here.
    while shared.agents.lock().await.join_next().await.is_some() {}
    loop {
        match event_rx.try_recv() {
            Ok(v) => {
                let _ = writeln!(writer, "{v}");
                let _ = writer.flush();
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
        }
    }
    let session = match Arc::try_unwrap(shared.session) {
        Ok(m) => m.into_inner().expect("session lock"),
        Err(_) => anyhow::bail!("session references still alive"),
    };
    Ok((session, writer))
}

/// One client connection: reads requests, dispatches onto `shared`,
/// writes responses for THIS connection plus all broadcast events.
/// Returns the writer when the client disconnects (EOF) — never on error
/// conditions that should keep the daemon alive.
pub async fn run_connection<R, W>(shared: &Shared, reader: R, writer: W) -> anyhow::Result<W>
where
    R: std::io::Read + Send + 'static,
    W: std::io::Write + Send + 'static,
{
    // Reader thread → request channel (unbounded send is sync-safe).
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<Incoming>();
    std::thread::spawn(move || {
        crate::dtrace::dtrace("conn: reader thread started");
        let reader = std::io::BufReader::new(reader);
        use std::io::BufRead;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            crate::dtrace::dtrace(&format!("conn: reader got {} bytes: {}", line.len(), &line.chars().take(120).collect::<String>()));
            if req_tx.send(line_to_incoming(&line)).is_err() {
                break;
            }
        }
        crate::dtrace::dtrace("conn: reader thread exited (EOF or error)");
    });

    // Single ordered writer: responses and events both flow through here.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer_thread = std::thread::spawn(move || {
        let mut w = writer;
        crate::dtrace::dtrace("conn: writer thread started");
        while let Some(v) = out_rx.blocking_recv() {
            crate::dtrace::dtrace(&format!("conn: writer writing {} bytes: {}", v.to_string().len(), &v.to_string().chars().take(120).collect::<String>()));
            let t0 = std::time::Instant::now();
            let r = writeln!(w, "{v}");
            let f = w.flush();
            crate::dtrace::dtrace(&format!("conn: writer done in {:?} writeln={:?} flush={:?}", t0.elapsed(), r.is_ok(), f.is_ok()));
        }
        crate::dtrace::dtrace("conn: writer thread exiting (out_tx dropped)");
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
    let mut writer = writer_thread.join().expect("writer thread");
    // Post-EOF event delivery: the join above blocks until in-flight agent
    // tasks finish (they hold out_tx clones), and those tasks broadcast
    // events after EOF with this connection's subscriber no longer polled —
    // the events sit unread in event_rx's buffer. Forward them before
    // returning the writer, so delivery matches the pre-refactor serve()
    // (which wrote them through the still-open out_tx).
    loop {
        match event_rx.try_recv() {
            Ok(v) => {
                let _ = writeln!(writer, "{v}");
                let _ = writer.flush();
            }
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Closed) => break,
            Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
        }
    }
    Ok(writer)
}

async fn dispatch(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let t0 = std::time::Instant::now();
    let method = req.method.clone();
    let rid = req.id;
    crate::dtrace::dtrace(&format!("dispatch: START {} id={:?}", method, rid));
    match req.method.as_str() {
        "login" => login_task(shared.session.clone(), req, out_tx).await,
        "pair" => pair_task(shared.session.clone(), req, out_tx).await,
        "chat.send" => chat_send_task(shared.clone(), req, out_tx).await,
        "machine.info" => {
            // Hostname label for the machine-executor registry; the id is
            // generated webview-side (stable per app install).
            let name = std::env::var("COMPUTERNAME").ok()
                .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "guild-machine".to_string());
            let _ = out_tx.send(response_value(
                req.id,
                Ok(Response::ok(req.id, serde_json::json!({ "name": name }))),
            ));
        }
        "session.info" => {
            let s = shared.session.lock().unwrap();
            let result = match &s.cloud {
                Some(cloud) => Ok(Response::ok(
                    req.id,
                    serde_json::json!({
                        "base_url": cloud.base_url,
                        "token": cloud.token,
                        "email": s.email,
                    }),
                )),
                None => Ok(Response::err(
                    req.id,
                    RpcError::new(RpcError::APP_BASE, "not logged in"),
                )),
            };
            let _ = out_tx.send(response_value(req.id, result));
        }
        "models.list" => {
            let session = shared.session.clone();
            let out_tx = out_tx.clone();
            tokio::spawn(async move {
                let result = async {
                    let cloud = session
                        .lock()
                        .unwrap()
                        .cloud
                        .clone()
                        .context("not logged in — call login first")?;
                    let models = cloud.list_models().await?;
                    Ok(Response::ok(
                        req.id,
                        serde_json::json!({ "models": models }),
                    ))
                };
                let _ = out_tx.send(response_value(req.id, result.await));
            });
        }
        "tool.run" => {
            let out_tx = out_tx.clone();
            tokio::spawn(async move {
                let result = async {
                    let name = param(&req, "name")?.to_string();
                    let workdir = param(&req, "workdir")?.to_string();
                    let args = req.params.get("args").cloned().unwrap_or(serde_json::json!({}));
                    let registry = guild_core::tools::ToolRegistry::builtins();
                    let tool = registry
                        .get(&name)
                        .with_context(|| format!("unknown tool {name}"))?;
                    match tool.run(std::path::Path::new(&workdir), args).await {
                        Ok(out) => Ok(Response::ok(
                            req.id,
                            serde_json::json!({
                                "output": out.output_for_model,
                                "ui_summary": out.ui_summary,
                                "diff": out.diff,
                                "meta": out.meta,
                                "is_error": false,
                            }),
                        )),
                        Err(e) => Ok(Response::ok(
                            req.id,
                            serde_json::json!({ "output": e.to_string(), "is_error": true }),
                        )),
                    }
                };
                let _ = out_tx.send(response_value(req.id, result.await));
            });
        }
        "agent.start" => {
            let _ = shared
                .agents
                .lock()
                .await
                .spawn(agent_start_task(shared.clone(), req, out_tx));
        }
        "agent.approve" => {
            tokio::spawn(agent_approve(shared.session.clone(), req, out_tx));
        }
        "agent.policy.set" => policy_set(shared.session.clone(), req, out_tx),
        "agent.policy.get" => policy_get(shared.session.clone(), req, out_tx),
        "daemon.hello" => {
            // Version + protocol handshake for daemon clients (wire method
            // exists before any client uses it). `pid` lets the GUI's
            // supervisor kill a wedged daemon outright.
            let _ = out_tx.send(response_value(
                req.id,
                Ok(Response::ok(
                    req.id,
                    json!({"version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION, "build": protocol::rpc::BUILD_ID, "pid": std::process::id()}),
                )),
            ));
        }
        "daemon.shutdown" => {
            let _ = shared.shutdown.send(true);
            let _ = out_tx.send(response_value(
                req.id,
                Ok(Response::ok(req.id, json!({"ok": true}))),
            ));
        }
        "registry.publish" => {
            tokio::spawn(registry_publish(shared.session.clone(), req, out_tx));
        }
        "registry.install" => {
            tokio::spawn(registry_install(shared.session.clone(), req, out_tx));
        }
        other => {
            let _ = out_tx.send(response_value(
                req.id,
                Err(anyhow::anyhow!("unknown method {other}")),
            ));
        }
    }
    crate::dtrace::dtrace(&format!("dispatch: END {} in {:?}", method, t0.elapsed()));
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
        save(
            &path,
            &StoredSession {
                base_url,
                token,
                email: Some(user.email.clone()),
            },
        )?;
        Ok(Response::ok(req.id, json!({"ok": true, "user": user})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

/// Redeems a one-time pairing code (webapp-issued) for a session — the
/// desktop counterpart of login when the org ships shared installers.
async fn pair_task(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let code = param(&req, "code")?.to_string();
        let (base_url, token, user) = CloudClient::pair(&code).await?;
        {
            let mut s = session.lock().unwrap();
            s.cloud = Some(CloudClient {
                base_url: base_url.clone(),
                token: token.clone(),
            });
            s.email = Some(user.email.clone());
        }
        let path = crate::session_store::default_path()?;
        save(
            &path,
            &StoredSession {
                base_url,
                token,
                email: Some(user.email.clone()),
            },
        )?;
        Ok(Response::ok(req.id, json!({"ok": true, "user": user})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

async fn chat_send_task(
    shared: Shared,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let text = param(&req, "text")?.to_string();
        let (cloud, existing_chat, model) = {
            let mut s = shared.session.lock().unwrap();
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
                shared.session.lock().unwrap().chat_id = Some(c);
                c
            }
        };
        let stream = cloud.chat_stream(chat_id, &model, &[Message::user(text.clone())]).await?;
        let (full_text, done) = collect_turn(stream).await?;
        {
            let mut s = shared.session.lock().unwrap();
            s.messages.push(Message::user(text));
            s.messages.push(Message {
                role: "assistant".into(),
                content: full_text.clone(),
                images: Vec::new(),
                audio: Vec::new(),
                tool_calls: None,
                tool_call_id: None,
                reasoning: None,
            });
        }
        // Broadcast: every connected client sees chat events.
        let _ = shared.events.send(event_value("chat.delta", json!({"content": full_text})));
        let (message_id, cost_usd, tokens_in, tokens_out) = match done {
            Some(protocol::api::StreamEvent::Done { message_id, cost_usd, tokens_in, tokens_out }) => {
                (message_id, cost_usd, tokens_in, tokens_out)
            }
            _ => anyhow::bail!("stream ended without done event"),
        };
        let _ = shared.events.send(event_value(
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
    shared: Shared,
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
        let mut s = shared.session.lock().unwrap();
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
                shared.session.lock().unwrap().chat_id = Some(c);
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

    // run the agent loop; events broadcast to every connected client
    let run = AgentRun {
        cloud: cloud.clone(),
        chat_id,
        project_dir,
        model,
        system: None, // skills index lands in Task 7
        history,
        policy,
        events: shared.events.clone(),
        pending,
    };
    let updated = run
        .spawn(ToolRegistry::builtins())
        .await
        .unwrap_or_default();

    shared.session.lock().unwrap().messages = updated;
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

async fn registry_publish(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let cloud = session
            .lock()
            .unwrap()
            .cloud
            .clone()
            .context("not logged in — call login first")?;
        let kind = param(&req, "kind")?.to_string();
        let dir = PathBuf::from(param(&req, "dir")?);
        let version = param(&req, "version")?.to_string();
        let r = crate::registry_client::publish(&cloud, &kind, &dir, &version).await?;
        Ok(Response::ok(
            req.id,
            json!({"slug": r.slug, "version": r.version}),
        ))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

async fn registry_install(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let cloud = session
            .lock()
            .unwrap()
            .cloud
            .clone()
            .context("not logged in — call login first")?;
        let slug = param(&req, "slug")?.to_string();
        let version = req.params["version"].as_str().map(String::from);
        if let Some(d) = req.params["project_dir"].as_str() {
            session.lock().unwrap().project_dir = Some(PathBuf::from(d));
        }
        let project_dir = session
            .lock()
            .unwrap()
            .project_dir
            .clone()
            .context("missing project_dir — pass it in registry.install params")?;
        let entry =
            crate::registry_client::install_skill(&cloud, &project_dir, &slug, version.as_deref())
                .await?;
        Ok(Response::ok(
            req.id,
            json!({"name": entry.name, "path": entry.path.to_string_lossy()}),
        ))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}
