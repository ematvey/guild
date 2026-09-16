//! Tauri side of the desktop shell — SINGLE PROCESS (spec
//! docs/specs/2026-09-13-single-process-desktop.md): the GUI process hosts
//! the engine (session, JSON-RPC dispatch, local tool execution) directly.
//! There is no headless daemon and no cross-process pipe to one; the local
//! socket remains only as the CLI-verb entry point, hosted by this process.
//!
//! Server link: exactly one standing WebSocket connection, owned by this
//! process — presence, client-tool dispatch, and the user fan-out bus all
//! ride it. The webview is a pure UI: HTTP request/response plus per-turn
//! replay, no tool execution, no presence duty.

use futures::{SinkExt, StreamExt};
use guild_app_server::jsonrpc_loop::{run_connection, Shared};
use protocol::ws::{WsClientMsg, WsServerMsg};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Client-side IPC trace: one line per rpc step into %TEMP%, so a wedge can
/// be diagnosed from the log without interactive debugging (the GUI's own
/// console is not visible to us).
pub fn ipc_trace(event: &str, detail: &str) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join("guild-rpc.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{ts} {event} {detail}");
    }
}

/// Pending downloaded update, waiting for the user to restart.
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

/// Everything the webview rpc surface needs: the in-process engine
/// connection (pipes to the same-process dispatch loop).
#[derive(Default)]
pub struct EngineState {
    cell: Arc<Mutex<Option<Arc<Engine>>>>,
    handle: Mutex<Option<AppHandle>>,
    next_id: AtomicU64,
    /// The engine's Shared (session + dispatch state), created at setup.
    shared: Mutex<Option<Shared>>,
}

pub struct Engine {
    /// Client→engine write half (std pipe writer; sync writes are fine —
    /// the dispatch loop reads on its own thread).
    writer: Arc<Mutex<std::io::PipeWriter>>,
    responses: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
    /// Completed JSON-RPC envelopes for poll-based clients: every response
    /// lands here regardless of transport, so the webview never needs a
    /// long-lived invoke response (Windows WebView2 can silently lose those).
    results: Arc<Mutex<HashMap<u64, Value>>>,
    /// Submit timestamps for the poll-timeout sweep.
    submitted: Arc<Mutex<HashMap<u64, std::time::Instant>>>,
}

/// One parsed line from the engine.
pub enum EngineLine {
    /// A reply carrying a request id.
    Response { id: u64, value: Value },
    /// A server-push event.
    Event(Value),
}

/// Pure line demux — unit-tested.
pub fn parse_line(line: &str) -> Option<EngineLine> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    // A JSON-RPC response has an `id` and no `event` field.
    if v.get("event").is_none() && v.get("id").is_some() {
        Some(EngineLine::Response {
            id: v["id"].as_u64()?,
            value: v,
        })
    } else {
        Some(EngineLine::Event(v))
    }
}

/// Builds the in-process engine: two unidirectional std pipes carry the
/// JSON-RPC line protocol between the webview-facing commands and the same
/// `run_connection` dispatch the CLI socket serves — one dispatch surface,
/// one session, two transports. Returns the engine (write half + response
/// plumbing) and the read half its demux reader must consume.
fn build_engine(shared: &Shared) -> anyhow::Result<(Engine, std::io::PipeReader)> {
    let (rd_in, wr_in) = std::io::pipe()?; // client → engine
    let (rd_out, wr_out) = std::io::pipe()?; // engine → client
    {
        let shared = shared.clone();
        // The dispatch loop runs for the process lifetime; it ends only when
        // the pipe write end drops (app exit).
        std::thread::spawn(move || {
            let rt = tauri::async_runtime::handle();
            let _ = rt.block_on(run_connection(&shared, rd_in, wr_out));
        });
    }
    Ok((
        Engine {
            writer: Arc::new(Mutex::new(wr_in)),
            responses: Arc::new(Mutex::new(HashMap::new())),
            results: Arc::new(Mutex::new(HashMap::new())),
            submitted: Arc::new(Mutex::new(HashMap::new())),
        },
        rd_out,
    ))
}

