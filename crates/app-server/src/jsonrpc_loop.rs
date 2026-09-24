//! JSON-RPC stdio loop — async, so agent runs and approvals proceed
//! concurrently (spec §3.2, §6). The UI-facing surface of the local engine.
//!
//! Methods: `login`, `pair`, `chat.send` (plain chat over the gateway
//! workflow), `agent.start` (the gateway shim), `agent.approve`,
//! `machine.identify`, `fs.*` (the file bridge), `session.*`, `models.list`,
//! `registry.*`, `mcp.*`. Streaming arrives as events.

use crate::agent_session::PendingApprovals;
use crate::auth_state::{AuthChange, AuthState};
use crate::cloud::CloudClient;
use crate::machine_link::MachineLinkConfig;
use anyhow::Context as _;
use guild_core::agent::policy::ApprovalPolicy;
use guild_core::tools::artifacts::ArtifactIndex;
use guild_core::tools::Approval;
use protocol::api::Message;
use protocol::rpc::{Request, Response, RpcError, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};
use uuid::Uuid;

#[derive(Default)]
pub struct Session {
    /// Auth fields — the cloud session, the signed-in email, and the
    /// machine identity. Owned by `auth_state`: reads through its
    /// accessors, every mutation through `AuthState::transition`.
    pub auth: AuthState,
    pub model: String,
    pub chat_id: Option<Uuid>,
    pub project_dir: Option<PathBuf>,
    pub policy: ApprovalPolicy,
    pub pending: PendingApprovals,
    /// An agent turn is in flight; a second agent.start would double-bind
    /// the session's project.
    pub agent_running: bool,
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
    /// Path→artifact-id index shared by every run of this engine process
    /// (tool artifacts: touch-time lookups hit what prefetch learned).
    pub artifacts: Arc<ArtifactIndex>,
    /// Set true by `daemon.shutdown`; the daemon's accept loop watches it.
    pub shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    /// The machine link's config channel: publish a config to connect the
    /// executor link, `None` to drop it (sign-out). The link task subscribes.
    pub machine_link: Arc<tokio::sync::watch::Sender<Option<MachineLinkConfig>>>,
    /// The session store's path (token.json). Injected by tests so they
    /// never touch the developer's real store; the daemon leaves it None
    /// and the default path applies.
    pub store_path: Option<PathBuf>,
}

impl Shared {
    pub fn new(session: Session) -> Self {
        let (events, _) = broadcast::channel(256);
        let (shutdown, _) = watch::channel(false);
        let (machine_link, _) = watch::channel(None);
        Self {
            session: Arc::new(Mutex::new(session)),
            events,
            agents: Arc::new(tokio::sync::Mutex::new(tokio::task::JoinSet::new())),
            artifacts: Arc::new(ArtifactIndex::new()),
            shutdown: Arc::new(shutdown),
            machine_link: Arc::new(machine_link),
            store_path: None,
        }
    }

    /// Republishes the machine link config from the session's auth state.
    /// A link exists when the daemon is logged in AND the webview reported
    /// its machine identity. Called after every auth transition (inside
    /// `AuthState::transition`) and at boot.
    pub fn publish_machine_link(&self) {
        self.session
            .lock()
            .unwrap()
            .auth
            .publish(&self.machine_link);
    }
}

