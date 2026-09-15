//! Disclosure + resolution tests for MCP plugins (milestone 9, Task W2):
//! turn-start resolution against a fixture MCP server, role-filtered
//! disclosure, auto-tools, the guide tool, and degrade-on-broken behavior.

use std::sync::Arc;

use guild_server::integrations::{
    call_plugin, fetch_guide, index_line, parse_auto_tool, resolve_plugins, tool_allowed, AutoTool,
    PluginExecutor, PluginTurn,
};
use guild_server::store::Store;
use guild_server::test_support::{full_state, test_state_with_db};
use serde_json::{json, Value};
use uuid::Uuid;

/// Store-level seeds use a fixed stand-in bundle hash: the hash-binding
/// paths only compare the stored value against the approval's, never
/// against object bytes (guide tests compute the real hash themselves).
const SEED_BUNDLE_SHA: &str = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}

// ---------- fixture MCP server (rmcp streamable HTTP, in-process) ----------

/// Exposes `echo(text)` (class read) and `admin_only_op()` (class admin),
/// bound on 127.0.0.1:<random port>. Returns the base URL.
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

// ---------- fixtures: org rows, registry, secrets ----------

fn manifest_value(url: &str) -> Value {
    json!({
        "kind": "integration",
        "slug": "hubspot",
        "version": "1.0.0",
        "description": "HubSpot CRM tools",
        "mcp": { "url": url },
        "auth": {
            "kind": "org_secret",
            "secret_names": ["api_key"],
            "identity_key": "email"
        },
        "tools": { "classes": { "echo": "read", "admin_only_op": "admin" } },
        "skills": ["hubspot-cookbook"]
    })
}

/// Installs a hubspot v2 plugin row (enabled) + registry version + secret.
/// `seed` reuses an existing org/user (full_state) instead of creating the
/// bootstrap admin.
async fn install_plugin(store: &Store, url: &str, seed: Option<(Uuid, Uuid)>) -> (Uuid, Uuid) {
    let (org, user_id) = match seed {
        Some(pair) => pair,
        None => {
            let user_id = store
                .identity()
                .ensure_bootstrap_admin("admin@a.b", "hunter226")
                .await
                .unwrap();
            let user = store.identity().get_user(user_id).await.unwrap();
            (user.org_id, user_id)
        }
    };
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
            manifest_value(url),
            "unused-key",
            SEED_BUNDLE_SHA,
            user_id,
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
    (org, user_id)
}

// ---------- resolution ----------

#[tokio::test]
async fn turn_start_resolves_mcp_plugin_with_namespaced_tools() {
    let ts = test_state_with_db().await;
    let url = spawn_fixture().await;
    let (org, _) = install_plugin(&ts.store(), &url, None).await;

    let turns = resolve_plugins(&ts.state, org).await.unwrap();
    assert_eq!(turns.len(), 1);
    let turn = &turns[0];
    assert_eq!(turn.slug, "hubspot");
    assert_eq!(turn.description, "HubSpot CRM tools");
    let names: Vec<&str> = turn.tools.iter().map(|t| t.spec.name.as_str()).collect();
    assert_eq!(names, vec!["hubspot_echo", "hubspot_admin_only_op"]);
    let echo = &turn.tools[0];
    assert_eq!(echo.class, "read");
    assert_eq!(echo.spec.description, "Echoes the text back");
    assert!(echo.spec.parameters["properties"]["text"].is_object());
    // No cookbook skill published -> no guide pointer.
    assert!(turn.guide_object_key.is_none());
    // Index line (spec §7.1).
    assert_eq!(
        index_line(turn),
        "Integration hubspot: HubSpot CRM tools — call hubspot_list_tools to discover its tools."
    );
}

#[tokio::test]
async fn turn_start_skips_unreachable_mcp_server() {
    let ts = test_state_with_db().await;
    let (org, _) = install_plugin(&ts.store(), "http://127.0.0.1:1/mcp", None).await;
    let turns = resolve_plugins(&ts.state, org).await.unwrap();
    assert!(turns.is_empty(), "broken plugin contributes nothing");
}

#[tokio::test]
async fn turn_start_skips_plugin_with_missing_secrets() {
    let ts = test_state_with_db().await;
    let url = spawn_fixture().await;
    let (org, _) = install_plugin(&ts.store(), &url, None).await;
    ts.store()
        .integration_secrets()
        .delete(org, "hubspot", "api_key")
        .await
        .unwrap();
    let turns = resolve_plugins(&ts.state, org).await.unwrap();
    assert!(turns.is_empty());
}

// ---------- disclosure filtering ----------

#[tokio::test]
async fn disclosure_filters_tools_by_role() {
    let ts = test_state_with_db().await;
    let url = spawn_fixture().await;
    let (org, _) = install_plugin(&ts.store(), &url, None).await;
    let turn = &resolve_plugins(&ts.state, org).await.unwrap()[0];

    // Default policy: member read-only — echo visible, admin tool hidden.
    let member: Vec<String> = turn
        .allowed_specs("member")
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(member, vec!["hubspot_echo"]);
    // Admin sees both.
    let admin: Vec<String> = turn
        .allowed_specs("admin")
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(admin, vec!["hubspot_echo", "hubspot_admin_only_op"]);
    // Owner counts as admin.
    assert_eq!(turn.allowed_specs("owner").len(), 2);

    // Tightened policy: even admins lose the admin-class tool.
    let mut tight = turn.clone();
    tight.row_config["tool_policy"] = json!({ "member": ["read"], "admin": ["read"] });
    assert!(tight
        .allowed_specs("admin")
        .iter()
        .all(|s| s.name != "hubspot_admin_only_op"));

    // The pure enforcement fn agrees (spec §6).
    let info = &turn.tools[1];
    assert!(!tool_allowed(info, &turn.row_config, "member"));
    assert!(tool_allowed(info, &turn.row_config, "admin"));
}

