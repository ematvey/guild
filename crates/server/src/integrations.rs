//! Integration plugins: server-side tools for the chat loop, contributed by
//! admin-configured integrations (per org). Adding an integration means
//! implementing [`Integration`] and registering it in [`integration_by_name`];
//! admins then enable it per org via the admin API — an integration
//! contributes tools only while enabled.

use crate::store::integrations::IntegrationRow;
use crate::state::AppState;
use crate::worker::mcp_pool::{McpPool, PoolKey, secrets_fingerprint};
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
}

/// One integration plugin. `config` is the admin-supplied JSON with the
/// non-secret settings only (e.g. the searxng base URL); `tools(config)`
/// validates the config and declares the tool surface it contributes.
pub trait Integration: Send + Sync {
    fn name(&self) -> &'static str;
    fn category(&self) -> Category;
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
    /// credentials; config keeps non-secret settings only.
    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<ToolOutcome, String>>;
}

/// The compiled-in integration kinds — keep in sync with
/// [`integration_by_name`].
pub fn integration_names() -> &'static [&'static str] {
    &[
        "searxng",
        "superproxy",
        #[cfg(feature = "test-support")]
        "testplug",
    ]
}

/// The registry of available integration kinds (code-level plugins).
pub fn integration_by_name(name: &str) -> Option<Arc<dyn Integration>> {
    match name {
        "searxng" => Some(Arc::new(searxng::Searxng)),
        "superproxy" => Some(Arc::new(superproxy::Superproxy)),
        #[cfg(feature = "test-support")]
        "testplug" => Some(Arc::new(testplug::TestPlug)),
        _ => None,
    }
}

/// Builds an in-code manifest in the registry's v2 shape and validates it
/// against the same rules a published bundle must pass (legal tool classes,
/// namespaced-name length) — built-ins reuse the registry validation, they
/// do not fork it.
pub fn in_code_manifest(
    name: &str,
    version: &str,
    description: &str,
    secret_names: &[&str],
    classes: &[(&str, &str)],
) -> BundleManifest {
    let manifest = BundleManifest {
        kind: "integration".to_string(),
        slug: name.to_string(),
        version: version.to_string(),
        description: description.to_string(),
        auth: Some(guild_core::registry::AuthManifest {
            secret_names: secret_names.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
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

/// How a server tool executes: a compiled-in Rust plugin or a remote MCP
/// server implementing the plugin contract (spec §3).
#[derive(Clone)]
pub enum ServerExecutor {
    Rust(Arc<dyn Integration>),
    Mcp(Box<McpEndpoint>),
}

/// One MCP plugin endpoint: the resolved connection facts (secrets decrypted
/// at turn start, never persisted in logs or events).
#[derive(Clone, Debug)]
pub struct McpEndpoint {
    pub slug: String,
    pub url: String,
    pub secrets: Vec<(String, String)>,
    pub manifest: BundleManifest,
}

/// Identity carried on one MCP tool call (spec §5): the envelope headers
/// are built from these values plus the resolved secrets.
#[derive(Clone, Debug)]
pub struct McpCallIdentity {
    pub org: Uuid,
    pub caller: Option<Uuid>,
    pub acting_as: Option<String>,
    pub call_id: Uuid,
}

/// Resolves the enabled integrations of one org into concrete server tools.
#[derive(Clone)]
pub struct ServerTool {
    pub spec: ToolSpec,
    pub executor: ServerExecutor,
    pub config: serde_json::Value,
}

/// Guild-provided tool name for an MCP plugin tool: `int_<slug>_<tool>`.
pub fn namespaced_tool(slug: &str, tool: &str) -> String {
    format!("int_{slug}_{tool}")
}

/// Strips the `int_<slug>_` namespace back off.
pub fn unnamespaced_tool<'a>(slug: &str, tool: &'a str) -> Option<&'a str> {
    tool.strip_prefix(&format!("int_{slug}_"))
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
        content: text,
        meta: None,
    })
}

