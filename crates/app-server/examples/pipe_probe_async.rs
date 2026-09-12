//! Async probe replicating the GUI's client flow *including* the tokio task
//! structure of lib.rs's rpc_request (spawn_blocking attach, std::sync::Mutex
//! stdin guard, blocking write on a worker, oneshot + timeout). Run with the
//! Guild exe path as argv[1]. Prints every step with timestamps so a freeze
//! localizes to: attach / write / response delivery / timeout sweep.

use guild_app_server::daemon;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

struct Engine {
    stdin: Arc<StdMutex<Box<dyn Write + Send>>>,
    responses: Arc<StdMutex<std::collections::HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
}

fn trace(msg: &str) {
    println!("[+{:?}] {}", std::thread::current().name().unwrap_or("?"), msg);
    let _ = std::io::stdout().flush();
}

fn envelope(id: u64, method: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "protocol": 1,
        "method": method, "params": {},
    })
}

async fn rpc(engine: &Arc<Engine>, next_id: &AtomicU64, method: &str) -> Result<serde_json::Value, String> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let t0 = Instant::now();
    trace(&format!("rpc-start id={id} method={method}"));
    let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
    engine.responses.lock().unwrap().insert(id, tx);
    {
        let mut stdin = engine.stdin.lock().unwrap();
        if let Err(e) = stdin
            .write_all(envelope(id, method).to_string().as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
        {
            trace(&format!("write-fail id={id} err={e}"));
            return Err(format!("write failed: {e}"));
        }
    }
    trace(&format!("write-ok id={id}"));
    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(v)) => {
            trace(&format!("rpc-resolved id={id} in {:?}", t0.elapsed()));
            Ok(v)
        }
        Ok(Err(_)) => Err("dropped".into()),
        Err(_) => {
            engine.responses.lock().unwrap().remove(&id);
            trace(&format!("rpc-timeout id={id} after {:?}", t0.elapsed()));
            Err("timeout".into())
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let bin = match std::env::args().nth(1) {
        Some(b) => b,
        None => {
            eprintln!("usage: pipe_probe_async <path to guild-desktop.exe>");
            std::process::exit(2);
        }
    };
    let t0 = Instant::now();
    trace("attaching (spawn if needed)...");
    let binpath = bin.clone();
    let pair = tokio::task::spawn_blocking(move || {
        daemon::attach(std::path::Path::new(&binpath))
    })
    .await
    .map_err(|e| format!("join: {e}"))
    .and_then(|r| r.map_err(|e| format!("attach: {e}")));
    let pair = match pair {
        Ok(p) => p,
        Err(e) => {
            trace(&format!("attach FAILED after {:?}: {e}", t0.elapsed()));
            return;
        }
    };
    trace(&format!("attach ok in {:?} (incl. handshake)", t0.elapsed()));
    let daemon::Pair(read, write, _) = pair;

    let engine = Arc::new(Engine {
        stdin: Arc::new(StdMutex::new(write)),
        responses: Arc::new(StdMutex::new(std::collections::HashMap::new())),
    });
    let next_id = AtomicU64::new(0);

    // Reader thread exactly like the GUI's lib.rs.
    {
        let responses = engine.responses.clone();
        std::thread::spawn(move || {
            let mut r = std::io::BufReader::new(read);
            loop {
                let mut line = String::new();
                use std::io::BufRead;
                match r.read_line(&mut line) {
                    Ok(0) => {
                        trace("reader-exit eof");
                        break;
                    }
                    Err(e) => {
                        trace(&format!("reader-exit err={e}"));
                        break;
                    }
                    Ok(_) => {}
                }
                let v: serde_json::Value = match serde_json::from_str(line.trim()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get("event").is_none() {
                    if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                        trace(&format!("resp id={id} bytes={}", line.len()));
                        if let Some(sender) = responses.lock().unwrap().remove(&id) {
                            let _ = sender.send(v);
                        }
                        continue;
                    }
                }
                trace(&format!("event {}", line.trim().chars().take(80).collect::<String>()));
            }
        });
    }

    // Same call sequence the GUI performs on mount + pairing.
    for round in 0..3 {
        match rpc(&engine, &next_id, "session.info").await {
            Ok(v) => trace(&format!("round {round} session.info OK: {v}")),
            Err(e) => trace(&format!("round {round} session.info ERR: {e}")),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    trace("probe-complete — all rpcs resolved; client machinery is healthy");
}
