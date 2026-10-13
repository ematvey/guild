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
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;
use uuid::Uuid;

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
    let kernel = std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()?;
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
    url.set_path(&format!("{}/api/v1/ws", url.path().trim_end_matches('/')));
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
    Error {
        message: String,
    },
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
    shared: &Shared,
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
    let ticket = match tokio::select! {
        result = cloud.ws_ticket() => result,
        _ = cfg_rx.changed() => return LinkEnd::Closed,
        _ = shutdown_rx.changed() => return LinkEnd::Closed,
    } {
        Ok(t) => t,
        Err(CloudError::Unauthorized) => return LinkEnd::AuthRequired,
        Err(e) => return LinkEnd::Failed(format!("ticket mint failed: {e}")),
    };
    let url = websocket_url(cfg, meta, instance_id, &ticket);
    let connected = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30), tokio_tungstenite::connect_async(url.as_str())) => result,
        _ = cfg_rx.changed() => return LinkEnd::Closed,
        _ = shutdown_rx.changed() => return LinkEnd::Closed,
    };
    let (ws, _) = match connected {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return LinkEnd::Failed(format!("connect failed: {e}")),
        Err(_) => return LinkEnd::Failed("connect timed out after 30s".into()),
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

    let hooks = crate::artifacts::registry_hooks(cloud.clone(), shared.artifacts.clone());
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
                            let hooks = hooks.clone();
                            tokio::spawn(async move {
                                let result =
                                    execute_client_tool(&name, &arguments, workdir.as_deref(), Some(hooks)).await;
                                let msg = WsClientMsg::ToolResult {
                                    chat_id,
                                    call_id,
                                    content: result.content,
                                    is_error: result.is_error,
                                    meta: result.meta,
                                    images: result.images,
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
                            let hooks = hooks.clone();
                            let cloud = cloud.clone();
                            tokio::spawn(async move {
                                let result = if op == "artifact.prefetch_v1" {
                                    prefetch_artifact(&payload, &hooks).await
                                } else if op == "skills.sync_v1" {
                                    sync_skills(&payload, &cloud).await
                                } else {
                                    machine_request_result(&op, &payload).await
                                };
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
                            // The server sends Error for non-terminal
                            // conditions too (rejected ToolResult, feed
                            // resync, thread_list failure): the link stays
                            // up — terminal conditions close the socket
                            // anyway. One transient error must not tear the
                            // link down and leave in-flight results with an
                            // unknown outcome.
                            crate::dtrace::dtrace(&format!(
                                "machine link server error: {message}"
                            ));
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

/// Cap on `fs_list` entries: the folder browse is a user-driven paginated
/// view, never a bulk export — an uncapped directory (node_modules,
/// /usr/lib) shipped its entire listing as one giant frame. Mirrors
/// read_file's truncation marker.
const FS_LIST_MAX_ENTRIES: usize = 1000;

/// Cap on `fs_read` payloads (machine-side control plane read): a huge file
/// must not ride the executor socket as one frame.
const FS_READ_MAX_BYTES: usize = 1024 * 1024;

/// The skill scope `skills.sync_v1` converges: the machine user's home
/// (`~/.agents/skills` — the same root the remote-context skill scan
/// reads). Env-overridable for tests.
fn skills_root() -> PathBuf {
    std::env::var("GUILD_SKILLS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate::fs_bridge::home_dir())
}

/// One `skills.sync_v1` request over the link: fills in each entry's
/// bundle URL when the server omitted it (the machine's own authenticated
/// registry bundle endpoint — the same one install_skill uses), then
/// converges the home skill scope. The bearer-auth fetch path is the
/// machine link's own cloud client, exactly like artifact prefetch.
async fn sync_skills(
    payload: &serde_json::Value,
    cloud: &CloudClient,
) -> Result<serde_json::Value, String> {
    let base = cloud.base_url.trim_end_matches('/');
    let mut payload = payload.clone();
    if let Some(skills) = payload["skills"].as_array_mut() {
        for entry in skills {
            let missing = entry["url"]
                .as_str()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .is_none();
            if missing {
                let slug = entry["slug"].as_str().unwrap_or_default();
                let version = entry["version"].as_str().unwrap_or_default();
                entry["url"] = serde_json::json!(format!(
                    "{base}/api/v1/registry/skill/{slug}/{version}/bundle"
                ));
            }
        }
    }
    crate::skill_sync::sync(
        &payload,
        |url: String| {
            let cloud = cloud.clone();
            async move { crate::skill_sync::fetch_bundle(&cloud, &url).await }
        },
        &skills_root(),
    )
    .await
}

/// Control-plane ops the server sends over the executor socket (read-only
/// filesystem access for the desktop's remote folder browse).
async fn prefetch_artifact(
    payload: &serde_json::Value,
    hooks: &guild_core::tools::artifacts::ArtifactHooks,
) -> Result<serde_json::Value, String> {
    use guild_core::tools::artifacts::{materialize, ArtifactPath};
    let workdir = Path::new(payload["workdir"].as_str().ok_or("missing workdir")?);
    if !workdir.is_absolute() || !workdir.is_dir() {
        return Err("invalid project directory".into());
    }
    let chat_id =
        serde_json::from_value::<Uuid>(payload["chat_id"].clone()).map_err(|e| e.to_string())?;
    let artifact_id = serde_json::from_value::<Uuid>(payload["artifact_id"].clone())
        .map_err(|e| e.to_string())?;
    let filename = payload["filename"].as_str().ok_or("missing filename")?;
    if filename.is_empty()
        || filename.len() > 1024
        || filename.contains(['/', '\\'])
        || matches!(filename, "." | "..")
    {
        return Err("invalid artifact filename".into());
    }
    hooks.index.record(chat_id, filename, artifact_id);
    let artifact = ArtifactPath {
        chat_id,
        filename: filename.into(),
    };
    let path = materialize(workdir, &artifact, &hooks.index, hooks.fetcher.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"path": path}))
}

async fn machine_request_result(
    op: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match op {
        "capabilities" => Ok(
            serde_json::json!({"operations": ["context.prepare_v1", "artifact.prefetch_v1", "skills.sync_v1"]}),
        ),
        "context.prepare_v1" => {
            let project = payload["project_dir"]
                .as_str()
                .ok_or("missing project_dir")?;
            let prompt = payload["prompt"].as_str().unwrap_or_default();
            if project.len() > 32768 || prompt.len() > 1024 * 1024 {
                return Err("context request exceeds limit".into());
            }
            let project = std::path::PathBuf::from(project);
            let prompt = prompt.to_string();
            let result = tokio::task::spawn_blocking(move || {
                crate::remote_context::prepare(&project, &prompt)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "fs_home" => Ok(serde_json::json!({
            "home": std::env::var("HOME").unwrap_or_default()
        })),
        "fs_read" => {
            use base64::Engine as _;
            let path = payload["path"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("missing path")?;
            if !Path::new(path).is_absolute() {
                return Err("path must be absolute".into());
            }
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|e| format!("{path}: {e}"))?;
            if bytes.len() > FS_READ_MAX_BYTES {
                return Err(format!("{path}: exceeds the 1 MiB read cap"));
            }
            match std::str::from_utf8(&bytes) {
                Ok(text) => Ok(serde_json::json!({ "path": path, "content": text })),
                Err(_) => Ok(serde_json::json!({
                    "path": path,
                    "content_base64": base64::engine::general_purpose::STANDARD.encode(&bytes)
                })),
            }
        }
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
            let mut truncated = false;
            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|e| format!("{path}: {e}"))?
            {
                if dirs.len() + files.len() >= FS_LIST_MAX_ENTRIES {
                    truncated = true;
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                let item = serde_json::json!({ "name": name, "is_dir": is_dir });
                if is_dir {
                    dirs.push(item)
                } else {
                    files.push(item)
                }
            }
            dirs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            dirs.extend(files);
            let mut result = serde_json::json!({ "entries": dirs });
            if truncated {
                result["truncated"] = serde_json::json!(true);
            }
            Ok(result)
        }
        other => Err(format!("unknown op {other:?}")),
    }
}

/// The builtin tool registry is immutable once built; building it per
/// dispatch re-allocated the whole map on every tool call.
fn builtin_registry() -> &'static guild_core::tools::ToolRegistry {
    static REGISTRY: std::sync::OnceLock<guild_core::tools::ToolRegistry> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(guild_core::tools::ToolRegistry::builtins)
}

/// The executor: one builtin tool call in the dispatch's workspace folder —
/// the exact semantics the Tauri host used before the link moved here.
struct ExecOutcome {
    content: String,
    is_error: bool,
    meta: Option<serde_json::Value>,
    images: Vec<String>,
}

async fn execute_client_tool(
    name: &str,
    arguments: &str,
    workdir: Option<&str>,
    hooks: Option<Arc<guild_core::tools::artifacts::ArtifactHooks>>,
) -> ExecOutcome {
    let result = async {
        let dir = workdir.ok_or_else(|| "no workspace folder is set for this chat — pick a project with 'Choose project' in the composer".to_string())?;
        let args: serde_json::Value = serde_json::from_str(arguments).map_err(|e| format!("invalid tool arguments: {e}"))?;
        let custom_registry;
        let registry = if name == "read_file" {
            let project = PathBuf::from(dir);
            let roots = tokio::task::spawn_blocking(move || crate::remote_context::skill_read_roots(&project))
                .await.map_err(|e| e.to_string())?;
            custom_registry = guild_core::tools::ToolRegistry::builtins_with_read_roots(roots);
            &custom_registry
        } else { builtin_registry() };
        // Artifact fetch uses the authenticated cloud session for this link,
        // including results spilled earlier in this same turn.
        registry.run_with_artifacts(name, Path::new(dir), args, hooks.as_deref())
            .await.map_err(|e| e.to_string())
    }.await;
    match result {
        Ok(out) => ExecOutcome {
            content: out.output_for_model,
            is_error: false,
            meta: out.meta,
            images: out.images,
        },
        Err(content) => ExecOutcome {
            content,
            is_error: true,
            meta: None,
            images: Vec::new(),
        },
    }
}

/// Installs the process-level rustls crypto provider (ring). The tree
/// enables both ring and aws-lc-rs, so rustls refuses to auto-select —
/// every WS connect (even plain ws://) panics without this. Idempotent.
pub fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The link task: owns the machine's executor connection while this process
/// hosts the CLI socket. Config changes arrive on the watch channel (login,
/// pair, identify, sign-out — in-process transitions and the token.json
/// watcher alike); the task exits when the daemon shuts down, so a retired
/// socket host never leaves a link running.
pub async fn run(shared: Shared, mut cfg_rx: watch::Receiver<Option<MachineLinkConfig>>) {
    ensure_crypto_provider();
    let meta = machine_meta();
    let mut instance_id = uuid::Uuid::now_v7();
    let mut current: Option<MachineLinkConfig> = None;
    let mut shutdown_rx = shared.shutdown.subscribe();
    loop {
        if *shutdown_rx.borrow_and_update() {
            return; // socket host retired: this process runs no link
        }
        // Block until a config exists.
        let cfg = loop {
            if let Some(c) = cfg_rx.borrow_and_update().clone() {
                if current.as_ref() != Some(&c) {
                    instance_id = uuid::Uuid::now_v7(); // new incarnation: no resume
                    current = Some(c.clone());
                }
                break c;
            }
            tokio::select! {
                r = cfg_rx.changed() => {
                    if r.is_err() {
                        return; // channel closed — daemon shutting down
                    }
                }
                _ = shutdown_rx.changed() => {
                    return; // watch moved at all — this host cycle is over
                }
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
                crate::dtrace::dtrace("machine link ended: displaced");
                // A newer connection took the slot — often the same
                // install's GUI-embedded daemon. Parking here stranded the
                // machine forever once that displacer closed (GUI quit):
                // retry after a long backoff instead. A genuinely competing
                // instance just re-displaces us; the slow cadence keeps
                // that fight visible without leaving the machine dead.
                if wait_for_config_change_or_backoff(&mut cfg_rx, &cfg, 300, &mut shutdown_rx).await
                {
                    return;
                }
            }
            LinkEnd::AuthRequired => {
                crate::dtrace::dtrace("machine link ended: auth_required");
                // The session token was rejected — could be a transient
                // 401 during a server deploy just as well as a revoked
                // token. Retry on a slow cadence; a real sign-out republishes
                // `None` and the outer loop parks anyway.
                if wait_for_config_change_or_backoff(&mut cfg_rx, &cfg, 60, &mut shutdown_rx).await
                {
                    return;
                }
            }
            LinkEnd::Closed => {
                crate::dtrace::dtrace("machine link ended: closed");
                // Clean close — config change (handled at loop top), the
                // server dropping us, or daemon shutdown: brief backoff,
                // then reconnect unless the host was retired.
                if shutdown_backoff(&mut shutdown_rx, 1).await {
                    return;
                }
            }
            LinkEnd::Failed(reason) => {
                crate::dtrace::dtrace(&format!("machine link: {reason}"));
                if shutdown_backoff(&mut shutdown_rx, 3).await {
                    return;
                }
            }
        }
    }
}

/// Shutdown-aware sleep: true when the daemon's host cycle ended — the
/// shutdown watch moved at all (retirement flips it true; a reclaiming host
/// relatches it false afterwards) or its sender went away. The caller must
/// stop relinking: a link that outlives its host cycle would double-link
/// against the next cycle's.
async fn shutdown_backoff(shutdown_rx: &mut watch::Receiver<bool>, secs: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => false,
        _ = shutdown_rx.changed() => true,
    }
}

/// The link registry: one config channel per live workspace. Every auth
/// transition publishes per-workspace configs through it; the supervisor
/// spawns one link task per channel, and a channel closing tears the
/// task's link down.
#[derive(Clone)]
pub struct LinkRegistry {
    channels: Arc<std::sync::Mutex<std::collections::HashMap<String, ChannelEntry>>>,
    /// Spawn requests for the supervisor: a key whose channel gained a
    /// config (new or reseeded link). Dedup is the supervisor's job.
    spawns: Arc<tokio::sync::mpsc::UnboundedSender<String>>,
}

/// One workspace's config channel. The keepalive receiver stays alive for
/// the channel's whole life: a watch channel with zero receivers closes —
/// sends fail and later subscribers would see stale values forever.
struct ChannelEntry {
    tx: watch::Sender<Option<MachineLinkConfig>>,
    _keepalive: watch::Receiver<Option<MachineLinkConfig>>,
}

/// Creates a registry and its spawn feed. The supervisor owns the receiver
/// for exactly one host cycle.
pub fn new_registry() -> (LinkRegistry, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (
        LinkRegistry {
            channels: Default::default(),
            spawns: Arc::new(tx),
        },
        rx,
    )
}

impl LinkRegistry {
    /// Publishes one workspace's link config, creating the channel on first
    /// publish. Sends unconditionally (the link task dedups configs
    /// itself); `Some` also queues a spawn request for the supervisor;
    /// `None` parks the link task (it reconnects when a config returns).
    pub fn publish(&self, base_url: &str, cfg: Option<MachineLinkConfig>) {
        let key = session_store::normalize_base(base_url);
        let tx = {
            let mut map = self.channels.lock().unwrap();
            map.entry(key.clone())
                .or_insert_with(|| {
                    let (tx, rx) = watch::channel(None);
                    ChannelEntry { tx, _keepalive: rx }
                })
                .tx
                .clone()
        };
        let _ = tx.send(cfg);
        if tx.borrow().is_some() {
            let _ = self.spawns.send(key);
        }
    }

    /// The config a workspace's channel currently holds (the watcher's
    /// file-noise dedup compares against this).
    pub fn current(&self, base_url: &str) -> Option<MachineLinkConfig> {
        let key = session_store::normalize_base(base_url);
        self.channels
            .lock()
            .unwrap()
            .get(&key)
            .map(|e| e.tx.borrow().clone())
            .unwrap_or(None)
    }

    /// Tears one workspace's link down: a `None` publish (an in-flight
    /// reconnect stops) followed by removing the channel — the closed
    /// channel makes a parked link task exit.
    pub fn drop_link(&self, base_url: &str) {
        let key = session_store::normalize_base(base_url);
        let sender = self.channels.lock().unwrap().remove(&key);
        if let Some(entry) = sender {
            let _ = entry.tx.send(None);
        }
    }

    /// Subscribes to one workspace's config channel, creating the channel
    /// when absent (tests, and callers that need a receiver before any
    /// publish).
    pub fn subscribe_or_create(
        &self,
        base_url: &str,
    ) -> watch::Receiver<Option<MachineLinkConfig>> {
        let key = session_store::normalize_base(base_url);
        let tx = {
            let mut map = self.channels.lock().unwrap();
            map.entry(key)
                .or_insert_with(|| {
                    let (tx, rx) = watch::channel(None);
                    ChannelEntry { tx, _keepalive: rx }
                })
                .tx
                .clone()
        };
        tx.subscribe()
    }

    /// Subscribes to one workspace's config channel (the supervisor hands
    /// the receiver to a fresh link task).
    pub fn subscribe(&self, base_url: &str) -> Option<watch::Receiver<Option<MachineLinkConfig>>> {
        let key = session_store::normalize_base(base_url);
        self.channels
            .lock()
            .unwrap()
            .get(&key)
            .map(|e| e.tx.subscribe())
    }
}

/// The link supervisor: spawns one [`run`] task per registry entry and
/// follows the registry's spawn feed. Lives exactly one host cycle (the
/// caller aborts its handle at teardown — the JoinSet aborts every child
/// link task with it). The spawn feed may repeat a key; the supervisor
/// spawns only the first request per key (the channel dedups configs).
pub async fn run_link_supervisor(
    shared: Shared,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    let mut spawned: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut set = tokio::task::JoinSet::new();
    while let Some(base) = rx.recv().await {
        if spawned.contains(&base) {
            continue;
        }
        if let Some(cfg_rx) = shared.links.subscribe(&base) {
            let handle = set.spawn(run(shared.clone(), cfg_rx));
            spawned.insert(base);
            let _ = handle; // the JoinSet aborts children on drop
        }
    }
}

/// Waits for the link config to actually change, but no longer than
/// `backoff_secs`: a stale config still retries once the backoff elapses,
/// so neither displacement nor a transient auth failure can park the
/// executor link permanently. A sign-out (`None`) breaks out immediately
/// and the outer loop parks. Returns true when the daemon shut down — the
/// link must not relink behind a retired socket host.
async fn wait_for_config_change_or_backoff(
    cfg_rx: &mut watch::Receiver<Option<MachineLinkConfig>>,
    current: &MachineLinkConfig,
    backoff_secs: u64,
    shutdown_rx: &mut watch::Receiver<bool>,
) -> bool {
    cfg_rx.borrow_and_update();
    let end = tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => false,
        r = cfg_rx.changed() => r.is_err(), // channel closed — daemon gone
        _ = shutdown_rx.changed() => true,  // host cycle over (true or relatched)
    };
    if end {
        return true;
    }
    if *shutdown_rx.borrow() {
        return true;
    }
    let published = cfg_rx.borrow().clone();
    match published {
        Some(c) if c != *current => false, // new config: outer loop reconnects with it
        // Same config or signed out: park briefly, then let the outer loop
        // decide (it re-checks shutdown before relinking).
        _ => shutdown_backoff(shutdown_rx, 1).await,
    }
}

/// The link config the persisted session implies, if any: a store carrying
/// the machine identity (machine_id + client_id — the identify step persists
/// both) yields a config; a store without identity parks the link, and a
/// missing store is a signed-out session.
pub fn config_from_store(path: &Path) -> Option<MachineLinkConfig> {
    let stored = session_store::load(path)?;
    Some(MachineLinkConfig {
        base_url: stored.base_url,
        token: stored.token,
        machine_id: stored.machine_id?,
        client_id: stored.client_id?,
        machine_name: stored.machine_name.unwrap_or_else(hostname_label),
    })
}

/// Store-change signature: existence + mtime + length. token.json changes
/// only on auth transitions, so polling this every second is cheap.
fn store_sig(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Watches token.json for auth transitions performed by ANOTHER process
/// (the GUI while a unit daemon owns the link, or a CLI verb): on every
/// change the active session is re-adopted (the token file is the ACTIVE
/// session's mirror) and its link config — or `None` for a sign-out — is
/// published onto that workspace's registry channel, unless it already
/// holds that exact config (in-process transitions publish it themselves).
/// Runs in the daemon process, so both GUI-hosted and unit-hosted daemons
/// self-heal regardless of who performed the auth action. Exits on daemon
/// shutdown.
pub async fn watch_token_store(
    path: PathBuf,
    session: Arc<std::sync::Mutex<crate::jsonrpc_loop::Session>>,
    links: LinkRegistry,
    mut shutdown_rx: watch::Receiver<bool>,
    poll: Duration,
) {
    // Outer None = first poll pending (the task body starts lazily, so the
    // store may already exist when the first poll runs — it must still be
    // reloaded and deduped against the channel).
    let mut last_sig: Option<Option<(std::time::SystemTime, u64)>> = None;
    loop {
        tokio::time::sleep(poll).await;
        if *shutdown_rx.borrow_and_update() {
            return;
        }
        let sig = Some(store_sig(&path));
        if sig == last_sig {
            continue;
        }
        last_sig = sig;
        let cfg = config_from_store(&path);
        {
            // The in-memory session follows the store too: the daemon built
            // Session.auth at boot, and the unit's CLI / agent.start /
            // registry.* read it — a re-pair must not leave stale auth.
            // Memory-only: no persist, and the link send below keeps its
            // dedup.
            // A different principal (sign-out, or another account's login)
            // resets the account-owned execution state like an in-process
            // transition.
            let mut s = session.lock().unwrap();
            let previous = crate::jsonrpc_loop::principal_of(&s);
            match session_store::load(&path) {
                Some(stored) => {
                    s.auth.adopt_stored(&stored);
                    // The mtime/length signature already filtered repeated
                    // polls; publish only when the implied config changed.
                    if links.current(&stored.base_url) != cfg {
                        links.publish(&stored.base_url, cfg);
                    }
                }
                None => {
                    // The active session's mirror vanished (external
                    // sign-out): drop that workspace's link; the store
                    // file is the source and it no longer holds it.
                    let dropped = s.auth.active_base().map(str::to_owned);
                    s.auth.adopt_cleared_active();
                    if let Some(base) = dropped {
                        links.drop_link(&base);
                    }
                }
            }
            crate::jsonrpc_loop::reset_if_principal_changed(&mut s, previous);
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

    /// The machine link against a hand-rolled mock hub: the hub mints a
    /// ticket, upgrades the machine socket, relays `machine_request` frames
    /// (capabilities, context preparation, artifact prefetch) to the
    /// connected machine and returns its `machine_response` frames, and
    /// serves the authenticated artifact endpoint the machine's prefetch
    /// fetcher downloads from. The hub's own routing and displacement
    /// semantics are server-side behavior, owned and tested there.
    #[tokio::test]
    async fn remote_context_and_prefetch_roundtrip_on_mock_hub_socket() {
        ensure_crypto_provider();
        use futures::{SinkExt, StreamExt};
        let (req_tx, req_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (resp_tx, mut resp_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let req_rx = Arc::new(std::sync::Mutex::new(Some(req_rx)));
        let resp_tx = Arc::new(std::sync::Mutex::new(Some(resp_tx)));
        let temp = temp_scoped_dir("remote-context-socket");
        let bundle_src = temp.join("bundle-src/demo-skill");
        std::fs::create_dir_all(&bundle_src).unwrap();
        std::fs::write(
            bundle_src.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: t\n---\nSYNCED-BODY",
        )
        .unwrap();
        let (bundle_bytes, _) = guild_core::registry::pack_skill(&bundle_src, "v2").unwrap();
        let bundle_sha = {
            use sha2::{Digest as _, Sha256};
            hex::encode(Sha256::digest(&bundle_bytes))
        };
        let sync_bundle = Arc::new(std::sync::Mutex::new(bundle_bytes.clone()));
        // The skills sync dispatch arm targets the machine user's home; the
        // test redirects it (env-overridable, same pattern as the heartbeat
        // cadence) so the machine's real ~/.agents is never touched.
        let skills_home = temp.join("skills-home");
        std::env::set_var("GUILD_SKILLS_ROOT", &skills_home);
        let app = axum::Router::new()
            .route(
                "/api/v1/ws/ticket",
                axum::routing::post(|| async {
                    axum::Json(serde_json::json!({"ticket":"fixture"}))
                }),
            )
            .route(
                "/api/v1/tool_artifacts/{artifact}",
                axum::routing::get(
                    |headers: axum::http::HeaderMap, artifact: axum::extract::Path<String>| async move {
                        if headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            != Some("Bearer tok")
                        {
                            return (axum::http::StatusCode::UNAUTHORIZED, String::new());
                        }
                        let _ = artifact;
                        (
                            axum::http::StatusCode::OK,
                            "prefetched before first touch".to_string(),
                        )
                    },
                ),
            )
            .route(
                "/api/v1/registry/skill/{slug}/{version}/bundle",
                {
                    let sync_bundle = sync_bundle.clone();
                    axum::routing::get(
                        move |headers: axum::http::HeaderMap,
                              axum::extract::Path((slug, version)): axum::extract::Path<(String, String)>| async move {
                            if headers
                                .get(axum::http::header::AUTHORIZATION)
                                .and_then(|v| v.to_str().ok())
                                != Some("Bearer tok")
                            {
                                return (axum::http::StatusCode::UNAUTHORIZED, Vec::new());
                            }
                            if slug != "demo-skill" || version != "v2" {
                                return (axum::http::StatusCode::NOT_FOUND, Vec::new());
                            }
                            (axum::http::StatusCode::OK, sync_bundle.lock().unwrap().clone())
                        },
                    )
                },
            )
            .route(
                "/api/v1/ws",
                axum::routing::get(move |ws: axum::extract::ws::WebSocketUpgrade| {
                    let req_rx = req_rx.clone();
                    let resp_tx = resp_tx.clone();
                    async move {
                        ws.on_upgrade(move |socket| async move {
                            let mut req_rx = req_rx
                                .lock()
                                .unwrap()
                                .take()
                                .expect("one machine connection");
                            let resp_tx = resp_tx.lock().unwrap().take().unwrap();
                            let (mut tx, mut rx) = socket.split();
                            // The machine identifies itself in the URL query;
                            // the link sends nothing until it must answer —
                            // relay requests immediately, ignore pings.
                            loop {
                                tokio::select! {
                                    request = req_rx.recv() => match request {
                                        Some(text) => {
                                            if tx
                                                .send(axum::extract::ws::Message::text(text))
                                                .await
                                                .is_err()
                                            {
                                                return;
                                            }
                                        }
                                        None => return,
                                    },
                                    incoming = rx.next() => match incoming {
                                        Some(Ok(axum::extract::ws::Message::Text(text))) => {
                                            let _ = resp_tx.send(text.to_string());
                                        }
                                        Some(Ok(_)) => {} // pings and pongs
                                        _ => return,
                                    },
                                }
                            }
                        })
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = MachineLinkConfig {
            base_url: base_url.clone(),
            machine_id: Uuid::now_v7().to_string(),
            ..cfg()
        };
        let (_config_tx, mut config_rx) = watch::channel(Some(config.clone()));
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let session = tokio::spawn(async move {
            ws_session(
                &Shared::new(crate::jsonrpc_loop::Session::default()),
                &config,
                &MachineMeta::default(),
                Uuid::now_v7(),
                &mut config_rx,
                &mut stop_rx,
            )
            .await
        });
        let root = temp.join("bound");
        let child = root.join("child");
        std::fs::create_dir_all(child.join(".agents/skills/socket-demo")).unwrap();
        std::fs::write(root.join(".git"), "gitdir: fixture").unwrap();
        std::fs::write(root.join("AGENTS.md"), "SOCKET-ROOT").unwrap();
        std::fs::write(child.join("AGENTS.override.md"), "SOCKET-CHILD").unwrap();
        std::fs::write(
            child.join(".agents/skills/socket-demo/SKILL.md"),
            "---\nname: socket-demo\ndescription: remote\n---\nSOCKET-SKILL",
        )
        .unwrap();
        std::fs::write(temp.join("AGENTS.md"), "OUTSIDE-PROJECT").unwrap();
        let ancestor_skill = root.join(".agents/skills/ancestor/SKILL.md");
        std::fs::create_dir_all(ancestor_skill.parent().unwrap()).unwrap();
        std::fs::write(
            &ancestor_skill,
            "---\nname: ancestor\n---\nREAD-ONLY-ANCESTOR",
        )
        .unwrap();
        let caps = hub_request(
            &req_tx,
            &mut resp_rx,
            "caps",
            "capabilities",
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert!(caps["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "context.prepare_v1"));
        let context = hub_request(
            &req_tx,
            &mut resp_rx,
            "ctx",
            "context.prepare_v1",
            serde_json::json!({"project_dir": child, "prompt":"/socket-demo"}),
        )
        .await
        .unwrap();
        let context: protocol::ws::MachineContext = serde_json::from_value(context).unwrap();
        let docs = context.instructions.unwrap();
        assert!(docs.find("SOCKET-ROOT").unwrap() < docs.find("SOCKET-CHILD").unwrap());
        assert!(!docs.contains("OUTSIDE-PROJECT"));
        assert!(context.skill_expansions.contains("SOCKET-SKILL"));
        assert!(context.skills_index.contains("socket-demo"));
        let read = execute_client_tool(
            "read_file",
            &serde_json::json!({"path": ancestor_skill}).to_string(),
            Some(&child.to_string_lossy()),
            None,
        )
        .await;
        assert!(!read.is_error);
        assert!(read.content.contains("READ-ONLY-ANCESTOR"));
        let write = execute_client_tool(
            "write_file",
            &serde_json::json!({"path": ancestor_skill, "content":"overwrite"}).to_string(),
            Some(&child.to_string_lossy()),
            None,
        )
        .await;
        assert!(write.is_error);
        let outside = execute_client_tool(
            "read_file",
            &serde_json::json!({"path": temp.join("AGENTS.md")}).to_string(),
            Some(&child.to_string_lossy()),
            None,
        )
        .await;
        assert!(outside.is_error);

        // Artifact prefetch: the machine downloads the artifact from the
        // hub's authenticated endpoint and materializes it in the workspace.
        let chat_id = Uuid::now_v7();
        let artifact_id = Uuid::now_v7();
        let artifact = hub_request(
            &req_tx,
            &mut resp_rx,
            "prefetch",
            "artifact.prefetch_v1",
            serde_json::json!({
                "workdir": child,
                "chat_id": chat_id,
                "artifact_id": artifact_id,
                "filename": "immediate.txt"
            }),
        )
        .await
        .unwrap();
        let artifact_path = child.join(artifact["path"].as_str().unwrap());
        assert_eq!(
            std::fs::read_to_string(&artifact_path).unwrap(),
            "prefetched before first touch"
        );
        // Path guards remain active on prefetch.
        let denied = hub_request(
            &req_tx,
            &mut resp_rx,
            "escape",
            "artifact.prefetch_v1",
            serde_json::json!({
                "workdir": child,
                "chat_id": chat_id,
                "artifact_id": artifact_id,
                "filename": "../escape"
            }),
        )
        .await;
        assert!(
            matches!(&denied, Err(e) if e.contains("invalid artifact filename")),
            "path escape must be rejected, got {denied:?}"
        );

        // Skills sync: the machine downloads the payload's bundle URL with
        // its own bearer credentials, converges the home skill scope, and
        // reports the result.
        let synced = hub_request(
            &req_tx,
            &mut resp_rx,
            "sync",
            "skills.sync_v1",
            serde_json::json!({"skills": [
                {"slug": "demo-skill", "version": "v2", "bundle_sha256": bundle_sha,
                 "url": format!("{}/api/v1/registry/skill/demo-skill/v2/bundle", base_url.clone())}
            ]}),
        )
        .await
        .unwrap();
        assert_eq!(synced["updated"], serde_json::json!(["demo-skill"]));
        let skill_dir = skills_home.join(".agents/skills/demo-skill");
        let skill_md = std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap();
        assert!(skill_md.contains("SYNCED-BODY"));
        assert!(
            skill_dir.join("agents/guild.yaml").exists(),
            "installed dir carries the provenance sidecar"
        );
        // A hash mismatch fails only that entry: the op still succeeds and
        // the summary carries the failed slug in `failed`.
        let bad_sha = hub_request(
            &req_tx,
            &mut resp_rx,
            "sync-bad",
            "skills.sync_v1",
            serde_json::json!({"skills": [
                {"slug": "demo-skill", "version": "v2", "bundle_sha256": "00",
                 "url": format!("{}/api/v1/registry/skill/demo-skill/v2/bundle", base_url)}
            ]}),
        )
        .await
        .unwrap();
        let failed = bad_sha["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1, "got {bad_sha}");
        assert_eq!(failed[0]["slug"], "demo-skill");
        assert!(failed[0]["error"]
            .as_str()
            .is_some_and(|e| e.contains("sha256 mismatch")));
        stop_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
        server.abort();
        std::env::remove_var("GUILD_SKILLS_ROOT");
        std::fs::remove_dir_all(temp).unwrap();
    }

    /// Sends one `machine_request` through the mock hub relay and awaits
    /// the machine's `machine_response` with the same `request_id`.
    async fn hub_request(
        req_tx: &tokio::sync::mpsc::UnboundedSender<String>,
        resp_rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
        request_id: &str,
        op: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        req_tx
            .send(
                serde_json::json!({
                    "type": "machine_request",
                    "request_id": request_id,
                    "op": op,
                    "payload": payload,
                })
                .to_string(),
            )
            .unwrap();
        let text = tokio::time::timeout(Duration::from_secs(5), resp_rx.recv())
            .await
            .expect("machine answered in time")
            .expect("machine socket closed");
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "machine_response");
        assert_eq!(value["request_id"], request_id);
        if value["ok"].as_bool().unwrap_or(false) {
            Ok(value["payload"].clone())
        } else {
            Err(value["error"].as_str().unwrap_or_default().to_string())
        }
    }
    #[tokio::test]
    async fn capability_discovery_is_versioned_and_unknown_operations_are_rejected() {
        let caps = machine_request_result("capabilities", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(
            caps["operations"],
            serde_json::json!([
                "context.prepare_v1",
                "artifact.prefetch_v1",
                "skills.sync_v1"
            ])
        );
        assert!(
            machine_request_result("context.prepare_v2", &serde_json::json!({}))
                .await
                .is_err()
        );
        assert!(machine_request_result(
            "context.prepare_v1",
            &serde_json::json!({"project_dir":"relative"})
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn config_change_cancels_a_stalled_upgrade() {
        ensure_crypto_provider();
        let entered = Arc::new(tokio::sync::Notify::new());
        let notify = entered.clone();
        let app = axum::Router::new()
            .route(
                "/api/v1/ws/ticket",
                axum::routing::post(|| async {
                    axum::Json(serde_json::json!({"ticket":"fixture"}))
                }),
            )
            .route(
                "/api/v1/ws",
                axum::routing::get(move || {
                    let notify = notify.clone();
                    async move {
                        notify.notify_one();
                        std::future::pending::<axum::http::StatusCode>().await
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = MachineLinkConfig { base_url, ..cfg() };
        let (tx, mut rx) = watch::channel(Some(config.clone()));
        let (_shutdown, mut stop) = watch::channel(false);
        let session = tokio::spawn(async move {
            ws_session(
                &Shared::new(crate::jsonrpc_loop::Session::default()),
                &config,
                &MachineMeta::default(),
                Uuid::now_v7(),
                &mut rx,
                &mut stop,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        tx.send(None).unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), session)
                .await
                .unwrap()
                .unwrap(),
            LinkEnd::Closed
        ));
        server.abort();
    }

    #[tokio::test]
    async fn backoff_retries_unchanged_config_and_signout_but_stops_on_shutdown() {
        let config = cfg();
        let (tx, mut rx) = watch::channel(Some(config.clone()));
        let (shutdown, mut stop) = watch::channel(false);
        assert!(!wait_for_config_change_or_backoff(&mut rx, &config, 0, &mut stop).await);
        tx.send(None).unwrap();
        assert!(!wait_for_config_change_or_backoff(&mut rx, &config, 0, &mut stop).await);
        shutdown.send(true).unwrap();
        assert!(wait_for_config_change_or_backoff(&mut rx, &config, 0, &mut stop).await);
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
            org_name: None,
            org_logo_url: None,
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
        let out = rt.block_on(execute_client_tool("read_file", "{}", None, None));
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
            None,
        ));
        assert!(out.is_error);
        assert!(out.content.contains("unknown tool"));
    }

    #[tokio::test]
    async fn executor_preserves_images_and_materializes_missing_artifacts() {
        let dir = temp_scoped_dir("tool-media-artifact");
        std::fs::write(dir.join("picture.png"), b"png-fixture").unwrap();
        let image =
            execute_client_tool("read_file", r#"{"path":"picture.png"}"#, dir.to_str(), None).await;
        assert!(!image.is_error, "{}", image.content);
        assert_eq!(image.images.len(), 1);
        assert!(image.images[0].starts_with("data:image/png;base64,"));

        let server = wiremock::MockServer::start().await;
        let chat = Uuid::now_v7();
        let artifact = Uuid::now_v7();
        wiremock::Mock::given(wiremock::matchers::path(format!("/api/v1/chats/{chat}/thread")))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"events":[{"event":{
                "type":"tool_result", "turn":1,"step":1,"call_id":"call","name":"api","content":"pointer",
                "artifact_id":artifact,"meta":{"card":{"card":"artifact","filename":"report.txt"}}
            }}]}))).mount(&server).await;
        wiremock::Mock::given(wiremock::matchers::path(format!(
            "/api/v1/tool_artifacts/{artifact}"
        )))
        .and(wiremock::matchers::header(
            "authorization",
            "Bearer fixture",
        ))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string("artifact body"))
        .expect(1)
        .mount(&server)
        .await;
        let hooks = crate::artifacts::registry_hooks(
            CloudClient {
                base_url: server.uri(),
                token: "fixture".into(),
            },
            Arc::new(guild_core::tools::artifacts::ArtifactIndex::new()),
        );
        let path = format!(".guild/artifacts/{chat}/report.txt");
        let args = serde_json::json!({"path":path}).to_string();
        let read = execute_client_tool("read_file", &args, dir.to_str(), Some(hooks.clone())).await;
        assert!(!read.is_error, "{}", read.content);
        assert_eq!(read.content, "artifact body");
        assert_eq!(
            std::fs::read_to_string(dir.join(&path)).unwrap(),
            "artifact body"
        );
        let cached = execute_client_tool("read_file", &args, dir.to_str(), Some(hooks)).await;
        assert!(!cached.is_error);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn temp_scoped_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("guild-fs-list-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fs_read_returns_text_and_rejects_relative_paths_and_oversize_files() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = temp_scoped_dir("fs-read");
        std::fs::write(dir.join("text.txt"), "hello fs_read").unwrap();
        let bytes: Vec<u8> = vec![0xFF, 0xFE, 0x00, 0x01];
        std::fs::write(dir.join("bin.bin"), &bytes).unwrap();
        let result = rt
            .block_on(machine_request_result(
                "fs_read",
                &serde_json::json!({ "path": dir.join("text.txt").to_string_lossy() }),
            ))
            .unwrap();
        assert_eq!(result["content"], "hello fs_read");
        let bin = rt
            .block_on(machine_request_result(
                "fs_read",
                &serde_json::json!({ "path": dir.join("bin.bin").to_string_lossy() }),
            ))
            .unwrap();
        use base64::Engine as _;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(bin["content_base64"].as_str().unwrap())
                .unwrap(),
            bytes
        );
        assert!(bin["content"].is_null());
        assert!(rt
            .block_on(machine_request_result(
                "fs_read",
                &serde_json::json!({ "path": "relative/path.txt" }),
            ))
            .is_err());
        assert!(rt
            .block_on(machine_request_result("fs_read", &serde_json::json!({})))
            .is_err());
        let big = dir.join("big.bin");
        std::fs::write(&big, vec![0u8; FS_READ_MAX_BYTES + 1]).unwrap();
        assert!(rt
            .block_on(machine_request_result(
                "fs_read",
                &serde_json::json!({ "path": big.to_string_lossy() }),
            ))
            .is_err());
        let missing = rt
            .block_on(machine_request_result(
                "fs_read",
                &serde_json::json!({ "path": dir.join("nope.txt").to_string_lossy() }),
            ))
            .unwrap_err();
        assert!(missing.contains("nope.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_list_lists_dirs_first_and_reports_no_truncation_below_the_cap() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = temp_scoped_dir("small");
        std::fs::create_dir(dir.join("b-dir")).unwrap();
        std::fs::create_dir(dir.join("a-dir")).unwrap();
        std::fs::write(dir.join("b-file"), "x").unwrap();
        std::fs::write(dir.join("a-file"), "x").unwrap();
        let result = rt
            .block_on(machine_request_result(
                "fs_list",
                &serde_json::json!({ "path": dir.to_string_lossy() }),
            ))
            .unwrap();
        assert_eq!(result["truncated"], serde_json::Value::Null);
        let entries = result["entries"].as_array().unwrap();
        let names: Vec<&str> = entries
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a-dir", "b-dir", "a-file", "b-file"]);
        assert!(entries.iter().all(|e| e["is_dir"].is_boolean()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_list_caps_entries_and_marks_truncation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = temp_scoped_dir("big");
        for i in 0..(FS_LIST_MAX_ENTRIES + 5) {
            std::fs::write(dir.join(format!("f{i:05}")), "x").unwrap();
        }
        let result = rt
            .block_on(machine_request_result(
                "fs_list",
                &serde_json::json!({ "path": dir.to_string_lossy() }),
            ))
            .unwrap();
        assert_eq!(result["truncated"], serde_json::json!(true));
        assert_eq!(
            result["entries"].as_array().unwrap().len(),
            FS_LIST_MAX_ENTRIES
        );
        let _ = std::fs::remove_dir_all(&dir);
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

    /// The persisted session implies a link config only when it carries the
    /// machine identity; a missing store is a signed-out session.
    #[test]
    fn config_from_store_needs_the_machine_identity() {
        let dir = std::env::temp_dir().join(format!("guild-link-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token.json");
        assert_eq!(config_from_store(&path), None, "no store = signed out");
        session_store::save(
            &path,
            &session_store::StoredSession {
                base_url: "http://x".into(),
                token: "t".into(),
                email: None,
                machine_id: None,
                client_id: None,
                machine_name: None,
                org_name: None,
                org_logo_url: None,
            },
        )
        .unwrap();
        assert_eq!(config_from_store(&path), None, "no identity = parked link");
        let mut stored = session_store::load(&path).unwrap();
        stored.machine_id = Some("m-1".into());
        stored.client_id = Some("c-1".into());
        session_store::save(&path, &stored).unwrap();
        let cfg = config_from_store(&path).expect("identity present");
        assert_eq!(cfg.machine_id, "m-1");
        assert_eq!(cfg.client_id, "c-1");
        assert_eq!(cfg.token, "t");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Auth transitions performed by another process land only in
    /// token.json: the watcher must republish a fresh pair, a re-login, and
    /// a sign-out (removal → None) onto the link's channel, and dedup
    /// against the config it already holds.
    #[tokio::test]
    async fn token_store_watcher_publishes_pair_relogin_and_signout() {
        let dir = std::env::temp_dir().join(format!("guild-link-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token.json");
        let (links, _) = new_registry();
        let mut rx = links.subscribe_or_create("http://x");
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let session = Arc::new(std::sync::Mutex::new(
            crate::jsonrpc_loop::Session::default(),
        ));
        let watched = session.clone();
        tokio::spawn(watch_token_store(
            path.clone(),
            watched,
            links.clone(),
            shutdown_rx,
            Duration::from_millis(20),
        ));
        let next = async |rx: &mut watch::Receiver<Option<MachineLinkConfig>>| {
            tokio::time::timeout(Duration::from_secs(5), async {
                rx.changed().await.ok()?;
                rx.borrow().clone()
            })
            .await
            .expect("watcher published in time")
        };
        let store = |token: &str| session_store::StoredSession {
            base_url: "http://x".into(),
            token: token.into(),
            email: None,
            machine_id: Some("m-1".into()),
            client_id: Some("c-1".into()),
            machine_name: Some("box".into()),
            org_name: None,
            org_logo_url: None,
        };
        // Fresh pair (file appears): the link comes up with the new token.
        session_store::save(&path, &store("t1")).unwrap();
        assert_eq!(next(&mut rx).await.unwrap().token, "t1");
        // Re-login (token rotates): the link follows, and the in-memory
        // session adopts the new token.
        session_store::save(&path, &store("t2")).unwrap();
        assert_eq!(next(&mut rx).await.unwrap().token, "t2");
        assert_eq!(
            session.lock().unwrap().auth.cloud().unwrap().token,
            "t2",
            "Session.auth follows the reloaded store"
        );
        // A store change that resolves to the config already held dedups:
        // no publish, the channel stays quiet (mtime re-save of the same
        // session).
        session_store::save(&path, &store("t2")).unwrap();
        let quiet = tokio::time::timeout(Duration::from_millis(300), rx.changed()).await;
        assert!(quiet.is_err(), "no publish for an unchanged config");
        // Sign-out (file removed): the link comes down.
        session_store::clear(&path).unwrap();
        assert_eq!(next(&mut rx).await, None);
        // The in-memory session followed every store change and the
        // sign-out cleared it.
        assert!(session.lock().unwrap().auth.cloud().is_none());
        shutdown_tx.send(true).ok();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Another process switches token.json from account A to B while the
    /// daemon holds the link: the daemon session drops A's chat/model/
    /// pending state and bumps the epoch, exactly like an in-process switch.
    #[tokio::test]
    async fn token_store_watcher_account_switch_resets_account_state() {
        let dir = std::env::temp_dir().join(format!("guild-link-switch-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token.json");
        let store = |token: &str, email: &str| session_store::StoredSession {
            base_url: "http://x".into(),
            token: token.into(),
            email: Some(email.into()),
            machine_id: Some("m-1".into()),
            client_id: Some("c-1".into()),
            machine_name: Some("box".into()),
            org_name: None,
            org_logo_url: None,
        };
        session_store::save(&path, &store("ta", "a@b")).unwrap();
        let mut initial = crate::jsonrpc_loop::Session::default();
        initial.auth.adopt_stored(&store("ta", "a@b"));
        initial.chat_id = Some(uuid::Uuid::now_v7());
        initial.model = "m".into();
        let session = Arc::new(std::sync::Mutex::new(initial));
        let (links, _) = new_registry();
        let mut rx = links.subscribe_or_create("http://x");
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        tokio::spawn(watch_token_store(
            path.clone(),
            session.clone(),
            links.clone(),
            shutdown_rx,
            Duration::from_millis(20),
        ));
        // First poll adopts the same principal: nothing resets.
        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .unwrap()
            .unwrap();
        {
            let s = session.lock().unwrap();
            assert!(s.chat_id.is_some(), "same principal keeps its chat");
            assert_eq!(s.epoch, 0);
        }
        session_store::save(&path, &store("tb", "b@b")).unwrap();
        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .unwrap()
            .unwrap();
        {
            let s = session.lock().unwrap();
            assert_eq!(s.auth.email(), Some("b@b"));
            assert!(s.chat_id.is_none(), "A's chat survived the external switch");
            assert!(s.model.is_empty());
            assert_eq!(s.epoch, 1);
        }
        shutdown_tx.send(true).ok();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod error_frame_tests {
    use super::*;

    /// A server Error frame (rejected ToolResult, feed resync, thread_list
    /// failure) is non-terminal: the link must stay up — the session loop
    /// still answers Pings afterwards and ends Closed on the server's
    /// close, not Failed.
    #[tokio::test]
    async fn server_error_frame_does_not_end_the_link() {
        ensure_crypto_provider();
        use futures::{SinkExt, StreamExt};
        let entered = Arc::new(tokio::sync::Notify::new());
        let notify = entered.clone();
        let app = axum::Router::new()
            .route(
                "/api/v1/ws/ticket",
                axum::routing::post(|| async {
                    axum::Json(serde_json::json!({"ticket":"fixture"}))
                }),
            )
            .route(
                "/api/v1/ws",
                axum::routing::get(move |ws: axum::extract::ws::WebSocketUpgrade| {
                    let notify = notify.clone();
                    async move {
                        notify.notify_one();
                        ws.on_upgrade(move |socket| async move {
                            let (mut tx, mut rx) = socket.split();
                            // Consume the client's registration noise.
                            for _ in 0..20 {
                                match tokio::time::timeout(
                                    Duration::from_secs(2),
                                    rx.next(),
                                )
                                .await
                                {
                                    Ok(Some(Ok(axum::extract::ws::Message::Text(_)))) => break,
                                    Ok(Some(Ok(_))) => continue,
                                    _ => return,
                                }
                            }
                            let _ = tx
                                .send(axum::extract::ws::Message::text(
                                    serde_json::json!({"type":"error","message":"transient: rejected ToolResult"})
                                        .to_string(),
                                ))
                                .await;
                            // The loop must still answer pings after the error.
                            let _ = tx
                                .send(axum::extract::ws::Message::Ping(vec![1u8].into()))
                                .await;
                            for _ in 0..50 {
                                match tokio::time::timeout(
                                    Duration::from_millis(200),
                                    rx.next(),
                                )
                                .await
                                {
                                    Ok(Some(Ok(axum::extract::ws::Message::Pong(_)))) => {
                                        let _ = tx.close().await;
                                        return;
                                    }
                                    _ => continue,
                                }
                            }
                            let _ = tx.close().await;
                        })
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = MachineLinkConfig {
            base_url,
            token: "tok".into(),
            machine_id: Uuid::now_v7().to_string(),
            client_id: "client-1".into(),
            machine_name: "box".into(),
        };
        let (tx, mut rx) = watch::channel(Some(config.clone()));
        let (_shutdown, mut stop) = watch::channel(false);
        let session = tokio::spawn(async move {
            ws_session(
                &Shared::new(crate::jsonrpc_loop::Session::default()),
                &config,
                &MachineMeta::default(),
                Uuid::now_v7(),
                &mut rx,
                &mut stop,
            )
            .await
        });
        entered.notified().await;
        let end = tokio::time::timeout(Duration::from_secs(15), session)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(end, LinkEnd::Closed),
            "an Error frame must not fail the link, got {end:?}"
        );
        server.abort();
    }
}
