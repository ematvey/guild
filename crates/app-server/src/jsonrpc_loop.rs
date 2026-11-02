//! JSON-RPC line loop — the dispatch surface of the local engine, served
//! to the desktop webview in-process and to CLI verbs over the local socket.
//! Agent turns run server-side; the engine owns the session, the machine
//! link (dispatched tools, skills sync), and the local file bridge.
//!
//! Methods: `login`, `pair`, `session.*`, `workspace.*`, `machine.identify`,
//! `registry.*`, `fs.*` (the file bridge), `daemon.hello` /
//! `daemon.shutdown`. The method contract is `protocol/rpc.schema.json`.
//! Every call is request/response; the only event is `rpc.error` for a
//! line that carries no request id.

use crate::auth_state::{AuthChange, AuthState};
use crate::cloud::CloudClient;
use crate::machine_link::LinkRegistry;
use crate::sync::LockExt;
use anyhow::Context as _;
use guild_core::tools::artifacts::ArtifactIndex;
use protocol::rpc::{Request, Response, RpcError, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

/// Every method `dispatch` serves; `protocol/rpc.schema.json` declares
/// each one's params and result.
pub const METHODS: &[&str] = &[
    "login",
    "pair",
    "session.info",
    "session.clear",
    "workspace.list",
    "workspace.switch",
    "machine.identify",
    "daemon.hello",
    "daemon.shutdown",
    "registry.publish",
    "registry.install",
    "registry.uninstall",
    "fs.scopes",
    "fs.read_text",
    "fs.list_dir",
    "fs.exists",
    "fs.write_text",
];

#[derive(Default)]
pub struct EngineState {
    /// Auth fields — the cloud session, the signed-in email, and the
    /// machine identity. Owned by `auth_state`: reads through its
    /// accessors, every mutation through `AuthState::transition`.
    pub auth: AuthState,
}

enum Incoming {
    Request(Request),
    /// A line that is not a valid request. `id` is its request id when the
    /// line carried one, so the caller gets an error response instead of
    /// waiting out its timeout.
    Malformed {
        id: Option<u64>,
        message: String,
    },
}

/// Engine state shared by every client connection: one engine state, one
/// artifact index, one shutdown flag, one link registry.
#[derive(Clone)]
pub struct Shared {
    pub session: Arc<Mutex<EngineState>>,
    /// Path→artifact-id index shared by every dispatched tool call of this
    /// engine process (touch-time lookups hit what earlier calls learned).
    pub artifacts: Arc<ArtifactIndex>,
    /// Set true by `daemon.shutdown`; the daemon's accept loop watches it.
    pub shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    /// The machine-link registry: one config channel per live workspace.
    /// Publish a config to connect that workspace's executor link, `None`
    /// (or `drop_link`) to tear it down. Each host cycle's supervisor opens
    /// its own spawn feed on it.
    pub links: LinkRegistry,
    /// The session store's path (token.json). Injected by tests so they
    /// never touch the developer's real store; the daemon leaves it None
    /// and the default path applies.
    pub store_path: Option<PathBuf>,
}

impl Shared {
    pub fn new(session: EngineState) -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            session: Arc::new(Mutex::new(session)),
            artifacts: Arc::new(ArtifactIndex::new()),
            shutdown: Arc::new(shutdown),
            links: LinkRegistry::new(),
            store_path: None,
        }
    }

    /// Republishes every workspace's machine-link config from the session's
    /// auth state. A workspace connects when it is logged in AND the webview
    /// reported its machine identity. Called after every auth transition
    /// (inside `AuthState::transition`) and at boot.
    pub fn publish_machine_link(&self) {
        self.session.guard().auth.publish(&self.links);
    }
}

/// Restores a persisted session (token.json) into a fresh EngineState, so an
/// app restart or a GUI engine re-spawn keeps auth. Thin wrapper over
/// `AuthState::restored` (the auth-state module owns the store).
pub async fn restored_session() -> anyhow::Result<EngineState> {
    Ok(EngineState {
        auth: AuthState::restored().await?,
    })
}

