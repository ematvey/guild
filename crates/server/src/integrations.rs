//! Integration plugins: server-side tools for the chat loop, contributed by
//! admin-configured integrations (per org). Adding an integration means
//! implementing [`Integration`] and registering it in [`integration_by_name`];
//! admins then enable it per org via the admin API — an integration
//! contributes tools only while enabled.

use crate::state::AppState;
use crate::worker::mcp_pool::{secrets_fingerprint, PoolKey};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use futures::future::BoxFuture;
use guild_core::registry::{tool_class, BundleManifest};
use protocol::api::ToolSpec;
use rmcp::model::CallToolRequestParams;
use rmcp::service::{Peer, RoleClient};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

/// What kind of tool surface an integration contributes — used by the admin
/// API/UI to group providers (serialized as `"search" | "fetch" | "other"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Search,
    Fetch,
    Other,
}

impl Category {
    /// Stable display order: search providers list first, then fetch, then
    /// other.
    pub fn display_rank(self) -> u8 {
        match self {
            Category::Search => 0,
            Category::Fetch => 1,
            Category::Other => 2,
        }
    }
}

/// Serializes a category list in display order — the admin API/UI renders
/// one badge per entry, so the ordering must be deterministic.
pub fn category_strings(categories: &[Category]) -> Vec<String> {
    let mut sorted: Vec<Category> = categories.to_vec();
    sorted.sort_by_key(|c| c.display_rank());
    sorted.into_iter().map(|c| c.to_string()).collect()
}

impl std::fmt::Display for Category {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Category::Search => "search",
            Category::Fetch => "fetch",
            Category::Other => "other",
        };
        f.write_str(s)
    }
}

/// Result of an integration tool execution. `content` is the model-facing
/// text (unchanged contract); `meta` is the tool-owned widget payload that
/// the chat loop persists on the `tool/result` event (spec C.2).
#[derive(Debug)]
pub struct ToolOutcome {
    pub content: String,
    pub meta: Option<serde_json::Value>,
    /// Binary payload the tool hands the model as a spilled artifact (tool
    /// artifacts design): the worker stores the bytes in object storage and
    /// replaces `content` with a pointer to the materialized file. Carrying
    /// a payload always spills, regardless of size.
    pub artifact: Option<guild_core::tools::ToolArtifact>,
}

/// One integration plugin. `config` is the admin-supplied JSON with the
/// non-secret settings only (e.g. the searxng base URL); `tools(config)`
/// validates the config and declares the tool surface it contributes.
pub trait Integration: Send + Sync {
    fn name(&self) -> &'static str;
    /// The tool-surface kinds the integration contributes — one entry per
    /// capability, in the integration's own order (the admin API sorts for
    /// display). Most integrations declare exactly one.
    fn categories(&self) -> &'static [Category];
    /// The in-code manifest (kind `integration`, slug = name, semver,
    /// description, `auth.secret_names`, `tools.classes`) — the same manifest
    /// shape a registry bundle carries, so built-ins and MCP plugins share
    /// disclosure, policy, and the enable gate. No `mcp` field and no
    /// registry bundle: the manifest lives in code.
    fn manifest(&self) -> BundleManifest;
    /// Validate config and declare tools. An error here means the admin
    /// supplied a broken config — the integration contributes nothing.
    fn tools(&self, config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>>;
    /// Runs one tool. `secrets` carries the resolved store values for the
    /// credentials; config keeps non-secret settings only. `acting_as` is
    /// the call's resolved external identity (spec §5) — None acts as the
    /// connector's default subject.
    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
        secrets: &'a [(String, String)],
        acting_as: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ToolOutcome, String>>;
    /// One cheap authenticated round-trip against the vendor with the
    /// would-be connection (merged config + secrets). A save is persisted
    /// only when this succeeds — a broken connection is never stored.
    fn test_connection<'a>(
        &'a self,
        config: &'a serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// Maps one authenticated probe to a test verdict: 2xx passes, anything
/// else names the failure without leaking credential values.
pub async fn probe(req: reqwest::RequestBuilder, what: &str) -> Result<(), String> {
    let resp = req
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("{what} unreachable: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("{what} rejected the connection ({status})"))
    }
}

/// One legacy credential promotion: the secret row's value becomes a plain
/// config setting (when config does not already carry it) and the row is
/// dropped.
struct LegacyPromotion {
    connector: &'static str,
    secret_name: &'static str,
    config_key: &'static str,
}

const LEGACY_PROMOTIONS: &[LegacyPromotion] = &[
    LegacyPromotion {
        connector: "atlassian",
        secret_name: "site",
        config_key: "site",
    },
    LegacyPromotion {
        connector: "atlassian",
        secret_name: "email",
        config_key: "email",
    },
    LegacyPromotion {
        connector: "langfuse",
        secret_name: "host",
        config_key: "base_url",
    },
    LegacyPromotion {
        connector: "google_workspace",
        secret_name: "admin_email",
        config_key: "admin_email",
    },
];

/// Settings that used to be stored as secrets (atlassian's site/email,
/// langfuse's host, google_workspace's admin_email) become plain config
/// values and their secret rows are dropped. Idempotent: runs at boot,
/// tolerates re-runs, and never touches rows that are still real
/// credentials (tokens, keys).
pub async fn migrate_legacy_credential_secrets(
    store: &crate::store::Store,
    master_key: &[u8; 32],
) -> anyhow::Result<()> {
    let orgs: Vec<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM orgs")
        .fetch_all(store.pool())
        .await?;
    for org in orgs {
        for p in LEGACY_PROMOTIONS {
            let Some(row) = store
                .integrations()
                .get_by_name(org, p.connector)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?
            else {
                continue;
            };
            if row.config[p.config_key].as_str().is_some() {
                continue; // config already carries the setting
            }
            let names = store
                .integration_secrets()
                .names(org, p.connector)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            if !names.iter().any(|n| n == p.secret_name) {
                continue;
            }
            let resolved = store
                .integration_secrets()
                .resolve(org, p.connector, &[p.secret_name.to_string()], master_key)
                .await;
            let Ok(value) = resolved else {
                tracing::warn!(
                    "legacy migration: cannot decrypt {}/{}; leaving it in place",
                    p.connector,
                    p.secret_name
                );
                continue;
            };
            let mut config = row.config.clone();
            config[p.config_key] = serde_json::Value::String(value[0].1.clone());
            store
                .integrations()
                .upsert(org, p.connector, &config, row.enabled)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            store
                .integration_secrets()
                .delete(org, p.connector, p.secret_name)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            tracing::info!(
                "migrated {}/{} secret into config",
                p.connector,
                p.secret_name
            );
        }
    }
    Ok(())
}

mod github;
mod gitlab;
mod hubspot;
mod langfuse;

/// The compiled-in integration kinds — keep in sync with
/// [`integration_by_name`].
pub fn integration_names() -> &'static [&'static str] {
    &[
        "searxng",
        "superproxy",
        "firecrawl",
        "google_workspace",
        "hubspot",
        "langfuse",
        "atlassian",
        "slack",
        "github",
        "gitlab",
        #[cfg(feature = "test-support")]
        "testplug",
    ]
}

/// The registry of available integration kinds (code-level plugins).
pub fn integration_by_name(name: &str) -> Option<Arc<dyn Integration>> {
    match name {
        "searxng" => Some(Arc::new(searxng::Searxng)),
        "superproxy" => Some(Arc::new(superproxy::Superproxy)),
        "firecrawl" => Some(Arc::new(firecrawl::Firecrawl)),
        "google_workspace" => Some(google_workspace::instance()),
        "hubspot" => Some(Arc::new(hubspot::Hubspot)),
        "langfuse" => Some(Arc::new(langfuse::Langfuse)),
        "atlassian" => Some(Arc::new(atlassian::Atlassian)),
        "slack" => Some(Arc::new(slack::Slack)),
        "github" => Some(Arc::new(github::Github)),
        "gitlab" => Some(Arc::new(gitlab::Gitlab)),
        #[cfg(feature = "test-support")]
        "testplug" => Some(Arc::new(testplug::TestPlug)),
        _ => None,
    }
}

/// Builds an in-code manifest in the registry's v2 shape and validates it
/// against the same rules a published bundle must pass (legal tool classes,
/// namespaced-name length, settings field kinds) — built-ins reuse the
/// registry validation, they do not fork it.
pub fn in_code_manifest(
    name: &str,
    version: &str,
    description: &str,
    secret_names: &[&str],
    classes: &[(&str, &str)],
    fields: &[guild_core::registry::FieldSpec],
) -> BundleManifest {
    // The schema is the source of truth: credential (secret-kind) fields
    // derive the auth secret list the enable gate and secret store key on.
    let derived: Vec<String> = fields
        .iter()
        .filter(|f| f.kind == "secret")
        .map(|f| f.name.clone())
        .collect();
    let secret_names: Vec<String> = if derived.is_empty() {
        secret_names.iter().map(|s| s.to_string()).collect()
    } else {
        derived
    };
    let manifest = BundleManifest {
        kind: "integration".to_string(),
        slug: name.to_string(),
        version: version.to_string(),
        description: description.to_string(),
        auth: Some(guild_core::registry::AuthManifest {
            secret_names,
            ..Default::default()
        }),
        settings: Some(guild_core::registry::SettingsManifest {
            fields: fields.to_vec(),
        }),
        tools: Some(guild_core::registry::ToolsManifest {
            classes: classes
                .iter()
                .map(|(tool, class)| (tool.to_string(), class.to_string()))
                .collect(),
        }),
        ..Default::default()
    };
    guild_core::registry::validate_v2(&manifest)
        .expect("in-code manifest violates the registry manifest rules");
    manifest
}

/// One settings field for an in-code manifest: name + kind with an optional
/// default. Label/help are added at call sites via struct update when the
/// field needs them.
pub fn field(name: &str, kind: &str) -> guild_core::registry::FieldSpec {
    guild_core::registry::FieldSpec {
        name: name.to_string(),
        kind: kind.to_string(),
        label: None,
        required: false,
        default: None,
        help: None,
        placeholder: None,
    }
}

/// How a plugin executes: a compiled-in Rust plugin or a remote MCP server
/// implementing the plugin contract (spec §3). One turn-start snapshot type
/// covers both kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginExecutor {
    Rust,
    Mcp,
}