/// Restores a persisted session (token.json) into a fresh Session, so an
/// app restart or a GUI engine re-spawn keeps auth. Thin wrapper over
/// `AuthState::restored` (the auth-state module owns the store).
pub async fn restored_session() -> anyhow::Result<Session> {
    let session = Session {
        auth: AuthState::restored().await?,
        ..Session::default()
    };
    Ok(session)
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
            crate::dtrace::dtrace(&format!(
                "conn: reader got {} bytes: {}",
                line.len(),
                crate::dtrace::redacted_frame_summary(&line, 120)
            ));
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
            crate::dtrace::dtrace(&format!(
                "conn: writer writing {} bytes: {}",
                v.to_string().len(),
                crate::dtrace::redacted_frame_summary(&v.to_string(), 120)
            ));
            let t0 = std::time::Instant::now();
            let r = writeln!(w, "{v}");
            let f = w.flush();
            crate::dtrace::dtrace(&format!(
                "conn: writer done in {:?} writeln={:?} flush={:?}",
                t0.elapsed(),
                r.is_ok(),
                f.is_ok()
            ));
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
        "login" => login_task(shared.clone(), req, out_tx).await,
        "pair" => pair_task(shared.clone(), req, out_tx).await,
        "chat.send" => chat_send_task(shared.clone(), req, out_tx).await,
        "machine.info" => {
            // Hostname label sent during machine registration; the id is
            // generated webview-side (stable per app install).
            let name = std::env::var("COMPUTERNAME")
                .ok()
                .or_else(|| {
                    std::fs::read_to_string("/etc/hostname")
                        .ok()
                        .map(|s| s.trim().to_string())
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "guild-machine".to_string());
            let _ = out_tx.send(response_value(
                req.id,
                Ok(Response::ok(req.id, serde_json::json!({ "name": name }))),
            ));
        }
        "session.info" => {
            let s = shared.session.lock().unwrap();
            let result = match s.auth.cloud() {
                Some(cloud) => Ok(Response::ok(
                    req.id,
                    serde_json::json!({
                        "base_url": cloud.base_url,
                        "token": cloud.token,
                        "email": s.auth.email(),
                    }),
                )),
                None => Ok(Response::err(
                    req.id,
                    RpcError::new(RpcError::APP_BASE, "not logged in"),
                )),
            };
            let _ = out_tx.send(response_value(req.id, result));
        }
        "session.clear" => {
            session_clear(shared.clone(), req, out_tx).await;
        }
        "machine.identify" => {
            tokio::spawn(machine_identify(shared.clone(), req, out_tx));
        }
        "models.list" => {
            let session = shared.session.clone();
            let out_tx = out_tx.clone();
            tokio::spawn(async move {
                let result = async {
                    let cloud = session
                        .lock()
                        .unwrap()
                        .auth
                        .cloud()
                        .cloned()
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
        "registry.uninstall" => {
            tokio::spawn(registry_uninstall(shared.session.clone(), req, out_tx));
        }
        "fs.scopes" => {
            let _ = out_tx.send(response_value(
                req.id,
                Ok(Response::ok(
                    req.id,
                    json!({
                        "config_dir": crate::fs_bridge::guild_config_dir().to_string_lossy(),
                        "home": crate::fs_bridge::home_dir().to_string_lossy(),
                    }),
                )),
            ));
        }
        "fs.read_text" | "fs.list_dir" | "fs.exists" | "fs.write_text" => {
            let _ = out_tx.send(response_value(req.id, fs_bridge_call(&req)));
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

/// The fs.* file bridge (fs_bridge.rs): primitive allowlisted operations
/// the webview uses for context assembly. The project folder arrives per
/// call — the webview owns the project binding (and thus the trust in it),
/// the same as every other client-owned request field.
fn fs_bridge_call(req: &Request) -> anyhow::Result<Response> {
    let project_dir = req.params["project_dir"].as_str().map(PathBuf::from);
    let path = req.params["path"]
        .as_str()
        .context("missing path")?
        .to_string();
    let payload = match req.method.as_str() {
        "fs.read_text" => {
            json!({ "content": crate::fs_bridge::read_text(project_dir.as_deref(), &path)? })
        }
        "fs.list_dir" => {
            json!({ "entries": crate::fs_bridge::list_dir(project_dir.as_deref(), &path)? })
        }
        "fs.exists" => json!({ "exists": crate::fs_bridge::exists(project_dir.as_deref(), &path) }),
        "fs.write_text" => {
            let body = req.params["body"].as_str().context("missing body")?;
            crate::fs_bridge::write_text(project_dir.as_deref(), &path, body)?;
            json!({ "ok": true })
        }
        other => anyhow::bail!("unknown fs verb {other}"),
    };
    Ok(Response::ok(req.id, payload))
}

fn param<'a>(req: &'a Request, key: &'a str) -> anyhow::Result<&'a str> {
    req.params[key].as_str().context(format!("missing {key}"))
}

/// Optional string param — absent/empty collapses to None.
fn optional_param(req: &Request, key: &str) -> Option<String> {
    req.params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Applies one auth transition to the session's auth state, persisting to
/// the default token.json path. The injectable-store variant is for tests.
fn auth_change(shared: &Shared, change: AuthChange) -> anyhow::Result<()> {
    auth_change_with_store(
        shared,
        change,
        shared
            .store_path
            .clone()
            .or_else(|| crate::session_store::default_path().ok()),
    )
}

fn auth_change_with_store(
    shared: &Shared,
    change: AuthChange,
    store: Option<PathBuf>,
) -> anyhow::Result<()> {
    let mut s = shared.session.lock().unwrap();
    s.auth
        .transition(change, store.as_deref(), &shared.machine_link)
}

async fn machine_identify(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let path = shared
        .store_path
        .clone()
        .or_else(|| crate::session_store::default_path().ok());
    machine_identify_with_store(shared, req, out_tx, path).await;
}

/// Records the webview-reported machine identity and publishes the machine
/// link config — thin over `AuthState::transition`. The store path is
/// injectable for tests; the daemon path uses the real token.json.
async fn machine_identify_with_store(
    shared: Shared,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
    store_path: Option<PathBuf>,
) {
    let result = (|| -> anyhow::Result<Response> {
        let machine_id = param(&req, "machine_id")?.to_string();
        auth_change_with_store(&shared, AuthChange::Identify { machine_id }, store_path)?;
        Ok(Response::ok(req.id, json!({ "ok": true })))
    })();
    let _ = out_tx.send(response_value(req.id, result));
}

/// Full sign-out: drop the cloud session and machine identity in memory and
/// the persisted token (token.json), so the next restore shows the
/// pair/sign-in screen instead of re-logging in silently — and drop the
/// machine link (the webview re-identifies on the next login). Thin over
/// `AuthState::transition`.
async fn session_clear(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = auth_change(&shared, AuthChange::SignOut)
        .map(|_| Response::ok(req.id, json!({ "ok": true })));
    let _ = out_tx.send(response_value(req.id, result));
}

/// `login` / `pair` land here once the credential exchange produced a
/// token: thin over `AuthState::transition` (mutate ⇒ persist ⇒ publish).
/// The webview sends its stable per-install `machine_id` along (when it has
/// one), so the executor link comes up in the same step as the login — no
/// gap in which a project create can race the not-yet-registered machine
/// and fail with "unknown machine". Shells that omit the field reuse the stored identity or generate one.
fn adopt_login_with_identity(
    shared: &Shared,
    base_url: String,
    token: String,
    email: String,
    machine_id: Option<String>,
    store: Option<PathBuf>,
) -> anyhow::Result<()> {
    auth_change_with_store(
        shared,
        AuthChange::Login {
            base_url,
            token,
            email,
        },
        store.clone(),
    )?;
    let machine_id = machine_id
        .filter(|id| !id.is_empty())
        .or_else(|| {
            shared
                .session
                .lock()
                .unwrap()
                .auth
                .machine_id()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    auth_change_with_store(shared, AuthChange::Identify { machine_id }, store)?;
    Ok(())
}

async fn login_task(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = async {
        let base_url = param(&req, "base_url")?.to_string();
        let email = param(&req, "email")?.to_string();
        let password = param(&req, "password")?.to_string();
        let (token, user) = CloudClient::login(&base_url, &email, &password).await?;
        adopt_login_with_identity(
            &shared,
            base_url,
            token,
            user.email.clone(),
            optional_param(&req, "machine_id"),
            crate::session_store::default_path().ok(),
        )?;
        Ok(Response::ok(req.id, json!({"ok": true, "user": user})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

/// Redeems a one-time pairing code (webapp-issued) for a session — the
/// desktop counterpart of login when the org ships shared installers.
async fn pair_task(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = async {
        let code = param(&req, "code")?.to_string();
        let (base_url, token, user) = CloudClient::pair(&code).await?;
        adopt_login_with_identity(
            &shared,
            base_url,
            token,
            user.email.clone(),
            optional_param(&req, "machine_id"),
            crate::session_store::default_path().ok(),
        )?;
        Ok(Response::ok(req.id, json!({"ok": true, "user": user})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

async fn chat_send_task(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = async {
        let text = param(&req, "text")?.to_string();
        let (cloud, existing_chat, model) = {
            let mut s = shared.session.lock().unwrap();
            let cloud = s
                .auth
                .cloud()
                .cloned()
                .context("not logged in — call login first")?;
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
        // The same turn submission the agent.start shim uses — the durable
        // gateway workflow, with no tools requested (plain completion).
        // History lives in the server's thread journal; nothing is mirrored
        // locally (unification spec §3).
        let stream = cloud
            .stream_completion(protocol::api::ChatCompletionRequest {
                server_workspace: None,
                send_mode: None,
                user_message_id: None,
                chat_id,
                model,
                messages: vec![Message::user(text.clone())],
                tools: None,
                system: None,
                client_tools: false,
                attachment_ids: Vec::new(),
                project_id: None,
                skills_index: None,
                agents_md: None,
            })
            .await?;
        let (message_id, cost_usd, tokens_in, tokens_out) =
            crate::agent_start::drive_chat(shared.events.clone(), stream).await?;
        Ok(Response::ok(
            req.id,
            json!({"chat_id": chat_id, "message_id": message_id, "cost_usd": cost_usd, "tokens_in": tokens_in, "tokens_out": tokens_out}),
        ))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

/// Starts an agent turn in the background: the shim (agent_start.rs) —
/// validates params, binds the machine-bound project, and drives the same
/// durable gateway workflow the GUI uses; progress streams as agent.*
/// events mapped from the workflow's frames. Acks immediately (the old
/// contract); failures before the ack are RPC errors, failures during the
/// run arrive as agent.error events.
async fn agent_start_task(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    // 1. Session state under the lock; context assembly and all HTTP after.
    let (cloud, project_dir, model, prompt, machine_id) = match (|| {
        let mut s = shared.session.lock().unwrap();
        let cloud = s
            .auth
            .cloud()
            .cloned()
            .context("not logged in — call login first")?;
        let machine_id = s
            .auth
            .machine_id()
            .context(
                "no machine identity reported — call machine.identify first (the workflow dispatches tools to this machine's executor link)",
            )?
            .to_string();
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
        anyhow::ensure!(
            !s.agent_running,
            "an agent run is already in progress for this session"
        );
        let prompt = param(&req, "prompt")?.to_string();
        // Set only after every param check: an early error return must not
        // wedge the session flag (every later start would report "already
        // in progress" until restart).
        s.agent_running = true;
        Ok((cloud, project_dir, s.model.clone(), prompt, machine_id))
    })() {
        Ok(v) => v,
        Err(e) => {
            let _ = out_tx.send(response_value(req.id, Err(e)));
            return;
        }
    };

    // Caller-assembled context (the client owns discovery — the webview
    // via lib/context.ts, an engine client via its own assembly over the
    // fs.* bridge): the shim forwards it into the additive request fields.
    let skills_index = req.params["skills_index"].as_str().map(str::to_string);
    let agents_md = req.params["agents_md"].as_str().map(str::to_string);

    // 2. The workflow dispatches tools to the machine the project is bound
    //    to — it must be this daemon's own executor link. Then chat
    //    attach/create. Failures here are RPC errors (nothing acked yet).
    let bound = async {
        let project =
            crate::agent_start::ensure_project(&cloud, &project_dir.to_string_lossy(), &machine_id)
                .await?;
        let chat_id = shared.session.lock().unwrap().chat_id;
        let chat_id = match chat_id {
            Some(c) => c,
            None => {
                let c = cloud.create_chat(Some("agent")).await?;
                shared.session.lock().unwrap().chat_id = Some(c);
                c
            }
        };
        Ok::<_, anyhow::Error>((project, chat_id))
    };
    let (project, chat_id) = match bound.await {
        Ok(v) => v,
        Err(e) => {
            shared.session.lock().unwrap().agent_running = false;
            let _ = out_tx.send(response_value(
                req.id,
                Err(anyhow::anyhow!("agent start failed: {e:#}")),
            ));
            return;
        }
    };

    // Rebuild the artifact path→id index from the thread log and prefetch
    // every artifact missing on disk, in the background.
    crate::artifacts::spawn_thread_sync_prefetch(
        cloud.clone(),
        shared.artifacts.clone(),
        project_dir.clone(),
        chat_id,
    );

    // 3. Ack before the run: progress arrives as events, run failures as
    //    agent.error — the old agent.start contract.
    let _ = out_tx.send(response_value(
        req.id,
        Ok(Response::ok(
            req.id,
            serde_json::json!({"started": true, "chat_id": chat_id}),
        )),
    ));

    let (policy, pending) = {
        let s = shared.session.lock().unwrap();
        (s.policy.clone(), s.pending.clone())
    };
    let streamed = cloud
        .stream_completion(protocol::api::ChatCompletionRequest {
            server_workspace: None,
            send_mode: None,
            user_message_id: None,
            chat_id,
            model,
            messages: vec![Message::user(prompt)],
            // The workflow declares the client tools from the project's
            // machine binding; the daemon's link answers the dispatches.
            tools: None,
            system: None,
            client_tools: true,
            attachment_ids: Vec::new(),
            project_id: Some(project.id),
            skills_index,
            agents_md,
        })
        .await;
    let run = match streamed {
        Ok(stream) => {
            crate::agent_start::drive(
                cloud.clone(),
                chat_id,
                policy,
                pending,
                shared.events.clone(),
                stream,
            )
            .await
        }
        Err(e) => Err(e),
    };
    shared.session.lock().unwrap().agent_running = false;
    if let Err(e) = run {
        // Surface model/policy/stream failures so the client unblocks
        // instead of waiting for agent.done forever.
        let _ = shared.events.send(
            serde_json::to_value(protocol::rpc::Event::new(
                "agent.error",
                serde_json::json!({ "message": e.to_string() }),
            ))
            .unwrap_or(Value::Null),
        );
    }
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
            .auth
            .cloud()
            .cloned()
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
            .auth
            .cloud()
            .cloned()
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
        let global = req.params["global"].as_bool().unwrap_or(false);
        let publisher = session
            .lock()
            .unwrap()
            .auth
            .email()
            .unwrap_or_default()
            .to_string();
        let entry = crate::registry_client::install_skill(
            &cloud,
            &project_dir,
            &slug,
            version.as_deref(),
            global,
            &publisher,
        )
        .await?;
        Ok(Response::ok(
            req.id,
            json!({"name": entry.name, "path": entry.path.to_string_lossy()}),
        ))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

/// Lists locally discovered skills with provenance, scope, and disabled
/// flag — the desktop skills manager's data source.
async fn registry_uninstall(
    session: Arc<Mutex<Session>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let slug = param(&req, "slug")?.to_string();
        if let Some(d) = req.params["project_dir"].as_str() {
            session.lock().unwrap().project_dir = Some(PathBuf::from(d));
        }
        let project_dir = session
            .lock()
            .unwrap()
            .project_dir
            .clone()
            .context("missing project_dir — pass it in registry.uninstall params")?;
        let global = req.params["global"].as_bool().unwrap_or(false);
        crate::registry_client::uninstall_skill(&project_dir, &slug, global)?;
        Ok(Response::ok(req.id, json!({"uninstalled": slug})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

#[cfg(test)]
mod machine_link_tests {
    use super::*;
    use crate::cloud::CloudClient;
    use tokio::sync::mpsc;

    fn identify_req(id: u64, machine_id: &str) -> Request {
        Request {
            jsonrpc: "2.0".into(),
            id,
            protocol: protocol::rpc::PROTOCOL_VERSION,
            method: "machine.identify".into(),
            params: serde_json::json!({ "machine_id": machine_id }),
        }
    }

    fn logged_in_shared() -> Shared {
        let session = Session {
            auth: crate::auth_state::AuthState::from_parts(
                Some(CloudClient {
                    base_url: "http://srv".into(),
                    token: "tok".into(),
                }),
                Some("a@b".into()),
                None,
                None,
            ),
            ..Default::default()
        };
        // Store path injected: these tests must never write the developer's
        // real token.json.
        let mut shared = Shared::new(session);
        shared.store_path = Some(
            std::env::temp_dir().join(format!("guild-test-token-{}.json", Uuid::now_v7())),
        );
        shared
    }

    #[tokio::test]
    async fn identify_stores_identity_and_publishes_link_config() {
        let shared = logged_in_shared();
        let mut link_rx = shared.machine_link.subscribe();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();

        machine_identify(shared.clone(), identify_req(1, "machine-1"), out_tx).await;

        // The RPC answered ok.
        let resp = out_rx.recv().await.unwrap();
        assert_eq!(resp["result"]["ok"], serde_json::json!(true));
        // The session carries the identity.
        assert_eq!(
            shared.session.lock().unwrap().auth.machine_id(),
            Some("machine-1")
        );
        // The link config was published from the session's cloud + identity,
        // with a generated client id and the hostname label.
        let cfg = link_rx.borrow_and_update().clone().expect("link published");
        assert_eq!(cfg.machine_id, "machine-1");
        assert_eq!(cfg.base_url, "http://srv");
        assert_eq!(cfg.token, "tok");
        assert!(!cfg.client_id.is_empty());
        assert!(!cfg.machine_name.is_empty());
    }

    #[tokio::test]
    async fn login_with_machine_id_brings_the_link_up_in_one_step() {
        let shared = logged_in_shared();
        let mut link_rx = shared.machine_link.subscribe();

        adopt_login_with_identity(
            &shared,
            "http://srv".into(),
            "tok".into(),
            "a@b".into(),
            Some("machine-9".into()),
            None,
        )
        .unwrap();

        let cfg = link_rx.borrow_and_update().clone().expect("link published");
        assert_eq!(cfg.machine_id, "machine-9");
        assert_eq!(cfg.base_url, "http://srv");
        assert_eq!(cfg.token, "tok");
    }

    #[tokio::test]
    async fn headless_login_persists_and_reuses_the_machine_identity() {
        let shared = logged_in_shared();
        let _rx = shared.machine_link.subscribe();
        let path = std::env::temp_dir().join(format!("guild-headless-{}.json", Uuid::now_v7()));
        for token in ["first", "second"] {
            adopt_login_with_identity(
                &shared,
                "http://srv".into(),
                token.into(),
                "a@b".into(),
                None,
                Some(path.clone()),
            )
            .unwrap();
            let stored = crate::session_store::load(&path).unwrap();
            let cfg = crate::machine_link::config_from_store(&path)
                .expect("persisted identity is executable");
            assert_eq!(stored.token, token);
            assert_eq!(
                cfg.machine_id,
                shared.session.lock().unwrap().auth.machine_id().unwrap()
            );
            if token == "first" {
                let before = cfg.machine_id.clone();
                adopt_login_with_identity(
                    &shared,
                    "http://srv".into(),
                    token.into(),
                    "a@b".into(),
                    None,
                    Some(path.clone()),
                )
                .unwrap();
                assert_eq!(
                    crate::machine_link::config_from_store(&path)
                        .unwrap()
                        .machine_id,
                    before
                );
            }
        }
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn login_without_machine_id_generates_an_identity() {
        let shared = logged_in_shared();
        let mut link_rx = shared.machine_link.subscribe();

        adopt_login_with_identity(
            &shared,
            "http://srv".into(),
            "tok".into(),
            "a@b".into(),
            None,
            None,
        )
        .unwrap();

        assert!(link_rx
            .borrow_and_update()
            .as_ref()
            .is_some_and(|cfg| Uuid::parse_str(&cfg.machine_id).is_ok()));
    }

    #[tokio::test]
    async fn login_with_blank_machine_id_generates_an_identity() {
        let shared = logged_in_shared();
        let mut link_rx = shared.machine_link.subscribe();

        adopt_login_with_identity(
            &shared,
            "http://srv".into(),
            "tok".into(),
            "a@b".into(),
            Some("".into()),
            None,
        )
        .unwrap();

        assert!(link_rx
            .borrow_and_update()
            .as_ref()
            .is_some_and(|cfg| Uuid::parse_str(&cfg.machine_id).is_ok()));
    }

    #[tokio::test]
    async fn identify_persists_identity_into_the_session_store() {
        let shared = logged_in_shared();
        let path = std::env::temp_dir().join(format!(
            "guild-identify-{}-{}.json",
            std::process::id(),
            uuid::Uuid::now_v7().simple()
        ));
        // Seed the store the way login left it.
        crate::session_store::save(
            &path,
            &crate::session_store::StoredSession {
                base_url: "http://srv".into(),
                token: "tok".into(),
                email: Some("a@b".into()),
                machine_id: None,
                client_id: None,
                machine_name: None,
            },
        )
        .unwrap();

        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        machine_identify_with_store(
            shared.clone(),
            identify_req(2, "machine-2"),
            out_tx,
            Some(path.clone()),
        )
        .await;
        let _ = out_rx.recv().await.unwrap();

        let stored = crate::session_store::load(&path).unwrap();
        assert_eq!(stored.machine_id.as_deref(), Some("machine-2"));
        assert!(stored.client_id.is_some());
        assert_eq!(stored.base_url, "http://srv");
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn identify_without_login_parks_the_link_but_keeps_identity() {
        let mut shared = Shared::new(Session::default());
        shared.store_path = Some(
            std::env::temp_dir().join(format!("guild-test-token-{}.json", Uuid::now_v7())),
        );
        let mut link_rx = shared.machine_link.subscribe();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();

        machine_identify(shared.clone(), identify_req(3, "machine-3"), out_tx).await;
        let _ = out_rx.recv().await.unwrap();

        // Identity is remembered (a later login adopts it)…
        assert_eq!(
            shared.session.lock().unwrap().auth.machine_id(),
            Some("machine-3")
        );
        // …but no link config is published without a session.
        assert!(link_rx.borrow_and_update().is_none());
    }

    #[tokio::test]
    async fn signing_out_drops_the_link() {
        let shared = logged_in_shared();
        let mut link_rx = shared.machine_link.subscribe();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        machine_identify(shared.clone(), identify_req(4, "machine-4"), out_tx).await;
        let _ = out_rx.recv().await.unwrap();
        assert!(link_rx.borrow_and_update().is_some());

        let (out_tx2, mut out_rx2) = mpsc::unbounded_channel();
        session_clear(shared.clone(), identify_req(5, ""), out_tx2).await;
        let _ = out_rx2.recv().await.unwrap();
        assert!(
            link_rx.borrow_and_update().is_none(),
            "sign-out drops the link"
        );
    }
}

#[cfg(test)]
mod agent_start_tests {
    use super::*;

    #[tokio::test]
    async fn missing_prompt_does_not_wedge_the_session_flag() {
        let shared = Shared::new(Session::default());
        let req = |id: u64| Request {
            jsonrpc: "2.0".into(),
            id,
            protocol: protocol::rpc::PROTOCOL_VERSION,
            method: "agent.start".into(),
            params: serde_json::json!({ "project_dir": "/tmp/x" }),
        };
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        agent_start_task(shared.clone(), req(1), out_tx.clone()).await;
        let first = out_rx.recv().await.unwrap();
        assert!(
            first.get("error").is_some(),
            "missing prompt is an error: {first}"
        );
        assert!(
            !first["error"]["message"].as_str().unwrap_or("").contains("already in progress"),
            "the flag must not wedge: {first}"
        );
        assert!(!shared.session.lock().unwrap().agent_running);

        // The next start reaches the real validation path (not logged in
        // here) instead of the false "already in progress".
        agent_start_task(shared.clone(), req(2), out_tx).await;
        let second = out_rx.recv().await.unwrap();
        let msg = second["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !msg.contains("already in progress"),
            "session wedged by the failed start: {second}"
        );
    }
}
