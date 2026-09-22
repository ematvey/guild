//! Registry bundles: tar.gz with a `manifest.json` at the root. Guild
//! metadata lives only here — SKILL.md stays in the ecosystem's format
//! (spec §4.4).

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct BundleManifest {
    /// skill | mcp | integration
    pub kind: String,
    pub slug: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    /// v2 integration fields — absent for v1 automation bundles.
    #[serde(default)]
    pub mcp: Option<McpManifest>,
    #[serde(default)]
    pub auth: Option<AuthManifest>,
    #[serde(default)]
    pub settings: Option<SettingsManifest>,
    #[serde(default)]
    pub tools: Option<ToolsManifest>,
    #[serde(default)]
    pub triggers: Vec<TriggerSpec>,
    #[serde(default)]
    pub skills: Vec<String>,
}

/// Streamable-HTTP MCP endpoint implementing the plugin contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct McpManifest {
    pub url: String,
}

/// One admin-facing configuration field. The integration settings UI is
/// rendered from these — the manifest is the schema, the admin UI is
/// generated, nothing is hardcoded per connector.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldSpec {
    pub name: String,
    /// string | text | number | boolean | secret
    pub kind: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub help: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
}

/// Typed settings schema for an integration: its configuration fields —
/// plain settings and credential (`secret`) fields alike. Credentials are
/// stored encrypted and rendered masked; a manifest declares them exactly
/// once, there is no free-form secret add.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SettingsManifest {
    #[serde(default)]
    pub fields: Vec<FieldSpec>,
}

pub const FIELD_KINDS: [&str; 5] = ["string", "text", "number", "boolean", "secret"];

impl SettingsManifest {
    /// The credential field names: fields of kind `secret`.
    pub fn secret_names(&self) -> Vec<String> {
        self.fields
            .iter()
            .filter(|f| f.kind == "secret")
            .map(|f| f.name.clone())
            .collect()
    }
}

/// Auth shape: one org-wide secret, an impersonated org credential, or a
/// per-member OAuth token cached by Guild.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthManifest {
    #[serde(default = "default_auth_kind")]
    pub kind: String,
    #[serde(default)]
    pub secret_names: Vec<String>,
    #[serde(default = "default_identity_key")]
    pub identity_key: String,
}

impl Default for AuthManifest {
    fn default() -> Self {
        Self {
            kind: default_auth_kind(),
            secret_names: vec![],
            identity_key: default_identity_key(),
        }
    }
}

fn default_auth_kind() -> String {
    "org_secret".into()
}

fn default_identity_key() -> String {
    "email".into()
}

/// Per-tool class declaration from the connector: read (default), write,
/// admin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ToolsManifest {
    #[serde(default)]
    pub classes: std::collections::BTreeMap<String, String>,
}

/// v1-compatible trigger descriptor (same shape as routine.json entries).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TriggerSpec {
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub trigger_config: serde_json::Value,
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
}

const TOOL_CLASSES: [&str; 3] = ["read", "write", "admin"];
const AUTH_KINDS: [&str; 3] = ["org_secret", "org_secret_impersonated", "per_user_token"];

/// Validates a manifest's shape and allowed kinds.
pub fn validate_manifest(m: &BundleManifest) -> anyhow::Result<()> {
    // Slugs land in namespaced tool names and filesystem paths: keep them to
    // lowercase letters, digits and dashes.
    anyhow::ensure!(!m.slug.is_empty(), "manifest slug is empty");
    anyhow::ensure!(m.slug.len() <= 64, "manifest slug is too long");
    anyhow::ensure!(
        m.slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
        "manifest slug must be [a-z0-9_-]"
    );
    anyhow::ensure!(!m.version.is_empty(), "manifest version is empty");
    anyhow::ensure!(
        matches!(m.kind.as_str(), "skill" | "mcp" | "integration"),
        "manifest kind must be skill, mcp, or integration"
    );
    Ok(())
}

