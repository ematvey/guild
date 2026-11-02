//! Tauri side of the desktop shell — SINGLE PROCESS (spec
//! docs/specs/2026-09-13-single-process-desktop.md): the GUI process hosts
//! the engine (session, JSON-RPC dispatch, local tool execution) directly.
//! There is no headless daemon and no cross-process pipe to one; the local
//! socket remains only as the CLI-verb entry point, hosted by this process.
//!
//! The shell holds no server connection of its own: the machine (executor)
//! role rides the engine's machine link, and all display state reaches the
//! webview over the webview's own member WebSocket. The shell's webview
//! surface is the engine rpc bridge (submit + poll, allowlisted methods),
//! local folder browsing, the engine trace toggle, and the updater.

use guild_app_server::jsonrpc_loop::{run_connection, Shared};
use guild_app_server::sync::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Pending downloaded update, waiting for the user to restart.
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
    /// Last update-check start time. The webview invokes check_update_now on
    /// every page load, so a reload storm must not hammer the update endpoint
    /// or hold duplicate in-flight downloads — a check inside the interval is
    /// a no-op (the 15-minute loop checks independently).
    last_check: Mutex<Option<std::time::Instant>>,
}

/// Everything the webview rpc surface needs: the in-process engine
/// connection (pipes to the same-process dispatch loop) and the engine's
/// Shared, published once the persisted session is restored.
pub struct EngineState {
    cell: Mutex<Option<Arc<Engine>>>,
    next_id: AtomicU64,
    /// The engine's Shared (session + dispatch state). `None` until the
    /// startup restore finishes; `start_engine` waits on it.
    shared: tokio::sync::watch::Sender<Option<Shared>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            cell: Mutex::new(None),
            next_id: AtomicU64::new(0),
            shared: tokio::sync::watch::Sender::new(None),
        }
    }
}

pub struct Engine {
    /// Client→engine write half (std pipe writer; sync writes are fine —
    /// the dispatch loop reads on its own thread).
    writer: Mutex<std::io::PipeWriter>,
    /// Completed JSON-RPC envelopes, drained by `rpc_poll`: the webview never
    /// holds a long-lived invoke open (Windows WebView2 can silently lose
    /// those).
    results: Mutex<HashMap<u64, Value>>,
    /// Submit timestamps of requests still waiting for their response: the
    /// poll-timeout sweep and the engine-exit failure path act on these only.
    submitted: Mutex<HashMap<u64, std::time::Instant>>,
}

impl Engine {
    fn new(writer: std::io::PipeWriter) -> Self {
        Self {
            writer: Mutex::new(writer),
            results: Mutex::new(HashMap::new()),
            submitted: Mutex::new(HashMap::new()),
        }
    }

    /// Records a request as in flight.
    fn submit(&self, id: u64) {
        self.submitted.guard().insert(id, std::time::Instant::now());
    }

    /// A response arrived: the request is no longer in flight, and its
    /// envelope waits for the next poll.
    fn complete(&self, id: u64, value: Value) {
        self.submitted.guard().remove(&id);
        self.results.guard().insert(id, value);
    }

    /// Fails every request still in flight with `message`.
    fn fail_in_flight(&self, message: &str) {
        let ids: Vec<u64> = self.submitted.guard().drain().map(|(id, _)| id).collect();
        let mut results = self.results.guard();
        for id in ids {
            results.insert(
                id,
                serde_json::json!({"id": id, "error": {"message": message}}),
            );
        }
    }

    /// Fails the in-flight requests submitted longer than `timeout` ago.
    fn expire(&self, now: std::time::Instant, timeout: Duration) {
        let stale: Vec<u64> = {
            let mut submitted = self.submitted.guard();
            let stale: Vec<u64> = submitted
                .iter()
                .filter(|(_, at)| now.duration_since(**at) > timeout)
                .map(|(id, _)| *id)
                .collect();
            for id in &stale {
                submitted.remove(id);
            }
            stale
        };
        let mut results = self.results.guard();
        for id in stale {
            guild_app_server::trace!("ipc rpc-timeout id={id}");
            results.entry(id).or_insert_with(
                || serde_json::json!({"id": id, "error": {"message": "engine timed out"}}),
            );
        }
    }

    /// Takes every completed envelope.
    fn drain(&self) -> Vec<Value> {
        self.results.guard().drain().map(|(_, v)| v).collect()
    }
}