/// Executes one resolved server tool. MCP calls go through the pool with the
/// identity envelope + secret headers; Rust plugins execute directly.
pub async fn execute_server_tool(
    tool: &ServerTool,
    mcp_tool: &str,
    args: serde_json::Value,
    pool: &McpPool,
    identity: &McpCallIdentity,
) -> Result<ToolOutcome, String> {
    match &tool.executor {
        ServerExecutor::Rust(plugin) => {
            plugin.execute(&tool.config, mcp_tool, args, &[]).await
        }
        ServerExecutor::Mcp(endpoint) => {
            let headers = envelope_headers(
                &identity.call_id,
                &identity.org,
                identity.caller.as_ref(),
                identity.acting_as.as_deref(),
                &endpoint.secrets,
            );
            let key = PoolKey {
                slug: endpoint.slug.clone(),
                url: endpoint.url.clone(),
                acting_as: identity.acting_as.clone(),
                secrets_fingerprint: secrets_fingerprint(&endpoint.secrets),
            };
            let peer = pool
                .get_or_connect(&key, &endpoint.url, headers)
                .await
                .map_err(|e| format!("integration {} unreachable: {e}", endpoint.slug))?;
            mcp_call_tool(&peer, mcp_tool, args).await
        }
    }
}

pub fn resolve_server_tools(rows: &[IntegrationRow]) -> anyhow::Result<Vec<ServerTool>> {
    let mut out = Vec::new();
    for row in rows {
        let Some(plugin) = integration_by_name(&row.name) else {
            continue; // unknown kind — ignore rather than fail the turn
        };
        for spec in plugin.tools(&row.config)? {
            out.push(ServerTool {
                spec,
                executor: ServerExecutor::Rust(plugin.clone()),
                config: row.config.clone(),
            });
        }
    }
    Ok(out)
}

/// Test-only built-in plugin (compiled with the `test-support` feature):
/// declares a required secret plus a read and an admin tool, so the
/// unified-resolution tests can exercise the enable gate, secrets
/// resolution into execute, class enforcement, and the script API end to
/// end. Its tools never touch the network.
#[cfg(feature = "test-support")]
pub mod testplug {
    use super::{in_code_manifest, Category, Integration, ToolOutcome};
    use futures::future::BoxFuture;
    use guild_core::registry::BundleManifest;
    use protocol::api::ToolSpec;

    pub struct TestPlug;

    impl Integration for TestPlug {
        fn name(&self) -> &'static str {
            "testplug"
        }

        fn category(&self) -> Category {
            Category::Other
        }

        fn manifest(&self) -> BundleManifest {
            in_code_manifest(
                "testplug",
                "0.1.0",
                "Test tools for the unified plugin interface",
                &["api_key"],
                &[("secret_echo", "read"), ("admin_op", "admin")],
            )
        }

        fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
            Ok(vec![
                ToolSpec {
                    name: "secret_echo".into(),
                    description: "Reports whether the declared secret resolved.".into(),
                    parameters: serde_json::json!({ "type": "object", "properties": {} }),
                },
                ToolSpec {
                    name: "admin_op".into(),
                    description: "An operation reserved for admins.".into(),
                    parameters: serde_json::json!({ "type": "object", "properties": {} }),
                },
            ])
        }

        fn execute<'a>(
            &'a self,
            _config: &'a serde_json::Value,
            tool: &'a str,
            _args: serde_json::Value,
            secrets: &'a [(String, String)],
        ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
            Box::pin(async move {
                match tool {
                    // Reflects secret resolution without ever echoing the value.
                    "secret_echo" => {
                        let present = secrets.iter().any(|(name, _)| name == "api_key");
                        Ok(ToolOutcome {
                            content: format!("api_key present: {present}"),
                            meta: None,
                        })
                    }
                    "admin_op" => Ok(ToolOutcome {
                        content: "admin ok".to_string(),
                        meta: None,
                    }),
                    other => Err(format!("testplug integration has no tool {other}")),
                }
            })
        }
    }
}

pub mod searxng {
    use super::{in_code_manifest, Category, Integration, ToolOutcome};
    use guild_core::registry::BundleManifest;
    use futures::future::BoxFuture;
    use protocol::api::ToolSpec;

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

        fn category(&self) -> Category {
            Category::Search
        }

