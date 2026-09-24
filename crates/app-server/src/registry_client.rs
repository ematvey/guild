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
    // Extract into a sibling temp dir and swap only after a clean extract:
    // extracting in place would leave the previous version's files behind
    // (and a partial failure a mixed tree) when the new bundle drops files.
    let parent = dest
        .parent()
        .ok_or_else(|| CloudError::Request("skill dir has no parent".into()))?;
    let staging = parent.join(format!(
        ".{}-update-{}",
        slug,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&staging);
    let manifest = registry::extract(&bytes, &staging)
        .map_err(|e| CloudError::Request(format!("extract failed: {e}")))?;
    let previous = parent.join(format!(".{}-previous", slug));
    let _ = std::fs::remove_dir_all(&previous);
    let moved_old = dest.exists();
    if moved_old {
        std::fs::rename(&dest, &previous)
            .map_err(|e| CloudError::Request(format!("swap failed: {e}")))?;
    }
    if let Err(e) = std::fs::rename(&staging, &dest) {
        if moved_old {
            let _ = std::fs::rename(&previous, &dest);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(CloudError::Request(format!("swap failed: {e}")));
    }
    let _ = std::fs::remove_dir_all(&previous);
    let provenance = SkillProvenance {
        source: "registry".into(),
        slug: manifest.slug.clone(),
        version: manifest.version.clone(),
        review_status: "approved".into(),
        publisher: publisher.into(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        bundle_hash: format!("sha256:{}", hex::encode(Sha256::digest(&bytes))),
        ..Default::default()
    };
    crate::registry_client::write_sidecar(&dest, &provenance)
        .map_err(|e| CloudError::Request(format!("sidecar write failed: {e}")))?;
    Ok(crate::registry_client::SkillEntry {
        name: manifest.slug,
        description: manifest.description,
        path: dest.join("SKILL.md"),
    })
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
        "source: {}\nslug: {}\nversion: {}\npublisher: {}\npublished_by_me: {}\nreview_status: {}\ninstalled_at: {}\nbundle_hash: {}\n",
        p.source, p.slug, p.version, p.publisher, p.published_by_me, p.review_status, p.installed_at, p.bundle_hash,
    );
    std::fs::write(path, body)?;
    Ok(())
}

/// Reads the sidecar; `None` when absent or unparsable (a dir without a
/// sidecar is a plain skill folder — never Guild-managed).
pub fn read_sidecar(dir: &Path) -> Option<SkillProvenance> {
    let body = std::fs::read_to_string(dir.join(SIDECAR_REL)).ok()?;
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for line in body.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        map.insert(k.trim().to_string(), v.trim().to_string());
    }
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    Some(SkillProvenance {
        source: get("source"),
        slug: get("slug"),
        version: get("version"),
        publisher: get("publisher"),
        published_by_me: get("published_by_me") == "true",
        review_status: get("review_status"),
        installed_at: get("installed_at"),
        bundle_hash: get("bundle_hash"),
    })
}

// ---------- /name explicit invocation ----------