/// Demuxing reader for the engine→client pipe: responses land in the shared
/// response/result maps, server-push events are emitted to the webview as
/// `rpc-event` (same shape the daemon pipe used to deliver).
fn start_engine_reader(app: AppHandle, engine: Arc<Engine>, rd_out: std::io::PipeReader) {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(rd_out);
        use std::io::BufRead;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    ipc_trace("reader-exit", "eof");
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    ipc_trace("reader-exit", &format!("err={e}"));
                    break;
                }
            }
            match parse_line(&line) {
                Some(EngineLine::Response { id, value }) => {
                    ipc_trace("resp", &format!("id={id} bytes={}", line.len()));
                    engine.results.lock().unwrap().insert(id, value.clone());
                    if let Some(sender) = engine.responses.lock().unwrap().remove(&id) {
                        let _ = sender.send(value);
                    }
                }
                Some(EngineLine::Event(ev)) => {
                    let _ = app.emit("rpc-event", ev);
                }
                None => {
                    let _ = app.emit(
                        "rpc-event",
                        serde_json::json!({
                            "protocol": 1u64, "event": "rpc.error",
                            "payload": {"message": format!("unparseable engine line: {line}")},
                        }),
                    );
                }
            }
        }
        // Engine gone (app teardown): fail every pending RPC.
        {
            let mut res = engine.results.lock().unwrap();
            for id in engine.submitted.lock().unwrap().keys() {
                res.insert(
                    *id,
                    serde_json::json!({"id": *id, "error": {"message": "engine dropped the request"}}),
                );
            }
        }
        let _ = app.emit(
            "rpc-event",
            serde_json::json!({
                "protocol": 1u64, "event": "rpc.error",
                "payload": {"message": "engine connection lost"},
            }),
        );
    });
}

fn envelope(id: u64, method: &str, params: &Value) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "protocol": 1u64,
        "method": method, "params": params,
    })
}

// ---- server link (the single standing connection) ----

/// In-flight mirror for one chat, fed by the fan-out bus: enough state for a
/// webview that opens (or reloads) mid-generation to catch up without a
/// second server connection. `frames` are the wire events in arrival order;
/// `seq` counts them.
#[derive(Default)]
struct Mirror {
    seq: u64,
    running: bool,
    frames: Vec<Value>,
}

#[derive(Default)]
pub struct GuildState {
    /// The engine Shared: one session, one dispatch surface, shared with the
    /// CLI socket accept loop.
    shared: Mutex<Option<Shared>>,
    /// Machine identity — the webview's localStorage id (it keys the chat
    /// bindings), passed in at boot. Presence starts only once it is set.
    machine_id: Mutex<Option<String>>,
    /// chat_id → workspace folder for local tool execution (pushed by the
    /// webview's run-in-folder state).
    dirs: Mutex<HashMap<String, String>>,
    /// chat_id → in-flight mirror.
    mirrors: Mutex<HashMap<String, Mirror>>,
    /// Bump to force the link task to re-read its config (login, sign-out,
    /// machine identity set).
    link_epoch: Arc<std::sync::atomic::AtomicU64>,
}

impl GuildState {
    fn shared(&self) -> Option<Shared> {
        self.shared.lock().unwrap().clone()
    }

    /// Snapshot of what the link needs right now: None until the webview
    /// provided the machine identity and a session exists.
    fn link_config(&self) -> Option<(String, String, String, String)> {
        let machine_id = self.machine_id.lock().unwrap().clone()?;
        let shared = self.shared()?;
        let s = shared.session.lock().unwrap();
        let cloud = s.cloud.as_ref()?;
        Some((
            cloud.base_url.clone(),
            cloud.token.clone(),
            machine_id,
            machine_name(),
        ))
    }

    fn mirror_update<F: FnOnce(&mut Mirror)>(&self, chat_id: &str, f: F) -> u64 {
        let mut mirrors = self.mirrors.lock().unwrap();
        let m = mirrors.entry(chat_id.to_string()).or_default();
        f(m);
        m.seq
    }
}

fn machine_name() -> String {
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

/// Percent-encode a query component (machine ids/names are simple, but the
/// name can carry spaces).
fn qenc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Debug)]
enum LinkError {
    Displaced,
    AuthRequired,
    Closed,
    Failed(String),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Displaced => f.write_str("displaced"),
            Self::AuthRequired => f.write_str("authentication required"),
            Self::Closed => f.write_str("socket closed"),
            Self::Failed(error) => f.write_str(error),
        }
    }
}

