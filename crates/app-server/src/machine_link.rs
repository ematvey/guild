//! The machine link: the daemon's executor connection to the server
//! (spec 2026-09-18 agent-loop unification §3.1). One WS per daemon,
//! registered as the machine's executor slot — the same role the Tauri
//! host held before the link moved here. The durable workflow dispatches
//! client tools to this socket; the daemon executes them with the builtin
//! registry and returns the result over the same socket.
//!
//! Lifecycle: the link config (server + token + machine identity) rides a
//! watch channel; login, pair, `machine.identify`, and sign-out publish
//! config changes and the task reconnects. Identity persists in
//! `token.json`, so the machine stays executable across daemon restarts —
//! including with no GUI open.

use crate::cloud::{CloudClient, CloudError};
use crate::jsonrpc_loop::Shared;
use crate::session_store;
use futures::{SinkExt, StreamExt};
use protocol::ws::{WsClientMsg, WsServerMsg};
use serde::Deserialize;
use uuid::Uuid;
use std::path::Path;
use std::time::Duration;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;

/// Heartbeat cadence and the dead-link verdict: the server pings every
/// socket ~15 s (challenge-pong in ws.rs), so a link with no inbound frame
/// for IDLE_SECS is a half-open route (suspend, NAT expiry, Wi-Fi blip) —
/// no TCP error will ever arrive on it, and without this watchdog the
/// session sat "connected" forever while the server had long freed the
/// slot (machine offline until the daemon restarted). Env-overridable for
/// tests.
fn heartbeat_secs() -> u64 {
    std::env::var("GUILD_LINK_HEARTBEAT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15)
}

fn idle_secs() -> u64 {
    std::env::var("GUILD_LINK_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(45)
}

/// What the link needs right now; `None` = disconnected (no session or no
/// machine identity yet).
#[derive(Debug, Clone, PartialEq)]
pub struct MachineLinkConfig {
    pub base_url: String,
    pub token: String,
    pub machine_id: String,
    pub client_id: String,
    pub machine_name: String,
}

/// Registry metadata reported on every machine connect: the durable
/// hardware fingerprint (re-pair adoption hint) plus OS and app versions.
/// Unavailable values are omitted — the server stores NULL.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct MachineMeta {
    pub fingerprint: Option<String>,
    pub os: Option<String>,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
}

fn non_empty(v: &str) -> Option<String> {
    let t = v.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Stable per-install hardware identity, lowercase-trimmed: MachineGuid on
/// Windows, /etc/machine-id on Linux, IOPlatformUUID on macOS.
#[cfg(windows)]
fn machine_fingerprint() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .ok()?;
    let guid: String = key.get_value("MachineGuid").ok()?;
    non_empty(&guid).map(|v| v.to_lowercase())
}

#[cfg(target_os = "linux")]
fn machine_fingerprint() -> Option<String> {
    let raw = std::fs::read_to_string("/etc/machine-id").ok()?;
    non_empty(&raw).map(|v| v.to_lowercase())
}

#[cfg(target_os = "macos")]
fn machine_fingerprint() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.contains("IOPlatformUUID"))?;
    let value = line.split('"').nth(3)?;
    non_empty(value).map(|v| v.to_lowercase())
}

/// Human-facing OS version (e.g. "24H2", "15.5"), trimmed.
#[cfg(windows)]
fn machine_os_version() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .ok()?;
    let version: String = key
        .get_value("DisplayVersion")
        .or_else(|_| key.get_value("CurrentVersion"))
        .ok()?;
    non_empty(&version)
}

#[cfg(target_os = "linux")]
fn machine_os_version() -> Option<String> {
    if let Ok(release) = std::fs::read_to_string("/etc/os-release") {
        for line in release.lines() {
            if let Some(value) = line.strip_prefix("VERSION_ID=") {
                if let Some(v) = non_empty(value.trim().trim_matches('"')) {
                    return Some(v);
                }
            }
        }
    }
    let kernel = std::process::Command::new("uname").arg("-r").output().ok()?;
    non_empty(&String::from_utf8_lossy(&kernel.stdout))
}

#[cfg(target_os = "macos")]
fn machine_os_version() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    non_empty(&String::from_utf8_lossy(&output.stdout))
}

