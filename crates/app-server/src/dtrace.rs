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
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Keys whose values must never reach the trace log — frames carry login
/// credentials and session tokens.
const SENSITIVE_KEYS: [&str; 6] = [
    "token",
    "password",
    "api_key",
    "secret",
    "authorization",
    "credential",
];

fn scrub(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let key = k.to_lowercase();
                if SENSITIVE_KEYS.iter().any(|s| key.contains(s)) {
                    *val = serde_json::Value::String("[redacted]".into());
                } else {
                    scrub(val);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                scrub(item);
            }
        }
        _ => {}
    }
}

/// A truncated, redacted summary of a protocol frame for the trace log:
/// sensitive values are replaced before anything is written to disk.
pub fn redacted_frame_summary(frame: &str, max_chars: usize) -> String {
    match serde_json::from_str::<serde_json::Value>(frame) {
        Ok(mut v) => {
            scrub(&mut v);
            let s = v.to_string();
            s.chars().take(max_chars).collect()
        }
        // Unparsable frames may still hold secrets — log shape only.
        Err(_) => format!("[non-json frame of {} bytes]", frame.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_summary_scrubs_credentials() {
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"login","params":{"email":"a@b.c","password":"hunter226"}}"#;
        let out = redacted_frame_summary(frame, 500);
        assert!(!out.contains("hunter226"), "{out}");
        assert!(out.contains("[redacted]"), "{out}");
        let frame = r#"{"result":{"token":"sess-abc123"}}"#;
        let out = redacted_frame_summary(frame, 500);
        assert!(!out.contains("sess-abc123"), "{out}");
    }

    #[test]
    fn redacted_summary_handles_non_json() {
        let out = redacted_frame_summary("AUTH user:pass@host", 120);
        // Unparsable frames are summarized as shape only, no content.
        assert!(!out.contains("user:pass"), "{out}");
    }
}
