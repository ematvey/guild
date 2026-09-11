//! Script-facing integration tool API tests (milestone 9, Task S4): the
//! authz matrix (session + org API key, class enforcement, impersonation
//! rules) and execution against a fixture MCP server.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{test_state_with_db, TestState};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

// ---------- fixture MCP server (rmcp streamable HTTP, in-process) ----------

/// Exposes `echo(text)` (read), `update_deal` (write), and `admin_only_op`
/// (admin), bound on 127.0.0.1:<random port>. Returns the base URL.
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
    use rmcp::transport::streamable_http_server::tower::{
        StreamableHttpServerConfig, StreamableHttpService,
    };

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
                        "update_deal",
                        "Updates a deal",
                        json!({ "type": "object", "properties": {} })
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
                "update_deal" => Ok(CallToolResponse::Complete(CallToolResult::success(
                    vec![ContentBlock::text("deal updated")],
                ))),
                _ => Err(McpError::method_not_found::<
                    rmcp::model::CallToolRequestMethod,
                >()),
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

// ---------- harness ----------

fn manifest_value(url: &str) -> Value {
    json!({
        "kind": "integration",
        "slug": "hubspot",
        "version": "1.0.0",
        "description": "HubSpot CRM tools",
        "mcp": { "url": url },
        "auth": { "kind": "org_secret", "secret_names": ["api_key"], "identity_key": "email" },
        "tools": { "classes": { "echo": "read", "update_deal": "write",
                                "admin_only_op": "admin" } },
        "skills": []
    })
}

struct Setup {
    ts: TestState,
    app: axum::Router,
    org: Uuid,
    admin_token: String,
    member_token: String,
    api_key: String,
}

/// Installs the enabled hubspot plugin (row + registry version + secret) and
/// creates an admin session, a member session, and an org API key.
async fn setup() -> Setup {
    let ts = test_state_with_db().await;
    let url = spawn_fixture().await;
    let store = ts.store();
    let admin_id = store
        .identity()
        .ensure_bootstrap_admin("admin@a.b", "hunter226")
        .await
        .unwrap();
    let admin = store.identity().get_user(admin_id).await.unwrap();
    let org = admin.org_id;
    let member = store
        .identity()
        .create_user(org, "member@a.b", "hunter226", "member")
        .await
        .unwrap();
    store
        .integrations()
        .upsert(
            org,
            "hubspot",
            &json!({ "mcp": { "url": url }, "auth": { "kind": "org_secret" }, "tool_policy": {} }),
            true,
        )
        .await
        .unwrap();
    store
        .registry()
        .upsert_version(
            org,
            "integration",
            "hubspot",
            "1.0.0",
            "HubSpot CRM tools",
            manifest_value(&url),
            "unused-key",
            admin_id,
        )
        .await
        .unwrap();
    store
        .integration_secrets()
        .upsert(org, "hubspot", "api_key", "sk-123", &[0u8; 32])
        .await
        .unwrap();
    let (_, admin_token) = store.identity().create_session(admin_id).await.unwrap();
    let (_, member_token) = store.identity().create_session(member.id).await.unwrap();
    let key = store.api_keys().create(org, admin_id, "scripts").await.unwrap();
    Setup {
        app: guild_server::build_router(ts.state.clone()),
        ts,
        org,
        admin_token,
        member_token,
        api_key: key.plaintext,
    }
}

async fn call_tool(s: &Setup, auth: Option<&str>, tool: &str, extra: Value) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/integrations/hubspot/tools/{tool}"))
        .header("content-type", "application/json");
    if let Some(token) = auth {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    for (k, v) in extra.as_object().unwrap_or(&json!({}).as_object().unwrap().clone()) {
        req = req.header(k.as_str(), v.as_str().unwrap_or(""));
    }
    let res = s
        .app
        .clone()
        .oneshot(req.body(Body::from(json!({ "text": "hi" }).to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, v)
}

// ---------- authz matrix ----------

#[tokio::test]
async fn unauthenticated_call_is_401() {
    let s = setup().await;
    let (status, _) = call_tool(&s, None, "echo", json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn member_can_call_read_tool_and_gets_the_fixture_answer() {
    let s = setup().await;
    let (status, body) = call_tool(&s, Some(&s.member_token), "int_hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    assert_eq!(body["content"], "echo: hi");
}

#[tokio::test]
async fn member_cannot_call_write_or_admin_tools() {
    let s = setup().await;
    let (write_status, _) = call_tool(&s, Some(&s.member_token), "int_hubspot_update_deal", json!({})).await;
    assert_eq!(write_status, StatusCode::FORBIDDEN);
    let (admin_status, _) = call_tool(&s, Some(&s.member_token), "int_hubspot_admin_only_op", json!({})).await;
    assert_eq!(admin_status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn admin_can_call_write_tool() {
    let s = setup().await;
    let (status, body) = call_tool(&s, Some(&s.admin_token), "int_hubspot_update_deal", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["content"], "deal updated");
}

#[tokio::test]
async fn acting_as_override_is_admin_only() {
    let s = setup().await;
    // Member tries to act as someone else -> 403.
    let (status, _) = call_tool(
        &s,
        Some(&s.member_token),
        "int_hubspot_echo",
        json!({ "x-guild-acting-as": "other@x.y" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Admin may act as someone else -> OK.
    let (status, body) = call_tool(
        &s,
        Some(&s.admin_token),
        "int_hubspot_echo",
        json!({ "x-guild-acting-as": "other@x.y" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn org_api_key_auth_works() {
    let s = setup().await;
    let (status, body) = call_tool(&s, Some(&s.api_key), "int_hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["content"], "echo: hi");
}

// ---------- listing ----------

#[tokio::test]
async fn integration_list_and_tools_are_policy_filtered() {
    let s = setup().await;

    let res = s
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/integrations")
                .header("authorization", format!("Bearer {}", s.member_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["slug"], "hubspot");
    assert_eq!(items[0]["description"], "HubSpot CRM tools");
    // Member sees only the read tool.
    assert_eq!(items[0]["tool_count"], 1);

    let res = s
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/integrations/hubspot/tools")
                .header("authorization", format!("Bearer {}", s.admin_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    let tools = body["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3);
    assert!(tools
        .iter()
        .all(|t| t["name"].as_str().unwrap().starts_with("int_hubspot_")));
    assert!(tools.iter().any(|t| t["class"] == "write"));

    // Disabled integration -> 404 for both endpoints.
    s.ts
        .store()
        .integrations()
        .upsert(s.org, "hubspot", &json!({ "mcp": { "url": "http://x/mcp" } }), false)
        .await
        .unwrap();
    let res = s
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/integrations/hubspot/tools")
                .header("authorization", format!("Bearer {}", s.admin_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn script_call_appends_audit_event() {
    let s = setup().await;
    let (status, _) = call_tool(&s, Some(&s.admin_token), "int_hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let events = s
        .ts
        .store()
        .events()
        .list(s.org, 50)
        .await
        .unwrap();
    let audit = events
        .iter()
        .find(|e| e.kind == "integration.tool_called")
        .expect("audit event exists");
    assert_eq!(audit.payload["slug"], "hubspot");
    assert_eq!(audit.payload["tool"], "echo");
    assert_eq!(audit.payload["via"], "script");
    assert_eq!(audit.payload["ok"], true);
}