        fn manifest(&self) -> BundleManifest {
            in_code_manifest(
                "searxng",
                "1.0.0",
                "Web search through a SearxNG instance",
                &[],
                &[("web_search", "read")],
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
            }])
        }

        fn execute<'a>(
            &'a self,
            config: &'a serde_json::Value,
            tool: &'a str,
            args: serde_json::Value,
            _secrets: &'a [(String, String)],
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
                    content: out,
                    meta: Some(meta),
                })
            })
        }
    }
}

pub mod superproxy {
    use super::{in_code_manifest, Category, Integration, ToolOutcome};
    use guild_core::registry::BundleManifest;
    use futures::future::BoxFuture;
    use protocol::api::ToolSpec;

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

        fn category(&self) -> Category {
            Category::Fetch
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
            }])
        }

        fn execute<'a>(
            &'a self,
            config: &'a serde_json::Value,
            tool: &'a str,
            args: serde_json::Value,
            secrets: &'a [(String, String)],
        ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
            Box::pin(async move {
                if tool != "web_fetch" {
                    return Err(format!("superproxy integration has no tool {tool}"));
                }
                let target = args["url"]
                    .as_str()
                    .ok_or("web_fetch requires url")?
                    .to_string();
                let max_chars = args["max_chars"].as_u64().unwrap_or(DEFAULT_MAX_CHARS as u64)
                    as usize;
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
                    content,
                    meta: Some(meta),
                })
            })
        }
    }
}

// ---------- MCP plugin turn state + disclosure (spec §7) ----------

/// One tool of an MCP plugin as journaled at turn start (namespaced spec +
/// the manifest class). Secret values are never journaled — they are
/// re-resolved from the store at call time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub spec: ToolSpec,
    pub class: String,
}

/// Turn-start resolution snapshot for one MCP plugin (journaled). Carries
/// everything the turn needs: the tool list, the system-prompt index line,
/// and the guide pointer — never secret values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPluginTurn {
    pub slug: String,
    pub description: String,
    pub tools: Vec<McpToolInfo>,
    /// Object-storage key of the first cookbook skill's bundle (guide tool).
    pub guide_object_key: Option<String>,
    /// The installed row's config (mcp url, auth shape, tool_policy).
    pub row_config: serde_json::Value,
    /// Declared secret names — values are resolved at call time only.
    pub secret_names: Vec<String>,
    /// Caller → external identity join key (v1: always "email").
    pub identity_key: String,
}

