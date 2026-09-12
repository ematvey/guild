//! Env-gated daemon-side trace (GUILD_DAEMON_TRACE=1 appends to
//! %TEMP%/guild-daemon-trace.log). Thread-safe, never panics, zero cost when
//! unset. Exists to localize the Windows named-pipe wedge in situ.

use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn dtrace(msg: &str) {
    if std::env::var("GUILD_DAEMON_TRACE").unwrap_or_default() != "1" {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let line = format!("{ts} #{n} T[{:?}] {msg}\n", std::thread::current().id());
    let path = std::env::temp_dir().join("guild-daemon-trace.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}
