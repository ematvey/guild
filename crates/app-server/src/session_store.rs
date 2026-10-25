//! Local session storage: where the app-server keeps the cloud token
//! (spec §3.2 — token never lives in the webview).

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct StoredSession {
    pub base_url: String,
    pub token: String,
    /// Known only for sessions stored by newer builds; None means the
    /// caller should treat the email as unknown (UI shows the token's
    /// server-side identity instead).
    #[serde(default)]
    pub email: Option<String>,
    /// The machine identity (webview-generated, stable per app install)
    /// once the client passed it in — the executor role keys on it. None
    /// until the first `machine.identify`.
    #[serde(default)]
    pub machine_id: Option<String>,
    /// Stable per-daemon-install client id (the WS presence key).
    #[serde(default)]
    pub client_id: Option<String>,
    /// Human-facing machine label reported at connect (hostname).
    #[serde(default)]
    pub machine_name: Option<String>,
    /// The workspace's display name and logo URL (server-relative), fetched
    /// from the server at login/restore — the switcher's identity data.
    /// None on rows from older stores.
    #[serde(default)]
    pub org_name: Option<String>,
    #[serde(default)]
    pub org_logo_url: Option<String>,
}

pub fn default_path() -> anyhow::Result<PathBuf> {
    let dir = dirs::config_dir().context("no config dir")?.join("guild");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("token.json"))
}

/// The path the daemon's token.json watcher polls. `GUILD_TOKEN_PATH`
/// overrides it (tests, custom store locations) — the default path is the
/// config-dir token.json every auth transition persists to.
// coherence:seam owner=@ematvey until=2027-01-31 reason="test hook redirects the token store"
pub fn store_watch_path() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("GUILD_TOKEN_PATH") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    default_path()
}

