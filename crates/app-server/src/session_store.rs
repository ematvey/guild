//! Local session storage: where the app-server keeps the cloud token
//! (spec §3.2 — token never lives in the webview).

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoredSession {
    pub base_url: String,
    pub token: String,
    /// Known only for sessions stored by newer builds; None means the
    /// caller should treat the email as unknown (UI shows the token's
    /// server-side identity instead).
    #[serde(default)]
    pub email: Option<String>,
}

pub fn default_path() -> anyhow::Result<PathBuf> {
    let dir = dirs::config_dir().context("no config dir")?.join("guild");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("token.json"))
}

pub fn save(path: &Path, session: &StoredSession) -> anyhow::Result<()> {
    let json = serde_json::to_string(session)?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    f.write_all(json.as_bytes())?;
    // Owner-only permissions — the file holds the bearer token. Set after
    // the write so pre-existing world-readable files are tightened too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = f.metadata()?.permissions();
        perms.set_mode(0o600);
        f.set_permissions(perms)?;
    }
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
        clear(&path).unwrap();
        assert!(load(&path).is_none());
        let _ = default_path(); // smoke: builds on this OS
    }
}