fn line_to_incoming(line: &str) -> Incoming {
    let line = line.trim();
    let malformed = |message: String| Incoming::Malformed {
        id: serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v.get("id").and_then(Value::as_u64)),
        message,
    };
    match serde_json::from_str::<Request>(line) {
        Ok(req) if req.is_valid() => Incoming::Request(req),
        Ok(_) => malformed("bad jsonrpc/protocol fields".into()),
        Err(e) => malformed(format!("invalid request: {e}")),
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

/// Reads requests until EOF, handles them, writes responses to the writer.
/// Returns the (mutated) session and the writer back. Thin wrapper: one
/// Shared, one connection.
pub async fn serve<R, W>(
    reader: R,
    writer: W,
    session: EngineState,
) -> anyhow::Result<(EngineState, W)>
where
    R: std::io::Read + Send + 'static,
    W: std::io::Write + Send + 'static,
{
    let shared = Shared::new(session);
    let writer = run_connection(&shared, reader, writer).await?;
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
        crate::trace!("conn: reader thread started");
        let reader = std::io::BufReader::new(reader);
        use std::io::BufRead;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let incoming = line_to_incoming(&line);
            crate::trace!(
                "conn: reader got {} bytes: {}",
                line.len(),
                match &incoming {
                    Incoming::Request(req) => format!("{} id={}", req.method, req.id),
                    Incoming::Malformed { id, .. } => format!("malformed id={id:?}"),
                }
            );
            if req_tx.send(incoming).is_err() {
                break;
            }
        }
        crate::trace!("conn: reader thread exited (EOF or error)");
    });

    // Single ordered writer: every response flows through here.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer_thread = std::thread::spawn(move || {
        let mut w = writer;
        crate::trace!("conn: writer thread started");
        while let Some(v) = out_rx.blocking_recv() {
            crate::trace!(
                "conn: writer writing id={} error={}",
                v["id"],
                v.get("error").is_some()
            );
            let t0 = std::time::Instant::now();
            let r = writeln!(w, "{v}");
            let f = w.flush();
            crate::trace!(
                "conn: writer done in {:?} writeln={:?} flush={:?}",
                t0.elapsed(),
                r.is_ok(),
                f.is_ok()
            );
        }
        crate::trace!("conn: writer thread exiting (out_tx dropped)");
        w
    });

    // Per-connection ordered queue: requests that read or change the
    // session run one after another in arrival order (a login lands before
    // the registry call that follows it). Network-bound handlers
    // (identify, registry) are spawned, so the queue only waits for each
    // request's session-touching part. The loop below never awaits a queued
    // handler: out-of-band requests (hello, shutdown) answer at once.
    let (ordered_tx, mut ordered_rx) = mpsc::unbounded_channel::<Request>();
    let ordered = {
        let shared = shared.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            while let Some(req) = ordered_rx.recv().await {
                dispatch(shared.clone(), req, out_tx.clone()).await;
            }
        })
    };

    while let Some(inc) = req_rx.recv().await {
        match inc {
            Incoming::Malformed {
                id: Some(id),
                message,
            } => {
                let _ = out_tx.send(
                    serde_json::to_value(Response::err(
                        id,
                        RpcError::new(RpcError::INVALID_REQUEST, message),
                    ))
                    .expect("error response serializes"),
                );
            }
            Incoming::Malformed { id: None, message } => {
                let _ = out_tx.send(json!({
                    "protocol": PROTOCOL_VERSION, "event": "rpc.error",
                    "payload": {"message": message},
                }));
            }
            Incoming::Request(req) if is_out_of_band(&req.method) => {
                dispatch(shared.clone(), req, out_tx.clone()).await;
            }
            Incoming::Request(req) => {
                let _ = ordered_tx.send(req);
            }
        }
    }
    drop(ordered_tx);
    let _ = ordered.await;
    drop(out_tx);
    // The join blocks until in-flight handlers finish (they hold out_tx
    // clones), so their responses are written before the writer returns.
    Ok(writer_thread.join().expect("writer thread"))
}

