//! MCP plugin executor tests: connection pool against an in-process fixture
//! MCP server, tool-class enforcement, identity resolution, and the
//! identity envelope headers (milestone 9, Task W1).

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::{HeaderMap, HeaderName};
use guild_server::integrations::{
    enforce_class, envelope_headers, mcp_call_tool, namespaced_tool, resolve_acting_as,
    McpCallIdentity, McpEndpoint, ServerExecutor, ServerTool,
};
use guild_server::worker::mcp_pool::{McpPool, PoolKey};
use protocol::api::ToolSpec;
use serde_json::{json, Value};
use uuid::Uuid;

// ---------- fixture MCP server (rmcp streamable HTTP, in-process) ----------

/// Exposes `echo(text) -> text` and `admin_only_op() -> error result`,
/// bound on 127.0.0.1:<random port>. Returns the base URL.
async fn spawn_fixture() -> String {
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

// ---------- pool ----------

#[tokio::test]
async fn pool_connects_to_fixture_and_lists_tools() {
    let url = spawn_fixture().await;
    let pool = McpPool::new();
    let key = PoolKey {
        slug: "hubspot".into(),
        url: url.clone(),
        acting_as: None,
        secrets_fingerprint: 0,
    };
    let peer = pool.get_or_connect(&key, &url, HeaderMap::new()).await.unwrap();
    let listed = peer.list_tools(None).await.unwrap();
    let names: Vec<&str> = listed.tools.iter().map(|t| t.name.as_ref()).collect();
    assert!(names.contains(&"echo"));
    assert!(names.contains(&"admin_only_op"));
}

#[tokio::test]
async fn pool_reuses_connection_for_same_key() {
    let url = spawn_fixture().await;
    let pool = McpPool::new();
    let key = PoolKey {
        slug: "hubspot".into(),
        url: url.clone(),
        acting_as: None,
        secrets_fingerprint: 0,
    };
    let _first = pool.get_or_connect(&key, &url, HeaderMap::new()).await.unwrap();
    // Same key must be served from the pool (a second connect would also
    // work, but the pooled entry is what makes envelope headers
    // per-connection).
    let second = pool.get_or_connect(&key, &url, HeaderMap::new()).await.unwrap();
    let listed = second.list_tools(None).await.unwrap();
    assert_eq!(listed.tools.len(), 2);
    assert_eq!(pool.len(), 1);
}

#[tokio::test]
async fn pool_reconnects_when_secrets_change() {
    let url = spawn_fixture().await;
    let pool = McpPool::new();
    let key = PoolKey {
        slug: "hubspot".into(),
        url: url.clone(),
        acting_as: None,
        secrets_fingerprint: 0,
    };
    let _ = pool.get_or_connect(&key, &url, HeaderMap::new()).await.unwrap();
    let key2 = PoolKey { secrets_fingerprint: 7, ..key };
    let _ = pool.get_or_connect(&key2, &url, HeaderMap::new()).await.unwrap();
    assert_eq!(pool.len(), 2);
}

#[tokio::test]
async fn pool_connect_failure_is_an_error() {
    // Port 1 refuses connections — a broken server degrades, never panics.
    let pool = McpPool::new();
    let key = PoolKey {
        slug: "hubspot".into(),
        url: "http://127.0.0.1:1/mcp".into(),
        acting_as: None,
        secrets_fingerprint: 0,
    };
    assert!(pool
        .get_or_connect(&key, &key.url, HeaderMap::new())
        .await
        .is_err());
}

#[tokio::test]
async fn mcp_call_roundtrip_through_fixture() {
    let url = spawn_fixture().await;
    let pool = McpPool::new();
    let key = PoolKey {
        slug: "hubspot".into(),
        url: url.clone(),
        acting_as: None,
        secrets_fingerprint: 0,
    };
    let peer = pool.get_or_connect(&key, &url, HeaderMap::new()).await.unwrap();
    let out = mcp_call_tool(&peer, "echo", json!({ "text": "hi" }))
        .await
        .unwrap();
    assert_eq!(out.content, "echo: hi");
    assert!(out.meta.is_none());
}

// ---------- enforcement ----------

fn mcp_manifest(classes: Value) -> Value {
    json!({
        "kind": "integration",
        "slug": "hubspot",
        "version": "1.0.0",
        "description": "d",
        "mcp": { "url": "https://mcp.example.com/mcp" },
        "tools": { "classes": classes }
    })
}

fn manifest(classes: Value) -> guild_core::registry::BundleManifest {
    serde_json::from_value(mcp_manifest(classes)).unwrap()
}

#[test]
fn enforce_class_manifest_class_is_the_floor() {
    let m = manifest(json!({ "search_contacts": "read", "update_deal": "write", "purge": "admin" }));

    // Default policy: member read-only, admin everything.
    assert!(enforce_class(&m, &None, "member", "search_contacts"));
    assert!(!enforce_class(&m, &None, "member", "update_deal"));
    assert!(!enforce_class(&m, &None, "member", "purge"));
    assert!(enforce_class(&m, &None, "admin", "update_deal"));
    assert!(enforce_class(&m, &None, "admin", "purge"));
    // Org owner counts as admin.
    assert!(enforce_class(&m, &None, "owner", "purge"));
}

#[test]
fn enforce_class_unknown_tool_defaults_to_read() {
    let m = manifest(json!({}));
    assert!(enforce_class(&m, &None, "member", "undeclared_tool"));
    assert!(enforce_class(&m, &None, "admin", "undeclared_tool"));
}

#[test]
fn enforce_class_policy_tightens_never_loosens() {
    let m = manifest(json!({ "update_deal": "write" }));

    // Policy tightened below default: admin loses write.
    let tight = json!({ "tool_policy": { "member": ["read"], "admin": ["read"] } });
    assert!(!enforce_class(&m, &Some(tight), "admin", "update_deal"));

    // A policy grant wider than the manifest class cannot loosen it: an
    // admin-class tool stays admin-only.
    let m2 = manifest(json!({ "purge": "admin" }));
    let wide = json!({ "tool_policy": { "member": ["read", "write", "admin"] } });
    assert!(!enforce_class(&m2, &Some(wide), "member", "purge"));

    // Policy may grant write to members when the manifest declares write.
    let grant = json!({ "tool_policy": { "member": ["read", "write"] } });
    assert!(enforce_class(&m, &Some(grant), "member", "update_deal"));
}

// ---------- identity ----------

#[test]
fn resolve_acting_as_rules() {
    // No override: acting as the caller's own email.
    assert_eq!(
        resolve_acting_as(Some("a@b.c"), None, false).unwrap(),
        Some("a@b.c".to_string())
    );
    // No caller email (org API key): null unless declared.
    assert_eq!(resolve_acting_as(None, None, false).unwrap(), None);
    // Non-admin override rejected.
    assert!(resolve_acting_as(Some("a@b.c"), Some("x@y.z"), false).is_err());
    // Admin override allowed.
    assert_eq!(
        resolve_acting_as(Some("a@b.c"), Some("x@y.z"), true).unwrap(),
        Some("x@y.z".to_string())
    );
    // Override equal to the caller's own identity is always fine.
    assert_eq!(
        resolve_acting_as(Some("a@b.c"), Some("a@b.c"), false).unwrap(),
        Some("a@b.c".to_string())
    );
}

// ---------- envelope ----------

fn header<'a>(map: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let name = HeaderName::from_lowercase(name.as_bytes()).unwrap();
    map.get(name).map(|v| v.to_str().unwrap())
}