impl McpPluginTurn {
    /// The journaled tools this plugin exposes that `role` may call, with
    /// their classes (spec §6/§7 policy filter).
    pub fn allowed_infos(&self, role: &str) -> Vec<&McpToolInfo> {
        self.tools
            .iter()
            .filter(|t| mcp_tool_allowed(t, &self.row_config, role))
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

/// Whether one journaled tool may be called by `role` under the row's
/// `tool_policy` (spec §6: manifest class is the floor; a stored policy
/// tightens; admin-class tools are admin-only — owners count as admins).
pub fn mcp_tool_allowed(info: &McpToolInfo, row_config: &serde_json::Value, role: &str) -> bool {
    let class = info.class.as_str();
    if class == "admin" && role != "admin" && role != "owner" {
        return false;
    }
    allowed_classes(&Some(row_config.clone()), role)
        .iter()
        .any(|c| class_rank(c) >= class_rank(class))
}

/// The system-prompt index line for one enabled integration (spec §7.1).
pub fn mcp_index_line(turn: &McpPluginTurn) -> String {
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

/// Recognizes an auto-tool call: `int_<slug>_list_tools` / `int_<slug>_guide`.
pub fn parse_auto_tool(turns: &[McpPluginTurn], name: &str) -> Option<(usize, AutoTool)> {
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

/// Turn-start resolution for MCP plugins (spec §7/§8): resolves enabled rows
/// with an `mcp.url`, the registry manifest, the tool list (connect via the
/// pool), and the guide pointer. Secrets are checked (declared names must be
/// stored) but only their presence — values ride the pool connection at call
/// time. A broken plugin degrades: skipped with a warning, the turn
/// continues without it.
pub async fn resolve_mcp_plugins(
    state: &AppState,
    org: Uuid,
) -> anyhow::Result<Vec<McpPluginTurn>> {
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
        let Some(url) = row.config["mcp"]["url"].as_str() else {
            continue; // v1 (compiled-in) row — handled by resolve_server_tools
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
                tracing::warn!("integration {}: secrets unresolved, skipping: {e}", row.name);
                continue;
            }
        };
        let headers = envelope_headers(&Uuid::now_v7(), &org, None, None, &secrets);
        let key = PoolKey {
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
            .map(|t| McpToolInfo {
                spec: ToolSpec {
                    name: namespaced_tool(&row.name, &t.name),
                    description: t.description.map(|d| d.into_owned()).unwrap_or_default(),
                    parameters: serde_json::Value::Object((*t.input_schema).clone()),
                },
                class: tool_class(&manifest, &t.name).to_string(),
            })
            .collect();
        let guide_object_key = guide_object_key(&store, org, &manifest).await?;
        out.push(McpPluginTurn {
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

/// Latest manifest of one registry integration item (any review status — an
/// installed row keeps resolving even if a republish reset the status).
async fn registry_manifest(
    store: &std::sync::Arc<crate::store::Store>,
    org: Uuid,
    slug: &str,
) -> anyhow::Result<BundleManifest> {
    let items = store
        .registry()
        .list_items(org, "integration")
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let item = items
        .iter()
        .find(|i| i.slug == slug)
        .ok_or_else(|| anyhow::anyhow!("no registry item {slug}"))?;
    let version = item
        .latest_version
        .clone()
        .ok_or_else(|| anyhow::anyhow!("registry item {slug} has no version"))?;
    let stored = store
        .registry()
        .get_version(org, "integration", slug, &version)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    serde_json::from_value::<BundleManifest>(stored.manifest)
        .map_err(|e| anyhow::anyhow!("manifest of {slug} unreadable: {e}"))
}

/// Object-storage key of the first cookbook skill's latest version bundle.
async fn guide_object_key(
    store: &std::sync::Arc<crate::store::Store>,
    org: Uuid,
    manifest: &BundleManifest,
) -> anyhow::Result<Option<String>> {
    let Some(slug) = manifest.skills.first() else {
        return Ok(None);
    };
    let items = match store.registry().list_items(org, "skill").await {
        Ok(items) => items,
        Err(_) => return Ok(None),
    };
    let Some(item) = items.iter().find(|i| &i.slug == slug) else {
        return Ok(None);
    };
    let Some(version) = item.latest_version.clone() else {
        return Ok(None);
    };
    let stored = store
        .registry()
        .get_version(org, "skill", slug, &version)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(Some(stored.object_key))
}

/// Executes one call against an MCP plugin's server: re-resolves the
/// declared secrets (journaled snapshots never carry values), connects via
/// the pool with the identity envelope, and calls the raw tool name.
pub async fn call_mcp_plugin(
    state: &AppState,
    turn: &McpPluginTurn,
    raw_tool: &str,
    args: serde_json::Value,
    org: Uuid,
    acting_as: Option<&str>,
) -> Result<ToolOutcome, String> {
    let store = state.store().await.map_err(|e| format!("store error: {e:?}"))?;
    let master_key = state.config.master_key().map_err(|e| e.to_string())?;
    let secrets = store
        .integration_secrets()
        .resolve(org, &turn.slug, &turn.secret_names, &master_key)
        .await
        .map_err(|e| format!("secrets unavailable: {e}"))?;
    let url = turn.row_config["mcp"]["url"]
        .as_str()
        .ok_or("mcp url missing")?
        .to_string();
    let headers = envelope_headers(
        &Uuid::now_v7(),
        &org,
        None,
        acting_as,
        &secrets,
    );
    let key = PoolKey {
        slug: turn.slug.clone(),
        url: url.clone(),
        acting_as: acting_as.map(str::to_string),
        secrets_fingerprint: secrets_fingerprint(&secrets),
    };
    let peer = state
        .mcp_pool
        .get_or_connect(&key, &url, headers)
        .await
        .map_err(|e| format!("integration {} unreachable: {e}", turn.slug))?;
    mcp_call_tool(&peer, raw_tool, args).await
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