/// Guild-provided tool name for an MCP plugin tool: `<slug>_<tool>`.
pub fn namespaced_tool(slug: &str, tool: &str) -> String {
    format!("{slug}_{tool}")
}

/// Strips the `<slug>_` namespace back off. Tolerates the legacy
/// `int_<slug>_` shape so journals and thread logs recorded before the
/// prefix drop still replay and render.
pub fn unnamespaced_tool<'a>(slug: &str, tool: &'a str) -> Option<&'a str> {
    tool.strip_prefix(&format!("{slug}_"))
        .or_else(|| tool.strip_prefix(&format!("int_{slug}_")))
}

/// Whether a plugin tool spec answers a wire tool name — either exactly, or
/// via the slug namespace (both sides stripped, legacy shape tolerated).
pub fn tool_matches(slug: &str, spec_name: &str, call_name: &str) -> bool {
    spec_name == call_name
        || match (
            unnamespaced_tool(slug, spec_name),
            unnamespaced_tool(slug, call_name),
        ) {
            (Some(s), Some(c)) => s == c,
            _ => false,
        }
}

/// Tool-class rank for the policy rule (spec §6): read < write < admin.
fn class_rank(class: &str) -> u8 {
    match class {
        "write" => 1,
        "admin" => 2,
        _ => 0,
    }
}

/// Classes one role may call. Default policy (spec §6): member read-only,
/// admin (and owner — owners are admins) everything; a stored
/// `tool_policy` tightens or reshapes per role, never past the manifest.
fn allowed_classes(org_policy: &Option<serde_json::Value>, role: &str) -> Vec<&'static str> {
    let role = if role == "owner" { "admin" } else { role };
    if let Some(policy) = org_policy
        .as_ref()
        .and_then(|p| p["tool_policy"].as_object())
        .and_then(|tp| tp.get(role))
        .and_then(|v| v.as_array())
    {
        let allowed: Vec<&'static str> = policy
            .iter()
            .filter_map(|v| v.as_str())
            .filter_map(|s| match s {
                "read" => Some("read"),
                "write" => Some("write"),
                "admin" => Some("admin"),
                _ => None,
            })
            .collect();
        return allowed;
    }
    match role {
        "admin" => vec!["read", "write", "admin"],
        _ => vec!["read"],
    }
}

/// Policy rule (spec §6): the manifest class is the connector's declaration;
/// the org can tighten, never loosen. A tool declared `admin` is callable
/// only by admins regardless of any wider policy grant. Unknown tools are
/// class `read` (spec §3).
pub fn enforce_class(
    manifest: &BundleManifest,
    org_policy: &Option<serde_json::Value>,
    role: &str,
    tool: &str,
) -> bool {
    let class = tool_class(manifest, tool);
    if class == "admin" && role != "admin" && role != "owner" {
        return false;
    }
    allowed_classes(org_policy, role)
        .iter()
        .any(|c| class_rank(c) >= class_rank(class))
}

/// Resolves the acting identity for one call (spec §5): no override acts as
/// the caller's own mapped identity (null when there is none); an override
/// to a different identity is admin-only.
#[allow(clippy::result_unit_err)] // the plan's cross-lane interface: Err carries no payload
pub fn resolve_acting_as(
    caller_email: Option<&str>,
    override_: Option<&str>,
    is_admin: bool,
) -> Result<Option<String>, ()> {
    match override_ {
        None => Ok(caller_email.map(|s| s.to_string())),
        Some(o) if Some(o) == caller_email || is_admin => Ok(Some(o.to_string())),
        Some(_) => Err(()),
    }
}

