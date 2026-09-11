//! Integration plugins: server-side tools for the chat loop, contributed by
//! admin-configured integrations (per org). Adding an integration means
//! implementing [`Integration`] and registering it in [`integration_by_name`];
//! admins then enable it per org via the admin API — an integration
//! contributes tools only while enabled.

use crate::store::integrations::IntegrationRow;
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

/// One integration plugin. `config` is the admin-supplied JSON (e.g. the
/// searxng base URL); `tools(config)` validates the config and declares the
/// tool surface it contributes.
pub trait Integration: Send + Sync {
    fn name(&self) -> &'static str;
    fn category(&self) -> Category;
    /// Validate config and declare tools. An error here means the admin
    /// supplied a broken config — the integration contributes nothing.
    fn tools(&self, config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>>;
    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
    ) -> BoxFuture<'a, Result<ToolOutcome, String>>;
}

/// The registry of available integration kinds (code-level plugins).
pub fn integration_by_name(name: &str) -> Option<Arc<dyn Integration>> {
    match name {
        "searxng" => Some(Arc::new(searxng::Searxng)),
        "superproxy" => Some(Arc::new(superproxy::Superproxy)),
        _ => None,
    }
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
            plugin.execute(&tool.config, mcp_tool, args).await
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

pub mod searxng {
    use super::{Category, Integration, ToolOutcome};
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
    use super::{Category, Integration, ToolOutcome};
    use futures::future::BoxFuture;
    use protocol::api::ToolSpec;

    const DEFAULT_MAX_CHARS: usize = 8000;

    /// Superproxy fetch integration (spec D). Config:
    /// `{ "base_url": "http://host:15505", "token"?: "…" }`.
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
                let (base, token) = config_parts(config).map_err(|e| e.to_string())?;
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