fn machine_meta() -> MachineMeta {
    MachineMeta {
        fingerprint: machine_fingerprint(),
        os: Some(std::env::consts::OS.to_string()),
        os_version: machine_os_version(),
        app_version: non_empty(env!("CARGO_PKG_VERSION")),
    }
}

/// Hostname label reported at connect (same sources as the machine.info
/// RPC): COMPUTERNAME on Windows, /etc/hostname elsewhere.
pub fn hostname_label() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "guild-machine".to_string())
}

/// Builds the upgrade URL: http(s) → ws(s), `/api/v1/ws`, all values
/// percent-encoded by the url crate. The ticket rides last (single-use,
/// minted per connect).
fn websocket_url(
    cfg: &MachineLinkConfig,
    meta: &MachineMeta,
    instance_id: uuid::Uuid,
    ticket: &str,
) -> Url {
    let mut url = Url::parse(&cfg.base_url).expect("link config carries a parsed URL");
    url.set_scheme(match url.scheme() {
        "https" => "wss",
        _ => "ws",
    })
    .expect("ws/wss are valid schemes");
    url.set_path(&format!(
        "{}/api/v1/ws",
        url.path().trim_end_matches('/')
    ));
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("ticket", ticket);
        query.append_pair("client_id", &cfg.client_id);
        query.append_pair("machine_id", &cfg.machine_id);
        query.append_pair("machine_name", &cfg.machine_name);
        if let Some(f) = &meta.fingerprint {
            query.append_pair("machine_fingerprint", f);
        }
        if let Some(o) = &meta.os {
            query.append_pair("machine_os", o);
        }
        if let Some(v) = &meta.os_version {
            query.append_pair("machine_os_version", v);
        }
        if let Some(v) = &meta.app_version {
            query.append_pair("machine_app_version", v);
        }
        query.append_pair("instance_id", &instance_id.to_string());
        query.append_pair("resume", "false");
    }
    url
}

/// The executor-relevant subset of `WsServerMsg`, extracted by tag-peeking
/// the raw JSON first: the link's liveness must not depend on the display
/// event vocabulary (`StreamEvent` gains variants regularly, and machine
/// sockets receive the same live feed as browser sockets). Only the frames
/// this socket acts on are parsed strictly; everything else — display
/// frames, unknown variants, unparseable text — is ignored.
enum ServerFrame {
    ToolDispatch {
        chat_id: Uuid,
        call_id: String,
        name: String,
        arguments: String,
        workdir: Option<String>,
    },
    MachineRequest {
        request_id: String,
        op: String,
        payload: serde_json::Value,
    },
    Displaced,
    AuthRequired,
    Error { message: String },
    /// Anything the executor does not act on: display/state frames, frames
    /// with an unknown `type` tag, non-JSON text. All ignored, never fatal.
    Other,
}

fn classify_server_frame(text: &str) -> ServerFrame {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ServerFrame::Other;
    };
    let tag = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    match tag {
        "tool_dispatch" | "machine_request" | "error" => {
            match serde_json::from_value::<WsServerMsg>(value) {
                Ok(WsServerMsg::ToolDispatch {
                    chat_id,
                    call_id,
                    name,
                    arguments,
                    workdir,
                }) => ServerFrame::ToolDispatch {
                    chat_id,
                    call_id,
                    name,
                    arguments,
                    workdir,
                },
                Ok(WsServerMsg::MachineRequest {
                    request_id,
                    op,
                    payload,
                }) => ServerFrame::MachineRequest {
                    request_id,
                    op,
                    payload,
                },
                Ok(WsServerMsg::Error { message }) => ServerFrame::Error { message },
                _ => ServerFrame::Other,
            }
        }
        "displaced" => ServerFrame::Displaced,
        "auth_required" => ServerFrame::AuthRequired,
        _ => ServerFrame::Other,
    }
}

/// Runs one WS session until it drops; returns why.
#[derive(Debug)]
enum LinkEnd {
    Displaced,
    AuthRequired,
    Closed,
    Failed(String),
}

