//! Registry client: publish and install over the cloud API (spec §4.4).

use crate::cloud::{CloudClient, CloudError};
use anyhow::Context as _;
use guild_core::registry::{self, BundleManifest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct PublishResult {
    pub slug: String,
    pub version: String,
}

/// Packs `source_dir` and publishes it to the org registry.
/// kind=skill requires SKILL.md; kind=mcp|integration packs the dir as-is
/// with a synthesized manifest.
pub async fn publish(
    cloud: &CloudClient,
    kind: &str,
    source_dir: &Path,
    version: &str,
) -> Result<PublishResult, CloudError> {
    let slug = source_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| CloudError::Request("source dir has no name".into()))?;
    let (bytes, manifest) = if kind == "skill" {
        registry::pack_skill(source_dir, version)
            .map_err(|e| CloudError::Request(format!("pack failed: {e}")))?
    } else {
        let manifest = BundleManifest {
            kind: kind.into(),
            slug: slug.clone(),
            version: version.into(),
            description: String::new(),
            dependencies: vec![],
            ..Default::default()
        };
        let bytes = registry::pack(source_dir, &manifest)
            .map_err(|e| CloudError::Request(format!("pack failed: {e}")))?;
        (bytes, manifest)
    };
    let bundle_hash = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    let url = format!(
        "{}/api/v1/registry/{kind}?slug={}&version={}",
        cloud.base_url.trim_end_matches('/'),
        urlencode(&manifest.slug),
        urlencode(&manifest.version),
    );
    let resp = cloud
        .http_pub()
        .post(&url)
        .bearer_auth(&cloud.token)
        .header("content-type", "application/gzip")
        .body(bytes)
        .send()
        .await?;
    let resp = CloudClient::check(resp).await?;
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Request(e.to_string()))?;
    if kind == "skill" {
        stamp_publish_sidecar(
            source_dir,
            &manifest,
            &bundle_hash,
            v["slug"].as_str().unwrap_or("").to_string(),
            v["version"].as_str().unwrap_or("").to_string(),
        );
    }
    Ok(PublishResult {
        slug: v["slug"].as_str().unwrap_or("").into(),
        version: v["version"].as_str().unwrap_or("").into(),
    })
}

/// Writes the provenance sidecar after a successful skill publish so the
/// source dir is linked to its registry identity (skills design §5).
fn stamp_publish_sidecar(
    source_dir: &Path,
    manifest: &BundleManifest,
    bundle_hash: &str,
    slug: String,
    version: String,
) {
    let p = SkillProvenance {
        source: "registry".into(),
        slug: if slug.is_empty() {
            manifest.slug.clone()
        } else {
            slug
        },
        version: if version.is_empty() {
            manifest.version.clone()
        } else {
            version
        },
        published_by_me: true,
        review_status: "pending".into(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        published_at: chrono::Utc::now().to_rfc3339(),
        bundle_hash: bundle_hash.into(),
        ..Default::default()
    };
    if let Err(e) = crate::registry_client::write_sidecar(source_dir, &p) {
        eprintln!("[guild] failed to write {SIDECAR_REL}: {e}");
    }
}

/// Installs the latest approved version (or a pinned one) of a skill into
/// the shared `.agents/skills/{slug}/` dir — repo scope by default, the
/// user's home scope with `global = true` (skills design §4). Writes the
/// provenance sidecar from the bundle manifest.
pub async fn install_skill(
    cloud: &CloudClient,
    project_dir: &Path,
    slug: &str,
    version: Option<&str>,
    global: bool,
    publisher: &str,
) -> Result<crate::registry_client::SkillEntry, CloudError> {
    if !valid_slug(slug) {
        return Err(CloudError::Request(format!("invalid skill slug {slug:?}")));
    }
    let base = cloud.base_url.trim_end_matches('/');
    let version = match version {
        Some(v) => v.to_string(),
        None => {
            // resolve latest approved
            let resp = cloud
                .http_pub()
                .get(format!("{base}/api/v1/registry/skill"))
                .bearer_auth(&cloud.token)
                .send()
                .await?;
            let resp = CloudClient::check(resp).await?;
            let v: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| CloudError::Request(e.to_string()))?;
            let items = v["items"]
                .as_array()
                .ok_or_else(|| CloudError::Request("bad items response".into()))?;
            let item = items
                .iter()
                .find(|i| i["slug"].as_str() == Some(slug))
                .ok_or_else(|| CloudError::Request(format!("no such registry item: {slug}")))?;
            if item["review_status"].as_str() != Some("approved") {
                return Err(CloudError::Request(format!("{slug} is not approved yet")));
            }
            item["latest_version"]
                .as_str()
                .ok_or_else(|| CloudError::Request("item has no versions".into()))?
                .to_string()
        }
    };
    let url = format!(
        "{base}/api/v1/registry/skill/{}/{version}/bundle",
        urlencode(slug)
    );
    let resp = cloud
        .http_pub()
        .get(&url)
        .bearer_auth(&cloud.token)
        .send()
        .await?;
    let resp = CloudClient::check(resp).await?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CloudError::Request(e.to_string()))?;
    let dest: PathBuf = if global {
        let home = dirs::home_dir().ok_or_else(|| CloudError::Request("no home dir".into()))?;
        home.join(".agents").join("skills").join(slug)
    } else {
        project_dir.join(".agents").join("skills").join(slug)
    };
    let bundle_hash = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    let publisher = publisher.to_string();
    let manifest = install_bundle(bytes.to_vec(), dest.clone(), move |manifest| {
        SkillProvenance {
            source: "registry".into(),
            slug: manifest.slug.clone(),
            version: manifest.version.clone(),
            review_status: "approved".into(),
            publisher,
            installed_at: chrono::Utc::now().to_rfc3339(),
            bundle_hash,
            ..Default::default()
        }
    })
    .await
    .map_err(CloudError::Request)?;
    Ok(crate::registry_client::SkillEntry {
        name: manifest.slug,
        description: manifest.description,
        path: dest.join("SKILL.md"),
    })
}