/// Requests answered straight from the connection loop, outside the
/// ordered queue: none of them waits on the session order, and each must
/// answer while a queued request (a login) is in flight.
fn is_out_of_band(method: &str) -> bool {
    matches!(method, "daemon.hello" | "daemon.shutdown")
}

async fn dispatch(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let t0 = std::time::Instant::now();
    let method = req.method.clone();
    let rid = req.id;
    crate::trace!("dispatch: START {} id={:?}", method, rid);
    match req.method.as_str() {
        "login" => login_task(shared.clone(), req, out_tx).await,
        "pair" => pair_task(shared.clone(), req, out_tx).await,
        "session.info" => {
            let s = shared.session.guard();
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
        "workspace.list" => {
            let _ = out_tx.send(response_value(req.id, workspace_list(&shared, req.id)));
        }
        "workspace.switch" => {
            workspace_switch(shared.clone(), req, out_tx).await;
        }
        "machine.identify" => {
            tokio::spawn(machine_identify(shared.clone(), req, out_tx));
        }
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
            shared.shutdown.send_replace(true);
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
            tokio::spawn(registry_uninstall(req, out_tx));
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
            let _ = out_tx.send(
                serde_json::to_value(Response::err(
                    req.id,
                    RpcError::new(
                        RpcError::METHOD_NOT_FOUND,
                        format!("unknown method {other}"),
                    ),
                ))
                .expect("error response serializes"),
            );
        }
    }
    crate::trace!("dispatch: END {} in {:?}", method, t0.elapsed());
}

/// The fs.* file bridge (fs_bridge.rs): primitive allowlisted operations
/// the webview uses for context assembly. The project folder arrives per
/// call and the allowlist derives from it, so the roots catch webview
/// logic bugs, not a hostile caller (see the fs_bridge module doc).
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
    auth_change_with_store(shared, change, store_path(shared))
}

/// The token.json path: the injected test store, else the default.
fn store_path(shared: &Shared) -> Option<PathBuf> {
    shared
        .store_path
        .clone()
        .or_else(|| crate::session_store::default_path().ok())
}

fn auth_change_with_store(
    shared: &Shared,
    change: AuthChange,
    store: Option<PathBuf>,
) -> anyhow::Result<()> {
    shared
        .session
        .guard()
        .auth
        .transition(change, store.as_deref(), &shared.links)
}