async fn ws_session(
    _shared: &Shared,
    cfg: &MachineLinkConfig,
    meta: &MachineMeta,
    instance_id: uuid::Uuid,
    cfg_rx: &mut watch::Receiver<Option<MachineLinkConfig>>,
    shutdown_rx: &mut watch::Receiver<bool>,
) -> LinkEnd {
    let cloud = CloudClient {
        base_url: cfg.base_url.clone(),
        token: cfg.token.clone(),
    };
    let ticket = match cloud.ws_ticket().await {
        Ok(t) => t,
        Err(CloudError::Unauthorized) => return LinkEnd::AuthRequired,
        Err(e) => return LinkEnd::Failed(format!("ticket mint failed: {e}")),
    };
    let url = websocket_url(cfg, meta, instance_id, &ticket);
    let (ws, _) = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok(pair) => pair,
        Err(e) => return LinkEnd::Failed(format!("connect failed: {e}")),
    };
    let (mut sink, mut stream) = ws.split();
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<WsMessage>();

    let mut writer = tokio::spawn(async move {
        while let Some(msg) = outbound_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut last_inbound = tokio::time::Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(heartbeat_secs()));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let end = loop {
        tokio::select! {
            // Liveness: any inbound frame proves the route; silence past the
            // idle deadline means the link is half-open — drop and reconnect.
            _ = heartbeat.tick() => {
                if last_inbound.elapsed() >= Duration::from_secs(idle_secs()) {
                    break LinkEnd::Closed;
                }
                let _ = outbound_tx.send(WsMessage::Ping(Vec::new().into()));
            }
            // Config changed while connected: drop and reconnect.
            _ = cfg_rx.changed() => {
                break LinkEnd::Closed;
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break LinkEnd::Closed;
                }
            }
            incoming = stream.next() => {
                let Some(msg) = incoming else { break LinkEnd::Closed };
                last_inbound = tokio::time::Instant::now();
                match msg {
                    Ok(WsMessage::Text(text)) => match classify_server_frame(&text) {
                        ServerFrame::ToolDispatch { chat_id, call_id, name, arguments, workdir } => {
                            // Execution rides a task: the reader must keep
                            // reading (and ponging) while a dispatch runs — a
                            // tool slower than the server's 10 s pong deadline
                            // used to tear the link down mid-command and lose
                            // the result. Responses are matched by call_id/
                            // request_id on the server, so completion order is
                            // free to interleave.
                            let outbound = outbound_tx.clone();
                            tokio::spawn(async move {
                                let result =
                                    execute_client_tool(&name, &arguments, workdir.as_deref()).await;
                                let msg = WsClientMsg::ToolResult {
                                    chat_id,
                                    call_id,
                                    content: result.content,
                                    is_error: result.is_error,
                                    meta: result.meta,
                                };
                                let _ = outbound.send(WsMessage::Text(
                                    serde_json::to_string(&msg)
                                        .expect("client message serializes")
                                        .into(),
                                ));
                            });
                        }
                        ServerFrame::MachineRequest { request_id, op, payload } => {
                            let outbound = outbound_tx.clone();
                            tokio::spawn(async move {
                                let result = machine_request_result(&op, &payload).await;
                                let (ok, resp_payload, error) = match result {
                                    Ok(v) => (true, Some(v), None),
                                    Err(e) => (false, None, Some(e)),
                                };
                                let msg = WsClientMsg::MachineResponse {
                                    request_id,
                                    ok,
                                    payload: resp_payload,
                                    error,
                                };
                                let _ = outbound.send(WsMessage::Text(
                                    serde_json::to_string(&msg)
                                        .expect("client message serializes")
                                        .into(),
                                ));
                            });
                        }
                        ServerFrame::Displaced => break LinkEnd::Displaced,
                        ServerFrame::AuthRequired => break LinkEnd::AuthRequired,
                        ServerFrame::Error { message } => {
                            break LinkEnd::Failed(format!("server error: {message}"));
                        }
                        ServerFrame::Other => {} // display frames and unknown variants: not ours
                    },
                    Ok(WsMessage::Ping(payload)) => {
                        let _ = outbound_tx.send(WsMessage::Pong(payload));
                    }
                    Ok(WsMessage::Close(_)) | Err(_) => break LinkEnd::Closed,
                    Ok(_) => {} // binary/pong noise
                }
            }
        }
    };
    // Close cleanly, then let the writer drain: dropping the sender is what
    // unblocks `recv` — without it the writer (and this function) hang
    // whenever the loop broke while the socket was still healthy (config
    // change, shutdown) and the link never reconnects.
    let _ = outbound_tx.send(WsMessage::Close(None));
    drop(outbound_tx);
    // The drain writes into a socket that may already be dead: bound it, or
    // a wedged TCP write hangs the reconnect here forever. In-flight
    // dispatches hold sender clones, so the drain also carries results that
    // landed between the loop break and the close.
    let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer).await;
    // A drain that timed out leaves the writer parked in sink.send on a
    // wedged route — abort it (dropping the sink closes the socket), or
    // every reconnect on such a route leaks one blocked task. Abort on an
    // already-finished writer is a no-op.
    writer.abort();
    end
}