/// Validates v2 integration manifest fields (mcp url, auth shape, tool
/// classes and namespaced-name length, trigger shape). v1 manifests with no
/// v2 fields pass unchanged.
pub fn validate_v2(m: &BundleManifest) -> anyhow::Result<()> {
    validate_manifest(m)?;
    if let Some(mcp) = &m.mcp {
        anyhow::ensure!(
            mcp.url.starts_with("http://") || mcp.url.starts_with("https://"),
            "mcp.url must be an absolute http(s) URL"
        );
    }
    if let Some(auth) = &m.auth {
        anyhow::ensure!(
            AUTH_KINDS.contains(&auth.kind.as_str()),
            "auth.kind must be org_secret, org_secret_impersonated, or per_user_token"
        );
        anyhow::ensure!(
            auth.identity_key == "email" || auth.identity_key.is_empty(),
            "auth.identity_key supports only email in v1"
        );
    }
    if let Some(settings) = &m.settings {
        let mut seen = std::collections::BTreeSet::new();
        for f in &settings.fields {
            anyhow::ensure!(!f.name.is_empty(), "settings field name is empty");
            anyhow::ensure!(
                f.name.len() <= 64
                    && f.name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "settings field name {f:?} must be [a-z0-9_] and <= 64 chars"
            );
            anyhow::ensure!(
                FIELD_KINDS.contains(&f.kind.as_str()),
                "settings field {f:?} kind must be one of {FIELD_KINDS:?}"
            );
            anyhow::ensure!(
                seen.insert(f.name.clone()),
                "duplicate settings field {f:?}"
            );
            // The generated form treats `default` per the field kind, so the
            // JSON value must match: string for string/text, number for
            // number, boolean for boolean. Missing and null stay allowed.
            let default_ok = f.default.as_ref().map_or(true, |d| {
                d.is_null()
                    || match f.kind.as_str() {
                        "number" => d.is_number(),
                        "boolean" => d.is_boolean(),
                        _ => d.is_string(),
                    }
            });
            anyhow::ensure!(
                default_ok,
                "settings field {f:?} kind {} needs a default of the same JSON type",
                f.kind
            );
        }
    }
    if let Some(tools) = &m.tools {
        for (name, class) in &tools.classes {
            anyhow::ensure!(
                TOOL_CLASSES.contains(&class.as_str()),
                "tool class for {name} must be read, write, or admin"
            );
            anyhow::ensure!(
                name.len() <= 64 - m.slug.len() - 1,
                "tool name {name} too long for namespacing under {}",
                m.slug
            );
        }
    }
    for t in &m.triggers {
        anyhow::ensure!(
            matches!(t.kind.as_str(), "webhook" | "interval"),
            "trigger kind must be webhook or interval"
        );
        anyhow::ensure!(!t.prompt.is_empty(), "trigger prompt is empty");
        anyhow::ensure!(!t.model.is_empty(), "trigger model is empty");
    }
    Ok(())
}

/// Effective manifest class for one tool: write, admin, or read (default for
/// undeclared tools).
pub fn tool_class(m: &BundleManifest, tool: &str) -> &'static str {
    m.tools
        .as_ref()
        .and_then(|t| {
            t.classes.get(tool).map(|c| match c.as_str() {
                "write" => "write",
                "admin" => "admin",
                _ => "read",
            })
        })
        .unwrap_or("read")
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
        ..Default::default()
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

/// Reads one file from a packed bundle without touching the filesystem.
/// Returns None when the bundle has no such entry. The matched entry is
/// bounded: a header-declared size past the cap (or a read that runs past
/// it) is rejected before the content is buffered.
pub fn read_bundle_file(bundle: &[u8], path: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let gz = flate2::read::GzDecoder::new(bundle);
    let mut tar = tar::Archive::new(gz);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let entry_path = entry.path()?.to_path_buf();
        if entry_path == std::path::Path::new(path) {
            anyhow::ensure!(
                entry.size() <= MAX_BUNDLE_FILE,
                "bundle entry '{}' exceeds the {}-byte read cap",
                path,
                MAX_BUNDLE_FILE
            );
            let mut buf = Vec::new();
            (&mut entry)
                .take(MAX_BUNDLE_FILE)
                .read_to_end(&mut buf)?;
            anyhow::ensure!(
                buf.len() as u64 <= MAX_BUNDLE_FILE,
                "bundle entry '{}' exceeds the {}-byte read cap",
                path,
                MAX_BUNDLE_FILE
            );
            return Ok(Some(buf));
        }
    }
    Ok(None)
}

/// Network-delivered bundles are untrusted: a decompressed bundle may not
/// exceed this total size (bundle-bomb guard).
const MAX_BUNDLE_TOTAL: u64 = 256 * 1024 * 1024;

/// Single-entry cap for reads out of a network-delivered bundle (a hostile
/// `manifest.json`/`SKILL.md` entry must not balloon the server's memory).
const MAX_BUNDLE_FILE: u64 = 16 * 1024 * 1024;