/// The WS machine link. The socket is the machine's liveness signal.
async fn ws_link_task(state: Arc<GuildState>, app: AppHandle) {
    let mut last_cfg: Option<(String, String, String)> = None;
    let mut was_connected = false;
    loop {
        let Some((base, token, machine_id, machine_name)) = state.link_config() else {
            if was_connected {
                was_connected = false;
                let _ = app.emit("app-presence", serde_json::json!({ "connected": false }));
            }
            last_cfg = None;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        };
        let cfg = (base.clone(), token.clone(), machine_id.clone());
        if last_cfg.as_ref() != Some(&cfg) {
            state.mirrors.lock().unwrap().clear();
            last_cfg = Some(cfg.clone());
        }
        let epoch = state.link_epoch.load(Ordering::SeqCst);
        let result = ws_session(
            &state,
            &app,
            &base,
            &token,
            &machine_id,
            &machine_name,
            &mut was_connected,
        )
        .await;
        if was_connected {
            was_connected = false;
            let _ = app.emit("app-presence", serde_json::json!({ "connected": false }));
        }
        match result {
            Ok(()) => ipc_trace("link", "socket closed"),
            Err(LinkError::Displaced) => {
                let _ = app.emit(
                    "app-presence",
                    serde_json::json!({ "connected": false, "displaced": true }),
                );
                wait_for_link_change(&state, epoch, &base, &token, &machine_id).await;
            }
            Err(LinkError::AuthRequired) => {
                ipc_trace("link", "authentication required; reminting ticket");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(error) => ipc_trace("link", &format!("socket ended: {error}")),
        }
        if state.link_epoch.load(Ordering::SeqCst) == epoch
            && state
                .link_config()
                .is_some_and(|(b, t, m, _)| b == base && t == token && m == machine_id)
        {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    }
}

async fn wait_for_link_change(
    state: &GuildState,
    epoch: u64,
    base: &str,
    token: &str,
    machine_id: &str,
) {
    loop {
        if state.link_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        let unchanged = state
            .link_config()
            .is_some_and(|(b, t, m, _)| b == base && t == token && m == machine_id);
        if !unchanged {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn ws_session(
    state: &Arc<GuildState>,
    app: &AppHandle,
    base: &str,
    token: &str,
    machine_id: &str,
    machine_name: &str,
    connected: &mut bool,
) -> Result<(), LinkError> {
    let cloud = state
        .shared()
        .and_then(|shared| shared.session.lock().unwrap().cloud.clone())
        .ok_or_else(|| LinkError::Failed("session disappeared".into()))?;
    let ticket_url = format!("{}/api/v1/ws/ticket", base.trim_end_matches('/'));
    let ticket_response = cloud
        .http_pub()
        .post(ticket_url)
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| LinkError::Failed(format!("ticket request: {error}")))?;
    if ticket_response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(LinkError::AuthRequired);
    }
    if !ticket_response.status().is_success() {
        return Err(LinkError::Failed(format!(
            "ticket request: HTTP {}",
            ticket_response.status()
        )));
    }
    let ticket = ticket_response
        .json::<Value>()
        .await
        .map_err(|error| LinkError::Failed(format!("ticket response: {error}")))?["ticket"]
        .as_str()
        .ok_or_else(|| LinkError::Failed("ticket response has no ticket".into()))?
        .to_string();

    let url = websocket_url(base, &ticket, machine_id, machine_id, machine_name)?;
    let (socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio_tungstenite::connect_async(url.as_str()),
    )
    .await
    .map_err(|_| LinkError::Failed("socket connect timed out".into()))?
    .map_err(|error| LinkError::Failed(format!("socket connect: {error}")))?;
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (out_tx, mut out_rx) =
        tokio::sync::mpsc::unbounded_channel::<tokio_tungstenite::tungstenite::Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            socket_tx
                .send(message)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    });
    let client_tx = tokio::sync::mpsc::unbounded_channel::<WsClientMsg>();
    let (client_msg_tx, mut client_msg_rx) = client_tx;
    let wire_tx = out_tx.clone();
    let client_writer = tokio::spawn(async move {
        while let Some(message) = client_msg_rx.recv().await {
            let text = serde_json::to_string(&message).expect("client message serializes");
            if wire_tx
                .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
                .is_err()
            {
                return;
            }
        }
    });

    let hello = match receive_ws_message(&mut socket_rx, &out_tx).await {
        Ok(message) => message,
        Err(error) => {
            writer.abort();
            client_writer.abort();
            return Err(error);
        }
    };
    if matches!(hello, WsServerMsg::Displaced) {
        writer.abort();
        client_writer.abort();
        return Err(LinkError::Displaced);
    }
    if matches!(hello, WsServerMsg::AuthRequired) {
        writer.abort();
        client_writer.abort();
        return Err(LinkError::AuthRequired);
    }
    if !matches!(hello, WsServerMsg::Hello) {
        writer.abort();
        client_writer.abort();
        return Err(LinkError::Failed(format!("expected hello, got {hello:?}")));
    }
    *connected = true;
    let _ = app.emit("app-presence", serde_json::json!({ "connected": true }));
    ipc_trace("link", "socket connected");

    let thread_list = match receive_ws_message(&mut socket_rx, &out_tx).await {
        Ok(message) => message,
        Err(error) => {
            writer.abort();
            client_writer.abort();
            return Err(error);
        }
    };
    if !matches!(thread_list, WsServerMsg::ThreadList { .. }) {
        writer.abort();
        client_writer.abort();
        return Err(LinkError::Failed(format!(
            "expected thread list, got {thread_list:?}"
        )));
    }

    let mut writer = Box::pin(writer);
    let result = loop {
        tokio::select! {
            writer_result = &mut writer => {
                break writer_result
                    .map_err(|error| LinkError::Failed(format!("socket writer: {error}")))
                    .and_then(|result| result.map_err(LinkError::Failed))
                    .map(|_| ());
            }
            incoming = socket_rx.next() => {
                match incoming {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        let message = match serde_json::from_str::<WsServerMsg>(&text) {
                            Ok(message) => message,
                            Err(error) => {
                                ipc_trace("link", &format!("invalid server message: {error}"));
                                continue;
                            }
                        };
                        match message {
                            WsServerMsg::LiveFrame { chat_id, machine_id: frame_machine_id, event }
                            | WsServerMsg::SnapshotFrame { chat_id, machine_id: frame_machine_id, event } => {
                                let data = websocket_frame_data(chat_id, frame_machine_id, event);
                                if let Err(error) = handle_app_frame(
                                    state, app, machine_id, &data, &client_msg_tx,
                                ).await {
                                    ipc_trace("link", &format!("frame error: {error}"));
                                }
                            }
                            WsServerMsg::ChatStatus { chat_id, generating } => {
                                let _ = app.emit("chat-status", serde_json::json!({
                                    "chat_id": chat_id,
                                    "generating": generating,
                                }));
                            }
                            WsServerMsg::OrgEvent { event } => {
                                let _ = app.emit("org-event", event);
                            }
                            WsServerMsg::Displaced => break Err(LinkError::Displaced),
                            WsServerMsg::AuthRequired => break Err(LinkError::AuthRequired),
                            WsServerMsg::Error { message } => {
                                ipc_trace("link", &format!("server error: {message}"));
                            }
                            WsServerMsg::Hello | WsServerMsg::ThreadList { .. }
                            | WsServerMsg::SyncBegin { .. }
                            | WsServerMsg::History { .. }
                            | WsServerMsg::SyncDone { .. } => {}
                        }
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(payload))) => {
                        if out_tx.send(tokio_tungstenite::tungstenite::Message::Pong(payload)).is_err() {
                            break Err(LinkError::Closed);
                        }
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                        break Err(LinkError::Closed);
                    }
                    Some(Err(error)) => break Err(LinkError::Failed(format!("socket read: {error}"))),
                    Some(Ok(_)) => {}
                }
            }
        }
    };
    client_writer.abort();
    writer.abort();
    let _ = app.emit("app-stream-reconnected", serde_json::json!({}));
    result
}