/// Control-plane ops the server sends over the executor socket (read-only
/// filesystem access for the desktop's remote folder browse).
async fn machine_request_result(
    op: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match op {
        "fs_home" => Ok(serde_json::json!({
            "home": std::env::var("HOME").unwrap_or_default()
        })),
        "fs_list" => {
            let path = payload["path"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("missing path")?;
            let mut reader = tokio::fs::read_dir(path)
                .await
                .map_err(|e| format!("{path}: {e}"))?;
            let mut dirs: Vec<serde_json::Value> = Vec::new();
            let mut files: Vec<serde_json::Value> = Vec::new();
            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|e| format!("{path}: {e}"))?
            {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry
                    .file_type()
                    .await
                    .map(|t| t.is_dir())
                    .unwrap_or(false);
                let item = serde_json::json!({ "name": name, "is_dir": is_dir });
                if is_dir { dirs.push(item) } else { files.push(item) }
            }
            dirs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            dirs.extend(files);
            Ok(serde_json::json!({ "entries": dirs }))
        }
        other => Err(format!("unknown op {other:?}")),
    }
}

/// The executor: one builtin tool call in the dispatch's workspace folder —
/// the exact semantics the Tauri host used before the link moved here.
struct ExecOutcome {
    content: String,
    is_error: bool,
    meta: Option<serde_json::Value>,
}

async fn execute_client_tool(name: &str, arguments: &str, workdir: Option<&str>) -> ExecOutcome {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));
    let outcome: Result<ExecOutcome, String> = match workdir {
        None => Err("no workspace folder is set for this chat — pick a project with 'Choose project' in the composer".to_string()),
        Some(dir) => {
            let registry = guild_core::tools::ToolRegistry::builtins();
            match registry.get(name) {
                Some(tool) => match tool.run(Path::new(dir), args).await {
                    Ok(out) => Ok(ExecOutcome {
                        content: out.output_for_model,
                        is_error: false,
                        meta: out.meta,
                    }),
                    Err(e) => Ok(ExecOutcome {
                        content: e.to_string(),
                        is_error: true,
                        meta: None,
                    }),
                },
                None => Err(format!("unknown tool {name}")),
            }
        }
    };
    match outcome {
        Ok(o) => o,
        Err(e) => ExecOutcome {
            content: e,
            is_error: true,
            meta: None,
        },
    }
}

