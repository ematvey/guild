//! Stage-by-stage sync probe: connect → handshake (with watchdog thread) →
//! rpc ×3 → full second attach → rpc. Prints each stage so a hang localizes
//! precisely. Usage: pipe_probe2 <path to guild-desktop.exe>

use guild_app_server::daemon::{self, Pair};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn ts() -> String {
    format!("[+{:?}]", Instant::now().elapsed())
}

fn attach_watchdog(bin: &str, label: String) {
    let t0 = Instant::now();
    println!("{}, label, attach: try_connect...", ts());
    let pair = daemon::try_connect();
    let pair = match pair {
        Ok(p) => {
            println!("{}, label, connect OK", ts());
            p
        }
        Err(e) => {
            println!("{}, label, connect FAILED: {e} — spawning daemon", ts());
            if let Err(e) = daemon::spawn_detached(std::path::Path::new(bin)) {
                println!("{}, label, spawn FAILED: {e}", ts());
                return;
            }
            let mut ok = None;
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(200));
                if let Ok(p) = daemon::try_connect() {
                    ok = Some(p);
                    break;
                }
            }
            match ok {
                Some(p) => {
                    println!("{}, label, connect OK after spawn {:?}", ts(), t0.elapsed());
                    p
                }
                None => {
                    println!("{}, label, connect FAILED after spawn (10s)", ts());
                    return;
                }
            }
        }
    };
    // Handshake with a watchdog: run it on a thread, wait 10s max.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let r = daemon::handshake(pair);
        let _ = tx.send(r);
    });
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(p)) => println!("{}, label, handshake OK {:?}", ts(), t0.elapsed()),
        Ok(Err(e)) => println!("{}, label, handshake ERR: {e}", ts()),
        Err(_) => println!("{}, label, handshake HUNG >10s — daemon silent!", ts()),
    }
    let _ = pair_unused(pair_label_hack());
}

fn pair_label_hack() -> Option<Pair> {
    None
}
fn pair_unused(_: Option<Pair>) {}

fn rpc_session(label: String, read: Box<dyn std::io::Read + Send>, raw: Option<isize>, mut write: Box<dyn std::io::Write + Send>) {
    let label2 = label.clone();
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let label = label2;
        let mut r = daemon::LineReader::new(read, raw);
        loop {
            let mut line = String::new();
            match r.read_line(&mut line) {
                Ok(false) => { eprintln!("{label} reader: eof"); break }
                Err(e) => { eprintln!("{label} reader: ERROR {e}"); break }
                Ok(true) => {
                    eprintln!("{} {} reader: {}", label, ts(), line.trim());
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    for id in 2..5 {
        let env = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "protocol": 1,
            "method": "session.info", "params": {}
        });
        eprintln!("{label} id={id}: calling write_all...");
        let r = write.write_all(env.to_string().as_bytes());
        eprintln!("{label} id={id}: write_all ok={:?}", r.is_ok());
        let r2 = write.write_all(b"\n");
        eprintln!("{label} id={id}: newline ok={:?}", r2.is_ok());
        let r3 = write.flush();
        eprintln!("{label} id={id}: flush ok={:?}", r3.is_ok());
        if r.is_err() || r2.is_err() || r3.is_err() {
            eprintln!("{label} id={id} WRITE FAILED");
            return;
        }
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(line) => eprintln!("{label} id={id} RESP: {}", line.trim()),
            Err(_) => eprintln!("{label} id={id} NO RESPONSE in 10s"),
        }
    }
}

fn main() {
    let bin = match std::env::args().nth(1) {
        Some(b) => b,
        None => {
            eprintln!("usage: pipe_probe2 <path to guild-desktop.exe>");
            std::process::exit(2);
        }
    };
    eprintln!("probe2 start");
    attach_watchdog(&bin, "#1".to_string());
    eprintln!("--- attach #2 (fresh connection, same daemon) ---");
    attach_watchdog(&bin, "#2".to_string());
    eprintln!("--- direct connect + rpc on the SAME pair as handshake ---");
    // Full manual flow: connect, handshake, then rpc on the returned pair.
    match daemon::try_connect() {
        Ok(p) => {
            eprintln!("#3 {} connect OK", ts());
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let r = daemon::handshake(p);
                let _ = tx.send(r);
            });
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Ok(Pair(read, write, raw))) => {
                    eprintln!("#3 {} handshake OK — rpc on the same pair", ts());
                    rpc_session("#3".to_string(), read, raw, write);
                }
                Ok(Err(e)) => eprintln!("#3 {} handshake ERR: {e}", ts()),
                Err(_) => eprintln!("#3 {} handshake HUNG >10s", ts()),
            }
        }
        Err(e) => eprintln!("#3 {} connect FAILED: {e}", ts()),
    }
    eprintln!("probe2 done");
}
