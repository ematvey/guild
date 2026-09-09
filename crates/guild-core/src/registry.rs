//! Registry bundles: tar.gz with a `manifest.json` at the root. Guild
//! metadata lives only here — SKILL.md stays in the ecosystem's format
//! (spec §4.4).

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BundleManifest {
    /// skill | mcp | integration
    pub kind: String,
    pub slug: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

/// Validates a manifest's shape and allowed kinds.
pub fn validate_manifest(m: &BundleManifest) -> anyhow::Result<()> {
    anyhow::ensure!(!m.slug.is_empty(), "manifest slug is empty");
    anyhow::ensure!(!m.version.is_empty(), "manifest version is empty");
    anyhow::ensure!(
        matches!(m.kind.as_str(), "skill" | "mcp" | "integration"),
        "manifest kind must be skill, mcp, or integration"
    );
    Ok(())
}

/// Parses `name:` and `description:` from YAML-ish frontmatter between `---`
/// fences. Tolerant: missing fields fall back to `fallback_name`.
pub fn parse_frontmatter(body: &str, fallback_name: &str) -> (String, String) {
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    if let Some(rest) = body.strip_prefix("---") {
        let front = rest.split("---").next().unwrap_or("");
        for line in front.lines() {
            if let Some(v) = line.strip_prefix("name:") {
                name = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("description:") {
                description = v.trim().trim_matches('"').to_string();
            }
        }
    }
    (name, description)
}

/// Packs `source_dir` into a tar.gz: `manifest.json` first, then every file
/// (sorted, relative paths). `manifest.json` inside the dir is ignored —
/// the passed manifest is authoritative.
pub fn pack(source_dir: &Path, manifest: &BundleManifest) -> anyhow::Result<Vec<u8>> {
    validate_manifest(manifest)?;
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);

    let manifest_json = serde_json::to_vec_pretty(manifest)?;
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_json.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "manifest.json", manifest_json.as_slice())
        .context("append manifest.json")?;

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_files(source_dir, &mut files)?;
    files.sort();
    for path in files {
        let rel = path.strip_prefix(source_dir).expect("relative");
        let rel = rel.to_str().context("non-utf8 file path in bundle")?;
        if rel == "manifest.json" {
            continue;
        }
        tar.append_path_with_name(&path, rel)
            .with_context(|| format!("append {rel}"))?;
    }
    Ok(tar.into_inner()?.finish()?)
}

/// Convenience: pack a skill directory (requires SKILL.md; slug = dir name,
/// description from frontmatter).
pub fn pack_skill(skill_dir: &Path, version: &str) -> anyhow::Result<(Vec<u8>, BundleManifest)> {
    let skill_md_path = skill_dir.join("SKILL.md");
    anyhow::ensure!(
        skill_md_path.is_file(),
        "no SKILL.md in {}",
        skill_dir.display()
    );
    let body = std::fs::read_to_string(&skill_md_path)?;
    let slug = skill_dir
        .file_name()
        .context("skill dir has no name")?
        .to_string_lossy()
        .into_owned();
    let (name, description) = parse_frontmatter(&body, &slug);
    let manifest = BundleManifest {
        kind: "skill".into(),
        slug: name,
        version: version.into(),
        description,
        dependencies: vec![],
    };
    let bytes = pack(skill_dir, &manifest)?;
    Ok((bytes, manifest))
}

fn collect_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

