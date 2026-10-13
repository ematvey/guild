//! Machine-side `skills.sync_v1`: converges the machine user's skill scope
//! (`~/.agents/skills`) to the server's desired install list (skills spec
//! §4). Every payload entry is downloaded, hash-verified, and extracted;
//! every skill dir NOT in the payload and carrying Guild's provenance
//! sidecar is removed — an empty list means "sync to nothing". Dirs without
//! the sidecar are user-created and never touched.

use crate::cloud::CloudClient;
use crate::registry_client::{self, SkillProvenance};
use guild_core::registry;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::future::Future;
use std::path::Path;

/// Authenticated bundle download for the sync: the machine fetches the
/// server's bundle URL with its own stored credentials — the same bearer
/// path the artifact prefetcher and install_skill use. The URL rides the
/// sync payload (short-TTL signed form) or falls back to the machine's
/// own registry endpoint, built by the link's dispatch arm.
pub async fn fetch_bundle(cloud: &CloudClient, url: &str) -> Result<Vec<u8>, String> {
    let resp = cloud
        .http_pub()
        .get(url)
        .bearer_auth(&cloud.token)
        .send()
        .await
        .map_err(|e| format!("bundle download failed: {e}"))?;
    let resp = CloudClient::check(resp)
        .await
        .map_err(|e| format!("bundle download failed: {e}"))?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("bundle download failed: {e}"))?;
    Ok(bytes.to_vec())
}