/// Engine methods the webview may call: the `webview: true` methods of
/// `protocol/rpc.schema.json` (a test holds the two equal). The rpc bridge
/// refuses anything else, so script running in the webview cannot reach
/// the rest of the engine's dispatch surface (shutdown, CLI-only installs).
const WEBVIEW_RPC_METHODS: &[&str] = &[
    "session.info",
    "session.clear",
    "pair",
    "login",
    "machine.identify",
    "workspace.list",
    "workspace.switch",
    "registry.publish",
    "registry.uninstall",
    "fs.scopes",
    "fs.read_text",
    "fs.list_dir",
    "fs.exists",
    "fs.write_text",
];

/// How long a request may stay in flight before `rpc_poll` fails it.
const RPC_TIMEOUT: Duration = Duration::from_secs(120);

fn webview_rpc_allowed(method: &str) -> bool {
    WEBVIEW_RPC_METHODS.contains(&method)
}

/// The request id and envelope of one engine line when it is a JSON-RPC
/// response (an `id`, no `event` field); None for anything else.
pub fn parse_response(line: &str) -> Option<(u64, Value)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("event").is_some() {
        return None;
    }
    Some((v.get("id")?.as_u64()?, v))
}

/// Builds the in-process engine: two unidirectional std pipes carry the
/// JSON-RPC line protocol between the webview-facing commands and the same
/// `run_connection` dispatch the CLI socket serves — one dispatch surface,
/// one session, two transports. Starts the dispatch loop and the response
/// reader.
fn build_engine(shared: &Shared) -> anyhow::Result<Arc<Engine>> {
    let (rd_in, wr_in) = std::io::pipe()?; // client → engine
    let (rd_out, wr_out) = std::io::pipe()?; // engine → client
    {
        let shared = shared.clone();
        // The dispatch loop runs for the process lifetime; it ends only when
        // the pipe write end drops (app exit).
        std::thread::spawn(move || {
            let rt = tauri::async_runtime::handle();
            let _ = rt.block_on(run_connection(&shared, rd_in, wr_out));
        });
    }
    let engine = Arc::new(Engine::new(wr_in));
    start_engine_reader(engine.clone(), rd_out);
    Ok(engine)
}

/// Reader for the engine→client pipe: responses complete their request.
/// The engine sends nothing else for a well-formed envelope; any other
/// line is only traced.
fn start_engine_reader(engine: Arc<Engine>, rd_out: std::io::PipeReader) {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(rd_out);
        use std::io::BufRead;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    guild_app_server::trace!("ipc reader-exit eof");
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    guild_app_server::trace!("ipc reader-exit err={e}");
                    break;
                }
            }
            match parse_response(&line) {
                Some((id, value)) => {
                    guild_app_server::trace!("ipc resp id={id} bytes={}", line.len());
                    engine.complete(id, value);
                }
                None => guild_app_server::trace!("ipc non-response bytes={}", line.len()),
            }
        }
        engine.fail_in_flight("engine dropped the request");
    });
}

fn envelope(id: u64, method: &str, params: &Value) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "protocol": 1u64,
        "method": method, "params": params,
    })
}

/// WSL caches shared by the folder-browsing commands.
#[derive(Default)]
pub struct GuildState {
    /// Distro → /etc/os-release PRETTY_NAME, fetched lazily (first
    /// list_wsl_distros call) and cached for the app run.
    wsl_pretty: Mutex<HashMap<String, Option<String>>>,
    /// The last parsed distro list with the time it was fetched — served
    /// stale-while-revalidate so a dialog never waits on a cold wsl.exe;
    /// `None` until the first fetch completes.
    wsl_distros: Mutex<Option<(std::time::Instant, Vec<Distro>)>>,
    /// Distro → $HOME, fetched lazily on first specifier use, cached for
    /// the app run.
    wsl_homes: Mutex<HashMap<String, Option<String>>>,
}

// ---- WSL + local filesystem browsing (project folder sources, spec §5) ----

/// One WSL distro as a folder source.
#[derive(Clone, Serialize, Deserialize)]
pub struct Distro {
    pub name: String,
    pub running: bool,
    pub pretty_name: Option<String>,
}

/// One row of a directory listing.
#[derive(Clone, Serialize, Deserialize)]
pub struct ListEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Runs wsl.exe with clean UTF-8 output; None on a non-Windows host, a
/// missing wsl.exe, or a failed command.
#[cfg(windows)]
fn run_wsl(args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("wsl.exe")
        .env("WSL_UTF8", "1")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(not(windows))]
fn run_wsl(_args: &[&str]) -> Option<String> {
    None
}