/// Extracts a bundle into `dest` (created if needed). Rejects path traversal
/// (no `..`, no absolute entries) and returns the manifest.
pub fn extract(bundle: &[u8], dest: &Path) -> anyhow::Result<BundleManifest> {
    std::fs::create_dir_all(dest)?;
    let gz = flate2::read::GzDecoder::new(bundle);
    let mut tar = tar::Archive::new(gz);
    let mut manifest: Option<BundleManifest> = None;
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_path_buf();
        anyhow::ensure!(
            !path.is_absolute(),
            "bundle entry is absolute: {}",
            path.display()
        );
        anyhow::ensure!(
            !path
                .components()
                .any(|c| c == std::path::Component::ParentDir),
            "bundle entry escapes the destination: {}",
            path.display()
        );
        let header_type = entry.header().entry_type();
        anyhow::ensure!(
            header_type.is_file() || header_type.is_dir(),
            "bundle entry is a special file: {}",
            path.display()
        );
        if path == std::path::Path::new("manifest.json") {
            let mut body = String::new();
            entry.read_to_string(&mut body)?;
            manifest = Some(serde_json::from_str(&body).context("bundle manifest.json invalid")?);
            continue;
        }
        if header_type.is_dir() {
            std::fs::create_dir_all(dest.join(&path))?;
            continue;
        }
        if let Some(parent) = dest.join(&path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(dest.join(&path))?;
    }
    manifest.context("bundle has no manifest.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write as _;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("guild-reg-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pack_extract_roundtrip() {
        let dir = scratch("pack");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: demo\ndescription: a demo skill\n---\nbody",
        )
        .unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/logo.txt"), "logo").unwrap();

        let manifest = BundleManifest {
            kind: "skill".into(),
            slug: "demo".into(),
            version: "1.2.3".into(),
            description: "a demo skill".into(),
            dependencies: vec![],
        };
        let bytes = pack(&dir, &manifest).unwrap();
        let dest = scratch("extract");
        let got = extract(&bytes, &dest).unwrap();
        assert_eq!(got, manifest);
        assert_eq!(
            fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            "---\nname: demo\ndescription: a demo skill\n---\nbody"
        );
        assert_eq!(
            fs::read_to_string(dest.join("assets/logo.txt")).unwrap(),
            "logo"
        );
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&dest).unwrap();
    }

    #[test]
    fn pack_skill_uses_frontmatter() {
        let dir = scratch("packskill");
        fs::create_dir_all(dir.join("deploy-check")).unwrap();
        fs::write(
            dir.join("deploy-check/SKILL.md"),
            "---\nname: deploy-check\ndescription: verify deploys\n---\nsteps",
        )
        .unwrap();
        let (bytes, m) = pack_skill(&dir.join("deploy-check"), "0.1.0").unwrap();
        assert_eq!(m.slug, "deploy-check");
        assert_eq!(m.description, "verify deploys");
        assert_eq!(m.kind, "skill");
        let dest = scratch("packskill-x");
        let got = extract(&bytes, &dest).unwrap();
        assert_eq!(got.slug, "deploy-check");
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&dest).unwrap();
    }

    #[test]
    fn pack_skill_requires_skill_md() {
        let dir = scratch("noskill");
        fs::create_dir_all(dir.join("empty")).unwrap();
        assert!(pack_skill(&dir.join("empty"), "1.0.0").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extract_rejects_traversal() {
        // hand-assemble a raw tar header with a `..` entry (the tar crate
        // refuses to *build* such archives, so build the bytes directly)
        let make_entry = |name: &str, data: &[u8]| -> Vec<u8> {
            let mut h = [0u8; 512];
            h[..name.len()].copy_from_slice(name.as_bytes());
            h[100..108].copy_from_slice(b"0000644\0");
            h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
            h[136..148].copy_from_slice(b"00000000000\0");
            h[156] = b'0'; // regular file
            h[257..263].copy_from_slice(b"ustar\0");
            h[263..265].copy_from_slice(b"00");
            let sum: u32 = h.iter().map(|b| *b as u32).sum();
            let chk = format!("{:06o}\0 ", sum);
            h[148..156].copy_from_slice(chk.as_bytes());
            let mut block = h.to_vec();
            block.extend_from_slice(data);
            let pad = (512 - data.len() % 512) % 512;
            block.extend(std::iter::repeat_n(0u8, pad));
            block
        };
        let mut raw = make_entry("../evil.txt", b"evil");
        raw.extend(std::iter::repeat_n(0u8, 1024)); // end blocks
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&raw).unwrap();
        let bytes = enc.finish().unwrap();
        let dest = scratch("traversal");
        assert!(extract(&bytes, &dest).is_err());
        assert!(!dest.join("evil.txt").exists());
        fs::remove_dir_all(&dest).unwrap();
    }
}