#[test]
fn auto_tools_are_recognized_and_namespaced() {
    let turn = PluginTurn {
        executor: PluginExecutor::Mcp,
        slug: "hubspot".into(),
        description: "d".into(),
        tools: vec![],
        guide_object_key: None,
        row_config: json!({}),
        secret_names: vec![],
        identity_key: "email".into(),
    };
    let turns = vec![turn];
    assert_eq!(
        parse_auto_tool(&turns, "hubspot_list_tools"),
        Some((0, AutoTool::ListTools))
    );
    assert_eq!(
        parse_auto_tool(&turns, "hubspot_guide"),
        Some((0, AutoTool::Guide))
    );
    assert_eq!(parse_auto_tool(&turns, "hubspot_echo"), None);
    assert_eq!(parse_auto_tool(&turns, "other_list_tools"), None);
}

// ---------- execution ----------

#[tokio::test]
async fn mcp_call_carries_identity_and_roundtrips() {
    let ts = test_state_with_db().await;
    let url = spawn_fixture().await;
    let (org, _) = install_plugin(&ts.store(), &url, None).await;
    let turn = resolve_plugins(&ts.state, org).await.unwrap().remove(0);

    // Acting as the caller's email (the identity_key=email join).
    let out = call_plugin(
        &ts.state,
        &turn,
        "echo",
        json!({ "text": "hello" }),
        org,
        Some("caller@a.b"),
    )
    .await
    .unwrap();
    assert_eq!(out.content, "echo: hello");

    // A changed acting_as creates a separate pooled connection (the
    // envelope rides the connection), and the call still works.
    let out = call_plugin(&ts.state, &turn, "echo", json!({ "text": "x" }), org, None)
        .await
        .unwrap();
    assert_eq!(out.content, "echo: x");
    assert_eq!(ts.state.mcp_pool.len(), 2);
}

#[tokio::test]
async fn guide_tool_returns_skill_md_from_object_storage() {
    use guild_core::registry::pack;
    let ts = full_state().await;
    let url = spawn_fixture().await;
    let store = ts.store();
    let (org, _) = install_plugin(&store, &url, Some((ts.org_id, ts.user_id))).await;

    // Publish a hubspot-cookbook skill bundle (SKILL.md) to the registry
    // and object storage, then approve it — the guide pointer resolves
    // through the approval gate only.
    let dir = std::env::temp_dir().join(format!("guild-guide-{}", Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: hubspot-cookbook\ndescription: how to use hubspot\n---\nUSE THE SEARCH FIRST",
    )
    .unwrap();
    let manifest = guild_core::registry::BundleManifest {
        kind: "skill".into(),
        slug: "hubspot-cookbook".into(),
        version: "1.0.0".into(),
        description: "how to use hubspot".into(),
        ..Default::default()
    };
    let bundle = pack(&dir, &manifest).unwrap();
    let bundle_sha = sha256_hex(&bundle);
    let object_key = format!("registry/{}", Uuid::now_v7().simple());
    ts.state
        .objects()
        .await
        .unwrap()
        .put(&object_key, bundle.clone())
        .await
        .unwrap();
    store
        .registry()
        .upsert_version(
            ts.org_id,
            "skill",
            "hubspot-cookbook",
            "1.0.0",
            "how to use hubspot",
            serde_json::to_value(&manifest).unwrap(),
            &object_key,
            &bundle_sha,
            ts.user_id,
        )
        .await
        .unwrap();
    std::fs::remove_dir_all(&dir).unwrap();

    // While the skill item is still a draft, the guide gate yields nothing.
    let turn = resolve_plugins(&ts.state, org).await.unwrap();
    assert!(
        turn[0].guide_object_key.is_none(),
        "unapproved skill content must not reach the guide tool"
    );

    // Approving binds the version + bundle hash; the guide resolves.
    store
        .registry()
        .set_review(
            ts.org_id,
            "skill",
            "hubspot-cookbook",
            "approved",
            Some("1.0.0"),
            Some(&bundle_sha),
        )
        .await
        .unwrap();
    let turn = resolve_plugins(&ts.state, org).await.unwrap();
    let key = turn[0].guide_object_key.as_ref().expect("guide pointer");
    let body = fetch_guide(&ts.state, key).await.unwrap();
    assert!(body.contains("USE THE SEARCH FIRST"), "{body}");
    assert!(body.contains("name: hubspot-cookbook"));

    // A same-manifest republish with different bundle bytes resets the
    // skill item to draft: the guide gate closes again.
    let dir = std::env::temp_dir().join(format!("guild-guide-{}", Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: hubspot-cookbook\ndescription: how to use hubspot\n---\nSWAPPED BYTE CONTENT",
    )
    .unwrap();
    let swapped = pack(&dir, &manifest).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    let swapped_key = format!("registry/{}", Uuid::now_v7().simple());
    ts.state
        .objects()
        .await
        .unwrap()
        .put(&swapped_key, swapped.clone())
        .await
        .unwrap();
    store
        .registry()
        .upsert_version(
            ts.org_id,
            "skill",
            "hubspot-cookbook",
            "1.0.0",
            "how to use hubspot",
            serde_json::to_value(&manifest).unwrap(),
            &swapped_key,
            &sha256_hex(&swapped),
            ts.user_id,
        )
        .await
        .unwrap();
    let turn = resolve_plugins(&ts.state, org).await.unwrap();
    assert!(
        turn[0].guide_object_key.is_none(),
        "byte-swapped republish must close the guide gate"
    );
}