/// Slug charset for sync targets: lowercase alphanumerics, `-`, `_` (the
/// registry manifest charset) — a path-escape slug never reaches the
/// filesystem.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 128
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Installs a skill dir in a staging sibling first: a failing extract or
/// hash check must never leave the previous version's tree torn down or a
/// mixed old/new tree on disk. The sidecar is written into staging before
/// the swap, so an installed dir always carries provenance.
pub async fn sync<F, Fut>(
    payload: &serde_json::Value,
    fetch: F,
    root: &Path,
) -> Result<serde_json::Value, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let skills = payload["skills"].as_array().ok_or("missing skills array")?;
    let skills_dir = root.join(".agents").join("skills");
    let mut updated: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    let mut desired: BTreeSet<String> = BTreeSet::new();
    let staging_timer = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    for (idx, entry) in skills.iter().enumerate() {
        let slug = entry["slug"].as_str().ok_or("skill entry missing slug")?;
        if !valid_slug(slug) {
            return Err(format!("invalid skill slug {slug:?}"));
        }
        desired.insert(slug.to_string());
        let version = entry["version"].as_str().unwrap_or_default().to_string();
        let url = entry["url"]
            .as_str()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .ok_or_else(|| format!("skill {slug} has no bundle url"))?
            .to_string();
        let expected = entry["bundle_sha256"]
            .as_str()
            .map(str::trim)
            .map(str::to_lowercase)
            .unwrap_or_default();
        if expected.is_empty() {
            return Err(format!("skill {slug} has no bundle_sha256"));
        }
        let bytes = fetch(url.clone())
            .await
            .map_err(|e| format!("{slug}: bundle download failed: {e}"))?;
        let actual = hex::encode(Sha256::digest(&bytes));
        if actual != expected {
            return Err(format!(
                "{slug}: bundle sha256 mismatch (expected {expected}, got {actual})"
            ));
        }
        let staging = skills_dir.join(format!(".{}-sync-{}", slug, staging_timer as usize + idx));
        let _ = std::fs::remove_dir_all(&staging);
        if let Err(e) = registry::extract(&bytes, &staging) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("{slug}: extract failed: {e}"));
        }
        let provenance = SkillProvenance {
            source: "registry".into(),
            slug: slug.to_string(),
            version: version.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            bundle_hash: format!("sha256:{actual}"),
            ..Default::default()
        };
        if let Err(e) = registry_client::write_sidecar(&staging, &provenance) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("{slug}: sidecar write failed: {e}"));
        }
        let dest = skills_dir.join(slug);
        if dest.is_dir() {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| format!("{slug}: replacing the old install failed: {e}"))?;
        }
        if let Err(e) = std::fs::rename(&staging, &dest) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("{slug}: install failed: {e}"));
        }
        updated.push(slug.to_string());
    }
    // Converge: any remaining dir that is not in the desired list and
    // carries Guild's provenance sidecar was pushed by an earlier sync and
    // is removed. Dirs without the sidecar are user-created — never touched.
    if let Ok(mut reader) = tokio::fs::read_dir(&skills_dir).await {
        while let Ok(Some(entry)) = reader.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir || desired.contains(&name) || name.starts_with('.') {
                continue;
            }
            let dir = skills_dir.join(&name);
            if registry_client::read_sidecar(&dir).is_some() {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    return Err(format!("{name}: removal failed: {e}"));
                }
                removed.push(name);
            }
        }
    }
    Ok(serde_json::json!({ "updated": updated, "removed": removed }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use guild_core::registry::pack_skill;
    use std::sync::{Arc, Mutex};

    fn temp_root(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "guild-skill-sync-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    /// Builds a real bundle: a dir with one SKILL.md, packed with
    /// pack_skill (the same path a registry publish takes).
    fn test_bundle(body: &str) -> Vec<u8> {
        let src = temp_root("src");
        std::fs::create_dir_all(src.join("demo-skill")).unwrap();
        std::fs::write(
            src.join("demo-skill/SKILL.md"),
            format!("---\nname: demo-skill\ndescription: t\n---\n{body}"),
        )
        .unwrap();
        let (bytes, _) = pack_skill(&src.join("demo-skill"), "v2").unwrap();
        let _ = std::fs::remove_dir_all(&src);
        bytes
    }

    fn sidecar_of(dir: &Path) -> Option<String> {
        std::fs::read_to_string(dir.join("agents/guild.yaml")).ok()
    }

    /// Installs the desired entry (sha-verified bundle extract + sidecar
    /// write), removes absent sidecar-carrying dirs, and leaves plain
    /// user dirs alone. An empty skills list converges to nothing.
    #[tokio::test]
    async fn sync_installs_updates_and_removes() {
        let root = temp_root("converge");
        let bytes = test_bundle("two");
        let fetched = Arc::new(Mutex::new(Vec::new()));
        let payload = serde_json::json!({"skills": [
            {"slug": "demo-skill", "version": "v2", "bundle_sha256": sha(&bytes),
             "url": "http://hub/api/v1/registry/skill/demo-skill/v2/bundle"}
        ]});
        // A previous Guild install (sidecar) must be replaced by v2...
        let old = root.join(".agents/skills/demo-skill");
        std::fs::create_dir_all(old.join("agents")).unwrap();
        std::fs::write(old.join("SKILL.md"), "one").unwrap();
        registry_client::write_sidecar(
            &old,
            &SkillProvenance {
                source: "registry".into(),
                slug: "demo-skill".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // ...a removed Guild install must disappear...
        let gone = root.join(".agents/skills/old-skill");
        std::fs::create_dir_all(gone.join("agents")).unwrap();
        std::fs::write(gone.join("SKILL.md"), "gone").unwrap();
        registry_client::write_sidecar(
            &gone,
            &SkillProvenance {
                source: "registry".into(),
                slug: "old-skill".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // ...and a user-created dir without a sidecar must survive.
        let user = root.join(".agents/skills/user-skill");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "mine").unwrap();

        let fetched_url = fetched.clone();
        let res = sync(
            &payload,
            move |url: String| {
                let seen = fetched_url.clone();
                let bytes = bytes.clone();
                async move {
                    seen.lock().unwrap().push(url.clone());
                    if url.contains("demo-skill") {
                        Ok(bytes)
                    } else {
                        Err(format!("unexpected url {url}"))
                    }
                }
            },
            &root,
        )
        .await
        .unwrap();

        let dir = root.join(".agents/skills/demo-skill");
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            format!("---\nname: demo-skill\ndescription: t\n---\ntwo")
        );
        assert!(
            sidecar_of(&dir).is_some_and(|s| s.contains("slug: demo-skill")),
            "installed dir carries the provenance sidecar"
        );
        assert!(!root.join(".agents/skills/old-skill").exists());
        assert!(user.join("SKILL.md").exists(), "user dir untouched");
        let seen = fetched.lock().unwrap();
        assert_eq!(seen.len(), 1, "only the desired entry is fetched");
        assert!(seen[0].contains("demo-skill"));
        assert_eq!(res["updated"], serde_json::json!(["demo-skill"]));
        assert_eq!(res["removed"], serde_json::json!(["old-skill"]));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The empty list is the converge frame: every Guild-managed dir goes,
    /// user dirs stay.
    #[tokio::test]
    async fn empty_payload_removes_managed_dirs_and_keeps_user_dirs() {
        let root = temp_root("empty");
        let managed = root.join(".agents/skills/pushed-skill");
        std::fs::create_dir_all(managed.join("agents")).unwrap();
        std::fs::write(managed.join("SKILL.md"), "x").unwrap();
        registry_client::write_sidecar(
            &managed,
            &SkillProvenance {
                source: "registry".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let user = root.join(".agents/skills/local-skill");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "mine").unwrap();
        let res = sync(
            &serde_json::json!({"skills": []}),
            |_url: String| async { Err::<Vec<u8>, String>("nothing to fetch".into()) },
            &root,
        )
        .await
        .unwrap();
        assert!(!managed.exists());
        assert!(user.exists());
        assert_eq!(res["updated"], serde_json::json!([]));
        assert_eq!(res["removed"], serde_json::json!(["pushed-skill"]));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hash mismatch rejects the entry (and leaves the old tree intact).
    #[tokio::test]
    async fn sha_mismatch_rejects_without_touching_the_installed_dir() {
        let root = temp_root("sha");
        let bytes = test_bundle("good");
        let old = root.join(".agents/skills/demo-skill");
        std::fs::create_dir_all(old.join("agents")).unwrap();
        std::fs::write(old.join("SKILL.md"), "old").unwrap();
        registry_client::write_sidecar(
            &old,
            &SkillProvenance {
                source: "registry".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let payload = serde_json::json!({"skills": [
            {"slug": "demo-skill", "version": "v2", "bundle_sha256": sha(b"other"), "url": "u"}
        ]});
        let res = sync(&payload, |_: String| async { Ok(bytes.clone()) }, &root).await;
        assert!(res.is_err(), "mismatched sha must fail");
        assert_eq!(
            std::fs::read_to_string(old.join("SKILL.md")).unwrap(),
            "old",
            "failed sync keeps the previous install"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hostile slug (path escape, mixed case, dots) never reaches the
    /// fetcher or the filesystem.
    #[tokio::test]
    async fn traversal_and_bad_slugs_are_rejected() {
        let root = temp_root("slug");
        for slug in ["../escape", "a/b", "UPPER", "a.b", "", "."] {
            let payload = serde_json::json!({"skills": [
                {"slug": slug, "version": "v1", "bundle_sha256": "0", "url": "u"}
            ]});
            let res = sync(&payload, |_: String| async { Ok(Vec::new()) }, &root).await;
            assert!(res.is_err(), "slug {slug:?} must be rejected");
        }
        assert!(!root.join(".agents/skills/escape").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
