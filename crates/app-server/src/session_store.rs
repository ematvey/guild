//! Local session storage: where the app-server keeps the cloud token
//! (spec §3.2 — token never lives in the webview).

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoredSession {
    pub base_url: String,
    pub token: String,
}

pub fn default_path() -> anyhow::Result<PathBuf> {
    let dir = dirs::config_dir().context("no config dir")?.join("guild");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("token.json"))
}

pub fn save(path: &Path, session: &StoredSession) -> anyhow::Result<()> {
    let json = serde_json::to_string(session)?;
    std::fs::write(path, json)?;
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
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path).unwrap().token, "t");
        clear(&path).unwrap();
        assert!(load(&path).is_none());
        let _ = default_path(); // smoke: builds on this OS
    }
}
