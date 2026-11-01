//! Machine-side `skills.sync_v1`: converges the machine user's skill scope
//! (`~/.agents/skills`) to the server's desired install list (skills spec
//! §4). Every payload entry is downloaded, hash-verified, and extracted;
//! every skill dir NOT in the payload and carrying Guild's provenance
//! sidecar is removed — an empty list means "sync to nothing". Dirs without
//! the sidecar are user-created and never touched. Entries are isolated:
//! a failing one lands in the summary's `failed` list while the rest still
//! install and removals still run. The fs-heavy work (extract, swap,
//! removals) runs on the blocking thread pool.

use crate::cloud::CloudClient;
use crate::registry_client::{self, SkillProvenance};
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

/// Converges `<root>/.agents/skills` to the payload's install list and
/// returns the `{updated, removed, failed}` summary.
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
    let mut failed: Vec<serde_json::Value> = Vec::new();
    let mut desired: BTreeSet<String> = BTreeSet::new();
    // Per-entry isolation: one bad entry (bad slug, missing url/sha,
    // download, hash, extract, or swap failure) becomes an entry in
    // `failed` — the remaining entries still install and the removal phase
    // always runs, so converge never wedges on a single skill.
    for entry in skills {
        let slug = entry["slug"].as_str().unwrap_or("?");
        let outcome = install_entry(entry, slug, &fetch, &skills_dir).await;
        // A failed entry is still a desired slug: its last-known-good
        // install stays on disk and must not be swept by the removal phase.
        desired.insert(slug.to_string());
        match outcome {
            Ok(()) => updated.push(slug.to_string()),
            Err(error) => failed.push(serde_json::json!({ "slug": slug, "error": error })),
        }
    }
    // Converge: any remaining dir that is not in the desired list and
    // carries Guild's provenance sidecar was pushed by an earlier sync and
    // is removed. Dirs without the sidecar are user-created — never touched.
    // Runs even when entries failed above; failed removals land in `failed`.
    let desired_c = desired.clone();
    let removals = tokio::task::spawn_blocking(move || -> Vec<Result<String, (String, String)>> {
        let mut outcomes = Vec::new();
        let Ok(reader) = std::fs::read_dir(&skills_dir) else {
            return outcomes;
        };
        for entry in reader.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir || desired_c.contains(&name) || name.starts_with('.') {
                continue;
            }
            let dir = skills_dir.join(&name);
            if registry_client::read_sidecar(&dir).is_some() {
                match std::fs::remove_dir_all(&dir) {
                    Ok(()) => outcomes.push(Ok(name)),
                    Err(e) => outcomes.push(Err((name, e.to_string()))),
                }
            }
        }
        outcomes
    })
    .await
    .map_err(|e| format!("skill removal task failed: {e}"))?;
    for outcome in removals {
        match outcome {
            Ok(name) => removed.push(name),
            Err((name, error)) => failed.push(serde_json::json!({ "slug": name, "error": error })),
        }
    }
    Ok(serde_json::json!({ "updated": updated, "removed": removed, "failed": failed }))
}