/// Builds the identity envelope (spec §5) plus secret headers (spec §4) for
/// one MCP call. Secrets appear only here — never in logs or events.
pub fn envelope_headers(
    call_id: &Uuid,
    org: &Uuid,
    caller: Option<&Uuid>,
    acting_as: Option<&str>,
    secrets: &[(String, String)],
) -> HeaderMap {
    let mut map = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&org.to_string()) {
        map.insert("x-guild-org", v);
    }
    if let Some(c) = caller {
        if let Ok(v) = HeaderValue::from_str(&c.to_string()) {
            map.insert("x-guild-caller", v);
        }
    }
    if let Some(a) = acting_as {
        if let Ok(v) = HeaderValue::from_str(a) {
            map.insert("x-guild-acting-as", v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&call_id.to_string()) {
        map.insert("x-guild-call-id", v);
    }
    for (name, value) in secrets {
        let Ok(name) = HeaderName::from_lowercase(format!("x-guild-secret-{name}").as_bytes())
        else {
            continue; // undeclarable secret name — never leak it by other means
        };
        if let Ok(v) = HeaderValue::from_str(value) {
            map.insert(name, v);
        }
    }
    map
}

/// Calls one tool on an MCP peer and maps the result to the integration
/// `ToolOutcome` contract. The tool name is the connector's raw name —
/// namespacing is Guild-side only.
pub async fn mcp_call_tool(
    peer: &Peer<RoleClient>,
    tool: &str,
    args: serde_json::Value,
) -> Result<ToolOutcome, String> {
    let mut params = CallToolRequestParams::new(tool.to_string());
    if let Some(obj) = args.as_object() {
        params = params.with_arguments(obj.clone());
    }
    let result = peer
        .call_tool(params)
        .await
        .map_err(|e| format!("mcp tool call failed: {e}"))?;
    let text = result
        .content
        .iter()
        .filter_map(|c| match c {
            rmcp::model::ContentBlock::Text(t) => Some(t.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if result.is_error.unwrap_or(false) {
        return Err(format!("mcp tool error: {text}"));
    }
    Ok(ToolOutcome {
        artifact: None,
        content: text,
        meta: None,
    })
}

/// Test-only built-in plugin (compiled with the `test-support` feature):
/// declares a required secret plus a read and an admin tool, so the
/// unified-resolution tests can exercise the enable gate, secrets
/// resolution into execute, class enforcement, and the script API end to
/// end. Its tools never touch the network.
#[cfg(feature = "test-support")]
pub mod testplug {
    use super::{field, in_code_manifest, Category, Integration, ToolOutcome};
    use futures::future::BoxFuture;
    use guild_core::registry::BundleManifest;
    use protocol::api::ToolSpec;

    pub struct TestPlug;

    impl Integration for TestPlug {
        fn name(&self) -> &'static str {
            "testplug"
        }

        fn categories(&self) -> &'static [Category] {
            &[Category::Other]
        }

        fn manifest(&self) -> BundleManifest {
            in_code_manifest(
                "testplug",
                "0.1.0",
                "Test tools for the unified plugin interface",
                &[],
                &[("secret_echo", "read"), ("admin_op", "admin")],
                &[guild_core::registry::FieldSpec {
                    required: true,
                    ..field("api_key", "secret")
                }],
            )
        }

        fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
            Ok(vec![
                ToolSpec {
                    name: "secret_echo".into(),
                    description: "Reports whether the declared secret resolved.".into(),
                    parameters: serde_json::json!({ "type": "object", "properties": {} }),
                    kind: Default::default(),
                },
                ToolSpec {
                    name: "admin_op".into(),
                    description: "An operation reserved for admins.".into(),
                    parameters: serde_json::json!({ "type": "object", "properties": {} }),
                    kind: Default::default(),
                },
            ])
        }

        fn execute<'a>(
            &'a self,
            _config: &'a serde_json::Value,
            tool: &'a str,
            _args: serde_json::Value,
            secrets: &'a [(String, String)],
            _acting_as: Option<&'a str>,
        ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
            Box::pin(async move {
                match tool {
                    // Reflects secret resolution without ever echoing the value.
                    "secret_echo" => {
                        let present = secrets.iter().any(|(name, _)| name == "api_key");
                        Ok(ToolOutcome {
                            artifact: None,
                            content: format!("api_key present: {present}"),
                            meta: None,
                        })
                    }
                    "admin_op" => Ok(ToolOutcome {
                        artifact: None,
                        content: "admin ok".to_string(),
                        meta: None,
                    }),
                    other => Err(format!("testplug integration has no tool {other}")),
                }
            })
        }

        fn test_connection<'a>(
            &'a self,
            _config: &'a serde_json::Value,
            _secrets: &'a [(String, String)],
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move { Ok(()) })
        }
    }
}

pub mod atlassian;
pub mod slack;

pub mod google_workspace;

pub mod searxng {
    use super::{field, in_code_manifest, probe, Category, Integration, ToolOutcome};
    use futures::future::BoxFuture;
    use guild_core::registry::BundleManifest;
    use protocol::api::{ToolKind, ToolSpec};

    /// SearxNG meta-search integration. Config: `{ "base_url": "http://…" }`.
    /// Exposes one tool: `web_search`.
    pub struct Searxng;

    fn base_url(config: &serde_json::Value) -> anyhow::Result<String> {
        let url = config["base_url"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("searxng config requires base_url"))?;
        Ok(url.trim_end_matches('/').to_string())
    }

    impl Integration for Searxng {
        fn name(&self) -> &'static str {
            "searxng"
        }

        fn categories(&self) -> &'static [Category] {
            &[Category::Search]
        }

        fn manifest(&self) -> BundleManifest {
            in_code_manifest(
                "searxng",
                "1.0.0",
                "Web search through a SearxNG instance",
                &[],
                &[("web_search", "read")],
                &[guild_core::registry::FieldSpec {
                    required: true,
                    placeholder: Some("http://searxng:8080".into()),
                    ..field("base_url", "string")
                }],
            )
        }
        fn tools(&self, config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
            base_url(config)?; // validates
            Ok(vec![ToolSpec {
                name: "web_search".into(),
                description: "Search the web and return the top results (title, url, snippet)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "count": { "type": "number", "description": "1-10, default 5" }
                    },
                    "required": ["query"]
                }),
                kind: ToolKind::WebSearch,
            }])
        }

        fn execute<'a>(
            &'a self,
            config: &'a serde_json::Value,
            tool: &'a str,
            args: serde_json::Value,
            _secrets: &'a [(String, String)],
            _acting_as: Option<&'a str>,
        ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
            Box::pin(async move {
                if tool != "web_search" {
                    return Err(format!("searxng integration has no tool {tool}"));
                }
                let query = args["query"]
                    .as_str()
                    .ok_or("web_search requires query")?
                    .to_string();
                let count = args["count"].as_u64().unwrap_or(5).clamp(1, 10) as usize;
                let url = base_url(config).map_err(|e| e.to_string())?;
                let resp = reqwest::Client::new()
                    .get(format!("{url}/search"))
                    .query(&[("q", query.as_str()), ("format", "json")])
                    .timeout(std::time::Duration::from_secs(20))
                    .send()
                    .await
                    .map_err(|e| format!("searxng unreachable: {e}"))?;
                if !resp.status().is_success() {
                    return Err(format!("searxng returned {}", resp.status()));
                }
                let body: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("searxng returned bad json: {e}"))?;
                let results = body["results"]
                    .as_array()
                    .map(|a| a.as_slice())
                    .unwrap_or_default();
                let truncated = results.len() > count;
                let mut out = String::new();
                let mut sources = Vec::new();
                for (i, hit) in results.iter().take(count).enumerate() {
                    let title = hit["title"].as_str().unwrap_or("(untitled)");
                    let url = hit["url"].as_str().unwrap_or("");
                    let snippet = hit["content"].as_str().unwrap_or("");
                    out.push_str(&format!("{}. {}\n{}\n{}\n\n", i + 1, title, url, snippet));
                    let mut src = serde_json::Map::new();
                    src.insert("url".into(), serde_json::Value::String(url.to_string()));
                    if !title.is_empty() && title != "(untitled)" {
                        src.insert("title".into(), serde_json::Value::String(title.to_string()));
                    }
                    if !snippet.is_empty() {
                        src.insert(
                            "snippet".into(),
                            serde_json::Value::String(snippet.to_string()),
                        );
                    }
                    sources.push(serde_json::Value::Object(src));
                }
                if out.is_empty() {
                    out = "No results.".to_string();
                }
                let meta = serde_json::json!({
                    "card": "web",
                    "kind": "search",
                    "sources": sources,
                    "truncated": truncated,
                });
                Ok(ToolOutcome {
                    artifact: None,
                    content: out,
                    meta: Some(meta),
                })
            })
        }

        fn test_connection<'a>(
            &'a self,
            config: &'a serde_json::Value,
            _secrets: &'a [(String, String)],
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let url = base_url(config).map_err(|e| e.to_string())?;
                probe(
                    reqwest::Client::new()
                        .get(format!("{url}/search"))
                        .query(&[("q", "guild"), ("format", "json")]),
                    "searxng",
                )
                .await
            })
        }
    }
}

