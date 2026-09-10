//! Integration plugins: server-side tools for the chat loop, contributed by
//! admin-configured integrations (per org). Adding an integration means
//! implementing [`Integration`] and registering it in [`integration_by_name`];
//! admins then enable it per org via the admin API — an integration
//! contributes tools only while enabled.

use crate::store::integrations::IntegrationRow;
use futures::future::BoxFuture;
use protocol::api::ToolSpec;
use std::sync::Arc;

/// One integration plugin. `config` is the admin-supplied JSON (e.g. the
/// searxng base URL); `tools(config)` validates the config and declares the
/// tool surface it contributes.
pub trait Integration: Send + Sync {
    fn name(&self) -> &'static str;
    /// Validate config and declare tools. An error here means the admin
    /// supplied a broken config — the integration contributes nothing.
    fn tools(&self, config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>>;
    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
    ) -> BoxFuture<'a, Result<String, String>>;
}

/// The registry of available integration kinds (code-level plugins).
pub fn integration_by_name(name: &str) -> Option<Arc<dyn Integration>> {
    match name {
        "searxng" => Some(Arc::new(searxng::Searxng)),
        _ => None,
    }
}

/// Resolves the enabled integrations of one org into concrete server tools.
pub struct ServerTool {
    pub spec: ToolSpec,
    pub integration: Arc<dyn Integration>,
    pub config: serde_json::Value,
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
                integration: plugin.clone(),
                config: row.config.clone(),
            });
        }
    }
    Ok(out)
}

pub mod searxng {
    use super::Integration;
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
        ) -> BoxFuture<'a, Result<String, String>> {
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
                let mut out = String::new();
                for (i, hit) in body["results"]
                    .as_array()
                    .map(|a| a.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .take(count)
                    .enumerate()
                {
                    let title = hit["title"].as_str().unwrap_or("(untitled)");
                    let url = hit["url"].as_str().unwrap_or("");
                    let snippet = hit["content"].as_str().unwrap_or("");
                    out.push_str(&format!("{}. {}\n{}\n{}\n\n", i + 1, title, url, snippet));
                }
                if out.is_empty() {
                    out = "No results.".to_string();
                }
                Ok(out)
            })
        }
    }
}
