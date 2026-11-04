//! Registry bundle manifests: the wire model shared by the hub (catalog,
//! publish, validation) and the machines (skill_sync, registry_client).
//! The tar.gz codec that carries `manifest.json` lives in guild-core
//! (`registry::pack`/`extract`) — this module owns the manifest semantics.

use serde::{Deserialize, Serialize};

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
    /// Markdown: where an admin gets this value. Omitted when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtain: Option<String>,
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
    /// The declared tools with their descriptions, for the catalog landing
    /// page. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub declared: Vec<DeclaredTool>,
}

/// One declared tool of a code plugin, as its landing page lists it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeclaredTool {
    pub name: String,
    /// read | write | admin
    pub class: String,
    #[serde(default)]
    pub description: String,
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

/// A bundle manifest that fails validation; the message names the field.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ManifestError(pub String);

/// Returns `ManifestError` with the formatted message unless `cond` holds.
macro_rules! ensure {
    ($cond:expr, $($msg:tt)+) => {
        if !$cond {
            return Err(ManifestError(format!($($msg)+)));
        }
    };
}

/// Validates a manifest's shape and allowed kinds.
pub fn validate_manifest(m: &BundleManifest) -> Result<(), ManifestError> {
    // Slugs land in namespaced tool names and filesystem paths: keep them to
    // lowercase letters, digits and dashes.
    ensure!(!m.slug.is_empty(), "manifest slug is empty");
    ensure!(m.slug.len() <= 64, "manifest slug is too long");
    ensure!(
        m.slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
        "manifest slug must be [a-z0-9_-]"
    );
    ensure!(!m.version.is_empty(), "manifest version is empty");
    ensure!(
        matches!(m.kind.as_str(), "skill" | "mcp" | "integration"),
        "manifest kind must be skill, mcp, or integration"
    );
    Ok(())
}

/// Validates v2 integration manifest fields (mcp url, auth shape, tool
/// classes and namespaced-name length, trigger shape). v1 manifests with no
/// v2 fields pass unchanged.
pub fn validate_v2(m: &BundleManifest) -> Result<(), ManifestError> {
    validate_manifest(m)?;
    if let Some(mcp) = &m.mcp {
        ensure!(
            mcp.url.starts_with("http://") || mcp.url.starts_with("https://"),
            "mcp.url must be an absolute http(s) URL"
        );
    }
    if let Some(auth) = &m.auth {
        ensure!(
            AUTH_KINDS.contains(&auth.kind.as_str()),
            "auth.kind must be org_secret, org_secret_impersonated, or per_user_token"
        );
        ensure!(
            auth.identity_key == "email" || auth.identity_key.is_empty(),
            "auth.identity_key supports only email in v1"
        );
    }
    if let Some(settings) = &m.settings {
        let mut seen = std::collections::BTreeSet::new();
        for f in &settings.fields {
            ensure!(!f.name.is_empty(), "settings field name is empty");
            ensure!(
                f.name.len() <= 64
                    && f.name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "settings field name {f:?} must be [a-z0-9_] and <= 64 chars"
            );
            ensure!(
                FIELD_KINDS.contains(&f.kind.as_str()),
                "settings field {f:?} kind must be one of {FIELD_KINDS:?}"
            );
            ensure!(
                seen.insert(f.name.clone()),
                "duplicate settings field {f:?}"
            );
            // The generated form treats `default` per the field kind, so the
            // JSON value must match: string for string/text, number for
            // number, boolean for boolean. Missing and null stay allowed.
            let default_ok = f.default.as_ref().is_none_or(|d| {
                d.is_null()
                    || match f.kind.as_str() {
                        "number" => d.is_number(),
                        "boolean" => d.is_boolean(),
                        _ => d.is_string(),
                    }
            });
            ensure!(
                default_ok,
                "settings field {f:?} kind {} needs a default of the same JSON type",
                f.kind
            );
        }
    }
    if let Some(tools) = &m.tools {
        for (name, class) in &tools.classes {
            ensure!(
                TOOL_CLASSES.contains(&class.as_str()),
                "tool class for {name} must be read, write, or admin"
            );
            ensure!(
                name.len() < 64 - m.slug.len(),
                "tool name {name} too long for namespacing under {}",
                m.slug
            );
        }
    }
    for t in &m.triggers {
        ensure!(
            matches!(t.kind.as_str(), "webhook" | "interval"),
            "trigger kind must be webhook or interval"
        );
        ensure!(!t.prompt.is_empty(), "trigger prompt is empty");
        ensure!(!t.model.is_empty(), "trigger model is empty");
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