/// Installs the process-level rustls crypto provider (ring). The tree
/// enables both ring and aws-lc-rs, so rustls refuses to auto-select —
/// every WS connect (even plain ws://) panics without this. Idempotent.
pub fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The link task: owns the machine's executor connection for the daemon's
/// lifetime. Spawned once by the daemon; config changes arrive on the watch
/// channel (login, pair, identify, sign-out).
pub async fn run(shared: Shared, mut cfg_rx: watch::Receiver<Option<MachineLinkConfig>>) {
    ensure_crypto_provider();
    let meta = machine_meta();
    let mut instance_id = uuid::Uuid::now_v7();
    let mut current: Option<MachineLinkConfig> = None;
    let mut shutdown_rx = shared.shutdown.subscribe();
    loop {
        // Block until a config exists.
        let cfg = loop {
            if let Some(c) = cfg_rx.borrow_and_update().clone() {
                if current.as_ref() != Some(&c) {
                    instance_id = uuid::Uuid::now_v7(); // new incarnation: no resume
                    current = Some(c.clone());
                }
                break c;
            }
            if cfg_rx.changed().await.is_err() {
                return; // channel closed — daemon shutting down
            }
        };
        crate::dtrace::dtrace(&format!("machine-link connecting as {}", cfg.machine_id));
        match ws_session(
            &shared,
            &cfg,
            &meta,
            instance_id,
            &mut cfg_rx,
            &mut shutdown_rx,
        )
        .await
        {
            LinkEnd::Displaced => {
                // A newer connection took the slot — often the same
                // install's GUI-embedded daemon. Parking here stranded the
                // machine forever once that displacer closed (GUI quit):
                // retry after a long backoff instead. A genuinely competing
                // instance just re-displaces us; the slow cadence keeps
                // that fight visible without leaving the machine dead.
                wait_for_config_change_or_backoff(&mut cfg_rx, &cfg, 300).await;
            }
            LinkEnd::AuthRequired => {
                // The session token was rejected — could be a transient
                // 401 during a server deploy just as well as a revoked
                // token. Retry on a slow cadence; a real sign-out republishes
                // `None` and the outer loop parks anyway.
                wait_for_config_change_or_backoff(&mut cfg_rx, &cfg, 60).await;
            }
            LinkEnd::Closed => {
                // Clean close — config change (handled at loop top) or the
                // server dropped us: brief backoff, then reconnect.
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            LinkEnd::Failed(reason) => {
                crate::dtrace::dtrace(&format!("machine link: {reason}"));
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
    }
}

/// Waits for the link config to actually change, but no longer than
/// `backoff_secs`: a stale config still retries once the backoff elapses,
/// so neither displacement nor a transient auth failure can park the
/// executor link permanently. A sign-out (`None`) breaks out immediately
/// and the outer loop parks.
async fn wait_for_config_change_or_backoff(
    cfg_rx: &mut watch::Receiver<Option<MachineLinkConfig>>,
    current: &MachineLinkConfig,
    backoff_secs: u64,
) {
    cfg_rx.borrow_and_update();
    let changed = tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => false,
        r = cfg_rx.changed() => r.is_ok(),
    };
    if !changed {
        return; // backoff elapsed: retry the same config
    }
    let published = cfg_rx.borrow().clone();
    match published {
        Some(c) if c != *current => {} // new config: outer loop reconnects with it
        _ => tokio::time::sleep(Duration::from_secs(1)).await, // same config or signed out
    }
}

/// Reads the machine identity the webview reported, generating the stable
/// client id on first identify.
pub fn adopt_identity(
    stored: &mut session_store::StoredSession,
    machine_id: &str,
) -> MachineLinkConfig {
    stored.machine_id = Some(machine_id.to_string());
    let client_id = stored
        .client_id
        .get_or_insert_with(|| uuid::Uuid::now_v7().to_string());
    let machine_name = stored.machine_name.get_or_insert_with(hostname_label);
    MachineLinkConfig {
        base_url: stored.base_url.clone(),
        token: stored.token.clone(),
        machine_id: machine_id.to_string(),
        client_id: client_id.clone(),
        machine_name: machine_name.clone(),
    }
}

/// The wire shape of the daemon's `machine.identify` params.
#[derive(Deserialize)]
pub struct IdentifyParams {
    pub machine_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> MachineLinkConfig {
        MachineLinkConfig {
            base_url: "http://localhost:18080".into(),
            token: "tok".into(),
            machine_id: "machine-1".into(),
            client_id: "client-1".into(),
            machine_name: "box".into(),
        }
    }

    #[test]
    fn websocket_url_is_ws_with_encoded_query_and_meta() {
        let meta = MachineMeta {
            fingerprint: Some("abc-123".into()),
            os: Some("linux".into()),
            os_version: Some("6.1".into()),
            app_version: Some("0.5.12".into()),
        };
        let url = websocket_url(&cfg(), &meta, uuid::Uuid::now_v7(), "tk");
        assert_eq!(url.scheme(), "ws");
        assert!(url.path().ends_with("/api/v1/ws"));
        let q = url.query().unwrap();
        assert!(q.contains("client_id=client-1"));
        assert!(q.contains("machine_id=machine-1"));
        assert!(q.contains("machine_name=box"));
        assert!(q.contains("machine_fingerprint=abc-123"));
        assert!(q.contains("machine_os=linux"));
        assert!(q.contains("machine_os_version=6.1"));
        assert!(q.contains("machine_app_version=0.5.12"));
        assert!(q.contains("instance_id="));
        assert!(q.contains("resume=false"));
        assert!(q.contains("ticket="));
        // Trailing slash on the base must not double up the path.
        let mut c = cfg();
        c.base_url = "http://localhost:18080/".into();
        let url2 = websocket_url(&c, &meta, uuid::Uuid::now_v7(), "tk");
        assert_eq!(url2.path(), "/api/v1/ws");
    }

    #[test]
    fn websocket_url_upgrades_https_to_wss() {
        let mut c = cfg();
        c.base_url = "https://guild.example.com".into();
        let url = websocket_url(&c, &MachineMeta::default(), uuid::Uuid::now_v7(), "tk");
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.host_str(), Some("guild.example.com"));
        assert!(url.query().unwrap().contains("ticket=tk"));
    }

    #[test]
    fn meta_collects_os_and_app_version() {
        let meta = machine_meta();
        assert_eq!(meta.os.as_deref(), Some(std::env::consts::OS));
        assert_eq!(meta.app_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn adopt_identity_generates_stable_ids() {
        let mut stored = session_store::StoredSession {
            base_url: "http://x".into(),
            token: "t".into(),
            email: None,
            machine_id: None,
            client_id: None,
            machine_name: None,
        };
        let first = adopt_identity(&mut stored, "m-1");
        assert_eq!(first.machine_id, "m-1");
        let cid = first.client_id.clone();
        // Re-adopt keeps the generated client id and label.
        let second = adopt_identity(&mut stored, "m-1");
        assert_eq!(second.client_id, cid);
        assert!(!second.machine_name.is_empty());
    }

    #[test]
    fn execute_client_tool_requires_a_workdir() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt.block_on(execute_client_tool("read_file", "{}", None));
        assert!(out.is_error);
        assert!(out.content.contains("no workspace folder"));
    }

    #[test]
    fn execute_client_tool_unknown_tool_errors() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt.block_on(execute_client_tool(
            "no_such_tool",
            "{}",
            Some(std::env::temp_dir().to_str().unwrap()),
        ));
        assert!(out.is_error);
        assert!(out.content.contains("unknown tool"));
    }

    /// The tag-peek classifier parses only the executor-relevant variants;
    /// display frames, unknown variants, and non-JSON text are all Other —
    /// server protocol evolution cannot end the executor session.
    #[test]
    fn classifier_ignores_display_unknown_and_malformed_frames() {
        let live = serde_json::json!({
            "type": "live_frame",
            "chat_id": uuid::Uuid::nil(),
            "generation_id": uuid::Uuid::nil(),
            "seq": 1,
            "event": {"type": "brand_new_stream_variant"}
        });
        for text in [
            live.to_string(),
            r#"{"type":"thread_list","chats":[]}"#.to_string(),
            "not json at all".to_string(),
            r#"{"no_type_tag": true}"#.to_string(),
            // A tool_dispatch that fails its typed parse is not fatal either.
            r#"{"type":"tool_dispatch","chat_id":42}"#.to_string(),
        ] {
            assert!(
                matches!(classify_server_frame(&text), ServerFrame::Other),
                "frame must be ignored, not fatal: {text}"
            );
        }
        assert!(matches!(
            classify_server_frame(r#"{"type":"displaced"}"#),
            ServerFrame::Displaced
        ));
        assert!(matches!(
            classify_server_frame(r#"{"type":"auth_required"}"#),
            ServerFrame::AuthRequired
        ));
        let dispatch = serde_json::json!({
            "type": "tool_dispatch",
            "chat_id": uuid::Uuid::nil(),
            "call_id": "c1",
            "name": "execute",
            "arguments": "{}"
        });
        match classify_server_frame(&dispatch.to_string()) {
            ServerFrame::ToolDispatch { call_id, name, .. } => {
                assert_eq!((call_id.as_str(), name.as_str()), ("c1", "execute"));
            }
            _ => panic!("tool_dispatch must classify"),
        }
    }
}
