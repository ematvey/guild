//! Tauri side of the desktop shell: attaches to the local daemon
//! (guild-app-server's per-user daemon) and bridges JSON-RPC line protocol
//! over the daemon socket (spec §3.1, §3.2, §3.3, §6).

use guild_app_server::daemon::Pair;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const PROTOCOL_VERSION: u32 = 1;

/// Pending downloaded update, waiting for the user to restart.
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

#[derive(Default)]
pub struct EngineState {
    engine: Mutex<Option<Arc<Engine>>>,
    handle: Mutex<Option<AppHandle>>,
    next_id: AtomicU64,
}

pub struct Engine {
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    responses: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
}

/// One parsed line from the engine's stdout.
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

/// Attaches to (or spawns) the per-user daemon and builds the Engine from
/// the socket pair. The daemon survives this app's exit; if it dies, the
/// reader thread clears the handle and the next start_engine re-attaches.
pub async fn attach_engine(app: &AppHandle) -> Result<Arc<Engine>, String> {
    // The daemon should be a copy of this binary (single-binary design);
    // GUILD_DAEMON_BIN overrides for dev.
    let bin = std::env::var("GUILD_DAEMON_BIN").unwrap_or_else(|_| {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "guild".to_string())
    });
    // daemon::attach is fully blocking — keep it off the async reactor.
    let pair = tokio::task::spawn_blocking(move || {
        guild_app_server::daemon::attach(std::path::Path::new(&bin))
    })
    .await
    .map_err(|e| format!("daemon attach join: {e}"))?
    .map_err(|e| format!("daemon attach failed: {e}"))?;
    let Pair(read, write) = pair;

    let engine = Arc::new(Engine {
        stdin: Arc::new(Mutex::new(write)),
        responses: Arc::new(Mutex::new(HashMap::new())),
    });

    // Reader thread: demux lines between responses and events.
    let responses = engine.responses.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(read);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            match parse_line(&line) {
                Some(EngineLine::Response { id, value }) => {
                    if let Some(sender) = responses.lock().unwrap().remove(&id) {
                        let _ = sender.send(value);
                    }
                }
                Some(EngineLine::Event(ev)) => {
                    let _ = app_handle.emit("rpc-event", ev);
                }
                None => {
                    let _ = app_handle.emit(
                        "rpc-event",
                        serde_json::json!({
                            "protocol": PROTOCOL_VERSION, "event": "rpc.error",
                            "payload": {"message": format!("unparseable daemon line: {line}")}
                        }),
                    );
                }
            }
        }
        // daemon gone: fail every pending RPC (dropping the oneshot senders
        // surfaces "engine dropped the request" to the callers instead of a
        // forever-pending invoke), then drop our handle so the next
        // start_engine re-attaches (respawning if needed).
        {
            let mut pending = responses.lock().unwrap();
            pending.clear();
        }
        let state: State<EngineState> = app_handle.state();
        *state.engine.lock().unwrap() = None;
        let _ = app_handle.emit(
            "rpc-event",
            serde_json::json!({
                "protocol": PROTOCOL_VERSION, "event": "rpc.error",
                "payload": {"message": "daemon connection lost"}
            }),
        );
    });

    Ok(engine)
}

fn envelope(id: u64, method: &str, params: &Value) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "protocol": PROTOCOL_VERSION,
        "method": method, "params": params,
    })
}

// Commands live in a submodule: `#[tauri::command]` in the crate-root
// module trips E0255 (macro re-imports itself).
pub mod commands {
    use super::*;

    #[tauri::command]
    pub async fn start_engine(state: State<'_, EngineState>) -> Result<(), String> {
        let handle = state
            .handle
            .lock()
            .unwrap()
            .clone()
            .expect("app handle set at setup");
        // Drop the guard before awaiting: tauri command futures must be Send.
        if state.engine.lock().unwrap().is_some() {
            return Ok(());
        }
        let engine = attach_engine(&handle).await?;
        let mut guard = state.engine.lock().unwrap();
        if guard.is_none() {
            // another concurrent attach may have won; its handle is equally
            // good (both are daemon connections)
            *guard = Some(engine);
        }
        Ok(())
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
        app: AppHandle,
        state: State<'_, EngineState>,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let engine = {
            let guard = state.engine.lock().unwrap();
            guard
                .clone()
                .ok_or_else(|| "engine not started".to_string())?
        };
        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
        // oneshot: tauri's async_runtime re-exports shadow `mpsc::channel`
        // inside #[tauri::command] scopes; oneshot stays unambiguous.
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        engine.responses.lock().unwrap().insert(id, tx);
        {
            let mut stdin = engine.stdin.lock().unwrap();
            if let Err(e) = stdin
                .write_all(envelope(id, &method, &params).to_string().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
            {
                // write failed → daemon is gone or wedged; drop the handle so
                // the next start_engine re-attaches (respawning if needed).
                *state.engine.lock().unwrap() = None;
                return Err(format!("engine write failed: {e}"));
            }
        }
        // Bounded wait: a wedged (alive-but-silent) engine must not leave the
        // UI spinning forever — 120s covers any legitimate request (pair,
        // login, session restore); chat streaming rides on events, not this.
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => {
                engine.responses.lock().unwrap().remove(&id);
                Err("engine dropped the request".into())
            }
            Err(_) => {
                engine.responses.lock().unwrap().remove(&id);
                // the connection is wedged: force a fresh attach next time
                let state: State<EngineState> = app.state();
                *state.engine.lock().unwrap() = None;
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
                // re-check every 6 hours while the app is open
                tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
            }
        });
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineState::default())
        .manage(UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_engine,
            commands::rpc_request,
            commands::install_update,
            commands::pending_update_version
        ])
        .setup(|app| {
            let state: State<EngineState> = app.state();
            *state.handle.lock().unwrap() = Some(app.handle().clone());
            start_update_checker(app.handle().clone());
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
}
