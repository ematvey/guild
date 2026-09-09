//! Tauri side of the desktop shell: spawns the local engine
//! (guild-app-server) and bridges JSON-RPC over the child's stdio
//! (spec §3.1, §3.2, §6).

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};


pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Default)]
pub struct EngineState {
    engine: Mutex<Option<Arc<Engine>>>,
    handle: Mutex<Option<AppHandle>>,
    next_id: AtomicU64,
}

pub struct Engine {
    #[allow(dead_code)]
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
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
        Some(EngineLine::Response { id: v["id"].as_u64()?, value: v })
    } else {
        Some(EngineLine::Event(v))
    }
}

/// Resolves the engine binary: env override, then workspace target dirs.
pub fn engine_binary() -> Option<String> {
    if let Ok(p) = std::env::var("GUILD_APP_SERVER_BIN") {
        return Some(p);
    }
    // In `tauri dev`, cwd is apps/desktop/src-tauri.
    for candidate in ["../../target/debug/guild-app-server", "../../target/release/guild-app-server"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    // Fall back to PATH lookup.
    let path = std::env::var("PATH").ok()?;
    path.split(':')
        .map(|dir| std::path::Path::new(dir).join("guild-app-server"))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

pub fn spawn_engine(app: &AppHandle) -> Result<Arc<Engine>, String> {
    let bin = engine_binary().ok_or_else(|| {
        "guild-app-server binary not found; set GUILD_APP_SERVER_BIN or run `cargo build -p guild-app-server`".to_string()
    })?;
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn {bin}: {e}"))?;
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");

    let engine = Arc::new(Engine {
        child: Mutex::new(child),
        stdin: Arc::new(Mutex::new(stdin)),
        responses: Arc::new(Mutex::new(HashMap::new())),
    });

    // Reader thread: demux lines between responses and events.
    let responses = engine.responses.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
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
                            "event": "rpc.error",
                            "payload": {"message": format!("unparseable engine line: {line}")}
                        }),
                    );
                }
            }
        }
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
        let handle = state.handle.lock().unwrap().clone().expect("app handle set at setup");
        let mut guard = state.engine.lock().unwrap();
        if guard.is_none() {
            *guard = Some(spawn_engine(&handle)?);
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn rpc_request(
        state: State<'_, EngineState>,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let engine = {
            let guard = state.engine.lock().unwrap();
            guard.clone().ok_or_else(|| "engine not started".to_string())?
        };
        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
        // oneshot: tauri's async_runtime re-exports shadow `mpsc::channel`
        // inside #[tauri::command] scopes; oneshot stays unambiguous.
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        engine.responses.lock().unwrap().insert(id, tx);
        {
            let mut stdin = engine.stdin.lock().unwrap();
            stdin
                .write_all(envelope(id, &method, &params).to_string().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("engine write failed: {e}"))?;
        }
        match rx.await {
            Ok(value) => Ok(value),
            Err(_) => {
                engine.responses.lock().unwrap().remove(&id);
                Err("engine dropped the request".into())
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![commands::start_engine, commands::rpc_request])
        .setup(|app| {
            let state: State<EngineState> = app.state();
            *state.handle.lock().unwrap() = Some(app.handle().clone());
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
