//! MCP clients: connect to servers configured in `{project}/.guild/mcp.json`
//! and `{config}/guild/mcp.json` (spec §3.2), exposing their tools to the
//! agent.

use anyhow::Context;
use guild_core::tools::{Tool, ToolFailure, ToolOutcome};
use protocol::api::ToolSpec;
use rmcp::model::{CallToolRequestParams, ClientConfig, Implementation};
use rmcp::service::{serve_client, RoleClient, RunningService};
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use tokio::process::Command;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct McpServerConfig {
    /// Spawn a local server: program + args.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    /// Or connect over HTTP (streamable HTTP transport).
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct McpFile {
    #[serde(default)]
    pub servers: BTreeMap<String, McpServerConfig>,
}

/// Reads and merges the project and user mcp.json files (project wins).
pub fn load_servers(project_dir: &Path, config_dir: &Path) -> BTreeMap<String, McpServerConfig> {
    let mut merged = BTreeMap::new();
    for path in [
        config_dir.join("mcp.json"),
        project_dir.join(".guild").join("mcp.json"),
    ] {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(file) = serde_json::from_slice::<McpFile>(&bytes) else {
            eprintln!("warning: malformed mcp.json at {}", path.display());
            continue;
        };
        for (name, cfg) in file.servers {
            merged.insert(name, cfg);
        }
    }
    merged
}

type Service = RunningService<RoleClient, rmcp::model::InitializeRequestParams>;

/// A connected MCP server with its tools wrapped as agent tools.
pub struct McpHandle {
    pub name: String,
    service: Service,
    tools: Vec<ToolSpec>,
    /// Wire tool name → raw MCP tool name (server names may contain '_';
    /// parsing the wire name back is unreliable).
    raw_names: std::collections::HashMap<String, String>,
}

impl McpHandle {
    pub fn tools(&self) -> &[ToolSpec] {
        &self.tools
    }

    pub async fn connect(name: &str, cfg: &McpServerConfig) -> anyhow::Result<Self> {
        let mut info = ClientConfig::default();
        info.client_info = Implementation::new("guild", "0.1.0");
        let service: Service = if let Some(cmd) = &cfg.command {
            let [program, args @ ..] = cmd.as_slice() else {
                anyhow::bail!("mcp server {name}: command needs at least a program");
            };
            let mut command = Command::new(program);
            command.args(args);
            let transport = TokioChildProcess::new(command)?;
            serve_client(info, transport)
                .await
                .context(format!("mcp {name}: handshake failed"))?
        } else if let Some(url) = &cfg.url {
            let transport = StreamableHttpClientTransport::from_uri(url.as_str());
            serve_client(info, transport)
                .await
                .context(format!("mcp {name}: connect failed"))?
        } else {
            anyhow::bail!("mcp server {name}: needs command or url");
        };
        let listed = service.peer().list_tools(None).await?;
        // Wire tool name → raw MCP tool name. Parsing the wire name back out
        // of `mcp_{server}_{tool}` mis-splits when the server name contains
        // '_', so the raw name is carried from the tool listing instead.
        let mut raw_names = std::collections::HashMap::new();
        let mut tools = Vec::new();
        for t in listed.tools {
            let wire = format!("mcp_{name}_{}", t.name);
            raw_names.insert(wire.clone(), t.name.to_string());
            tools.push(ToolSpec {
                name: wire,
                description: t.description.map(|d| d.into_owned()).unwrap_or_default(),
                parameters: Value::Object((*t.input_schema).clone()),
                kind: Default::default(),
            });
        }
        Ok(Self {
            name: name.to_string(),
            service,
            tools,
            raw_names,
        })
    }

    pub fn tool_wrappers(&self) -> Vec<Arc<dyn Tool>> {
        self.tools
            .iter()
            .map(|spec| {
                let service = self.service.peer().clone();
                let spec = spec.clone();
                let raw_name = self.raw_names.get(&spec.name).cloned();
                Arc::new(McpTool {
                    spec,
                    service,
                    raw_name,
                }) as Arc<dyn Tool>
            })
            .collect()
    }
}

/// One MCP tool surfaced through the registry (default policy: ask).
pub struct McpTool {
    spec: ToolSpec,
    service: rmcp::service::Peer<RoleClient>,
    /// The tool's name on its MCP server, as listed at connect time.
    raw_name: Option<String>,
}

#[async_trait::async_trait]
impl Tool for McpTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    async fn run(&self, _workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let raw_name = self.raw_name.clone().ok_or_else(|| {
            ToolFailure::Execution(format!(
                "mcp tool {} is no longer listed on its server",
                self.spec.name
            ))
        })?;
        let mut params = CallToolRequestParams::new(raw_name);
        if let Some(obj) = args.as_object() {
            params = params.with_arguments(obj.clone());
        }
        let result = self
            .service
            .call_tool(params)
            .await
            .map_err(|e| ToolFailure::Execution(format!("mcp call failed: {e}")))?;
        let text: String = result
            .content
            .iter()
            .filter_map(|c| match c {
                rmcp::model::ContentBlock::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if result.is_error.unwrap_or(false) {
            return Err(ToolFailure::Execution(format!("mcp tool error: {text}")));
        }
        Ok(ToolOutcome {
            images: Vec::new(),
            output_for_model: text,
            meta: None,
        })
    }
}

/// Connects to all configured servers; failures are logged and skipped so a
/// broken MCP server never blocks the agent session.
pub async fn connect_all(project_dir: &Path, config_dir: &Path) -> Vec<(String, McpHandle)> {
    let mut out = Vec::new();
    for (name, cfg) in load_servers(project_dir, config_dir) {
        match McpHandle::connect(&name, &cfg).await {
            Ok(h) => out.push((name, h)),
            Err(e) => eprintln!("warning: mcp server {name} unavailable: {e}"),
        }
    }
    out
}