async fn receive_ws_message<S>(
    socket_rx: &mut S,
    out_tx: &tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
) -> Result<WsServerMsg, LinkError>
where
    S: futures::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    loop {
        match socket_rx.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                return serde_json::from_str(&text)
                    .map_err(|error| LinkError::Failed(format!("server message: {error}")));
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(payload))) => {
                out_tx
                    .send(tokio_tungstenite::tungstenite::Message::Pong(payload))
                    .map_err(|_| LinkError::Closed)?;
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                return Err(LinkError::Closed);
            }
            Some(Err(error)) => return Err(LinkError::Failed(format!("socket read: {error}"))),
            Some(Ok(_)) => {}
        }
    }
}

fn websocket_url(
    base: &str,
    ticket: &str,
    client_id: &str,
    machine_id: &str,
    machine_name: &str,
) -> Result<url::Url, LinkError> {
    let mut url = url::Url::parse(base)
        .map_err(|error| LinkError::Failed(format!("bad server URL: {error}")))?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        scheme => {
            return Err(LinkError::Failed(format!(
                "unsupported server scheme: {scheme}"
            )))
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| LinkError::Failed("could not set websocket scheme".into()))?;
    let path = format!("{}/api/v1/ws", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url.set_query(Some(&format!(
        "ticket={}&client_id={}&machine_id={}&machine_name={}",
        qenc(ticket),
        qenc(client_id),
        qenc(machine_id),
        qenc(machine_name),
    )));
    Ok(url)
}

fn websocket_frame_data(
    chat_id: uuid::Uuid,
    machine_id: Option<String>,
    event: protocol::api::StreamEvent,
) -> String {
    serde_json::json!({
        "chat_id": chat_id,
        "machine_id": machine_id,
        "event": event,
    })
    .to_string()
}

/// Handles one WS frame: mirrors it for late webviews and — for client
/// tools bound to this machine — executes it and sends the result.
async fn handle_app_frame(
    state: &Arc<GuildState>,
    app: &AppHandle,
    machine_id: &str,
    data: &str,
    result_tx: &tokio::sync::mpsc::UnboundedSender<WsClientMsg>,
) -> Result<(), String> {
    let v: Value = serde_json::from_str(data).map_err(|e| format!("frame parse: {e}"))?;
    let chat_id = v["chat_id"].as_str().unwrap_or_default().to_string();
    let ev = v["event"].clone();
    let ev_type = ev["type"].as_str().unwrap_or_default().to_string();

    // Mirror + forward to the webview (it renders what it has open and asks
    // for the mirror when it needs catch-up).
    let seq = state.mirror_update(&chat_id, |m| {
        m.running = !matches!(ev_type.as_str(), "done" | "error");
        if m.running {
            m.frames.push(ev.clone());
            if m.frames.len() > 4000 {
                m.frames.drain(..1000);
            }
        } else {
            // Turn over: the durable thread has everything; drop the mirror.
            m.frames.clear();
        }
        m.seq += 1;
    });
    let _ = app.emit(
        "app-frame",
        serde_json::json!({ "chat_id": chat_id, "seq": seq, "event": ev }),
    );

    if ev_type == "tool_started" && ev["executor"].as_str() == Some("client") {
        // Execute only for THIS machine (other devices render).
        let bound = v["machine_id"].as_str().unwrap_or_default();
        if bound == machine_id {
            let call_id = ev["call_id"].as_str().unwrap_or_default().to_string();
            let name = ev["name"].as_str().unwrap_or_default().to_string();
            let args = ev["arguments"].as_str().unwrap_or("{}").to_string();
            let st = state.clone();
            let result_tx = result_tx.clone();
            let chat = chat_id.clone();
            tokio::spawn(async move {
                if let Err(e) = execute_tool(&st, &result_tx, &chat, &call_id, &name, &args).await {
                    ipc_trace("tool", &format!("{name} {call_id} failed: {e}"));
                }
            });
        }
    }
    Ok(())
}

/// Runs one client tool in the chat's workspace folder and sends its result
/// over the standing machine socket.
async fn execute_tool(
    state: &Arc<GuildState>,
    result_tx: &tokio::sync::mpsc::UnboundedSender<WsClientMsg>,
    chat_id: &str,
    call_id: &str,
    name: &str,
    args_json: &str,
) -> Result<(), String> {
    let dir = state.dirs.lock().unwrap().get(chat_id).cloned();
    let args: Value = serde_json::from_str(args_json).unwrap_or(serde_json::json!({}));
    let outcome: Result<Value, String> = match dir {
        None => Err("no workspace folder is set for this chat — pick one with 'Run in folder…' in the composer".to_string()),
        Some(dir) => {
            let registry = guild_core::tools::ToolRegistry::builtins();
            match registry.get(name) {
                Some(tool) => match tool.run(std::path::Path::new(&dir), args).await {
                    Ok(out) => Ok(serde_json::json!({
                        "content": out.output_for_model,
                        "is_error": false,
                        "meta": out.meta,
                        "images": out.images,
                    })),
                    Err(e) => Ok(serde_json::json!({ "content": e.to_string(), "is_error": true })),
                },
                None => Err(format!("unknown tool {name}")),
            }
        }
    };
    let payload = match outcome {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "content": e, "is_error": true }),
    };
    result_tx
        .send(WsClientMsg::ToolResult {
            chat_id: chat_id
                .parse()
                .map_err(|error| format!("invalid chat id: {error}"))?,
            call_id: call_id.to_string(),
            content: payload["content"].as_str().unwrap_or_default().to_string(),
            is_error: payload["is_error"].as_bool().unwrap_or(true),
            meta: payload
                .get("meta")
                .cloned()
                .filter(|value| !value.is_null()),
        })
        .map_err(|_| "socket closed before tool result was sent".to_string())?;
    ipc_trace("tool", &format!("{name} {call_id} ok"));
    Ok(())
}

