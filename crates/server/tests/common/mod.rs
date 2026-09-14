//! Shared fixtures for integration test binaries.

use serde_json::{json, Value};
use std::sync::Arc;

// ---------- fixture MCP server (rmcp streamable HTTP, in-process) ----------

/// Exposes `echo(text) -> text` and `admin_only_op() -> error result`,
/// bound on 127.0.0.1:<random port>. Returns the base URL.
pub async fn spawn_fixture() -> String {
    use axum::Router;
    use rmcp::ErrorData as McpError;
    use rmcp::handler::server::ServerHandler;
    use rmcp::model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        ServerInfo, Tool,
    };
    use rmcp::service::{RequestContext, RoleServer};
    use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
    use rmcp::transport::streamable_http_server::tower::{StreamableHttpService, StreamableHttpServerConfig};

    struct Fixture;

    impl ServerHandler for Fixture {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::default()
        }

        async fn list_tools(
            &self,
            _request: Option<rmcp::model::PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> Result<ListToolsResult, McpError> {
            Ok(ListToolsResult {
                tools: vec![
                    Tool::new(
                        "echo",
                        "Echoes the text back",
                        json!({
                            "type": "object",
                            "properties": { "text": { "type": "string" } },
                            "required": ["text"]
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    ),
                    Tool::new(
                        "admin_only_op",
                        "An operation reserved for admins",
                        json!({ "type": "object", "properties": {} })
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                ],
                ..Default::default()
            })
        }

        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, McpError> {
            let text = request
                .arguments
                .as_ref()
                .and_then(|a| a.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match request.name.as_ref() {
                "echo" => Ok(CallToolResponse::Complete(CallToolResult::success(
                    vec![ContentBlock::text(format!("echo: {text}"))],
                ))),
                "admin_only_op" => Ok(CallToolResponse::Complete(CallToolResult::error(
                    vec![ContentBlock::text("denied")],
                ))),
                other => {
                    let _ = other;
                    Err(McpError::method_not_found::<rmcp::model::CallToolRequestMethod>())
                }
            }
        }
    }

    let service = StreamableHttpService::new(
        || Ok(Fixture),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let app = Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{addr}/mcp")
}