/// One wsl.exe listing pass: parse, filter helpers, store in the stale-
/// while-revalidate cache. Deliberately spawns NOTHING per distro — a
/// per-distro os-release read would start every distro at app startup;
/// pretty names are fetched on first browse instead (the user-driven
/// boot). The caller owns a blocking context.
fn fetch_wsl_distros(state: &Arc<GuildState>) -> Result<Vec<Distro>, String> {
    let Some(raw) = run_wsl(&["--list", "--verbose"]) else {
        let empty: Vec<Distro> = Vec::new();
        *state.wsl_distros.guard() = Some((std::time::Instant::now(), empty.clone()));
        return Ok(empty);
    };
    let mut out = Vec::new();
    for (name, running) in parse_wsl_list(&raw) {
        if name.starts_with("docker-desktop") {
            continue;
        }
        let pretty_name = state.wsl_pretty.guard().get(&name).cloned().flatten();
        out.push(Distro {
            name,
            running,
            pretty_name,
        });
    }
    *state.wsl_distros.guard() = Some((std::time::Instant::now(), out.clone()));
    Ok(out)
}

/// One data row of `wsl --list --verbose` output: (name, running). The
/// header row and blank lines are skipped; a leading `*` (default distro)
/// is stripped.
fn parse_wsl_list_row(line: &str) -> Option<(String, bool)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("NAME") {
        return None;
    }
    let mut tokens = trimmed.trim_start_matches('*').split_whitespace();
    let name = tokens.next()?.to_string();
    let state = tokens.next().unwrap_or("");
    Some((name, state.eq_ignore_ascii_case("running")))
}

/// Parses `wsl --list --verbose` output into (name, running) rows. NUL
/// separators are stripped defensively (older wsl.exe emits UTF-16-ish
/// output even with WSL_UTF8=1).
fn parse_wsl_list(raw: &str) -> Vec<(String, bool)> {
    let clean: String = raw.chars().filter(|c| *c != '\0').collect();
    clean.lines().filter_map(parse_wsl_list_row).collect()
}

/// PRETTY_NAME of an /etc/os-release body (first match, quotes stripped).
fn parse_pretty_name(os_release: &str) -> Option<String> {
    os_release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|v| !v.is_empty())
}

// Commands live in a submodule: `#[tauri::command]` in the crate-root
// module trips E0255 (macro re-imports itself).
pub mod commands {
    use super::*;