// Commands live in a submodule: `#[tauri::command]` in the crate-root
// module trips E0255 (macro re-imports itself).
pub mod commands {
    use super::*;

    /// Idempotent: the engine exists from app setup; kept so the webview's
    /// boot flow is unchanged.
    #[tauri::command]
    pub async fn start_engine(state: State<'_, EngineState>) -> Result<(), String> {
        if state.cell.lock().unwrap().is_some() {
            return Ok(());
        }
        let shared = state
            .shared
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "engine not initialized".to_string())?;
        let (engine, rd_out) = build_engine(&shared).map_err(|e| e.to_string())?;
        let engine = Arc::new(engine);
        let handle = state
            .handle
            .lock()
            .unwrap()
            .clone()
            .expect("app handle set at setup");
        start_engine_reader(handle, engine.clone(), rd_out);
        let mut guard = state.cell.lock().unwrap();
        if guard.is_none() {
            *guard = Some(engine);
        }
        Ok(())
    }

    /// The webview hands over its machine identity (localStorage, stable per
    /// install — it keys existing chat bindings). Starts/refreshes the
    /// server link.
    #[tauri::command]
    pub async fn set_machine_identity(
        state: State<'_, Arc<GuildState>>,
        machine_id: String,
    ) -> Result<(), String> {
        let changed = {
            let mut m = state.machine_id.lock().unwrap();
            let changed = m.as_deref() != Some(machine_id.as_str());
            *m = Some(machine_id);
            changed
        };
        if changed {
            state.link_epoch.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }

    /// The webview pushes the run-in-folder state (per chat) so the app
    /// process can execute tools — including while the window is closed.
    #[tauri::command]
    pub async fn set_chat_dir(
        state: State<'_, Arc<GuildState>>,
        chat_id: String,
        dir: Option<String>,
    ) -> Result<(), String> {
        let mut dirs = state.dirs.lock().unwrap();
        match dir {
            Some(d) => {
                dirs.insert(chat_id, d);
            }
            None => {
                dirs.remove(&chat_id);
            }
        }
        Ok(())
    }

    /// In-flight mirror catch-up for a webview opening (or reloading) a chat
    /// mid-generation: everything the fan-out bus delivered so far, plus the
    /// seq watermark — frames with seq ≤ this are already reflected.
    #[tauri::command]
    pub async fn chat_snapshot(
        state: State<'_, Arc<GuildState>>,
        chat_id: String,
    ) -> Result<Value, String> {
        let mirrors = state.mirrors.lock().unwrap();
        let Some(m) = mirrors.get(&chat_id) else {
            return Ok(serde_json::json!({ "running": false, "seq": 0, "frames": [] }));
        };
        Ok(serde_json::json!({
            "running": m.running,
            "seq": m.seq,
            "frames": m.frames,
        }))
    }

    /// Submit an rpc without waiting for its response: returns the request id
    /// immediately. Results are collected by rpc_poll. This keeps every webview
    /// invoke sub-millisecond — Windows WebView2 can silently lose long-lived
    /// invoke responses, and a pair/login must not depend on that path.
    #[tauri::command]
    pub async fn rpc_submit(
        state: State<'_, EngineState>,
        method: String,
        params: Value,
    ) -> Result<u64, String> {
        let engine = {
            let guard = state.cell.lock().unwrap();
            guard
                .clone()
                .ok_or_else(|| "engine not started".to_string())?
        };
        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
        ipc_trace("rpc-start", &format!("id={id} method={method}"));
        engine
            .submitted
            .lock()
            .unwrap()
            .insert(id, std::time::Instant::now());
        let mut w = engine.writer.lock().unwrap();
        if let Err(e) = w
            .write_all(envelope(id, &method, &params).to_string().as_bytes())
            .and_then(|_| w.write_all(b"\n"))
            .and_then(|_| w.flush())
        {
            ipc_trace("write-fail", &format!("id={id} err={e}"));
            engine.submitted.lock().unwrap().remove(&id);
            *state.cell.lock().unwrap() = None;
            return Err(format!("engine write failed: {e}"));
        }
        drop(w);
        ipc_trace("write-ok", &format!("id={id}"));
        Ok(id)
    }

    /// Drain completed rpc envelopes (and inject timeouts for submissions
    /// older than 120s). Returns full JSON-RPC envelopes; clients route by
    /// the `id` field.
    #[tauri::command]
    pub async fn rpc_poll(state: State<'_, EngineState>) -> Result<Vec<Value>, String> {
        let engine = {
            let guard = state.cell.lock().unwrap();
            guard.clone()
        };
        let Some(engine) = engine else {
            return Ok(vec![]);
        };
        let now = std::time::Instant::now();
        {
            let mut sub = engine.submitted.lock().unwrap();
            let mut results = engine.results.lock().unwrap();
            let stale: Vec<u64> = sub
                .iter()
                .filter(|(_, t)| now.duration_since(**t) > std::time::Duration::from_secs(120))
                .map(|(id, _)| *id)
                .collect();
            for id in stale {
                sub.remove(&id);
                results.entry(id).or_insert_with(
                    || serde_json::json!({"id": id, "error": {"message": "engine timed out"}}),
                );
                ipc_trace("rpc-timeout", &format!("id={id}"));
            }
        }
        let mut results = engine.results.lock().unwrap();
        let drained: Vec<Value> = results.drain().map(|(_, v)| v).collect();
        Ok(drained)
    }

    /// Version of the pending downloaded update, if any (UI queries on mount
    /// so a toast isn't missed when the update finished before the webview).
    #[tauri::command]
    pub async fn pending_update_version(
        state: State<'_, UpdateState>,
    ) -> Result<Option<String>, String> {
        Ok(state
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map(|(u, _)| u.version.clone()))
    }

    /// Applies the pending downloaded update and restarts the app.
    #[tauri::command]
    pub async fn install_update(
        state: State<'_, UpdateState>,
        app: AppHandle,
    ) -> Result<(), String> {
        let (update, bytes) = state
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "no pending update".to_string())?;
        // on Windows the installer exits the app itself; mac/linux restart below
        update.install(bytes).map_err(|e| e.to_string())?;
        app.request_restart();
        #[allow(unreachable_code)]
        Ok(())
    }

    #[tauri::command]
    pub async fn rpc_request(
        state: State<'_, EngineState>,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let engine = {
            let guard = state.cell.lock().unwrap();
            guard
                .clone()
                .ok_or_else(|| "engine not started".to_string())?
        };
        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
        let t0 = std::time::Instant::now();
        ipc_trace("rpc-start", &format!("id={id} method={method}"));
        // oneshot: tauri's async_runtime re-exports shadow `mpsc::channel`
        // inside #[tauri::command] scopes; oneshot stays unambiguous.
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        engine.responses.lock().unwrap().insert(id, tx);
        {
            let mut w = engine.writer.lock().unwrap();
            if let Err(e) = w
                .write_all(envelope(id, &method, &params).to_string().as_bytes())
                .and_then(|_| w.write_all(b"\n"))
                .and_then(|_| w.flush())
            {
                ipc_trace("write-fail", &format!("id={id} err={e}"));
                *state.cell.lock().unwrap() = None;
                return Err(format!("engine write failed: {e}"));
            }
        }
        ipc_trace("write-ok", &format!("id={id}"));
        // Bounded wait: a wedged (alive-but-silent) engine must not leave the
        // UI spinning forever — 120s covers any legitimate request (pair,
        // login, session restore); chat streaming rides on events, not this.
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(value)) => {
                ipc_trace("rpc-resolved", &format!("id={id} in {:?}", t0.elapsed()));
                Ok(value)
            }
            Ok(Err(_)) => {
                engine.responses.lock().unwrap().remove(&id);
                ipc_trace("rpc-dropped", &format!("id={id} after {:?}", t0.elapsed()));
                Err("engine dropped the request".into())
            }
            Err(_) => {
                engine.responses.lock().unwrap().remove(&id);
                ipc_trace("rpc-timeout", &format!("id={id} after {:?}", t0.elapsed()));
                Err("engine timed out".into())
            }
        }
    }
} // commands module