pub mod superproxy {
    use super::{field, in_code_manifest, probe, Category, Integration, ToolOutcome};
    use futures::future::BoxFuture;
    use guild_core::registry::BundleManifest;
    use protocol::api::{ToolKind, ToolSpec};

    const DEFAULT_MAX_CHARS: usize = 8000;

    /// Superproxy fetch integration (spec D). Config:
    /// `{ "base_url": "http://host:15505", "token"?: "…" }`. The gateway
    /// token is a secret: the stored `token` secret wins; the config `token`
    /// remains as a fallback so existing configs keep working — new
    /// deployments store the secret instead.
    /// Exposes one tool: `web_fetch` — markdown page fetch through the
    /// superproxy gateway (SSRF-screened, cached).
    pub struct Superproxy;

    fn config_parts(config: &serde_json::Value) -> anyhow::Result<(String, Option<String>)> {
        let base = config["base_url"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("superproxy config requires base_url"))?
            .trim_end_matches('/')
            .to_string();
        let token = config["token"].as_str().map(|s| s.to_string());
        Ok((base, token))
    }

    /// Composes the model-facing text: title header + markdown body,
    /// truncated to `max_chars` chars with a `[truncated]` marker.
    fn compose(title: Option<&str>, content: &str, max_chars: usize) -> (String, bool) {
        let full = match title {
            Some(t) => format!("# {t}\n\n{content}"),
            None => content.to_string(),
        };
        if full.chars().count() <= max_chars {
            (full, false)
        } else {
            let cut: String = full.chars().take(max_chars).collect();
            (format!("{cut}\n\n[truncated]"), true)
        }
    }

    impl Integration for Superproxy {
        fn name(&self) -> &'static str {
            "superproxy"
        }

        fn categories(&self) -> &'static [Category] {
            &[Category::Fetch]
        }

        fn manifest(&self) -> BundleManifest {
            // No declared secrets: the gateway token is optional (legacy
            // config fallback), so the enable gate must not require it.
            in_code_manifest(
                "superproxy",
                "1.0.0",
                "Fetch web pages as markdown through the superproxy gateway",
                &[],
                &[("web_fetch", "read")],
                &[
                    guild_core::registry::FieldSpec {
                        required: true,
                        placeholder: Some("http://superproxy:15505".into()),
                        ..field("base_url", "string")
                    },
                    guild_core::registry::FieldSpec {
                        help: Some(
                            "Legacy fallback; prefer storing the token secret instead".into(),
                        ),
                        ..field("token", "string")
                    },
                ],
            )
        }

        fn tools(&self, config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
            config_parts(config)?; // validates
            Ok(vec![ToolSpec {
                name: "web_fetch".into(),
                description: "Fetch a web page through the superproxy gateway and return its \
                              content as markdown (title, description, main text)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Absolute http(s) URL to fetch" },
                        "max_chars": { "type": "number",
                            "description": "Max characters of returned content (default 8000)" }
                    },
                    "required": ["url"]
                }),
                kind: ToolKind::WebBrowse,
            }])
        }

        fn execute<'a>(
            &'a self,
            config: &'a serde_json::Value,
            tool: &'a str,
            args: serde_json::Value,
            secrets: &'a [(String, String)],
            _acting_as: Option<&'a str>,
        ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
            Box::pin(async move {
                if tool != "web_fetch" {
                    return Err(format!("superproxy integration has no tool {tool}"));
                }
                let target = args["url"]
                    .as_str()
                    .ok_or("web_fetch requires url")?
                    .to_string();
                let max_chars = args["max_chars"]
                    .as_u64()
                    .unwrap_or(DEFAULT_MAX_CHARS as u64) as usize;
                let (base, config_token) = config_parts(config).map_err(|e| e.to_string())?;
                // The stored secret wins; the config token is the legacy fallback.
                let token = secrets
                    .iter()
                    .find(|(name, _)| name == "token")
                    .map(|(_, value)| value.clone())
                    .or(config_token);
                let mut req = reqwest::Client::new()
                    .get(format!("{base}/v1/fetch"))
                    .query(&[("url", target.as_str()), ("format", "markdown")])
                    .timeout(std::time::Duration::from_secs(60));
                if let Some(token) = &token {
                    req = req.bearer_auth(token);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| format!("search tool unreachable: {e}"))?;
                if !resp.status().is_success() {
                    return Err(format!("search tool returned {}", resp.status()));
                }
                let body: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("search tool returned bad json: {e}"))?;

                let page_content = body["content"].as_str().unwrap_or("");
                let title = body["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let (content, truncated) = compose(title, page_content, max_chars);

                let final_url = body["url"].as_str().unwrap_or(&target);
                let status_code = body["status"].as_u64().unwrap_or(0) as u16;
                let mut meta = serde_json::json!({
                    "card": "web",
                    "kind": "fetch",
                    "url": final_url,
                    "status_code": status_code,
                    "truncated": truncated,
                });
                if let Some(t) = title {
                    meta["title"] = serde_json::Value::String(t.to_string());
                }
                Ok(ToolOutcome {
                    artifact: None,
                    content,
                    meta: Some(meta),
                })
            })
        }

        fn test_connection<'a>(
            &'a self,
            config: &'a serde_json::Value,
            secrets: &'a [(String, String)],
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let (base, config_token) = config_parts(config).map_err(|e| e.to_string())?;
                let token = secrets
                    .iter()
                    .find(|(name, _)| name == "token")
                    .map(|(_, value)| value.clone())
                    .or(config_token);
                let mut req = reqwest::Client::new()
                    .get(format!("{base}/v1/fetch"))
                    .query(&[("url", "https://example.com"), ("format", "markdown")]);
                if let Some(token) = &token {
                    req = req.bearer_auth(token);
                }
                probe(req, "superproxy").await
            })
        }
    }
}

pub mod firecrawl {
    use super::{field, in_code_manifest, Category, Integration, ToolOutcome};
    use futures::future::BoxFuture;
    use guild_core::registry::BundleManifest;
    use protocol::api::{ToolKind, ToolSpec};

    /// Compose server reaches host ports through `host.docker.internal`
    /// (deploy compose `extra_hosts: host-gateway`), so the self-hosted
    /// Firecrawl API defaults to that address.
    const DEFAULT_BASE_URL: &str = "http://host.docker.internal:3002";
    const DEFAULT_MAX_CHARS: usize = 8000;
    /// Per-result markdown excerpt cap for search results scraped with
    /// `scrape: true` — the search content stays a results list, not full
    /// pages.
    const SCRAPE_EXCERPT_CHARS: usize = 2000;
    const MAP_LINK_LIMIT: usize = 500;

    /// Firecrawl integration (self-hosted v1 API). Config:
    /// `{ "base_url"?: "http://…" }` — defaults to the docker-reachable
    /// address above. Secret: optional `api_key`, sent as the Bearer token
    /// (the self-hosted API does not enforce auth). Tools: `scrape` (page as
    /// markdown), `search` (SearXNG-backed results, optional per-result
    /// markdown), `map` (site link list). The async crawl API is not a tool
    /// — a long-poll tool call is a bad fit.
    pub struct Firecrawl;