/// Slug charset for skill dirs: lowercase alphanumerics, `-`, `_` (the
/// registry manifest charset) — a path-escape slug never reaches the
/// filesystem.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 128
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Installs one skill bundle as `dest` (`<skills dir>/<slug>`), on the
/// blocking pool: extract into a staging sibling, write the provenance
/// sidecar (built from the bundle manifest) into staging, move the
/// previous install aside, rename staging into place, and drop the
/// previous install. Any failure removes staging and restores the previous
/// install, so the dir is never torn down or a mixed old/new tree, and an
/// installed dir always carries provenance. Returns the bundle manifest.
pub async fn install_bundle(
    bytes: Vec<u8>,
    dest: PathBuf,
    provenance: impl FnOnce(&BundleManifest) -> SkillProvenance + Send + 'static,
) -> Result<BundleManifest, String> {
    let slug = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !valid_slug(&slug) {
        return Err(format!("invalid skill slug {slug:?}"));
    }
    tokio::task::spawn_blocking(move || {
        let parent = dest.parent().ok_or("skill dir has no parent")?;
        std::fs::create_dir_all(parent).map_err(|e| format!("{slug}: {e}"))?;
        let nonce = uuid::Uuid::now_v7().simple();
        let staging = parent.join(format!(".{slug}-staging-{nonce}"));
        let previous = parent.join(format!(".{slug}-previous-{nonce}"));
        let staged = registry::extract(&bytes, &staging)
            .map_err(|e| format!("{slug}: extract failed: {e}"))
            .and_then(|manifest| {
                write_sidecar(&staging, &provenance(&manifest))
                    .map_err(|e| format!("{slug}: sidecar write failed: {e}"))?;
                Ok(manifest)
            });
        let manifest = match staged {
            Ok(manifest) => manifest,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e);
            }
        };
        let moved_old = dest.exists();
        if moved_old {
            if let Err(e) = std::fs::rename(&dest, &previous) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(format!("{slug}: replacing the old install failed: {e}"));
            }
        }
        if let Err(e) = std::fs::rename(&staging, &dest) {
            if moved_old {
                let _ = std::fs::rename(&previous, &dest);
            }
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("{slug}: install failed: {e}"));
        }
        let _ = std::fs::remove_dir_all(&previous);
        Ok(manifest)
    })
    .await
    .map_err(|e| format!("skill install task failed: {e}"))?
}

/// Removes a previously installed skill dir. Only dirs whose provenance
/// sidecar says `source: registry` may be removed — Guild never deletes
/// plain skill folders it did not install (they may be codex/pi-authored).
pub fn uninstall_skill(project_dir: &Path, slug: &str, global: bool) -> Result<(), CloudError> {
    let dest: PathBuf = if global {
        let home = dirs::home_dir().ok_or_else(|| CloudError::Request("no home dir".into()))?;
        home.join(".agents").join("skills").join(slug)
    } else {
        project_dir.join(".agents").join("skills").join(slug)
    };
    if !dest.is_dir() {
        return Err(CloudError::Request(format!("{} is not installed", slug)));
    }
    match crate::registry_client::read_sidecar(&dest) {
        Some(p) if p.source == "registry" => {}
        Some(p) => {
            return Err(CloudError::Request(format!(
                "refusing to uninstall {slug}: provenance is '{}'",
                p.source
            )))
        }
        None => {
            return Err(CloudError::Request(format!(
                "refusing to uninstall {slug}: no {SIDECAR_REL} — not installed by Guild"
            )))
        }
    }
    std::fs::remove_dir_all(&dest).map_err(|e| CloudError::Request(format!("remove failed: {e}")))
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ---------- provenance sidecar + skill entries (registry-owned; discovery lives client-side — spec 2026-09-18 unification §3) ----------

#[derive(Debug, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// Directory holding SKILL.md (the agent reads it with read_file).
    pub path: PathBuf,
}