pub fn save(path: &Path, session: &StoredSession) -> anyhow::Result<()> {
    let json = serde_json::to_string(session)?;
    use std::io::Write;
    // Write a sibling tmp (owner-only) and rename over the target: an
    // in-place write truncated by a crash or a full disk would fail to
    // parse on the next boot and silently drop the session to the pairing
    // screen. rename replaces an existing destination on every platform.
    // Unique sibling tmp per save: parallel writers (tests, GUI + CLI in one
    // process) must not collide on the tmp file; the rename itself is atomic.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)?;
    // Owner-only permissions — the file holds the bearer token. The rename
    // also replaces any pre-existing world-readable file with a 0600 one.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = f.metadata()?.permissions();
        perms.set_mode(0o600);
        f.set_permissions(perms)?;
    }
    f.write_all(json.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load(path: &Path) -> Option<StoredSession> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn clear(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// The multi-workspace store: every live session plus the active pointer.
/// Lives beside token.json, which remains the mirror of the ACTIVE session
/// for the watcher and CLI readers.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct WorkspaceStore {
    /// base_url (normalized: no trailing slash) of the active session.
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<StoredSession>,
}

/// Canonical store key for a server: trimmed of the trailing slash, so the
/// same server is always one map entry regardless of how it was entered.
pub fn normalize_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

/// The workspace store's path: a sibling of the token path, same directory,
/// same permissions discipline.
pub fn workspaces_path(token_path: &Path) -> PathBuf {
    token_path.with_file_name("workspaces.json")
}

fn write_json_atomic(path: &Path, json: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    // Write a sibling tmp (owner-only) and rename over the target: an
    // in-place write truncated by a crash or a full disk would fail to
    // parse on the next boot and silently drop the session to the pairing
    // screen. rename replaces an existing destination on every platform.
    // Unique sibling tmp per save: parallel writers (tests, GUI + CLI in one
    // process) must not collide on the tmp file; the rename itself is atomic.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)?;
    // Owner-only permissions — the file holds the bearer token. The rename
    // also replaces any pre-existing world-readable file with a 0600 one.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = f.metadata()?.permissions();
        perms.set_mode(0o600);
        f.set_permissions(perms)?;
    }
    f.write_all(json)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Saves the whole workspace store atomically (0600, tmp+rename).
pub fn save_store(path: &Path, store: &WorkspaceStore) -> anyhow::Result<()> {
    write_json_atomic(path, &serde_json::to_vec(store)?)
}

/// Loads the workspace store, migrating a legacy single-session token.json
/// on first read: a token file without a workspaces.json becomes the sole
/// entry and the active session, and the migrated store is persisted.
/// No token.json and no workspaces.json → an empty store, no file created.
pub fn load_store(token_path: &Path) -> WorkspaceStore {
    let ws_path = workspaces_path(token_path);
    if let Ok(bytes) = std::fs::read(&ws_path) {
        if let Ok(store) = serde_json::from_slice(&bytes) {
            return store;
        }
        // Unparseable store: fall through to migration rather than lose
        // the token mirror — same failure posture as token.json itself.
    }
    match load(token_path) {
        Some(s) => {
            let store = WorkspaceStore {
                active: Some(normalize_base(&s.base_url)),
                workspaces: vec![s],
            };
            let _ = save_store(&ws_path, &store);
            store
        }
        None => WorkspaceStore::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_load_clear_roundtrip() {
        let path = std::env::temp_dir().join(format!("guild-test-{}.json", std::process::id()));
        let s = StoredSession {
            base_url: "http://x".into(),
            token: "t".into(),
            email: Some("a@b".into()),
            machine_id: Some("m".into()),
            client_id: Some("c".into()),
            machine_name: Some("box".into()),
            org_name: None,
            org_logo_url: None,
        };
        save(&path, &s).unwrap();
        // The token file must be owner-only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(load(&path).unwrap().token, "t");
        assert_eq!(load(&path).unwrap().machine_id.as_deref(), Some("m"));
        // No tmp sidecar survives the rename; a re-save over an existing
        // file works too.
        let stem = format!("guild-test-{}", std::process::id());
        let no_tmp = |n: &str| !n.starts_with(&stem) || !n.contains(".json.tmp");
        assert!(std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .all(|e| no_tmp(&e.file_name().to_string_lossy())));
        let mut s2 = s.clone();
        s2.token = "t2".into();
        save(&path, &s2).unwrap();
        assert_eq!(load(&path).unwrap().token, "t2");
        // A pre-machine-id store (older build) still loads.
        std::fs::write(&path, r#"{"base_url":"http://x","token":"t"}"#).unwrap();
        let old = load(&path).unwrap();
        assert!(old.machine_id.is_none() && old.client_id.is_none());
        clear(&path).unwrap();
        assert!(load(&path).is_none());
        let _ = default_path(); // smoke: builds on this OS
    }

    #[test]
    fn workspace_store_roundtrip_and_migration() {
        let dir = std::env::temp_dir().join(format!("guild-ws-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let token_path = dir.join("token.json");
        let _ = clear(&token_path);
        let _ = clear(&dir.join("workspaces.json"));

        // No files at all: an empty store, and no workspaces.json created.
        let empty = load_store(&token_path);
        assert!(empty.workspaces.is_empty() && empty.active.is_none());
        assert!(!dir.join("workspaces.json").exists());

        // Legacy single-session token.json migrates into the store and is
        // persisted on first load.
        save(
            &token_path,
            &StoredSession {
                base_url: "http://a.example.com/".into(),
                token: "ta".into(),
                email: Some("a@b".into()),
                machine_id: Some("m".into()),
                client_id: Some("c".into()),
                machine_name: Some("box".into()),
                org_name: None,
                org_logo_url: None,
            },
        )
        .unwrap();
        let migrated = load_store(&token_path);
        assert_eq!(migrated.active.as_deref(), Some("http://a.example.com"));
        assert_eq!(migrated.workspaces.len(), 1);
        assert_eq!(migrated.workspaces[0].token, "ta");
        // The migration persisted: a second load reads the store file.
        let again = load_store(&token_path);
        assert_eq!(again.active, migrated.active);
        assert_eq!(again.workspaces.len(), migrated.workspaces.len());
        assert_eq!(again.workspaces[0].token, migrated.workspaces[0].token);

        // A full store round-trips with 0600 permissions.
        let mut store = migrated.clone();
        store.workspaces.push(StoredSession {
            base_url: "http://b.example.com".into(),
            token: "tb".into(),
            email: None,
            machine_id: None,
            client_id: None,
            machine_name: None,
            org_name: None,
            org_logo_url: None,
        });
        store.active = Some("http://b.example.com".into());
        save_store(&dir.join("workspaces.json"), &store).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("workspaces.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let loaded = load_store(&token_path);
        assert_eq!(loaded.active.as_deref(), Some("http://b.example.com"));
        assert_eq!(loaded.workspaces.len(), 2);
        assert_eq!(loaded.workspaces[1].base_url, "http://b.example.com");
        // Normalize: trailing slash and whitespace collapse to one key.
        assert_eq!(normalize_base(" http://x/ "), "http://x");
    }
}