/// Extracts a bundle into `dest` (created if needed). Rejects path traversal
/// (no `..`, no absolute entries) and returns the manifest.
pub fn extract(bundle: &[u8], dest: &Path) -> anyhow::Result<BundleManifest> {
    extract_with_cap(bundle, dest, MAX_BUNDLE_TOTAL)
}

fn extract_with_cap(bundle: &[u8], dest: &Path, cap: u64) -> anyhow::Result<BundleManifest> {
    std::fs::create_dir_all(dest)?;
    let gz = flate2::read::GzDecoder::new(bundle);
    let mut tar = tar::Archive::new(gz);
    let mut manifest: Option<BundleManifest> = None;
    let mut total: u64 = 0;
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
        // Count every entry against the decompressed-size cap before it
        // reaches the disk.
        total = total.saturating_add(entry.size());
        anyhow::ensure!(
            total <= cap,
            "bundle decompressed size exceeds the cap ({cap} bytes)"
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
    use serde_json::json;
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
            ..Default::default()
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

    fn v2_manifest() -> BundleManifest {
        serde_json::from_value(serde_json::json!({
            "kind": "integration", "slug": "hubspot", "version": "1.0.0",
            "description": "HubSpot CRM tools",
            "mcp": { "url": "https://mcp.example.com/mcp" },
            "auth": { "kind": "org_secret_impersonated",
                      "secret_names": ["sa_json"], "identity_key": "email" },
            "tools": { "classes": { "search_contacts": "read",
                                    "update_deal": "write" } },
            "triggers": [{ "kind": "webhook", "prompt": "digest",
                           "model": "gpt-4o-mini" }],
            "skills": ["hubspot-cookbook"]
        }))
        .unwrap()
    }

    #[test]
    fn v2_manifest_roundtrip_and_validation() {
        let m = v2_manifest();
        validate_v2(&m).unwrap();
        assert_eq!(m.mcp.as_ref().unwrap().url, "https://mcp.example.com/mcp");
        assert_eq!(tool_class(&m, "search_contacts"), "read");
        assert_eq!(tool_class(&m, "update_deal"), "write");
        assert_eq!(tool_class(&m, "unknown_tool"), "read");
    }

    #[test]
    fn settings_fields_validate() {
        let mut m = v2_manifest();
        m.settings = Some(SettingsManifest {
            fields: vec![FieldSpec {
                name: "base_url".into(),
                kind: "string".into(),
                label: None,
                required: true,
                default: None,
                help: None,
                placeholder: None,
            }],
        });
        validate_v2(&m).unwrap();

        // Unknown kind rejected.
        m.settings.as_mut().unwrap().fields[0].kind = "blob".into();
        assert!(validate_v2(&m).is_err());

        // Duplicate names rejected.
        m.settings.as_mut().unwrap().fields[0].kind = "string".into();
        let dup = m.settings.as_ref().unwrap().fields[0].clone();
        m.settings.as_mut().unwrap().fields.push(dup);
        assert!(validate_v2(&m).is_err());

        // A default must match the field's JSON type.
        let mut m = v2_manifest();
        m.settings = Some(SettingsManifest {
            fields: vec![FieldSpec {
                name: "base_url".into(),
                kind: "string".into(),
                label: None,
                required: false,
                default: Some(json!("https://x")),
                help: None,
                placeholder: None,
            }],
        });
        validate_v2(&m).unwrap();
        m.settings.as_mut().unwrap().fields[0].default = Some(json!(7));
        assert!(validate_v2(&m).is_err());
        m.settings.as_mut().unwrap().fields[0].kind = "number".into();
        validate_v2(&m).unwrap();
        m.settings.as_mut().unwrap().fields[0].default = Some(json!(true));
        assert!(validate_v2(&m).is_err());
        m.settings.as_mut().unwrap().fields[0].kind = "boolean".into();
        validate_v2(&m).unwrap();
        m.settings.as_mut().unwrap().fields[0].kind = "text".into();
        m.settings.as_mut().unwrap().fields[0].default = Some(json!(true));
        assert!(validate_v2(&m).is_err());
        m.settings.as_mut().unwrap().fields[0].default = None;
        validate_v2(&m).unwrap();
        m.settings.as_mut().unwrap().fields[0].default = Some(json!(null));
        validate_v2(&m).unwrap();
    }

    #[test]
    fn v2_validation_rejects_bad_fields() {
        let mut m = v2_manifest();
        m.mcp.as_mut().unwrap().url = "ftp://x".into();
        assert!(validate_v2(&m).is_err());
        let mut m = v2_manifest();
        m.auth.as_mut().unwrap().kind = "magic".into();
        assert!(validate_v2(&m).is_err());
        let mut m = v2_manifest();
        m.tools
            .as_mut()
            .unwrap()
            .classes
            .insert("t".into(), "sudo".into());
        assert!(validate_v2(&m).is_err());
        let mut m = v2_manifest();
        m.mcp.as_mut().unwrap().url = "https://x/".into();
        let mut long = BundleManifest {
            slug: m.slug.clone(),
            ..v2_manifest()
        };
        long.tools.as_mut().unwrap().classes.insert(
            "a_very_long_tool_name_exceeding_sixty_four_characters_limit_x".into(),
            "read".into(),
        );
        assert!(validate_v2(&long).is_err());
    }

    #[test]
    fn v1_manifest_still_validates() {
        let m = BundleManifest {
            kind: "integration".into(),
            slug: "digest".into(),
            version: "0.1.0".into(),
            description: String::new(),
            dependencies: vec![],
            mcp: None,
            auth: None,
            settings: None,
            tools: None,
            triggers: vec![],
            skills: vec![],
        };
        validate_v2(&m).unwrap();
        assert!(m.mcp.is_none());
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

    #[test]
    fn manifest_slug_charset_is_enforced() {
        for bad in ["Deploy Check", "a/b", "UPPER", "a.b"] {
            let m = BundleManifest {
                kind: "skill".into(),
                slug: bad.into(),
                ..v2_manifest()
            };
            assert!(
                validate_manifest(&m).is_err(),
                "slug {bad:?} must be rejected"
            );
        }
        let good = BundleManifest {
            kind: "skill".into(),
            slug: "deploy-check-2".into(),
            ..v2_manifest()
        };
        validate_manifest(&good).unwrap();
        // underscores are legal: existing connector slugs use them
        // (google_workspace), and tool namespacing no longer re-parses them.
        let underscored = BundleManifest {
            kind: "integration".into(),
            slug: "hub_spot".into(),
            ..v2_manifest()
        };
        validate_manifest(&underscored).unwrap();
    }

    #[test]
    fn extract_caps_decompressed_size() {
        // A bundle whose entries exceed the caller's cap is rejected before
        // anything lands on disk (the real cap is 256 MB; the test passes a
        // tiny one).
        let dir = scratch("capped-src");
        fs::write(dir.join("a.txt"), "aaaaaaaaaa").unwrap();
        let manifest = BundleManifest {
            kind: "skill".into(),
            slug: "capped".into(),
            ..v2_manifest()
        };
        let bytes = pack(&dir, &manifest).unwrap();
        let dest = scratch("capped-dest");
        assert!(extract_with_cap(&bytes, &dest, 4).is_err());
        assert!(!dest.join("a.txt").exists());
        // A generous cap extracts normally.
        extract_with_cap(&bytes, &dest, MAX_BUNDLE_TOTAL).unwrap();
        fs::remove_dir_all(&dest).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod bundle_read_tests {
    use super::*;
    use std::io::Write as _;

    /// Builds a raw tar.gz bundle with one entry of the given size (filled
    /// with a repeating byte) — no pack() pipeline, so the entry size is
    /// fully controlled.
    fn bundle_with_entry(name: &str, size: usize) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(size as u64);
        header.set_mode(0o644);
        header.set_cksum();
        let body = vec![b'x'; size];
        tar.append_data(&mut header, name, body.as_slice()).unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn read_bundle_file_reads_an_entry_within_the_cap() {
        let bundle = bundle_with_entry("SKILL.md", 1024);
        let got = read_bundle_file(&bundle, "SKILL.md").unwrap().unwrap();
        assert_eq!(got.len(), 1024);
        assert!(read_bundle_file(&bundle, "missing.txt").unwrap().is_none());
    }

    #[test]
    fn read_bundle_file_refuses_an_entry_over_the_read_cap() {
        let bundle = bundle_with_entry("manifest.json", 17 * 1024 * 1024);
        let err = read_bundle_file(&bundle, "manifest.json")
            .expect_err("oversized entry must be rejected, not buffered");
        assert!(
            err.to_string().contains("read cap"),
            "refusal names the cap: {err}"
        );
    }

    #[test]
    fn read_bundle_file_rejects_an_oversize_header_before_decompression() {
        // A hostile header claiming far more than the cap: rejected on the
        // declared size alone.
        let bundle = bundle_with_entry("bomb.bin", 16 * 1024 * 1024 + 1);
        assert!(read_bundle_file(&bundle, "bomb.bin").is_err());
    }
}