/// Checks the paired server for a newer signed build and, if found, downloads
/// it in the background. Emits `update.ready {version}` when the update can be
/// applied; the frontend shows a restart toast (VSCode/Zed-style: download is
/// silent, applying happens on the user's restart).
async fn check_and_prepare_update(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    // only paired/logged-in instances have a server to ask
    let session_path = match guild_app_server::session_store::default_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let Some(session) = guild_app_server::session_store::load(&session_path) else {
        eprintln!("updater: no stored session, skipping");
        return;
    };
    eprintln!("updater: checking {}", session.base_url);
    let endpoint = format!(
        "{}/api/v1/updates/latest.json",
        session.base_url.trim_end_matches('/')
    );
    let url = match url::Url::parse(&endpoint) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("updater: bad server url: {e}");
            return;
        }
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.build())
    {
        Ok(u) => u,
        Err(e) => {
            eprintln!("updater: bad endpoint config: {e}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            eprintln!("updater: up to date");
            return;
        }
        Err(e) => {
            eprintln!("updater: check failed: {e}");
            return;
        }
    };
    let version = update.version.clone();
    eprintln!("updater: downloading version {version}");
    let app_for_progress = app.clone();
    let result = update
        .download(
            move |chunk, total| {
                let _ = app_for_progress.emit(
                    "update-progress",
                    serde_json::json!({"chunk": chunk, "total": total}),
                );
            },
            || {},
        )
        .await;
    let bytes = match result {
        Ok(b) => b,
        Err(e) => {
            eprintln!("updater: download failed: {e}");
            let _ = app.emit(
                "update-failed",
                serde_json::json!({"message": e.to_string()}),
            );
            return;
        }
    };
    let state: State<UpdateState> = app.state();
    *state.pending.lock().unwrap() = Some((update, bytes));
    eprintln!("updater: version {version} ready to install");
    let _ = app.emit("update-ready", serde_json::json!({"version": version}));
}