    fn base_url(config: &serde_json::Value) -> String {
        config["base_url"]
            .as_str()
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn api_key(secrets: &[(String, String)]) -> Option<String> {
        secrets
            .iter()
            .find(|(name, _)| name == "api_key")
            .map(|(_, value)| value.clone())
            .filter(|v| !v.is_empty())
    }

    /// POSTs one Firecrawl v1 JSON endpoint and returns the parsed body.
    /// The Bearer key rides only when configured.
    async fn post_json(
        base: &str,
        path: &str,
        body: serde_json::Value,
        key: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let mut req = reqwest::Client::new()
            .post(format!("{base}{path}"))
            .json(&body)
            .timeout(std::time::Duration::from_secs(60));
        if let Some(key) = key {
            req = req.bearer_auth(key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("firecrawl unreachable: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("firecrawl returned an unreadable body: {e}"))?;
        if !status.is_success() {
            // Char-bounded head: byte-slicing could panic inside the plugin
            // run when a multibyte character straddles the cut, and the
            // resulting panic loop would retry the read forever.
            let head: String = text.chars().take(300).collect();
            return Err(format!("firecrawl returned {status}: {head}"));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("firecrawl returned bad json: {e}"))?;
        if parsed["success"] == serde_json::Value::Bool(false) {
            let err = parsed["error"].as_str().unwrap_or("unknown error");
            return Err(format!("firecrawl error: {err}"));
        }
        Ok(parsed)
    }

    /// Truncates `text` to `max_chars` chars, appending a `[truncated]`
    /// marker when cut.
    fn truncate(text: &str, max_chars: usize) -> (String, bool) {
        if text.chars().count() <= max_chars {
            (text.to_string(), false)
        } else {
            let cut: String = text.chars().take(max_chars).collect();
            (format!("{cut}\n\n[truncated]"), true)
        }
    }

    impl Integration for Firecrawl {
        fn name(&self) -> &'static str {
            "firecrawl"
        }

        fn categories(&self) -> &'static [Category] {
            &[Category::Fetch, Category::Search]
        }

        fn manifest(&self) -> BundleManifest {
            in_code_manifest(
                "firecrawl",
                "1.0.0",
                "Scrape pages as markdown, search, and map site links through a \
                 self-hosted Firecrawl API (crawl jobs are not exposed as tools)",
                &["api_key"],
                &[("scrape", "read"), ("search", "read"), ("map", "read")],
                &[
                    guild_core::registry::FieldSpec {
                        default: Some(serde_json::json!(DEFAULT_BASE_URL)),
                        help: Some("Self-hosted Firecrawl API URL".into()),
                        ..field("base_url", "string")
                    },
                    guild_core::registry::FieldSpec {
                        help: Some(
                            "Sent as the Bearer token; the self-hosted API does not require it"
                                .into(),
                        ),
                        ..field("api_key", "secret")
                    },
                ],
            )
        }

        fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
            Ok(vec![
                ToolSpec {
                    name: "scrape".into(),
                    description: "Fetch a web page through the Firecrawl API and return its \
                                  content as markdown."
                        .into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "url": { "type": "string",
                                "description": "Absolute http(s) URL to scrape" },
                            "max_chars": { "type": "number",
                                "description": "Max characters of returned markdown (default 8000)" }
                        },
                        "required": ["url"]
                    }),
                    kind: ToolKind::WebBrowse,
                },
                ToolSpec {
                    name: "search".into(),
                    description: "Search the web through the Firecrawl API and return the top \
                                  results (title, url, description)."
                        .into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": { "type": "string" },
                            "limit": { "type": "number", "description": "1-20, default 5" },
                            "scrape": { "type": "boolean",
                                "description": "Also scrape each result and return a short \
                                    markdown excerpt (slower)" }
                        },
                        "required": ["query"]
                    }),
                    kind: ToolKind::WebSearch,
                },
                ToolSpec {
                    name: "map".into(),
                    description: "List the links Firecrawl discovers on one site (sitemap \
                                  style crawl)."
                        .into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "url": { "type": "string",
                                "description": "Absolute http(s) URL of the site root" }
                        },
                        "required": ["url"]
                    }),
                    kind: Default::default(),
                },
            ])
        }

        fn execute<'a>(
            &'a self,
            config: &'a serde_json::Value,
            tool: &'a str,
            args: serde_json::Value,
            secrets: &'a [(String, String)],
            _acting_as: Option<&'a str>,
        ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
            Box::pin(async move {
                let base = base_url(config);
                let key = api_key(secrets);
                match tool {
                    "scrape" => {
                        let url = args["url"]
                            .as_str()
                            .ok_or("scrape requires url")?
                            .to_string();
                        let max_chars = args["max_chars"]
                            .as_u64()
                            .unwrap_or(DEFAULT_MAX_CHARS as u64)
                            as usize;
                        let resp = post_json(
                            &base,
                            "/v1/scrape",
                            serde_json::json!({ "url": url, "formats": ["markdown"] }),
                            key.as_deref(),
                        )
                        .await?;
                        let markdown = resp["data"]["markdown"].as_str().unwrap_or("").to_string();
                        let meta_url = resp["data"]["metadata"]["sourceURL"]
                            .as_str()
                            .or(resp["data"]["metadata"]["url"].as_str())
                            .unwrap_or(&url);
                        let status_code = resp["data"]["metadata"]["statusCode"]
                            .as_u64()
                            .unwrap_or(200) as u16;
                        let (content, truncated) = truncate(&markdown, max_chars);
                        let mut meta = serde_json::json!({
                            "card": "web",
                            "kind": "fetch",
                            "url": meta_url,
                            "status_code": status_code,
                            "truncated": truncated,
                        });
                        if let Some(t) = resp["data"]["metadata"]["title"]
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            meta["title"] = serde_json::Value::String(t.to_string());
                        }
                        Ok(ToolOutcome {
                            artifact: None,
                            content,
                            meta: Some(meta),
                        })
                    }
                    "search" => {
                        let query = args["query"]
                            .as_str()
                            .ok_or("search requires query")?
                            .to_string();
                        let limit = args["limit"].as_u64().unwrap_or(5).clamp(1, 20) as usize;
                        let mut body = serde_json::json!({ "query": query, "limit": limit });
                        if args["scrape"].as_bool().unwrap_or(false) {
                            body["scrapeOptions"] = serde_json::json!({ "formats": ["markdown"] });
                        }
                        let resp = post_json(&base, "/v1/search", body, key.as_deref()).await?;
                        // The self-hosted API returns a flat results array;
                        // the cloud shape nests it under data.web.
                        let results = resp["data"]["web"]
                            .as_array()
                            .or(resp["data"].as_array())
                            .map(|a| a.as_slice())
                            .unwrap_or_default();
                        let truncated = results.len() > limit;
                        let mut out = String::new();
                        let mut sources = Vec::new();
                        for (i, hit) in results.iter().take(limit).enumerate() {
                            let title = hit["title"].as_str().unwrap_or("(untitled)");
                            let url = hit["url"].as_str().unwrap_or("");
                            let description = hit["description"].as_str().unwrap_or("");
                            out.push_str(&format!(
                                "{}. {}\n{}\n{}\n\n",
                                i + 1,
                                title,
                                url,
                                description
                            ));
                            if let Some(md) = hit["markdown"].as_str() {
                                let (excerpt, _) = truncate(md, SCRAPE_EXCERPT_CHARS);
                                out.push_str(&excerpt);
                                out.push_str("\n\n");
                            }
                            let mut src = serde_json::Map::new();
                            src.insert("url".into(), serde_json::Value::String(url.to_string()));
                            if !title.is_empty() && title != "(untitled)" {
                                src.insert(
                                    "title".into(),
                                    serde_json::Value::String(title.to_string()),
                                );
                            }
                            if !description.is_empty() {
                                src.insert(
                                    "snippet".into(),
                                    serde_json::Value::String(description.to_string()),
                                );
                            }
                            sources.push(serde_json::Value::Object(src));
                        }
                        if out.is_empty() {
                            out = "No results.".to_string();
                        }
                        let meta = serde_json::json!({
                            "card": "web",
                            "kind": "search",
                            "sources": sources,
                            "truncated": truncated,
                        });
                        Ok(ToolOutcome {
                            artifact: None,
                            content: out,
                            meta: Some(meta),
                        })
                    }
                    "map" => {
                        let url = args["url"].as_str().ok_or("map requires url")?.to_string();
                        let resp = post_json(
                            &base,
                            "/v1/map",
                            serde_json::json!({ "url": url }),
                            key.as_deref(),
                        )
                        .await?;
                        let links = resp["links"]
                            .as_array()
                            .map(|a| a.as_slice())
                            .unwrap_or(&[]);
                        let mut out = String::new();
                        for link in links.iter().take(MAP_LINK_LIMIT) {
                            let link = match link {
                                serde_json::Value::String(s) => s.as_str(),
                                v => v["url"].as_str().unwrap_or(""),
                            };
                            if !link.is_empty() {
                                out.push_str(link);
                                out.push('\n');
                            }
                        }
                        if out.is_empty() {
                            out = "No links found.".to_string();
                        }
                        Ok(ToolOutcome {
                            artifact: None,
                            content: out,
                            meta: None,
                        })
                    }
                    other => Err(format!("firecrawl integration has no tool {other}")),
                }
            })
        }

        fn test_connection<'a>(
            &'a self,
            config: &'a serde_json::Value,
            secrets: &'a [(String, String)],
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let base = base_url(config);
                let resp = reqwest::Client::new()
                    .get(format!("{base}/"))
                    .timeout(std::time::Duration::from_secs(15));
                let resp = if let Some(key) = api_key(secrets) {
                    resp.bearer_auth(key)
                } else {
                    resp
                };
                let resp = resp
                    .send()
                    .await
                    .map_err(|e| format!("firecrawl unreachable: {e}"))?;
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                if !status.is_success() {
                    return Err(format!("firecrawl rejected the connection ({status})"));
                }
                if !body.contains("Firecrawl API") {
                    return Err(
                        "firecrawl: unexpected response at / (not a Firecrawl API?)".to_string()
                    );
                }
                Ok(())
            })
        }
    }
}

