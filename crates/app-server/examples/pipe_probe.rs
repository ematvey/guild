//! Standalone Windows probe replicating the GUI's client-side flow exactly:
//! attach (connect/spawn + byte-wise handshake) -> reader thread on the read
//! half -> rpc write on the write half -> wait for the response. Run with the
//! Guild exe path as argv[1]; prints every step with timestamps.

use guild_app_server::daemon;
use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

fn main() {
    let bin = match std::env::args().nth(1) {
        Some(b) => b,
        None => {
            eprintln!("usage: pipe_probe <path to guild-desktop.exe>");
            std::process::exit(2);
        }
    };
    let t0 = Instant::now();
    println!("[probe] attaching (spawn if needed)...");
    let pair = match daemon::attach(std::path::Path::new(&bin)) {
        Ok(p) => p,
        Err(e) => {
            println!("[probe] attach FAILED after {:?}: {e}", t0.elapsed());
            return;
        }
    };
    println!("[probe] attach ok in {:?} (incl. handshake)", t0.elapsed());
    let daemon::Pair(read, mut write, _) = pair;

    // Reader thread exactly like the GUI's lib.rs.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut r = BufReader::new(read);
        loop {
            let mut line = String::new();
            match r.read_line(&mut line) {
                Ok(0) => {
                    println!("[reader +{:?}] eof", t0.elapsed());
                    break;
                }
                Err(e) => {
                    println!("[reader +{:?}] err {e}", t0.elapsed());
                    break;
                }
                Ok(_) => {
                    println!("[reader +{:?}] {}", t0.elapsed(), line.trim());
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let env = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "protocol": 1,
        "method": "session.info", "params": {}
    });
    if let Err(e) = write
        .write_all(env.to_string().as_bytes())
        .and_then(|_| write.write_all(b"\n"))
        .and_then(|_| write.flush())
    {
        println!("[probe] write FAILED: {e}");
        return;
    }
    println!("[probe] write-ok at {:?}", t0.elapsed());

    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(l) => println!(
            "[probe] RESPONSE at {:?}: {}",
            t0.elapsed(),
            l.trim()
        ),
        Err(_) => println!("[probe] TIMEOUT: no response in 30s <<< WEDGE"),
    }
}
