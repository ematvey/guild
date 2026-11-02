//! The engine's diagnostic trace, shared by the daemon, the machine link
//! and the desktop shell's rpc bridge: one line per step in
//! `<user cache dir>/guild/guild-trace.log` (owner-only, size-capped).
//! Off by default. Two gates, either enables: `GUILD_DAEMON_TRACE=1` in the
//! environment (read once; headless daemons) or the runtime flag the
//! desktop sets from Settings → About. Use [`crate::trace!`]: its message
//! is formatted only when the trace is on. Lines carry methods, ids and
//! sizes, never request or response payloads.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Runtime gate, flipped by the desktop settings toggle.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Size cap: past it the file is truncated and restarted, so a forgotten
/// toggle cannot grow it without bound.
const TRACE_MAX_BYTES: u64 = 1 << 20;

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Effective gate: the runtime flag OR the env var (read once).
pub fn enabled() -> bool {
    static ENV: OnceLock<bool> = OnceLock::new();
    ENABLED.load(Ordering::Relaxed)
        || *ENV.get_or_init(|| std::env::var("GUILD_DAEMON_TRACE").is_ok_and(|v| v == "1"))
}

/// Where the trace lands, for the settings UI to show the user: the
/// per-user cache dir, never the shared temp dir.
pub fn trace_path() -> std::path::PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("guild")
        .join("guild-trace.log")
}

/// Formats and writes one trace line when the trace is on; the arguments
/// are not evaluated otherwise.
#[macro_export]
macro_rules! trace {
    ($($arg:tt)*) => {
        if $crate::trace::enabled() {
            $crate::trace::write_line(&format!($($arg)*));
        }
    };
}

struct Sink {
    file: std::fs::File,
    len: u64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(0);

/// Appends one line (the [`crate::trace!`] backend). Never panics; a sink
/// that cannot be opened drops the line.
pub fn write_line(msg: &str) {
    use crate::sync::LockExt as _;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let line = format!("{ts} #{n} T[{:?}] {msg}\n", std::thread::current().id());
    let mut sink = SINK.guard();
    if sink.is_none() {
        *sink = open_sink(&trace_path());
    }
    let Some(s) = sink.as_mut() else { return };
    if s.len > TRACE_MAX_BYTES && s.file.set_len(0).is_ok() {
        s.len = 0;
    }
    if s.file.write_all(line.as_bytes()).is_ok() {
        s.len += line.len() as u64;
    }
}

/// Opens the trace file for appending, owner-only (dir 0700, file 0600 on
/// Unix; the per-user cache dir is already private on Windows).
fn open_sink(path: &std::path::Path) -> Option<Sink> {
    let dir = path.parent()?;
    std::fs::create_dir_all(dir).ok()?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        options.mode(0o600);
    }
    let file = options.open(path).ok()?;
    #[cfg(unix)]
    {
        // A file created before by another build keeps its old mode.
        use std::os::unix::fs::PermissionsExt as _;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some(Sink { file, len })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_toggle_gates_the_trace_and_the_message_is_lazy() {
        if std::env::var("GUILD_DAEMON_TRACE").is_ok_and(|v| v == "1") {
            return; // the env gate is process-global; this test owns the flag only
        }
        set_enabled(false);
        assert!(!enabled());
        let evaluated = std::cell::Cell::new(false);
        let probe = || {
            evaluated.set(true);
            "x"
        };
        crate::trace!("{}", probe());
        assert!(!evaluated.get(), "a disabled trace formatted its message");
    }

    #[cfg(unix)]
    #[test]
    fn the_sink_is_owner_only_and_appends() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("guild-trace-{}", uuid::Uuid::now_v7()));
        let path = dir.join("t.log");
        let mut sink = open_sink(&path).unwrap();
        sink.file.write_all(b"one\n").unwrap();
        drop(sink);
        let mut sink = open_sink(&path).unwrap();
        assert_eq!(sink.len, 4);
        sink.file.write_all(b"two\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