// ---------- generic vendor REST pass-through (the `api` tool) ----------

/// Auth schemes the connectors' `api` tools use.
pub(super) enum ApiAuth {
    Bearer(String),
    Basic(String, String),
    PrivateToken(String),
}

/// The shared tool spec for a connector's `api` tool: the vendor's whole
/// REST surface behind one call — real filters, associations, batch, and
/// pagination, everything the narrow named tools don't cover.
pub(super) fn api_tool_spec(vendor: &str) -> ToolSpec {
    ToolSpec {
        name: "api".into(),
        description: format!(
            "Call any {vendor} REST endpoint directly — the full API surface \
             beyond the named tools. Args: method (GET/POST/PATCH/PUT/DELETE, \
             default GET), path (starts with /), query (object of strings), \
             body (JSON object). Use the named tools for simple lookups; use \
             this for filters, associations, batch operations, and anything \
             else the API supports."
        ),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "method": { "type": "string",
                    "description": "HTTP method, default GET" },
                "path": { "type": "string",
                    "description": "Endpoint path starting with /" },
                "query": { "type": "object",
                    "description": "Query parameters as strings" },
                "body": { "type": "object",
                    "description": "JSON request body (POST/PATCH/PUT)" }
            },
            "required": ["path"]
        }),
        kind: Default::default(),
    }
}

/// Runs one generic vendor REST call. `path` must start with `/`; the
/// method is whitelisted; the body is sent as JSON when present. The raw
/// response text is the content, truncated to `max_chars`.
pub(super) async fn call_vendor_api(
    base: &str,
    auth: &ApiAuth,
    args: &serde_json::Value,
    max_chars: usize,
    extra_headers: &[(&str, &str)],
) -> Result<ToolOutcome, String> {
    let path = args["path"]
        .as_str()
        .ok_or("api requires path (starting with /)")?;
    if !path.starts_with('/') {
        return Err("api path must start with /".to_string());
    }
    let method = args["method"].as_str().unwrap_or("GET").to_uppercase();
    let method = match method.as_str() {
        "GET" | "POST" | "PATCH" | "PUT" | "DELETE" => method,
        other => return Err(format!("api method {other} not allowed")),
    };
    let mut req = reqwest::Client::new()
        .request(method.parse().unwrap(), format!("{base}{path}"))
        .timeout(std::time::Duration::from_secs(60));
    match auth {
        ApiAuth::Bearer(t) => req = req.bearer_auth(t),
        ApiAuth::Basic(u, p) => req = req.basic_auth(u, Some(p)),
        ApiAuth::PrivateToken(t) => {
            req = req.header("PRIVATE-TOKEN", t);
        }
    }
    for (name, value) in extra_headers {
        req = req.header(*name, *value);
    }
    if let Some(q) = args["query"].as_object() {
        for (k, v) in q {
            if let Some(s) = v.as_str() {
                req = req.query(&[(k.as_str(), s)]);
            } else {
                req = req.query(&[(k.as_str(), v.to_string().as_str())]);
            }
        }
    }
    if let Some(b) = args["body"].as_object() {
        req = req.json(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("api call failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("api body unreadable: {e}"))?;
    if !status.is_success() {
        let head: String = text.chars().take(300).collect();
        return Err(format!("api returned {status}: {head}"));
    }
    let truncated = text.chars().count() > max_chars;
    let content: String = text.chars().take(max_chars).collect();
    Ok(ToolOutcome {
        artifact: None,
        content: if truncated {
            format!("{content}\n\n[truncated]")
        } else {
            content
        },
        meta: Some(serde_json::json!({
            "card": "api", "kind": "api",
            "status": status.as_u16(), "truncated": truncated,
        })),
    })
}

// ---------- plugin turn state + disclosure (spec §7) ----------

/// One tool of a plugin (built-in or MCP) as journaled at turn start
/// (namespaced spec + the manifest class). Secret values are never journaled
/// — they are re-resolved from the store at call time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginToolInfo {
    pub spec: ToolSpec,
    pub class: String,
}

/// Turn-start resolution snapshot for one enabled plugin — built-in Rust
/// and MCP plugins resolve through the same journaled shape. Carries
/// everything the turn needs: the executor kind, the tool list, the
/// system-prompt index line, and the guide pointer — never secret values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginTurn {
    pub executor: PluginExecutor,
    pub slug: String,
    pub description: String,
    pub tools: Vec<PluginToolInfo>,
    /// Object-storage key of the first cookbook skill's bundle (guide tool).
    pub guide_object_key: Option<String>,
    /// The installed row's config (non-secret settings, tool_policy, and for
    /// MCP plugins the mcp url / auth shape).
    pub row_config: serde_json::Value,
    /// Declared secret names — values are resolved at call time only.
    pub secret_names: Vec<String>,
    /// Caller → external identity join key (v1: always "email").
    pub identity_key: String,
}

impl PluginTurn {
    /// The journaled tools this plugin exposes that `role` may call, with
    /// their classes (spec §6/§7 policy filter).
    pub fn allowed_infos(&self, role: &str) -> Vec<&PluginToolInfo> {
        self.tools
            .iter()
            .filter(|t| tool_allowed(self, t, role))
            .collect()
    }

    /// The tool names this plugin declares to the model, filtered by the
    /// caller's role (spec §7: a member never sees tools it cannot call).
    pub fn allowed_specs(&self, role: &str) -> Vec<ToolSpec> {
        self.allowed_infos(role)
            .into_iter()
            .map(|t| t.spec.clone())
            .collect()
    }

    pub fn auto_tool_names(&self) -> [String; 2] {
        [
            namespaced_tool(&self.slug, "list_tools"),
            namespaced_tool(&self.slug, "guide"),
        ]
    }
}

// ---------- per-tool admin curation (adapters spec §6) ----------

/// Per-tool approval value forcing a durable approval prompt on every call,
/// regardless of the caller's policy or chat mode.
pub const TOOL_APPROVAL_ALWAYS_ASK: &str = "always_ask";

/// One tool's admin curation as stored on the integration row's config:
/// `config.tools[<raw tool name>] = { "enabled": bool, "approval": str }`.
/// The admin's per-tool configuration is the single source of truth for
/// exposure and approval — for built-in and MCP plugins alike.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCurate {
    pub enabled: bool,
    pub always_ask: bool,
}

