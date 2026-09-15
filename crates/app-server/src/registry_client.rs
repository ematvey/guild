//! Registry client: publish and install over the cloud API (spec §4.4).

use crate::cloud::{CloudClient, CloudError};
use crate::skills::{SkillProvenance, SIDECAR_REL};
use guild_core::registry::{self, BundleManifest};
use sha2::{Digest, Sha256};
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
        slug: if slug.is_empty() { manifest.slug.clone() } else { slug },
        version: if version.is_empty() { manifest.version.clone() } else { version },
        published_by_me: true,
        review_status: "pending".into(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        bundle_hash: bundle_hash.into(),
        ..Default::default()
    };
    if let Err(e) = crate::skills::write_sidecar(source_dir, &p) {
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
) -> Result<crate::skills::SkillEntry, CloudError> {
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
    let manifest = registry::extract(&bytes, &dest)
        .map_err(|e| CloudError::Request(format!("extract failed: {e}")))?;
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
    crate::skills::write_sidecar(&dest, &provenance)
        .map_err(|e| CloudError::Request(format!("sidecar write failed: {e}")))?;
    Ok(crate::skills::SkillEntry {
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
        return Err(CloudError::Request(format!(
            "{} is not installed",
            slug
        )));
    }
    match crate::skills::read_sidecar(&dest) {
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
    std::fs::remove_dir_all(&dest)
        .map_err(|e| CloudError::Request(format!("remove failed: {e}")))
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
