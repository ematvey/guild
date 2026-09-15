//! Peek-visibility experiment: purely sequential (no concurrent reader).
//! connect -> write hello -> read (blocking) -> write session.info ->
//! peek-poll printing availability -> read. Answers whether PeekNamedPipe on
//! the client's read half can see daemon responses AT ALL on this machine.
//! Usage: pipe_probe3 <path to guild-desktop.exe>

use guild_app_server::daemon::{self};
use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

fn ts() -> String {
    format!("[+{:?}]", Instant::now().elapsed())
}

fn main() {
    let bin = std::env::args().nth(1).expect("usage: pipe_probe3 <exe>");
    eprintln!("{} connect...", ts());
    let daemon::Pair(read, mut write, raw) = daemon::try_connect()
        .or_else(|_| {
            daemon::spawn_detached(std::path::Path::new(&bin))?;
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(200));
                if let Ok(p) = daemon::try_connect() {
                    return Ok(p);
                }
            }
            anyhow::bail!("no daemon")
        })
        .expect("connect");
    eprintln!(
        "{} connected, raw read handle = 0x{:x}",
        ts(),
        raw.unwrap_or(0)
    );

    // hello round-trip, sequential.
    let hello = r#"{"jsonrpc":"2.0","id":0,"protocol":1,"method":"daemon.hello","params":{}}"#;
    write.write_all(hello.as_bytes()).unwrap();
    write.write_all(b"\n").unwrap();
    write.flush().unwrap();
    eprintln!("{} hello written, reading (blocking)...", ts());
    let mut r = BufReader::new(read);
    let mut line = String::new();
    r.read_line(&mut line).expect("read hello response");
    eprintln!("{} hello response: {}", ts(), line.trim());

    // session.info with peek-poll visibility.
    let si = r#"{"jsonrpc":"2.0","id":2,"protocol":1,"method":"session.info","params":{}}"#;
    write.write_all(si.as_bytes()).unwrap();
    write.write_all(b"\n").unwrap();
    write.flush().unwrap();
    eprintln!("{} session.info written; peek-polling 6s...", ts());
    let mut seen = false;
    for _ in 0..24 {
        std::thread::sleep(Duration::from_millis(250));
        let avail = guild_app_server::daemon::peek_available_pub(raw.unwrap());
        eprintln!("{} peek avail = {}", ts(), avail);
        if avail > 0 {
            seen = true;
            break;
        }
    }
    if seen {
        let mut line2 = String::new();
        r.read_line(&mut line2).expect("read session.info response");
        eprintln!("{} session.info response: {}", ts(), line2.trim());
        eprintln!("{} VERDICT: peek WORKS on the read half", ts());
    } else {
        eprintln!("{} VERDICT: peek NEVER sees data (blind)", ts());
        // last resort: is the data readable at all? blocking read (no writer
        // is active now, so no deadlock risk):
        let mut line3 = String::new();
        match r.read_line(&mut line3) {
            Ok(_) => eprintln!("{} blocking read got: {}", ts(), line3.trim()),
            Err(e) => eprintln!("{} blocking read err: {e}", ts()),
        }
    }
    eprintln!("{} done", ts());
}