async fn machine_identify(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let path = store_path(&shared);
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

/// Sign-out: drop the cloud session (target = the optional `base_url`
/// param, else the ACTIVE workspace) in memory and the persisted store, so
/// the next restore shows the pair/sign-in screen instead of re-logging in
/// silently — and drop the machine link (the webview re-identifies on the
/// next login). Thin over `AuthState::transition`.
async fn session_clear(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let target = optional_param(&req, "base_url").map(|b| crate::session_store::normalize_base(&b));
    let cloud = {
        let s = shared.session.guard();
        match target.as_deref() {
            Some(base) => s.auth.cloud_of(base).cloned(),
            None => s.auth.cloud().cloned(),
        }
    };
    if let Some(cloud) = cloud {
        let _ = cloud
            .http_pub()
            .post(format!(
                "{}/api/v1/auth/logout",
                cloud.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&cloud.token)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await;
    }
    let change = match target {
        Some(base_url) => AuthChange::SignOutWorkspace { base_url },
        None => AuthChange::SignOut,
    };
    let result = auth_change(&shared, change).map(|_| Response::ok(req.id, json!({ "ok": true })));
    let _ = out_tx.send(response_value(req.id, result));
}

/// Every live workspace plus the active pointer (the switcher's data).
fn workspace_list(shared: &Shared, req_id: u64) -> anyhow::Result<Response> {
    let s = shared.session.guard();
    let (active, rows) = s.auth.workspaces();
    Ok(Response::ok(
        req_id,
        json!({
            "active": active,
            "workspaces": rows,
        }),
    ))
}

/// Makes an existing workspace active. Thin over `AuthState::transition`
/// (mutate ⇒ persist ⇒ publish);
/// answers with the same shape as `session.info` so the webview can mirror
/// the new active session in one step.
async fn workspace_switch(shared: Shared, req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = (|| -> anyhow::Result<Response> {
        let base_url = param(&req, "base_url")?.to_string();
        auth_change(&shared, AuthChange::Switch { base_url })?;
        let s = shared.session.guard();
        let cloud = s.auth.cloud().context("switch left no active session")?;
        Ok(Response::ok(
            req.id,
            json!({
                "base_url": cloud.base_url,
                "token": cloud.token,
                "email": s.auth.email(),
            }),
        ))
    })();
    let _ = out_tx.send(response_value(req.id, result));
}

/// `login` / `pair` land here once the credential exchange produced a
/// token: thin over `AuthState::transition` (mutate ⇒ persist ⇒ publish).
/// The webview sends its stable per-install `machine_id` along (when it has
/// one), so the executor link comes up in the same step as the login — no
/// gap in which a project create can race the not-yet-registered machine
/// and fail with "unknown machine". Shells that omit the field reuse the stored identity or generate one.
async fn adopt_login_with_identity(
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
            base_url: base_url.clone(),
            token,
            email,
        },
        store.clone(),
    )?;
    let machine_id = machine_id
        .filter(|id| !id.is_empty())
        .or_else(|| shared.session.guard().auth.machine_id().map(str::to_owned))
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    auth_change_with_store(shared, AuthChange::Identify { machine_id }, store.clone())?;
    // The switcher's identity data (name + logo) rides the fresh token;
    // best-effort, after the session is fully adopted. The fetch runs with
    // the session lock released: the guard is a std::sync::Mutex, and
    // holding it across the network await parks a worker thread that every
    // other task needs (the daemon runs two workers), which wedges the
    // daemon until restart.
    let cloud = shared.session.guard().auth.cloud_of(&base_url).cloned();
    if let Some(cloud) = cloud {
        if let Ok((name, logo)) = cloud.org_settings().await {
            let mut session = shared.session.guard();
            session
                .auth
                .apply_org_identity(&base_url, name, logo, store.as_deref());
        }
    }
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
            store_path(&shared),
        )
        .await?;
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
            store_path(&shared),
        )
        .await?;
        Ok(Response::ok(req.id, json!({"ok": true, "user": user})))
    }
    .await;
    let _ = out_tx.send(response_value(req.id, result));
}

