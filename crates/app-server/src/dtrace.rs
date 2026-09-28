//! Daemon-side trace (appends to %TEMP%/guild-daemon-trace.log). Two gates,
//! either enables: the GUILD_DAEMON_TRACE=1 env var (headless daemons,
//! debugging) or the runtime flag the desktop app sets from
//! Settings → About. Thread-safe, never panics, zero cost when off. Exists
//! to localize the Windows named-pipe wedge in situ.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Runtime gate, flipped by the desktop settings toggle; the env var stays
/// independent so a headless daemon needs no settings surface.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Size cap for the trace: past it the file is truncated and restarted (a
/// forgotten toggle must not grow the temp file without bound).
const TRACE_MAX_BYTES: u64 = 1 << 20;

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Effective gate: the runtime flag OR the env var.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
        || std::env::var("GUILD_DAEMON_TRACE").unwrap_or_default() == "1"
}

/// Where the trace lands, for the settings UI to show the user.
pub fn trace_path() -> std::path::PathBuf {
    std::env::temp_dir().join("guild-daemon-trace.log")
}
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn dtrace(msg: &str) {
    if !enabled() {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let line = format!("{ts} #{n} T[{:?}] {msg}\n", std::thread::current().id());
    let path = trace_path();
    let truncate = std::fs::metadata(&path)
        .map(|m| m.len() > TRACE_MAX_BYTES)
        .unwrap_or(false);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(!truncate)
        .truncate(truncate)
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
    fn runtime_toggle_gates_the_trace_without_the_env_var() {
        if std::env::var("GUILD_DAEMON_TRACE").unwrap_or_default() == "1" {
            return; // env gate is process-global; this test owns the flag only
        }
        set_enabled(false);
        assert!(!enabled());
        set_enabled(true);
        assert!(enabled());
        set_enabled(false);
        assert!(!enabled());
    }

    #[test]
    fn redacted_summary_handles_non_json() {
        let out = redacted_frame_summary("AUTH user:pass@host", 120);
        // Unparsable frames are summarized as shape only, no content.
        assert!(!out.contains("user:pass"), "{out}");
    }
}