pub fn start_update_checker(app: AppHandle) {
    // debug builds run from target/ with dev sessions; never self-replace them
    // (GUILD_UPDATER_FORCE opts a debug build in for testing)
    if cfg!(debug_assertions) && std::env::var("GUILD_UPDATER_FORCE").is_err() {
        return;
    }
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("updater runtime");
        rt.block_on(async move {
            loop {
                check_and_prepare_update(&app).await;
                // re-check every 15 minutes while the app is open
                tokio::time::sleep(std::time::Duration::from_secs(15 * 60)).await;
            }
        });
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // single-instance must be the first plugin: a second launch focuses
        // the running one instead of forking a second engine/session.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineState::default())
        .manage(UpdateState::default())
        .manage(Arc::new(GuildState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::start_engine,
            commands::rpc_request,
            commands::rpc_submit,
            commands::rpc_poll,
            commands::set_machine_identity,
            commands::set_chat_dir,
            commands::chat_snapshot,
            commands::install_update,
            commands::pending_update_version
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // One session, one dispatch surface. The CLI socket and the
            // webview pipes both serve this Shared. Bounded: an unreachable
            // server must not hang the window open — the token stays usable
            // by the link either way.
            let session = tauri::async_runtime::block_on(async {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    guild_app_server::jsonrpc_loop::restored_session(),
                )
                .await
                {
                    Ok(r) => r.unwrap_or_else(|_| Default::default()),
                    Err(_) => {
                        eprintln!("setup: session restore timed out; starting without a validated session");
                        Default::default()
                    }
                }
            });
            let shared = guild_app_server::jsonrpc_loop::Shared::new(session);
            {
                let state: State<EngineState> = app.state();
                *state.shared.lock().unwrap() = Some(shared.clone());
            }
            {
                let guild: State<Arc<GuildState>> = app.state();
                *guild.shared.lock().unwrap() = Some(shared.clone());
            }

            // CLI verbs: the socket is hosted by this process, backed by its
            // own restored session (login/pair through the webview writes the
            // same token store, so both surfaces stay authed). If an old
            // background daemon still owns the endpoint, this returns Ok and
            // the stale one serves CLI until it is shut down.
            {
                tauri::async_runtime::spawn(async move {
                    match guild_app_server::jsonrpc_loop::restored_session().await {
                        Ok(cli_session) => {
                            let _ = guild_app_server::daemon::run_daemon_on(
                                guild_app_server::daemon::socket_path().expect("socket path"),
                                cli_session,
                            )
                            .await;
                        }
                        Err(e) => eprintln!("cli socket host: session restore failed: {e}"),
                    }
                });
            }

            // The webview-facing engine (in-process pipes).
            {
                let state: State<EngineState> = app.state();
                let (engine, rd_out) = build_engine(&shared).map_err(|e| e.to_string())?;
                let engine = Arc::new(engine);
                start_engine_reader(handle.clone(), engine.clone(), rd_out);
                *state.cell.lock().unwrap() = Some(engine);
            }

            // The single standing server connection: shares the managed
            // state (machine identity, dirs, mirrors) with the commands.
            {
                let guild: State<Arc<GuildState>> = app.state();
                let guild = guild.inner().clone();
                tauri::async_runtime::spawn(ws_link_task(guild, handle.clone()));
            }

            // Window close → collapse to tray (the process keeps executing
            // tools and holding presence). Real exit only from the tray.
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win2.hide();
                    }
                });
            }

            // Tray: Open / Quit.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            let open = MenuItem::with_id(app, "open", "Open Guild", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Guild", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
                .map_err(|e| e.to_string())?;
            TrayIconBuilder::with_id("guild-tray")
                .icon(icon)
                .tooltip("Guild")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            start_update_checker(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_line_kinds() {
        let resp = r#"{"jsonrpc":"2.0","id":3,"protocol":1,"result":{"ok":true}}"#;
        match parse_line(resp) {
            Some(EngineLine::Response { id, .. }) => assert_eq!(id, 3),
            _ => panic!("expected response"),
        }
        let ev = r#"{"protocol":1,"event":"chat.delta","payload":{"content":"hi"}}"#;
        match parse_line(ev) {
            Some(EngineLine::Event(v)) => assert_eq!(v["event"], "chat.delta"),
            _ => panic!("expected event"),
        }
        assert!(parse_line("not json").is_none());
    }

    #[test]
    fn envelope_carries_protocol() {
        let v = envelope(5, "login", &serde_json::json!({"a": 1}));
        assert_eq!(v["protocol"], 1);
        assert_eq!(v["id"], 5);
    }

    #[test]
    fn websocket_url_uses_ws_scheme_and_encodes_all_query_values() {
        let url = websocket_url(
            "https://guild.example/base",
            "ticket/+",
            "machine id",
            "machine id",
            "Desk & Lab",
        )
        .unwrap();
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.path(), "/base/api/v1/ws");
        assert_eq!(
            url.query(),
            Some("ticket=ticket%2F%2B&client_id=machine%20id&machine_id=machine%20id&machine_name=Desk%20%26%20Lab")
        );
    }

    #[test]
    fn websocket_frame_data_keeps_app_frame_shape() {
        let data = websocket_frame_data(
            uuid::Uuid::nil(),
            Some("machine".into()),
            protocol::api::StreamEvent::Delta {
                content: "hello".into(),
            },
        );
        let value: Value = serde_json::from_str(&data).unwrap();
        assert_eq!(value["chat_id"], uuid::Uuid::nil().to_string());
        assert_eq!(value["machine_id"], "machine");
        assert_eq!(value["event"]["type"], "delta");
    }
}