async fn registry_publish(
    session: Arc<Mutex<EngineState>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let cloud = session
            .guard()
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
    session: Arc<Mutex<EngineState>>,
    req: Request,
    out_tx: mpsc::UnboundedSender<Value>,
) {
    let result = async {
        let cloud = session
            .guard()
            .auth
            .cloud()
            .cloned()
            .context("not logged in — call login first")?;
        let slug = param(&req, "slug")?.to_string();
        let version = req.params["version"].as_str().map(String::from);
        let project_dir = optional_param(&req, "project_dir").map(PathBuf::from);
        let global = req.params["global"].as_bool().unwrap_or(false);
        let publisher = session.guard().auth.email().unwrap_or_default().to_string();
        let entry = crate::registry_client::install_skill(
            &cloud,
            project_dir.as_deref(),
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

/// `registry.uninstall`: removes a Guild-installed skill from the project
/// (or, with `global`, the home) skill scope. `project_dir` is per call
/// and required for the project scope.
async fn registry_uninstall(req: Request, out_tx: mpsc::UnboundedSender<Value>) {
    let result = async {
        let slug = param(&req, "slug")?.to_string();
        let project_dir = optional_param(&req, "project_dir").map(PathBuf::from);
        let global = req.params["global"].as_bool().unwrap_or(false);
        crate::registry_client::uninstall_skill(project_dir.as_deref(), &slug, global)?;
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
        let session = EngineState {
            auth: crate::auth_state::AuthState::from_parts(
                Some(CloudClient {
                    base_url: "http://srv".into(),
                    token: "tok".into(),
                }),
                Some("a@b".into()),
                None,
                None,
            ),
        };
        let mut shared = Shared::new(session);
        shared.store_path = Some(tmp_token_dir());
        shared
    }

    /// A token path in a UNIQUE temp directory — workspaces.json is a
    /// sibling of the token path, so flat filenames would share one
    /// /tmp/workspaces.json across every test and run.
    fn tmp_token_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("guild-rpc-{}", uuid::Uuid::now_v7().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("token.json")
    }

    #[tokio::test]
    async fn identify_stores_identity_and_publishes_link_config() {
        let shared = logged_in_shared();
        let mut link_rx = shared.links.subscribe_or_create("http://srv");
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();

        machine_identify(shared.clone(), identify_req(1, "machine-1"), out_tx).await;

        // The RPC answered ok.
        let resp = out_rx.recv().await.unwrap();
        assert_eq!(resp["result"]["ok"], serde_json::json!(true));
        // The session carries the identity.
        assert_eq!(shared.session.guard().auth.machine_id(), Some("machine-1"));
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
        let mut link_rx = shared.links.subscribe_or_create("http://srv");

        adopt_login_with_identity(
            &shared,
            "http://srv".into(),
            "tok".into(),
            "a@b".into(),
            Some("machine-9".into()),
            None,
        )
        .await
        .unwrap();

        let cfg = link_rx.borrow_and_update().clone().expect("link published");
        assert_eq!(cfg.machine_id, "machine-9");
        assert_eq!(cfg.base_url, "http://srv");
        assert_eq!(cfg.token, "tok");
    }

    #[tokio::test]
    async fn headless_login_persists_and_reuses_the_machine_identity() {
        let shared = logged_in_shared();
        let _rx = shared.links.subscribe_or_create("http://srv");
        let path = tmp_token_dir();
        for token in ["first", "second"] {
            adopt_login_with_identity(
                &shared,
                "http://srv".into(),
                token.into(),
                "a@b".into(),
                None,
                Some(path.clone()),
            )
            .await
            .unwrap();
            let stored = crate::session_store::load(&path).unwrap();
            let cfg = crate::machine_link::config_from_store(&path)
                .expect("persisted identity is executable");
            assert_eq!(stored.token, token);
            assert_eq!(
                cfg.machine_id,
                shared.session.guard().auth.machine_id().unwrap()
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
                .await
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
        let mut link_rx = shared.links.subscribe_or_create("http://srv");

        adopt_login_with_identity(
            &shared,
            "http://srv".into(),
            "tok".into(),
            "a@b".into(),
            None,
            None,
        )
        .await
        .unwrap();

        assert!(link_rx
            .borrow_and_update()
            .as_ref()
            .is_some_and(|cfg| Uuid::parse_str(&cfg.machine_id).is_ok()));
    }

    #[tokio::test]
    async fn login_with_blank_machine_id_generates_an_identity() {
        let shared = logged_in_shared();
        let mut link_rx = shared.links.subscribe_or_create("http://srv");

        adopt_login_with_identity(
            &shared,
            "http://srv".into(),
            "tok".into(),
            "a@b".into(),
            Some("".into()),
            None,
        )
        .await
        .unwrap();

        assert!(link_rx
            .borrow_and_update()
            .as_ref()
            .is_some_and(|cfg| Uuid::parse_str(&cfg.machine_id).is_ok()));
    }

    #[tokio::test]
    async fn identify_persists_identity_into_the_session_store() {
        let shared = logged_in_shared();
        let path = tmp_token_dir();
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
                org_name: None,
                org_logo_url: None,
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
        let mut shared = Shared::new(EngineState::default());
        shared.store_path =
            Some(std::env::temp_dir().join(format!("guild-test-token-{}.json", Uuid::now_v7())));
        let mut link_rx = shared.links.subscribe_or_create("http://srv");
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();

        machine_identify(shared.clone(), identify_req(3, "machine-3"), out_tx).await;
        let _ = out_rx.recv().await.unwrap();

        // Identity is remembered (a later login adopts it)…
        assert_eq!(shared.session.guard().auth.machine_id(), Some("machine-3"));
        // …but no link config is published without a session.
        assert!(link_rx.borrow_and_update().is_none());
    }

    #[tokio::test]
    async fn signing_out_drops_the_link() {
        let shared = logged_in_shared();
        let mut link_rx = shared.links.subscribe_or_create("http://srv");
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

    /// workspace.list must answer with the REQUEST's id: the webview's rpc
    /// waiter matches on it — a hardcoded id would time out every call and
    /// silently hide the switcher. This goes through the real dispatch.
    #[tokio::test]
    async fn workspace_list_correlates_the_response_id() {
        let shared = logged_in_shared();
        let req = Request {
            jsonrpc: "2.0".into(),
            id: 77,
            protocol: protocol::rpc::PROTOCOL_VERSION,
            method: "workspace.list".into(),
            params: serde_json::json!({}),
        };
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        dispatch(shared.clone(), req, out_tx).await;
        let resp = out_rx.recv().await.unwrap();
        assert_eq!(resp["id"], serde_json::json!(77));
        assert_eq!(resp["result"]["active"], serde_json::json!("http://srv"));
        assert_eq!(resp["result"]["workspaces"].as_array().unwrap().len(), 1);
    }

    /// `registry.uninstall` takes its project per call: a project-scope
    /// call without `project_dir` fails instead of reusing an earlier
    /// call's project.
    #[tokio::test]
    async fn registry_uninstall_needs_its_own_project_dir() {
        let project =
            std::env::temp_dir().join(format!("guild-rpc-proj-{}", Uuid::now_v7().simple()));
        let skill = project.join(".agents/skills/demo");
        std::fs::create_dir_all(&skill).unwrap();
        crate::registry_client::write_sidecar(
            &skill,
            &crate::registry_client::SkillProvenance {
                source: "registry".into(),
                slug: "demo".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let call = |id: u64, params: Value| async move {
            let (out_tx, mut out_rx) = mpsc::unbounded_channel();
            registry_uninstall(Request::new(id, "registry.uninstall", params), out_tx).await;
            out_rx.recv().await.unwrap()
        };
        let missing = call(1, json!({ "slug": "demo" })).await;
        assert!(
            missing["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("project_dir")),
            "{missing}"
        );
        assert!(skill.exists());
        let ok = call(2, json!({ "slug": "demo", "project_dir": project })).await;
        assert_eq!(ok["result"]["uninstalled"], "demo", "{ok}");
        assert!(!skill.exists());
        std::fs::remove_dir_all(&project).unwrap();
    }

    /// The dispatch table and `METHODS` agree: every listed method is
    /// routed (never METHOD_NOT_FOUND), and an unlisted one is not.
    #[tokio::test]
    async fn every_listed_method_is_dispatched() {
        let mut shared = Shared::new(EngineState::default());
        shared.store_path = Some(tmp_token_dir());
        for (id, method) in METHODS.iter().enumerate() {
            // Network- and process-touching verbs are routed without being
            // executed here: their own tests cover them.
            if matches!(
                *method,
                "login" | "pair" | "daemon.shutdown" | "registry.publish" | "registry.install"
            ) {
                continue;
            }
            let (out_tx, mut out_rx) = mpsc::unbounded_channel();
            dispatch(
                shared.clone(),
                Request::new(id as u64, *method, json!({})),
                out_tx,
            )
            .await;
            let resp = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_ne!(
                resp["error"]["code"],
                json!(RpcError::METHOD_NOT_FOUND),
                "{method}: {resp}"
            );
        }
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        dispatch(shared, Request::new(99, "chat.send", json!({})), out_tx).await;
        let resp = out_rx.recv().await.unwrap();
        assert_eq!(resp["error"]["code"], json!(RpcError::METHOD_NOT_FOUND));
    }
}

#[cfg(test)]
mod connection_tests {
    use super::*;

    /// `METHODS` is exactly the method table of the rpc contract.
    #[test]
    fn methods_match_the_rpc_contract() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../protocol/rpc.schema.json")).unwrap();
        let mut from_schema: Vec<&str> = schema["methods"]
            .as_object()
            .expect("rpc.schema.json has a methods table")
            .keys()
            .map(String::as_str)
            .filter(|k| !k.starts_with('$'))
            .collect();
        from_schema.sort_unstable();
        let mut dispatched = METHODS.to_vec();
        dispatched.sort_unstable();
        assert_eq!(dispatched, from_schema);
    }

    /// A login whose server reply is withheld does not block the
    /// connection's out-of-band requests: hello answers while the login is
    /// still in flight.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_slow_login_does_not_block_hello() {
        use std::io::{BufRead as _, Write as _};
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/auth/login"))
            .respond_with(
                wiremock::ResponseTemplate::new(401).set_delay(std::time::Duration::from_secs(3)),
            )
            .mount(&server)
            .await;
        let shared = Shared::new(EngineState::default());
        let (client, conn) = std::os::unix::net::UnixStream::pair().unwrap();
        let conn_read = conn.try_clone().unwrap();
        let host = shared.clone();
        tokio::spawn(async move { run_connection(&host, conn_read, conn).await });
        let mut writer = client.try_clone().unwrap();
        let line = |id: u64, method: &str, params: Value| {
            serde_json::to_string(&Request::new(id, method, params)).unwrap()
        };
        writeln!(
            writer,
            "{}",
            line(
                1,
                "login",
                json!({"base_url": server.uri(), "email": "a@b", "password": "x"})
            )
        )
        .unwrap();
        writeln!(writer, "{}", line(2, "daemon.hello", json!({}))).unwrap();
        let started = std::time::Instant::now();
        let seen = tokio::task::spawn_blocking(move || {
            client
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut reader = std::io::BufReader::new(client);
            let mut seen = Vec::new();
            while seen.len() < 2 {
                let mut buf = String::new();
                if reader.read_line(&mut buf).unwrap_or(0) == 0 {
                    break;
                }
                let v: Value = serde_json::from_str(buf.trim()).unwrap();
                seen.push((v, started.elapsed()));
            }
            seen
        })
        .await
        .unwrap();
        let position = |pred: &dyn Fn(&Value) -> bool| seen.iter().position(|(v, _)| pred(v));
        let hello = position(&|v| v["id"] == 2).expect("hello answered");
        let login = position(&|v| v["id"] == 1).expect("login answered");
        assert!(hello < login, "{seen:?}");
        assert!(
            seen[hello].1 < std::time::Duration::from_secs(2),
            "hello waited for the login: {seen:?}"
        );
    }

    /// A login whose token.json write fails still changes the in-memory
    /// principal, and a retry succeeds.
    #[test]
    fn a_failed_persist_during_an_account_switch_still_switches_in_memory() {
        let session = EngineState {
            auth: crate::auth_state::AuthState::from_parts(
                Some(CloudClient {
                    base_url: "http://srv".into(),
                    token: "tok-a".into(),
                }),
                Some("a@b".into()),
                None,
                None,
            ),
        };
        let shared = Shared::new(session);
        let login = || AuthChange::Login {
            base_url: "http://srv".into(),
            token: "tok-b".into(),
            email: "b@b".into(),
        };
        // A path under a regular file cannot be written.
        let blocker = std::env::temp_dir().join(format!("guild-blocker-{}", Uuid::now_v7()));
        std::fs::write(&blocker, "x").unwrap();
        let bad = blocker.join("token.json");
        assert!(auth_change_with_store(&shared, login(), Some(bad)).is_err());
        assert_eq!(shared.session.guard().auth.email(), Some("b@b"));
        let good = std::env::temp_dir().join(format!("guild-token-{}.json", Uuid::now_v7()));
        auth_change_with_store(&shared, login(), Some(good.clone())).unwrap();
        let _ = std::fs::remove_file(&blocker);
        let _ = std::fs::remove_file(&good);
    }
}