/// Installs one payload entry: download, sha-verify, then
/// [`registry_client::install_bundle`]. A failure anywhere leaves the
/// previous install untouched.
async fn install_entry<F, Fut>(
    entry: &serde_json::Value,
    slug: &str,
    fetch: &F,
    skills_dir: &Path,
) -> Result<(), String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    if !registry_client::valid_slug(slug) {
        return Err(format!("invalid skill slug {slug:?}"));
    }
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
    let bytes = fetch(url)
        .await
        .map_err(|e| format!("{slug}: bundle download failed: {e}"))?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        return Err(format!(
            "{slug}: bundle sha256 mismatch (expected {expected}, got {actual})"
        ));
    }
    let provenance = SkillProvenance {
        source: "registry".into(),
        slug: slug.to_string(),
        version,
        publisher: entry["publisher"].as_str().unwrap_or_default().to_string(),
        published_at: entry["published_at"].as_str().unwrap_or_default().to_string(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        bundle_hash: format!("sha256:{actual}"),
        ..Default::default()
    };
    registry_client::install_bundle(bytes, skills_dir.join(slug), move |_| provenance)
        .await
        .map(|_| ())
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
    fn test_bundle(slug: &str, body: &str) -> Vec<u8> {
        let src = temp_root("src");
        std::fs::create_dir_all(src.join(slug)).unwrap();
        std::fs::write(
            src.join(slug).join("SKILL.md"),
            format!("---\nname: {slug}\ndescription: t\n---\n{body}"),
        )
        .unwrap();
        let (bytes, _) = pack_skill(&src.join(slug), "v2").unwrap();
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
        let bytes = test_bundle("demo-skill", "two");
        let fetched = Arc::new(Mutex::new(Vec::new()));
        let payload = serde_json::json!({"skills": [
            {"slug": "demo-skill", "version": "v2", "bundle_sha256": sha(&bytes),
             "publisher": "Dana Levi", "published_at": "2026-05-12T09:00:00Z",
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
        // The payload's provenance lands in the sidecar, so the agent can
        // name the publisher from the machine's own index.
        let sidecar = sidecar_of(&dir).unwrap();
        assert!(sidecar.contains("publisher: Dana Levi"), "{sidecar}");
        assert!(sidecar.contains("published_at: 2026-05-12T09:00:00Z"), "{sidecar}");
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

    /// A hash mismatch fails that one entry (and leaves the old tree
    /// intact) without failing the whole op.
    #[tokio::test]
    async fn sha_mismatch_fails_the_entry_without_touching_the_installed_dir() {
        let root = temp_root("sha");
        let bytes = test_bundle("demo-skill", "good");
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
        let res = sync(&payload, |_: String| async { Ok(bytes.clone()) }, &root)
            .await
            .unwrap();
        let failed = res["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1, "the bad entry is isolated: {res}");
        assert_eq!(failed[0]["slug"], "demo-skill");
        assert!(failed[0]["error"]
            .as_str()
            .is_some_and(|e| e.contains("sha256 mismatch")));
        assert_eq!(
            std::fs::read_to_string(old.join("SKILL.md")).unwrap(),
            "old",
            "failed entry keeps the previous install"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// One bad entry never wedges converge: the good entries still install,
    /// absent slugs still get removed, and the failed list names the bad
    /// entry instead of failing the whole op.
    #[tokio::test]
    async fn one_bad_entry_does_not_block_good_installs_or_removals() {
        let root = temp_root("isolate");
        let good_bytes = test_bundle("good-skill", "fresh");
        // A previously synced skill no longer in the payload must be removed
        // even though another entry fails...
        let gone = root.join(".agents/skills/gone-skill");
        std::fs::create_dir_all(gone.join("agents")).unwrap();
        std::fs::write(gone.join("SKILL.md"), "gone").unwrap();
        registry_client::write_sidecar(
            &gone,
            &SkillProvenance {
                source: "registry".into(),
                slug: "gone-skill".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // ...and a user dir without a sidecar must survive the failed entry.
        let user = root.join(".agents/skills/user-skill");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "mine").unwrap();
        let payload = serde_json::json!({"skills": [
            {"slug": "good-skill", "version": "v2", "bundle_sha256": sha(&good_bytes), "url": "u-good"},
            {"slug": "bad-skill", "version": "v1", "bundle_sha256": sha(b"corrupt"), "url": "u-bad"}
        ]});
        let res = sync(
            &payload,
            |_: String| async { Ok(good_bytes.clone()) },
            &root,
        )
        .await
        .unwrap();
        assert_eq!(res["updated"], serde_json::json!(["good-skill"]));
        assert_eq!(res["removed"], serde_json::json!(["gone-skill"]));
        let failed = res["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1, "only the bad entry fails: {res}");
        assert_eq!(failed[0]["slug"], "bad-skill");
        assert!(failed[0]["error"]
            .as_str()
            .is_some_and(|e| e.contains("sha256 mismatch")));
        assert_eq!(
            std::fs::read_to_string(root.join(".agents/skills/good-skill/SKILL.md")).unwrap(),
            "---\nname: good-skill\ndescription: t\n---\nfresh"
        );
        assert!(
            !gone.exists(),
            "removal phase runs despite the failed entry"
        );
        assert!(user.join("SKILL.md").exists(), "user dir untouched");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hostile slug (path escape, mixed case, dots) never reaches the
    /// fetcher or the filesystem — it becomes an isolated failed entry.
    #[tokio::test]
    async fn traversal_and_bad_slugs_are_isolated_failures() {
        let root = temp_root("slug");
        for slug in ["../escape", "a/b", "UPPER", "a.b", "", "."] {
            let payload = serde_json::json!({"skills": [
                {"slug": slug, "version": "v1", "bundle_sha256": "0", "url": "u"}
            ]});
            let res = sync(
                &payload,
                |_: String| async { Err::<Vec<u8>, String>("fetcher must not be called".into()) },
                &root,
            )
            .await
            .unwrap();
            let failed = res["failed"].as_array().unwrap();
            assert_eq!(failed.len(), 1, "slug {slug:?} must fail its entry");
            assert_eq!(failed[0]["slug"], slug);
            assert_eq!(res["updated"], serde_json::json!([]));
        }
        assert!(!root.join(".agents/skills/escape").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
