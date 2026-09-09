//! Registry client: publish and install over the cloud API (spec §4.4).

use crate::cloud::{CloudClient, CloudError};
use guild_core::registry::{self, BundleManifest};
use std::path::Path;

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
        };
        let bytes = registry::pack(source_dir, &manifest)
            .map_err(|e| CloudError::Request(format!("pack failed: {e}")))?;
        (bytes, manifest)
    };
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
    Ok(PublishResult {
        slug: v["slug"].as_str().unwrap_or("").into(),
        version: v["version"].as_str().unwrap_or("").into(),
    })
}

/// Installs the latest approved version (or a pinned one) of a skill into
/// `{project}/.guild/skills/{slug}/`.
pub async fn install_skill(
    cloud: &CloudClient,
    project_dir: &Path,
    slug: &str,
    version: Option<&str>,
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
    let dest = project_dir.join(".guild").join("skills").join(slug);
    let manifest = registry::extract(&bytes, &dest)
        .map_err(|e| CloudError::Request(format!("extract failed: {e}")))?;
    Ok(crate::skills::SkillEntry {
        name: manifest.slug,
        description: manifest.description,
        path: dest.join("SKILL.md"),
    })
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
