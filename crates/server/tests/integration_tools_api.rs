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
    use rmcp::ErrorData as McpError;

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
                "echo" => Ok(CallToolResponse::Complete(CallToolResult::success(vec![
                    ContentBlock::text(format!("echo: {text}")),
                ]))),
                "update_deal" => Ok(CallToolResponse::Complete(CallToolResult::success(vec![
                    ContentBlock::text("deal updated"),
                ]))),
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

/// Store-level seeds use a fixed stand-in bundle hash: the hash-binding
/// paths only compare the stored value against the approval's, never
/// against object bytes (these tests resolve manifests, not bundles).
const SEED_BUNDLE_SHA: &str = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

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
            SEED_BUNDLE_SHA,
            admin_id,
        )
        .await
        .unwrap();
    // Resolution resolves approved items only — the review gate binds to
    // the reviewed version and bundle hash.
    store
        .registry()
        .set_review(
            org,
            "integration",
            "hubspot",
            "approved",
            Some("1.0.0"),
            Some(SEED_BUNDLE_SHA),
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
    let key = store
        .api_keys()
        .create(org, admin_id, "scripts")
        .await
        .unwrap();
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
    for (k, v) in extra
        .as_object()
        .unwrap_or(&json!({}).as_object().unwrap().clone())
    {
        req = req.header(k.as_str(), v.as_str().unwrap_or(""));
    }
    let res = s
        .app
        .clone()
        .oneshot(
            req.body(Body::from(json!({ "text": "hi" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
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
    let (status, body) = call_tool(&s, Some(&s.member_token), "hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    assert_eq!(body["content"], "echo: hi");
}

#[tokio::test]
async fn member_cannot_call_write_or_admin_tools() {
    let s = setup().await;
    let (write_status, _) =
        call_tool(&s, Some(&s.member_token), "hubspot_update_deal", json!({})).await;
    assert_eq!(write_status, StatusCode::FORBIDDEN);
    let (admin_status, _) = call_tool(
        &s,
        Some(&s.member_token),
        "hubspot_admin_only_op",
        json!({}),
    )
    .await;
    assert_eq!(admin_status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn admin_can_call_write_tool() {
    let s = setup().await;
    let (status, body) =
        call_tool(&s, Some(&s.admin_token), "hubspot_update_deal", json!({})).await;
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
        "hubspot_echo",
        json!({ "x-guild-acting-as": "other@x.y" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Admin may act as someone else -> OK.
    let (status, body) = call_tool(
        &s,
        Some(&s.admin_token),
        "hubspot_echo",
        json!({ "x-guild-acting-as": "other@x.y" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn org_api_key_auth_works() {
    let s = setup().await;
    let (status, body) = call_tool(&s, Some(&s.api_key), "hubspot_echo", json!({})).await;
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
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
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
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let tools = body["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3);
    assert!(tools
        .iter()
        .all(|t| t["name"].as_str().unwrap().starts_with("hubspot_")));
    assert!(tools.iter().any(|t| t["class"] == "write"));

    // Disabled integration -> 404 for both endpoints.
    s.ts.store()
        .integrations()
        .upsert(
            s.org,
            "hubspot",
            &json!({ "mcp": { "url": "http://x/mcp" } }),
            false,
        )
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
    let (status, _) = call_tool(&s, Some(&s.admin_token), "hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let events = s.ts.store().events().list(s.org, 50).await.unwrap();
    let audit = events
        .iter()
        .find(|e| e.kind == "integration.tool_called")
        .expect("audit event exists");
    assert_eq!(audit.payload["slug"], "hubspot");
    assert_eq!(audit.payload["tool"], "echo");
    assert_eq!(audit.payload["via"], "script");
    assert_eq!(audit.payload["ok"], true);
}

// ---------- review gate: republish reclassification ----------

/// Resolution resolves only manifests whose approval still covers the
/// latest version. Republishing — same version with changed content, or a
/// new version — resets the review status, so the plugin stops resolving
/// until an admin re-approves; the re-approved manifest (not the old
/// approval) then governs the class floor.
#[tokio::test]
async fn republished_manifest_requires_rereview_before_resolution() {
    let s = setup().await;
    let store = s.ts.store();

    // A member republishes the same version with loosened classes: the
    // review status resets to draft and the plugin stops resolving.
    let publisher = store
        .identity()
        .create_user(s.org, "pub@a.b", "hunter226", "member")
        .await
        .unwrap();
    let version = store
        .registry()
        .item_versions(s.org, "integration", "hubspot")
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap()
        .version;
    let mut manifest = store
        .registry()
        .get_version(s.org, "integration", "hubspot", &version)
        .await
        .unwrap()
        .manifest;
    manifest["tools"]["classes"] = json!({
        "echo": "read", "update_deal": "read", "admin_only_op": "read",
    });
    store
        .registry()
        .upsert_version(
            s.org,
            "integration",
            "hubspot",
            &version,
            "HubSpot CRM tools",
            manifest.clone(),
            "unused-key",
            SEED_BUNDLE_SHA,
            publisher.id,
        )
        .await
        .unwrap();
    let item = store
        .registry()
        .list_items(s.org, "integration")
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.slug == "hubspot")
        .unwrap();
    assert_eq!(item.review_status, "draft");

    // Draft content governs nothing: the tools list is empty (404) and the
    // member's admin-class tool call finds no resolved integration.
    let res = s
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/integrations/hubspot/tools")
                .header("authorization", format!("Bearer {}", s.member_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let (status, _) = call_tool(
        &s,
        Some(&s.member_token),
        "hubspot_admin_only_op",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Re-approval binds to the republished manifest: it now governs, and
    // its loosened classes apply (the review, not the old approval, is the
    // source of the class floor).
    store
        .registry()
        .set_review(
            s.org,
            "integration",
            "hubspot",
            "approved",
            Some(&version),
            Some(SEED_BUNDLE_SHA),
        )
        .await
        .unwrap();
    let res = s
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/integrations/hubspot/tools")
                .header("authorization", format!("Bearer {}", s.member_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (status, body) = call_tool(
        &s,
        Some(&s.member_token),
        "hubspot_admin_only_op",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A new version resets again: no resolution until re-reviewed.
    manifest["version"] = json!("2.0.0");
    store
        .registry()
        .upsert_version(
            s.org,
            "integration",
            "hubspot",
            "2.0.0",
            "HubSpot CRM tools",
            manifest,
            "unused-key",
            SEED_BUNDLE_SHA,
            publisher.id,
        )
        .await
        .unwrap();
    let (status, _) = call_tool(&s, Some(&s.member_token), "hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    store
        .registry()
        .set_review(
            s.org,
            "integration",
            "hubspot",
            "approved",
            Some("2.0.0"),
            Some(SEED_BUNDLE_SHA),
        )
        .await
        .unwrap();
    let (status, body) = call_tool(&s, Some(&s.member_token), "hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["content"], "echo: hi");
}

/// A pre-binding approval (`reviewed_version` NULL, the state rows carried
/// before the reviewed-version/bundle-hash columns existed) counts as no
/// approval: an unchanged same-version republish must reset to draft
/// instead of re-binding it. Once the approval is bound, the identical
/// republish keeps the status.
#[tokio::test]
async fn unbound_approval_republish_resets_to_draft() {
    let s = setup().await;
    let store = s.ts.store();

    // Strip the approval's bindings — the pre-migration upgrade state.
    sqlx::query(
        "UPDATE registry_items SET reviewed_version = NULL, reviewed_bundle_sha256 = NULL \
         WHERE org_id = $1 AND kind = 'integration' AND slug = 'hubspot'",
    )
    .bind(s.org)
    .execute(store.pool())
    .await
    .unwrap();

    let stored = store
        .registry()
        .get_version(s.org, "integration", "hubspot", "1.0.0")
        .await
        .unwrap();
    let publisher = store
        .identity()
        .create_user(s.org, "pub@a.b", "hunter226", "member")
        .await
        .unwrap();
    store
        .registry()
        .upsert_version(
            s.org,
            "integration",
            "hubspot",
            "1.0.0",
            "HubSpot CRM tools",
            stored.manifest.clone(),
            "unused-key",
            SEED_BUNDLE_SHA,
            publisher.id,
        )
        .await
        .unwrap();
    let item = store
        .registry()
        .list_items(s.org, "integration")
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.slug == "hubspot")
        .unwrap();
    assert_eq!(
        item.review_status, "draft",
        "unbound approval must not survive a republish"
    );
    let (status, _) = call_tool(&s, Some(&s.member_token), "hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Positive control: with a bound approval the identical republish keeps
    // the status.
    store
        .registry()
        .set_review(
            s.org,
            "integration",
            "hubspot",
            "approved",
            Some("1.0.0"),
            Some(SEED_BUNDLE_SHA),
        )
        .await
        .unwrap();
    store
        .registry()
        .upsert_version(
            s.org,
            "integration",
            "hubspot",
            "1.0.0",
            "HubSpot CRM tools",
            stored.manifest,
            "unused-key",
            SEED_BUNDLE_SHA,
            publisher.id,
        )
        .await
        .unwrap();
    let item = store
        .registry()
        .list_items(s.org, "integration")
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.slug == "hubspot")
        .unwrap();
    assert_eq!(item.review_status, "approved");
    let (status, body) = call_tool(&s, Some(&s.member_token), "hubspot_echo", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
