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
use std::path::Path;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;

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

    let writer = tokio::spawn(async move {
        while let Some(msg) = outbound_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let end = loop {
        tokio::select! {
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
                match msg {
                    Ok(WsMessage::Text(text)) => match serde_json::from_str::<WsServerMsg>(&text) {
                        Ok(WsServerMsg::ToolDispatch { chat_id, call_id, name, arguments, workdir }) => {
                            let result = execute_client_tool(&name, &arguments, workdir.as_deref()).await;
                            let msg = WsClientMsg::ToolResult {
                                chat_id,
                                call_id,
                                content: result.content,
                                is_error: result.is_error,
                                meta: result.meta,
                            };
                            let _ = outbound_tx.send(WsMessage::Text(
                                serde_json::to_string(&msg).expect("client message serializes").into(),
                            ));
                        }
                        Ok(WsServerMsg::Displaced) => break LinkEnd::Displaced,
                        Ok(WsServerMsg::AuthRequired) => break LinkEnd::AuthRequired,
                        Ok(WsServerMsg::Error { message }) => {
                            break LinkEnd::Failed(format!("server error: {message}"));
                        }
                        Ok(_) => {} // display frames belong to the GUI's member socket
                        Err(e) => break LinkEnd::Failed(format!("bad server frame: {e}")),
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
    let _ = outbound_tx.send(WsMessage::Close(None));
    let _ = writer.await;
    end
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
            LinkEnd::Displaced | LinkEnd::AuthRequired => {
                // A newer connection took the slot, or the session expired:
                // wait for the config to actually change (re-login /
                // re-identify) before retrying.
                loop {
                    cfg_rx.borrow_and_update();
                    if cfg_rx.changed().await.is_err() {
                        return;
                    }
                    match cfg_rx.borrow().clone() {
                        Some(c) if c != cfg => break,
                        Some(_) => {} // same config re-published — keep waiting
                        None => break, // signed out: outer loop parks
                    }
                }
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
}