#[test]
fn envelope_headers_carry_ids_and_secrets() {
    let call_id = Uuid::now_v7();
    let org = Uuid::now_v7();
    let caller = Uuid::now_v7();
    let secrets = vec![("api_key".to_string(), "sk-123".to_string())];
    let map = envelope_headers(&call_id, &org, Some(&caller), Some("a@b.c"), &secrets);
    assert_eq!(header(&map, "x-guild-org").unwrap(), org.to_string());
    assert_eq!(header(&map, "x-guild-caller").unwrap(), caller.to_string());
    assert_eq!(header(&map, "x-guild-acting-as").unwrap(), "a@b.c");
    assert_eq!(header(&map, "x-guild-call-id").unwrap(), call_id.to_string());
    assert_eq!(header(&map, "x-guild-secret-api_key").unwrap(), "sk-123");
}

#[test]
fn envelope_headers_omit_absent_fields() {
    let map = envelope_headers(&Uuid::now_v7(), &Uuid::now_v7(), None, None, &[]);
    assert!(header(&map, "x-guild-caller").is_none());
    assert!(header(&map, "x-guild-acting-as").is_none());
    assert!(header(&map, "x-guild-secret-api_key").is_none());
}

// ---------- executor plumbing ----------

#[tokio::test]
async fn server_tool_dispatches_mcp_executor() {
    let url = spawn_fixture().await;
    let manifest: guild_core::registry::BundleManifest =
        serde_json::from_value(mcp_manifest(json!({ "echo": "read" }))).unwrap();
    let endpoint = McpEndpoint {
        slug: "hubspot".into(),
        url: url.clone(),
        secrets: vec![],
        manifest,
    };
    let tool = ServerTool {
        spec: ToolSpec {
            name: "int_hubspot_echo".into(),
            description: "Echoes".into(),
            parameters: json!({}),
        },
        executor: ServerExecutor::Mcp(Box::new(endpoint)),
        config: json!({}),
    };
    let pool = McpPool::new();
    let identity = McpCallIdentity {
        org: Uuid::now_v7(),
        caller: None,
        acting_as: None,
        call_id: Uuid::now_v7(),
    };
    let out = guild_server::integrations::execute_server_tool(
        &tool,
        "echo",
        json!({ "text": "roundtrip" }),
        &pool,
        &identity,
    )
    .await
    .unwrap();
    assert_eq!(out.content, "echo: roundtrip");
}

#[test]
fn namespaced_tool_builds_int_prefix() {
    assert_eq!(namespaced_tool("hubspot", "echo"), "int_hubspot_echo");
}

// keep unused-import lints quiet for the HashMap helper above
#[allow(dead_code)]
fn _touch(_: HashMap<String, String>) {}