/// Reads one tool's stored curation. Absent from the stored config:
/// - adapter-bound (built-in Rust connector): enabled, follow user policy —
///   zero-config behavior is identical to the pre-curation model;
/// - MCP-bound (live discovery): disabled — nothing is exposed that the
///   admin did not approve, and remote drift lands in the disabled state.
///
/// Unknown approval values read as the default (follow user policy).
pub fn tool_curate(row_config: &serde_json::Value, mcp: bool, raw_tool: &str) -> ToolCurate {
    let stored = &row_config["tools"][raw_tool];
    match stored {
        serde_json::Value::Object(_) => ToolCurate {
            enabled: stored["enabled"].as_bool().unwrap_or(!mcp),
            always_ask: stored["approval"].as_str() == Some(TOOL_APPROVAL_ALWAYS_ASK),
        },
        // Not configured: the one default rule per kind.
        _ => ToolCurate {
            enabled: !mcp,
            always_ask: false,
        },
    }
}

/// Whether one journaled tool may be called by `role` (spec §6): per-tool
/// curation first (a disabled tool is invisible — not declared to the model
/// and not callable via the script API), then the class rule (manifest class
/// is the floor; a stored `tool_policy` tightens; admin-class tools are
/// admin-only — owners count as admins). Guards built-in and MCP tools alike.
pub fn tool_allowed(turn: &PluginTurn, info: &PluginToolInfo, role: &str) -> bool {
    let raw = unnamespaced_tool(&turn.slug, &info.spec.name).unwrap_or(&info.spec.name);
    if !tool_curate(&turn.row_config, turn.executor == PluginExecutor::Mcp, raw).enabled {
        return false;
    }
    let class = info.class.as_str();
    if class == "admin" && role != "admin" && role != "owner" {
        return false;
    }
    allowed_classes(&Some(turn.row_config.clone()), role)
        .iter()
        .any(|c| class_rank(c) >= class_rank(class))
}

/// The system-prompt index line for one enabled integration (spec §7.1).
pub fn index_line(turn: &PluginTurn) -> String {
    format!(
        "Integration {}: {} — call {} to discover its tools.",
        turn.slug,
        turn.description,
        namespaced_tool(&turn.slug, "list_tools")
    )
}

/// Guild-provided per-plugin disclosure tools (spec §7.2/§7.3) — never sent
/// to the MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoTool {
    ListTools,
    Guide,
}

/// Recognizes an auto-tool call: `<slug>_list_tools` / `<slug>_guide`
/// (legacy `int_<slug>_…` journals tolerated).
pub fn parse_auto_tool(turns: &[PluginTurn], name: &str) -> Option<(usize, AutoTool)> {
    let name = name.strip_prefix("int_").unwrap_or(name);
    for (i, turn) in turns.iter().enumerate() {
        let [list, guide] = turn.auto_tool_names();
        if name == list {
            return Some((i, AutoTool::ListTools));
        }
        if name == guide {
            return Some((i, AutoTool::Guide));
        }
    }
    None
}

/// Turn-start resolution for the enabled plugins of one org (spec §7/§8) —
/// built-in Rust plugins and MCP plugins resolve through the same snapshot:
/// the tool list with manifest classes, the index line, and the guide
/// pointer. Secrets are checked (declared names must be stored) but only
/// their presence — values are re-resolved from the store at call time. A
/// broken plugin degrades: skipped with a warning, the turn continues
/// without it.
pub async fn resolve_plugins(state: &AppState, org: Uuid) -> anyhow::Result<Vec<PluginTurn>> {
    use guild_core::registry::tool_class;
    let store = state.store().await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let rows = store
        .integrations()
        .list_enabled(org)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let master_key = state.config.master_key()?;
    let mut out = Vec::new();
    for row in rows {
        // An installed v2 bundle is the admin's explicit choice — a row
        // carrying an mcp.url resolves as MCP even when a compiled-in
        // connector of the same slug exists (see upsert_integration).
        if row.config["mcp"]["url"].as_str().is_none() {
            if let Some(plugin) = integration_by_name(&row.name) {
                // Built-in plugin: tools come from tools(config), classes
                // from the in-code manifest — the same snapshot shape as
                // MCP plugins.
                let manifest = plugin.manifest();
                let secret_names = manifest
                    .auth
                    .as_ref()
                    .map(|a| a.secret_names.clone())
                    .unwrap_or_default();
                // Presence check only — values ride to execute() at call
                // time.
                if let Err(e) = store
                    .integration_secrets()
                    .resolve(org, &row.name, &secret_names, &master_key)
                    .await
                {
                    tracing::warn!(
                        "integration {}: secrets unresolved, skipping: {e}",
                        row.name
                    );
                    continue;
                }
                let specs = match plugin.tools(&row.config) {
                    Ok(specs) => specs,
                    Err(e) => {
                        tracing::warn!("integration {}: broken config, skipping: {e}", row.name);
                        continue;
                    }
                };
                let tools = specs
                    .into_iter()
                    .map(|spec| {
                        let class = tool_class(&manifest, &spec.name).to_string();
                        PluginToolInfo {
                            spec: ToolSpec {
                                name: namespaced_tool(&row.name, &spec.name),
                                ..spec
                            },
                            class,
                        }
                    })
                    .collect();
                out.push(PluginTurn {
                    executor: PluginExecutor::Rust,
                    slug: row.name.clone(),
                    description: manifest.description.clone(),
                    tools,
                    guide_object_key: None,
                    row_config: row.config.clone(),
                    secret_names,
                    identity_key: manifest
                        .auth
                        .as_ref()
                        .map(|a| a.identity_key.clone())
                        .unwrap_or_else(|| "email".into()),
                });
                continue;
            }
            // Unknown kind with no mcp.url — nothing to resolve.
            continue;
        }
        // MCP plugin: tools come from the plugin server's list_tools, classes
        // from the registry manifest. The connect happens before curation
        // filtering deliberately: drift detection (new remote tools landing
        // disabled) requires the live list, and turn-start has no cheaper
        // cached source. An org that disables every tool of a row still pays
        // the connection — accepted trade-off, revisit with a tool cache.
        let Some(url) = row.config["mcp"]["url"].as_str() else {
            continue; // unknown kind with no mcp url — ignore rather than fail the turn
        };
        let manifest = match registry_manifest(&store, org, &row.name).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("integration {}: no registry manifest: {e}", row.name);
                continue;
            }
        };
        let secret_names = manifest
            .auth
            .as_ref()
            .map(|a| a.secret_names.clone())
            .unwrap_or_default();
        // Resolve (decrypt) the declared secrets — also the presence check.
        let secrets = match store
            .integration_secrets()
            .resolve(org, &row.name, &secret_names, &master_key)
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "integration {}: secrets unresolved, skipping: {e}",
                    row.name
                );
                continue;
            }
        };
        let headers = envelope_headers(&Uuid::now_v7(), &org, None, None, &secrets);
        let key = PoolKey {
            org,
            slug: row.name.clone(),
            url: url.to_string(),
            acting_as: None,
            secrets_fingerprint: secrets_fingerprint(&secrets),
        };
        let peer = match state.mcp_pool.get_or_connect(&key, url, headers).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("integration {} unreachable, skipping: {e}", row.name);
                continue;
            }
        };
        let listed = match peer.list_tools(None).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!("integration {}: list_tools failed, skipping: {e}", row.name);
                continue;
            }
        };
        let tools = listed
            .tools
            .into_iter()
            .map(|t| PluginToolInfo {
                spec: ToolSpec {
                    name: namespaced_tool(&row.name, &t.name),
                    description: t.description.map(|d| d.into_owned()).unwrap_or_default(),
                    parameters: serde_json::Value::Object((*t.input_schema).clone()),
                    kind: Default::default(),
                },
                class: tool_class(&manifest, &t.name).to_string(),
            })
            .collect();
        let guide_object_key = guide_object_key(&store, org, &manifest).await;
        out.push(PluginTurn {
            executor: PluginExecutor::Mcp,
            slug: row.name.clone(),
            description: manifest.description.clone(),
            tools,
            guide_object_key,
            row_config: row.config.clone(),
            secret_names,
            identity_key: manifest
                .auth
                .as_ref()
                .map(|a| a.identity_key.clone())
                .unwrap_or_else(|| "email".into()),
        });
    }
    Ok(out)
}