    /// Resolves once the engine can take requests: waits for the startup
    /// session restore (bounded by setup), and rebuilds the engine after a
    /// write failure dropped it.
    #[tauri::command]
    pub async fn start_engine(state: State<'_, EngineState>) -> Result<(), String> {
        let shared = state
            .shared
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "engine not initialized".to_string())?
            .clone()
            .ok_or_else(|| "engine not initialized".to_string())?;
        let mut cell = state.cell.guard();
        if cell.is_none() {
            *cell = Some(build_engine(&shared).map_err(|e| e.to_string())?);
        }
        Ok(())
    }

    /// The engine trace (Settings → About toggle): effective on/off and
    /// where the log lands. One log carries the engine, machine-link and
    /// webview-rpc steps, so a wedge (e.g. the Windows instant-close) is
    /// localized without an env var set at launch.
    #[tauri::command]
    pub fn daemon_trace_state() -> Value {
        serde_json::json!({
            "enabled": guild_app_server::trace::enabled(),
            "path": guild_app_server::trace::trace_path().to_string_lossy(),
        })
    }

    /// Flips the runtime trace gate and persists the choice as a marker file
    /// in the guild config dir, so the next launch restores it. Applies to
    /// the app-hosted daemon (single-process design); a systemd-unit daemon
    /// is a separate process and still uses GUILD_DAEMON_TRACE=1.
    #[tauri::command]
    pub fn set_daemon_trace(on: bool) -> Result<(), String> {
        guild_app_server::trace::set_enabled(on);
        let marker = guild_app_server::fs_bridge::guild_config_dir().join("daemon-trace.enabled");
        if on {
            std::fs::create_dir_all(marker.parent().expect("config dir has a parent"))
                .map_err(|e| e.to_string())?;
            std::fs::write(&marker, b"1").map_err(|e| e.to_string())?;
        } else {
            let _ = std::fs::remove_file(&marker);
        }
        Ok(())
    }

    /// Restores the persisted trace toggle at launch: the marker file wins
    /// over nothing; the env var needs no seeding (the trace reads it).
    pub fn seed_daemon_trace() {
        let marker = guild_app_server::fs_bridge::guild_config_dir().join("daemon-trace.enabled");
        if marker.exists() {
            guild_app_server::trace::set_enabled(true);
        }
    }

    /// WSL distros on this machine, for the project folder sources. Each
    /// row: `wsl --list --verbose` name + running state, plus the distro's
    /// PRETTY_NAME (lazy, cached per distro). Runs on the blocking pool —
    /// one wsl.exe spawn per uncached distro would otherwise stall the async
    /// runtime; the cache lock is never held across a spawn. Windows only;
    /// every other platform returns an empty list.
    #[tauri::command]
    pub async fn list_wsl_distros(
        state: State<'_, Arc<GuildState>>,
    ) -> Result<Vec<Distro>, String> {
        let state = state.inner().clone();
        tokio::task::spawn_blocking(move || {
            const TTL: std::time::Duration = std::time::Duration::from_secs(60);
            let cached = state.wsl_distros.guard().clone();
            if let Some((at, distros)) = cached {
                if at.elapsed() < TTL {
                    return Ok(distros);
                }
                // Stale: answer from the cache at once, refresh behind it —
                // the next open sees the fresh list without ever waiting.
                let bg = state.clone();
                // Dropping the JoinHandle detaches this cache refresh.
                drop(tokio::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || fetch_wsl_distros(&bg)).await;
                }));
                return Ok(distros);
            }
            fetch_wsl_distros(&state)
        })
        .await
        .map_err(|e| format!("wsl distro listing failed: {e}"))?
    }

    /// The distro's PRETTY_NAME (e.g. Arch Linux), fetched on first browse
    /// of that distro — a user-driven moment, since the browse listing
    /// already boots the distro. Cached for the app run; the lookup runs on
    /// the blocking pool with the cache lock never held across the spawn.
    #[tauri::command]
    pub async fn wsl_pretty_name(
        state: State<'_, Arc<GuildState>>,
        distro: String,
    ) -> Result<Option<String>, String> {
        let state = state.inner().clone();
        tokio::task::spawn_blocking(move || {
            let cached = state.wsl_pretty.guard().get(&distro).cloned();
            if let Some(cached) = cached {
                return Ok(cached);
            }
            let pretty = run_wsl(&["-d", &distro, "--exec", "cat", "/etc/os-release"])
                .as_deref()
                .and_then(parse_pretty_name);
            state.wsl_pretty.guard().insert(distro, pretty.clone());
            Ok(pretty)
        })
        .await
        .map_err(|e| format!("wsl pretty-name lookup failed: {e}"))?
    }

    /// The distro's default user's home directory (LINUX path, e.g.
    /// /home/me), for `~` expansion in the path specifier. Cached per
    /// distro; the lookup runs on the blocking pool (one wsl.exe spawn on
    /// the first call), with the cache lock never held across the spawn.
    #[tauri::command]
    pub async fn wsl_home(
        state: State<'_, Arc<GuildState>>,
        distro: String,
    ) -> Result<Option<String>, String> {
        let state = state.inner().clone();
        tokio::task::spawn_blocking(move || {
            let cached = state.wsl_homes.guard().get(&distro).cloned();
            if let Some(cached) = cached {
                return Ok(cached);
            }
            let home = run_wsl(&["-d", &distro, "--exec", "sh", "-c", "echo $HOME"])
                .map(|raw| raw.trim().to_string())
                .filter(|h| h.starts_with('/') && !h.is_empty());
            state.wsl_homes.guard().insert(distro, home.clone());
            Ok(home)
        })
        .await
        .map_err(|e| format!("wsl home lookup failed: {e}"))?
    }

    /// Directory listing for the path specifier: unfiltered (dotfiles
    /// included), dirs first, then files, each alphabetically. Works over
    /// `\\wsl.localhost\<distro>\…` UNC paths on Windows and plain paths
    /// elsewhere. Allowlisted: home dir and WSL distro roots only — an
    /// unrestricted webview path would enumerate the whole host and, on
    /// Windows, any crafted UNC path makes this process open an outbound
    /// SMB connection (NTLM credential leak).
    #[tauri::command]
    pub async fn list_dir(path: String) -> Result<Vec<ListEntry>, String> {
        let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
        list_dir_allowed(&path, &home)?;
        if !path.starts_with("\\\\") {
            // Plain-path branch: resolve the root through symlinks so a link
            // under home cannot point the listing outside it. The WSL branch
            // is governed by its prefix rule alone.
            let canon = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
            if !canon.starts_with(&home) {
                return Err(format!("not browsable (outside home): {path}"));
            }
        }
        let (mut dirs, mut files): (Vec<ListEntry>, Vec<ListEntry>) = (Vec::new(), Vec::new());
        for entry in std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
            let Ok(entry) = entry else { continue };
            let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);
            let item = ListEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir,
            };
            if is_dir {
                dirs.push(item);
            } else {
                files.push(item);
            }
        }
        let key = |e: &ListEntry| e.name.to_lowercase();
        dirs.sort_by_key(|a| key(a));
        files.sort_by_key(|a| key(a));
        dirs.extend(files);
        Ok(dirs)
    }

    /// Pure allowlist for `list_dir`: the WSL distro roots
    /// (`\\wsl.localhost\<distro>\…`) and the user's home directory. All
    /// other UNC paths are rejected outright, plain paths must be absolute
    /// and lexically inside home (a canonicalized re-check against symlinks
    /// happens in `list_dir` itself). Configured project roots are not part
    /// of this rule — the Rust process has no project store; the only
    /// caller (the path specifier) browses WSL roots and home.
    pub fn list_dir_allowed(path: &str, home: &Path) -> Result<(), String> {
        if path.is_empty() {
            return Err("empty path".to_string());
        }
        // UNC branch: only the WSL 9P shares are legitimate browse roots;
        // any other UNC (e.g. \\host\share) is an NTLM-leak vector.
        guild_app_server::fs_bridge::check_unc_browse(path)?;
        if path.starts_with(r"\\") || path.starts_with("//") {
            return Ok(());
        }
        // Drive-relative forms ("C:foo") and plain relatives are absolute-
        // check bait: reject anything Path does not consider absolute.
        let p = Path::new(path);
        if !p.is_absolute() {
            return Err(format!("path must be absolute: {path}"));
        }
        let norm = normalize_lexical(p);
        // Case-insensitive comparison on Windows only: its paths are, its
        // separators vary; elsewhere the filesystem is case-sensitive.
        let (norm_str, home_str) = (norm.to_string_lossy(), home.to_string_lossy());
        // `get` rather than slicing: a home length that falls inside a
        // multi-byte character of the path is "not under", not a panic.
        #[cfg(windows)]
        let under = norm_str
            .get(..home_str.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(&home_str))
            && norm_str
                .get(home_str.len()..)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '\\']));
        #[cfg(not(windows))]
        let under = norm_str.starts_with(&*home_str)
            && (norm_str.len() == home_str.len() || norm_str[home_str.len()..].starts_with('/'));
        if !under {
            return Err(format!("not browsable (outside home): {path}"));
        }
        Ok(())
    }

    /// Lexical path cleanup: `.` dropped, `..` popped (root-relative pops at
    /// the root are no-ops). No filesystem access — the symlink-resolving
    /// canonicalize happens in the command.
    fn normalize_lexical(path: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for comp in path.components() {
            match comp {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                comp => out.push(comp.as_os_str()),
            }
        }
        out
    }

    /// Submit an rpc without waiting for its response: returns the request id
    /// immediately. Results are collected by rpc_poll. This keeps every webview
    /// invoke sub-millisecond — Windows WebView2 can silently lose long-lived
    /// invoke responses, and a pair/login must not depend on that path.
    /// Only `WEBVIEW_RPC_METHODS` are forwarded.
    #[tauri::command]
    pub async fn rpc_submit(
        state: State<'_, EngineState>,
        method: String,
        params: Value,
    ) -> Result<u64, String> {
        if !webview_rpc_allowed(&method) {
            guild_app_server::trace!("ipc rpc-refused method={method}");
            return Err(format!("rpc method not available to the app: {method}"));
        }
        let engine = state
            .cell
            .guard()
            .clone()
            .ok_or_else(|| "engine not started".to_string())?;
        let id = state.next_id.fetch_add(1, Ordering::SeqCst);
        guild_app_server::trace!("ipc rpc-start id={id} method={method}");
        engine.submit(id);
        let mut w = engine.writer.guard();
        if let Err(e) = w
            .write_all(envelope(id, &method, &params).to_string().as_bytes())
            .and_then(|_| w.write_all(b"\n"))
            .and_then(|_| w.flush())
        {
            guild_app_server::trace!("ipc write-fail id={id} err={e}");
            engine.submitted.guard().remove(&id);
            *state.cell.guard() = None;
            return Err(format!("engine write failed: {e}"));
        }
        drop(w);
        guild_app_server::trace!("ipc write-ok id={id}");
        Ok(id)
    }

    /// Drain completed rpc envelopes (and inject timeouts for requests still
    /// in flight after 120s). Returns full JSON-RPC envelopes; clients route
    /// by the `id` field.
    #[tauri::command]
    pub async fn rpc_poll(state: State<'_, EngineState>) -> Result<Vec<Value>, String> {
        let Some(engine) = state.cell.guard().clone() else {
            return Ok(vec![]);
        };
        engine.expire(std::time::Instant::now(), RPC_TIMEOUT);
        Ok(engine.drain())
    }

    /// Version of the pending downloaded update, if any (UI queries on mount
    /// so a toast isn't missed when the update finished before the webview).
    #[tauri::command]
    pub async fn pending_update_version(
        state: State<'_, UpdateState>,
    ) -> Result<Option<String>, String> {
        Ok(state
            .pending
            .guard()
            .as_ref()
            .map(|(u, _)| u.version.clone()))
    }

    /// Applies the pending downloaded update and restarts the app.
    #[tauri::command]
    pub async fn install_update(
        state: State<'_, UpdateState>,
        app: AppHandle,
    ) -> Result<(), String> {
        let (update, bytes) = {
            let mut guard = state.pending.guard();
            guard
                .take()
                .ok_or_else(|| "no pending update".to_string())?
        };
        // on Windows the installer exits the app itself; mac/linux restart below
        if let Err(e) = update.install(&bytes) {
            // Restore: a failed install must not lose the pending update —
            // the next install attempt would otherwise report "no pending
            // update".
            *state.pending.guard() = Some((update, bytes));
            return Err(e.to_string());
        }
        app.request_restart();
        #[allow(unreachable_code)]
        Ok(())
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
    // An already-downloaded pending update must not re-download every
    // cycle — the bytes are ready and a restart applies them.
    {
        let state: State<UpdateState> = app.state();
        let already = state
            .pending
            .guard()
            .as_ref()
            .is_some_and(|(pending, _)| pending.version == version);
        if already {
            eprintln!("updater: version {version} already pending");
            let _ = app.emit("update-ready", serde_json::json!({"version": version}));
            return;
        }
    }
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
    *state.pending.guard() = Some((update, bytes));
    eprintln!("updater: version {version} ready to install");
    let _ = app.emit("update-ready", serde_json::json!({"version": version}));
}