pub fn parse_frontmatter(body: &str, fallback_name: &str) -> (String, String) {
    guild_core::registry::parse_frontmatter(body, fallback_name)
}

/// Provenance for one installed/published skill dir. Guild metadata never
/// enters SKILL.md; this rides beside it where other harnesses ignore it.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SkillProvenance {
    /// registry | local
    pub source: String,
    pub slug: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    /// When the publisher pushed this version (RFC 3339); empty when the
    /// server did not send it.
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub published_by_me: bool,
    #[serde(default)]
    pub review_status: String,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub bundle_hash: String,
}

/// Sidecar path relative to the skill dir (single source of truth in
/// guild-core, which is what `pack` excludes).
pub use guild_core::registry::SIDECAR_REL;

/// Writes the flat sidecar as `key: value` YAML (all fields are plain
/// scalars; no nesting, no quoting needed).
pub fn write_sidecar(dir: &Path, p: &SkillProvenance) -> anyhow::Result<()> {
    let path = dir.join(SIDECAR_REL);
    std::fs::create_dir_all(path.parent().context("no sidecar parent")?)?;
    let body = format!(
        "source: {}\nslug: {}\nversion: {}\npublisher: {}\npublished_at: {}\npublished_by_me: {}\nreview_status: {}\ninstalled_at: {}\nbundle_hash: {}\n",
        p.source,
        p.slug,
        p.version,
        p.publisher,
        p.published_at,
        p.published_by_me,
        p.review_status,
        p.installed_at,
        p.bundle_hash,
    );
    std::fs::write(path, body)?;
    Ok(())
}

/// Reads the sidecar; `None` when absent or unparsable (a dir without a
/// sidecar is a plain skill folder — never Guild-managed).
pub fn read_sidecar(dir: &Path) -> Option<SkillProvenance> {
    Some(parse_sidecar(
        &std::fs::read_to_string(dir.join(SIDECAR_REL)).ok()?,
    ))
}

/// Parses sidecar text (the flat `key: value` YAML write_sidecar emits).
/// Unknown keys are ignored and missing keys default, so a sidecar from an
/// older or newer machine still reads.
pub fn parse_sidecar(body: &str) -> SkillProvenance {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for line in body.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        map.insert(k.trim().to_string(), v.trim().to_string());
    }
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    SkillProvenance {
        source: get("source"),
        slug: get("slug"),
        version: get("version"),
        publisher: get("publisher"),
        published_at: get("published_at"),
        published_by_me: get("published_by_me") == "true",
        review_status: get("review_status"),
        installed_at: get("installed_at"),
        bundle_hash: get("bundle_hash"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(dir: &Path, slug: &str, body: &str) -> Vec<u8> {
        let src = dir.join("src").join(slug);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("SKILL.md"),
            format!("---\nname: {slug}\ndescription: t\n---\n{body}"),
        )
        .unwrap();
        registry::pack_skill(&src, "v1").unwrap().0
    }

    /// A good bundle replaces the install whole (sidecar included); a
    /// corrupt bundle or a path-escape slug leaves the previous install
    /// and no staging debris behind.
    #[tokio::test]
    async fn install_bundle_swaps_whole_and_rolls_back_on_failure() {
        let dir = std::env::temp_dir().join(format!("guild-install-{}", uuid::Uuid::now_v7()));
        let skills = dir.join("skills");
        let dest = skills.join("demo");
        let prov = |_: &BundleManifest| SkillProvenance {
            source: "registry".into(),
            slug: "demo".into(),
            ..Default::default()
        };
        install_bundle(bundle(&dir, "demo", "ONE"), dest.clone(), prov)
            .await
            .unwrap();
        install_bundle(bundle(&dir, "demo", "TWO"), dest.clone(), prov)
            .await
            .unwrap();
        assert!(std::fs::read_to_string(dest.join("SKILL.md"))
            .unwrap()
            .contains("TWO"));
        assert!(read_sidecar(&dest).is_some());

        let err = install_bundle(b"not a bundle".to_vec(), dest.clone(), prov)
            .await
            .unwrap_err();
        assert!(err.contains("extract failed"), "{err}");
        assert!(std::fs::read_to_string(dest.join("SKILL.md"))
            .unwrap()
            .contains("TWO"));
        let debris: Vec<_> = std::fs::read_dir(&skills)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n != "demo")
            .collect();
        assert!(debris.is_empty(), "{debris:?}");

        let escape = install_bundle(bundle(&dir, "x", "X"), skills.join(".."), prov).await;
        assert!(escape.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