/// The manifest whose content an admin's approval covers: resolved only
/// while the item is approved AND the approval's recorded version is still
/// the latest — a republish resets the review status, so unreviewed tool
/// classes and secret declarations never govern member access.
pub(crate) async fn registry_manifest(
    store: &std::sync::Arc<crate::store::Store>,
    org: Uuid,
    slug: &str,
) -> anyhow::Result<BundleManifest> {
    let (version, bundle_sha256) = store
        .registry()
        .approved_bundle(org, "integration", slug)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "registry item {slug} has no approval covering its latest version and bundle"
            )
        })?;
    let stored = store
        .registry()
        .get_version(org, "integration", slug, &version)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    if stored.bundle_sha256.as_deref() != Some(bundle_sha256.as_str()) {
        anyhow::bail!("registry item {slug}: stored bundle no longer matches the approved hash");
    }
    serde_json::from_value::<BundleManifest>(stored.manifest)
        .map_err(|e| anyhow::anyhow!("manifest of {slug} unreadable: {e}"))
}

/// Object-storage key of the first cookbook skill's bundle — resolved only
/// through the approval gate (approved version + bundle hash), so draft,
/// superseded, or byte-swapped skill content never reaches model context.
async fn guide_object_key(
    store: &std::sync::Arc<crate::store::Store>,
    org: Uuid,
    manifest: &BundleManifest,
) -> Option<String> {
    let slug = manifest.skills.first()?;
    // A store error is not unapproved content — the guide degrades to None
    // so a transient store failure never fails plugin resolution for the
    // whole turn. Approval gates below stay fail-closed.
    let Ok(Some((version, bundle_sha256))) =
        store.registry().approved_bundle(org, "skill", slug).await
    else {
        return None;
    };
    let Ok(stored) = store
        .registry()
        .get_version(org, "skill", slug, &version)
        .await
    else {
        return None;
    };
    if stored.bundle_sha256.as_deref() != Some(bundle_sha256.as_str()) {
        return None;
    }
    Some(stored.object_key)
}

/// Executes one call against a resolved plugin: re-resolves the secrets
/// (journaled snapshots never carry values), then runs the built-in plugin
/// directly or connects to the MCP server via the pool with the identity
/// envelope, and calls the raw tool name.
// Plugin dispatch keeps org, caller and call identity separate at this boundary.
#[allow(clippy::too_many_arguments)]
pub async fn call_plugin(
    state: &AppState,
    turn: &PluginTurn,
    raw_tool: &str,
    args: serde_json::Value,
    org: Uuid,
    caller: Uuid,
    call_id: Uuid,
    acting_as: Option<&str>,
) -> Result<ToolOutcome, String> {
    let store = state
        .store()
        .await
        .map_err(|e| format!("store error: {e:?}"))?;
    let master_key = state.config.master_key().map_err(|e| e.to_string())?;
    match turn.executor {
        PluginExecutor::Rust => {
            let plugin = integration_by_name(&turn.slug)
                .ok_or_else(|| format!("unknown integration {}", turn.slug))?;
            // Every stored secret of the slug rides to execute() — the
            // built-in picks what it needs (superproxy's optional gateway
            // token included); values never reach logs or events.
            let names = store
                .integration_secrets()
                .names(org, &turn.slug)
                .await
                .map_err(|e| format!("secrets unavailable: {e:?}"))?
                .into_iter()
                .collect::<Vec<_>>();
            let secrets = store
                .integration_secrets()
                .resolve(org, &turn.slug, &names, &master_key)
                .await
                .map_err(|e| format!("secrets unavailable: {e}"))?;
            plugin
                .execute(&turn.row_config, raw_tool, args, &secrets, acting_as)
                .await
        }
        PluginExecutor::Mcp => {
            let secrets = store
                .integration_secrets()
                .resolve(org, &turn.slug, &turn.secret_names, &master_key)
                .await
                .map_err(|e| format!("secrets unavailable: {e}"))?;
            let url = turn.row_config["mcp"]["url"]
                .as_str()
                .ok_or("mcp url missing")?
                .to_string();
            let headers = envelope_headers(&call_id, &org, Some(&caller), acting_as, &secrets);
            // rmcp headers belong to the transport. A short-lived call
            // connection keeps caller and call ID exact without shared
            // mutable headers or accumulating one pool entry per call.
            let service = crate::worker::mcp_pool::McpPool::connect(&url, headers)
                .await
                .map_err(|e| format!("integration {} unreachable: {e}", turn.slug))?;
            mcp_call_tool(service.peer(), raw_tool, args).await
        }
    }
}

/// Fetches and unpacks the guide body (SKILL.md, falling back to README) of
/// one cookbook bundle from object storage (spec §7.3).
pub async fn fetch_guide(state: &AppState, object_key: &str) -> Option<String> {
    let objects = state.objects().await.ok()?;
    let bundle = objects.get(object_key).await.ok()?;
    for path in ["SKILL.md", "README.md"] {
        if let Ok(Some(bytes)) = guild_core::registry::read_bundle_file(&bundle, path) {
            if let Ok(text) = String::from_utf8(bytes) {
                return Some(text);
            }
        }
    }
    None
}