/// On-demand update check: the webview invokes this on every page load
/// (F5, navigation) so a fresh refresh asks the server promptly — debounced
/// to one check per interval so a reload storm cannot hammer the endpoint.
#[tauri::command]
async fn check_update_now(app: AppHandle) {
    const MIN_INTERVAL: Duration = Duration::from_secs(60);
    {
        let state: State<UpdateState> = app.state();
        let mut last = state.last_check.guard();
        if let Some(t) = *last {
            if t.elapsed() < MIN_INTERVAL {
                return;
            }
        }
        *last = Some(std::time::Instant::now());
    }
    check_and_prepare_update(&app).await;
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
                // The loop shares the debounce clock so a webview reload right
                // after a scheduled check does not re-download immediately.
                {
                    let state: State<UpdateState> = app.state();
                    *state.last_check.guard() = Some(std::time::Instant::now());
                }
                check_and_prepare_update(&app).await;
                // re-check every 15 minutes while the app is open
                tokio::time::sleep(std::time::Duration::from_secs(15 * 60)).await;
            }
        });
    });
}

/// Restores the persisted session, hosts the CLI socket on it, builds the
/// webview engine, and publishes the Shared so `start_engine` resolves.
async fn boot_engine(app: AppHandle) {
    guild_app_server::machine_link::ensure_crypto_provider();
    let session = match tokio::time::timeout(
        Duration::from_secs(10),
        guild_app_server::jsonrpc_loop::restored_session(),
    )
    .await
    {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => {
            eprintln!("setup: session restore failed: {error:#}; starting signed out");
            guild_app_server::trace!("ipc session_restore_failed {error:#}");
            Default::default()
        }
        Err(_) => {
            eprintln!("setup: session restore timed out; starting without a validated session");
            Default::default()
        }
    };
    let shared = Shared::new(session);

    // CLI verbs: the socket is hosted by this process, backed by the SAME
    // Shared the webview engine dispatches on — pair/login from the webview
    // must reach the machine link's watch channel in the same step, not on
    // the next app start. If an old background daemon still owns the
    // endpoint, this waits and hosts the moment the stale one is retired.
    // While the systemd unit daemon is active (after `daemon install`) the
    // host task parks: no socket, no machine link — the unit owns the
    // executor, and the GUI reclaims both when the unit stops. Whoever hosts
    // the socket, auth stays propagated: the daemon re-seeds its link config
    // from token.json changes.
    {
        let daemon_shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            match guild_app_server::daemon::socket_path() {
                Ok(path) => {
                    let _ =
                        guild_app_server::daemon::run_daemon_shared_reclaiming(path, daemon_shared)
                            .await;
                }
                Err(e) => eprintln!("setup: no CLI socket path: {e}"),
            }
        });
    }

    let state: State<EngineState> = app.state();
    match build_engine(&shared) {
        Ok(engine) => *state.cell.guard() = Some(engine),
        // start_engine retries the build from the published Shared.
        Err(e) => eprintln!("setup: engine build failed: {e}"),
    }
    state.shared.send_replace(Some(shared));
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn run() {
    commands::seed_daemon_trace();
    tauri::Builder::default()
        // single-instance must be the first plugin: a second launch focuses
        // the running one instead of forking a second engine/session.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineState::default())
        .manage(UpdateState::default())
        .manage(Arc::new(GuildState::default()))
        .invoke_handler(tauri::generate_handler![
            check_update_now,
            commands::start_engine,
            commands::rpc_submit,
            commands::rpc_poll,
            commands::list_wsl_distros,
            commands::wsl_home,
            commands::wsl_pretty_name,
            commands::list_dir,
            commands::daemon_trace_state,
            commands::set_daemon_trace,
            commands::install_update,
            commands::pending_update_version
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Warm the WSL distro list while the window loads — the first
            // wsl.exe call may boot the whole WSL2 VM (seconds); the dialog
            // should never be the one paying that cost.
            {
                let state = app.state::<Arc<GuildState>>().inner().clone();
                std::thread::spawn(move || {
                    let _ = fetch_wsl_distros(&state);
                });
            }

            // One session, one dispatch surface: the CLI socket and the
            // webview pipes both serve this Shared. The restore validates the
            // stored session against the server, so it runs off the main
            // thread (the window paints meanwhile; `start_engine` waits for
            // it). Bounded: an unreachable server must not hold the engine
            // back — the stored token stays usable either way.
            tauri::async_runtime::spawn(boot_engine(handle.clone()));

            // Window close → collapse to tray (the process keeps executing
            // tools and holding presence). Real exit only from the tray.
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win2.hide();
                    }
                });
            }

            // Tray: Open / Quit.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            let open = MenuItem::with_id(app, "open", "Open Guild", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Guild", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
                .map_err(|e| e.to_string())?;
            TrayIconBuilder::with_id("guild-tray")
                .icon(icon)
                .tooltip("Guild")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            start_update_checker(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dir_allows_wsl_and_home_rejects_the_rest() {
        let home = Path::new("/home/me");
        // WSL distro roots (the path specifier's browse target).
        assert!(commands::list_dir_allowed(r"\\wsl.localhost\Ubuntu\home\me\proj", home).is_ok());
        assert!(commands::list_dir_allowed(r"\\wsl.localhost\Debian\", home).is_ok());
        // Other UNC paths are rejected outright.
        assert!(commands::list_dir_allowed(r"\\attacker-host\share", home).is_err());
        assert!(commands::list_dir_allowed(r"\\wsl$\Ubuntu\tmp", home).is_err());
        // Distro-less WSL prefix is malformed.
        assert!(commands::list_dir_allowed(r"\\wsl.localhost\", home).is_err());
        // Home subtree ok; everything else outside rejected.
        assert!(commands::list_dir_allowed("/home/me/projects/x", home).is_ok());
        assert!(commands::list_dir_allowed("/home/me", home).is_ok());
        assert!(commands::list_dir_allowed("/etc", home).is_err());
        assert!(commands::list_dir_allowed("/home/meet", home).is_err());
        // Traversal is resolved lexically before the home check.
        assert!(commands::list_dir_allowed("/home/me/../../etc", home).is_err());
        assert!(commands::list_dir_allowed("/home/me/sub/../proj", home).is_ok());
        // Relative and drive-relative forms rejected.
        assert!(commands::list_dir_allowed("relative/dir", home).is_err());
        assert!(commands::list_dir_allowed("C:Users\\me", home).is_err());
        assert!(commands::list_dir_allowed("", home).is_err());
    }

    #[test]
    fn parse_response_takes_responses_only() {
        let resp = r#"{"jsonrpc":"2.0","id":3,"protocol":1,"result":{"ok":true}}"#;
        assert_eq!(parse_response(resp).map(|(id, _)| id), Some(3));
        let ev = r#"{"protocol":1,"event":"rpc.error","payload":{"message":"bad"}}"#;
        assert!(parse_response(ev).is_none());
        assert!(parse_response("not json").is_none());
    }

    /// The webview allowlist is exactly the rpc contract's webview method
    /// set (`protocol/rpc.schema.json` `methods`, `webview: true`), and
    /// every one is a method the engine dispatches.
    #[test]
    fn webview_methods_match_the_rpc_contract() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../../protocol/rpc.schema.json")).unwrap();
        let mut from_schema: Vec<&str> = schema["methods"]
            .as_object()
            .expect("rpc.schema.json has a methods table")
            .iter()
            .filter(|(_, m)| m["webview"] == Value::Bool(true))
            .map(|(name, _)| name.as_str())
            .collect();
        from_schema.sort_unstable();
        let mut allowed = WEBVIEW_RPC_METHODS.to_vec();
        allowed.sort_unstable();
        assert_eq!(allowed, from_schema);
        for method in WEBVIEW_RPC_METHODS {
            assert!(
                guild_app_server::jsonrpc_loop::METHODS.contains(method),
                "{method} is not dispatched"
            );
        }
    }

    fn test_engine() -> Engine {
        let (_rd, wr) = std::io::pipe().unwrap();
        Engine::new(wr)
    }

    #[test]
    fn a_response_ends_the_request_in_flight() {
        let engine = test_engine();
        engine.submit(7);
        engine.complete(7, serde_json::json!({"id": 7, "result": {"ok": true}}));
        assert!(engine.submitted.guard().is_empty());
        // Neither the timeout sweep nor engine exit rewrites a finished rpc.
        engine.expire(
            std::time::Instant::now() + Duration::from_secs(600),
            RPC_TIMEOUT,
        );
        engine.fail_in_flight("engine dropped the request");
        let drained = engine.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0]["result"]["ok"], true);
    }

    #[test]
    fn requests_without_a_response_time_out_or_fail_on_engine_exit() {
        let engine = test_engine();
        engine.submit(1);
        engine.submit(2);
        engine.expire(std::time::Instant::now(), RPC_TIMEOUT);
        assert!(engine.drain().is_empty(), "fresh requests are not expired");
        engine.expire(
            std::time::Instant::now() + RPC_TIMEOUT + Duration::from_secs(1),
            RPC_TIMEOUT,
        );
        engine.submit(3);
        engine.fail_in_flight("engine dropped the request");
        let mut drained = engine.drain();
        drained.sort_by_key(|v| v["id"].as_u64());
        let messages: Vec<&str> = drained
            .iter()
            .map(|v| v["error"]["message"].as_str().unwrap())
            .collect();
        assert_eq!(
            messages,
            [
                "engine timed out",
                "engine timed out",
                "engine dropped the request"
            ]
        );
    }

    #[test]
    fn webview_rpc_allowlist_admits_only_the_app_surface() {
        for method in [
            "session.info",
            "pair",
            "login",
            "fs.write_text",
            "registry.publish",
        ] {
            assert!(webview_rpc_allowed(method), "{method}");
        }
        for method in [
            "agent.start",
            "agent.policy.set",
            "daemon.shutdown",
            "chat.send",
            "",
        ] {
            assert!(!webview_rpc_allowed(method), "{method}");
        }
    }

    #[test]
    fn envelope_carries_protocol() {
        let v = envelope(5, "login", &serde_json::json!({"a": 1}));
        assert_eq!(v["protocol"], 1);
        assert_eq!(v["id"], 5);
    }

    #[test]
    fn wsl_list_rows_parse_name_and_running_state() {
        let raw = "  NAME            STATE           VERSION\n\
                   * Ubuntu-22.04    Running         2\n\
                     docker-desktop  Stopped         2\n\
                   \n";
        assert_eq!(
            parse_wsl_list(raw),
            vec![
                ("Ubuntu-22.04".to_string(), true),
                ("docker-desktop".to_string(), false),
            ]
        );
    }

    #[test]
    fn wsl_list_survives_nul_separators_and_uses_lowercase_running() {
        let raw = "N\u{0}A\u{0}M\u{0}E\u{0}\n\u{0} a\u{0}r\u{0}c\u{0}h\u{0} \u{0}R\u{0}u\u{0}n\u{0}n\u{0}i\u{0}n\u{0}g\u{0} \u{0}2\u{0}\n\u{0}";
        assert_eq!(parse_wsl_list(raw), vec![("arch".to_string(), true)]);
    }

    #[test]
    fn pretty_name_parses_from_os_release() {
        assert_eq!(
            parse_pretty_name("NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\n"),
            Some("Arch Linux".to_string())
        );
        assert_eq!(parse_pretty_name("ID=arch\n"), None);
        assert_eq!(parse_pretty_name("PRETTY_NAME=\n"), None);
    }
}
