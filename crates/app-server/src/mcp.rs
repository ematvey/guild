//! MCP clients: connect to servers configured in `{project}/.guild/mcp.json`
//! and `{config}/guild/mcp.json` (spec §3.2), exposing their tools to the
//! agent.

use anyhow::Context;
use guild_core::tools::{Approval, Tool, ToolFailure, ToolOutcome};
use protocol::api::ToolSpec;
use rmcp::model::{CallToolRequestParams, ClientInfo, Implementation};
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
}

impl McpHandle {
    pub fn tools(&self) -> &[ToolSpec] {
        &self.tools
    }

    pub async fn connect(name: &str, cfg: &McpServerConfig) -> anyhow::Result<Self> {
        let mut info = ClientInfo::default();
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
        let tools = listed
            .tools
            .into_iter()
            .map(|t| ToolSpec {
                name: format!("mcp_{name}_{}", t.name),
                description: t.description.map(|d| d.into_owned()).unwrap_or_default(),
                parameters: Value::Object((*t.input_schema).clone()),
            })
            .collect();
        Ok(Self {
            name: name.to_string(),
            service,
            tools,
        })
    }

    pub fn tool_wrappers(&self) -> Vec<Arc<dyn Tool>> {
        self.tools
            .iter()
            .map(|spec| {
                let service = self.service.peer().clone();
                let spec = spec.clone();
                Arc::new(McpTool { spec, service }) as Arc<dyn Tool>
            })
            .collect()
    }
}

/// One MCP tool surfaced through the registry (default policy: ask).
pub struct McpTool {
    spec: ToolSpec,
    service: rmcp::service::Peer<RoleClient>,
}

#[async_trait::async_trait]
impl Tool for McpTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn default_policy(&self) -> Approval {
        Approval::Ask
    }

    async fn run(&self, _workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure> {
        let raw_name = self
            .spec
            .name
            .strip_prefix("mcp_")
            .and_then(|rest| rest.split_once('_'))
            .map(|(_, tool)| tool)
            .unwrap_or("?")
            .to_string();
        let mut params = CallToolRequestParams::new(raw_name.clone());
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
            ui_summary: Some(format!("mcp::{}", self.spec.name)),
            diff: None,
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
