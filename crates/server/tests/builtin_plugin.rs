//! Unified plugin interface tests (milestone 10, Lane CORE C3): the fake
//! built-in `testplug` integration (compiled with `test-support`) exercising
//! the enable gate, secrets resolution into execute, class enforcement, the
//! script API + audit, and the auto-tools — the same surfaces MCP plugins
//! get.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::integrations::{index_line, parse_auto_tool, resolve_plugins, AutoTool};
use guild_server::test_support::{full_state, test_state_with_db};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

const SLUG: &str = "testplug";

// ---------- resolution ----------

#[tokio::test]
async fn builtin_resolves_with_namespaced_tools_and_manifest_classes() {
    let ts = test_state_with_db().await;
    let org = seed_org(&ts).await;
    ts.store()
        .integrations()
        .upsert(org, SLUG, &json!({}), true)
        .await
        .unwrap();
    ts.store()
        .integration_secrets()
        .upsert(org, SLUG, "api_key", "sk-123", &[0u8; 32])
        .await
        .unwrap();

    let turns = resolve_plugins(&ts.state, org).await.unwrap();
    assert_eq!(turns.len(), 1);
    let turn = &turns[0];
    assert_eq!(
        turn.executor,
        guild_server::integrations::PluginExecutor::Rust
    );
    assert_eq!(turn.slug, SLUG);
    assert_eq!(
        turn.description,
        "Test tools for the unified plugin interface"
    );
    let names: Vec<&str> = turn.tools.iter().map(|t| t.spec.name.as_str()).collect();
    assert_eq!(names, vec!["testplug_secret_echo", "testplug_admin_op"]);
    assert_eq!(turn.tools[0].class, "read");
    assert_eq!(turn.tools[1].class, "admin");
    // Built-ins have no registry cookbook — the guide tool degrades.
    assert!(turn.guide_object_key.is_none());
    // Index line (spec §7.1), same shape as MCP plugins.
    assert_eq!(
        index_line(turn),
        format!(
            "Integration {SLUG}: Test tools for the unified plugin interface — call \
             testplug_list_tools to discover its tools."
        )
    );
}

#[tokio::test]
async fn builtin_disclosure_filters_tools_by_role() {
    let ts = test_state_with_db().await;
    let org = seed_org(&ts).await;
    ts.store()
        .integrations()
        .upsert(org, SLUG, &json!({}), true)
        .await
        .unwrap();
    ts.store()
        .integration_secrets()
        .upsert(org, SLUG, "api_key", "sk-123", &[0u8; 32])
        .await
        .unwrap();
    let turn = &resolve_plugins(&ts.state, org).await.unwrap()[0];

    // Default policy: member read-only — the read tool visible, the
    // admin-class tool hidden.
    let member: Vec<String> = turn
        .allowed_specs("member")
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(member, vec!["testplug_secret_echo"]);
    // Admin sees both.
    let admin: Vec<String> = turn
        .allowed_specs("admin")
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(admin, vec!["testplug_secret_echo", "testplug_admin_op"]);

    // A stored policy tightens: members lose even the read tool.
    let ts2 = test_state_with_db().await;
    let org2 = seed_org(&ts2).await;
    ts2.store()
        .integrations()
        .upsert(
            org2,
            SLUG,
            &json!({ "tool_policy": { "member": [] } }),
            true,
        )
        .await
        .unwrap();
    ts2.store()
        .integration_secrets()
        .upsert(org2, SLUG, "api_key", "sk-123", &[0u8; 32])
        .await
        .unwrap();
    let turn = &resolve_plugins(&ts2.state, org2).await.unwrap()[0];
    assert!(turn.allowed_specs("member").is_empty());
}

#[tokio::test]
async fn builtin_with_missing_required_secrets_is_skipped() {
    let ts = test_state_with_db().await;
    let org = seed_org(&ts).await;
    ts.store()
        .integrations()
        .upsert(org, SLUG, &json!({}), true)
        .await
        .unwrap();
    // No stored api_key: the plugin contributes nothing this turn.
    let turns = resolve_plugins(&ts.state, org).await.unwrap();
    assert!(turns.is_empty());
}

#[tokio::test]
async fn builtin_auto_tools_are_recognized() {
    let ts = test_state_with_db().await;
    let org = seed_org(&ts).await;
    ts.store()
        .integrations()
        .upsert(org, SLUG, &json!({}), true)
        .await
        .unwrap();
    ts.store()
        .integration_secrets()
        .upsert(org, SLUG, "api_key", "sk-123", &[0u8; 32])
        .await
        .unwrap();
    let turns = resolve_plugins(&ts.state, org).await.unwrap();
    assert_eq!(
        parse_auto_tool(&turns, "testplug_list_tools"),
        Some((0, AutoTool::ListTools))
    );
    assert_eq!(
        parse_auto_tool(&turns, "testplug_guide"),
        Some((0, AutoTool::Guide))
    );
    assert_eq!(parse_auto_tool(&turns, "testplug_secret_echo"), None);
}

// ---------- admin API: enable gate + secret lifecycle ----------

async fn put_json(app: &axum::Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

async fn get_json(app: &axum::Router, uri: &str, token: &str) -> Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn post_json(app: &axum::Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

#[tokio::test]
async fn builtin_enable_gate_and_secret_lifecycle() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // Creating with enable-on but without the declared secret → 409
    // missing_secrets with names.
    let (status, body) = post_json(
        &app,
        "/api/v1/admin/integrations",
        &token,
        json!({ "name": "testplug", "config": {}, "enabled": true }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "missing_secrets");
    assert!(
        body["error"]["message"].to_string().contains("api_key"),
        "missing names listed: {}",
        body["error"]["message"]
    );

    // Create the (disabled) row; its id is the object's address.
    let (status, body) = post_json(
        &app,
        "/api/v1/admin/integrations",
        &token,
        json!({ "name": "testplug", "config": {}, "enabled": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["id"].as_str().expect("created row id").to_string();

    // Saving with the credential value rides the unified PUT: the row is
    // stored enabled, and the secret is persisted in the same call.
    let (status, _) = put_json(
        &app,
        &format!("/api/v1/admin/integrations/{id}"),
        &token,
        json!({ "config": {}, "enabled": true, "secrets": { "api_key": "sk-123" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The listing exposes name + masked preview, never a value.
    let v = get_json(
        &app,
        &format!("/api/v1/admin/integrations/{id}/secrets"),
        &token,
    )
    .await;
    let items = v["secrets"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "api_key");
    assert_eq!(items[0]["masked"], "\u{2022}".repeat(6)); // "sk-123" — one bullet per char
    assert!(items[0].get("value").is_none());
    assert!(!v.to_string().contains("sk-123"));

    // A save without re-entering the credential keeps it (CRUD update):
    // disable, then re-enable — both succeed with no secrets payload.
    let (status, _) = put_json(
        &app,
        &format!("/api/v1/admin/integrations/{id}"),
        &token,
        json!({ "config": {}, "enabled": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "disabling keeps stored secrets");
    let (status, _) = put_json(
        &app,
        &format!("/api/v1/admin/integrations/{id}"),
        &token,
        json!({ "config": {}, "enabled": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "re-enabling with the stored secret");
}

// ---------- script API: execution, class enforcement, audit ----------

struct Setup {
    app: axum::Router,
    ts: guild_server::test_support::TestState,
    org: Uuid,
    admin_token: String,
    member_token: String,
}

async fn setup() -> Setup {
    let ts = test_state_with_db().await;
    let admin_id = ts
        .store()
        .identity()
        .ensure_bootstrap_admin("admin@a.b", "hunter226")
        .await
        .unwrap();
    let org = ts
        .store()
        .identity()
        .get_user(admin_id)
        .await
        .unwrap()
        .org_id;
    ts.store()
        .integrations()
        .upsert(org, SLUG, &json!({}), true)
        .await
        .unwrap();
    ts.store()
        .integration_secrets()
        .upsert(org, SLUG, "api_key", "sk-123", &[0u8; 32])
        .await
        .unwrap();
    let member = ts
        .store()
        .identity()
        .create_user(org, "member@a.b", "hunter226", "member")
        .await
        .unwrap();
    let (_, admin_token) = ts
        .store()
        .identity()
        .create_session(admin_id)
        .await
        .unwrap();
    let (_, member_token) = ts
        .store()
        .identity()
        .create_session(member.id)
        .await
        .unwrap();
    Setup {
        app: guild_server::build_router(ts.state.clone()),
        ts,
        org,
        admin_token,
        member_token,
    }
}

async fn call_tool(s: &Setup, auth: &str, tool: &str) -> (StatusCode, Value) {
    let res = s
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/integrations/{SLUG}/tools/{tool}"))
                .header("authorization", format!("Bearer {auth}"))
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

#[tokio::test]
async fn builtin_script_call_resolves_secrets_into_execute_and_audits() {
    let s = setup().await;
    let (status, body) = call_tool(&s, &s.member_token, "testplug_secret_echo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    // The resolved store secret reached the plugin's execute().
    assert_eq!(body["content"], "api_key present: true");

    // The audit event carries the identity record (spec §8).
    let events = s.ts.store().events().list(s.org, 50).await.unwrap();
    let audit = events
        .iter()
        .find(|e| e.kind == "integration.tool_called")
        .expect("audit event exists");
    assert_eq!(audit.payload["slug"], SLUG);
    assert_eq!(audit.payload["tool"], "secret_echo");
    assert_eq!(audit.payload["via"], "script");
    assert_eq!(audit.payload["ok"], true);
}

#[tokio::test]
async fn builtin_class_enforcement_member_vs_admin() {
    let s = setup().await;
    // Member: the read tool works, the admin-class tool is 403.
    let (status, _) = call_tool(&s, &s.member_token, "testplug_secret_echo").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call_tool(&s, &s.member_token, "testplug_admin_op").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Admin: both work.
    let (status, body) = call_tool(&s, &s.admin_token, "testplug_admin_op").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["content"], "admin ok");
}

#[tokio::test]
async fn script_list_includes_built_ins() {
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
    let entry = items
        .iter()
        .find(|i| i["slug"] == "testplug")
        .expect("built-in listed");
    assert_eq!(
        entry["description"],
        "Test tools for the unified plugin interface"
    );
    // Member sees only the read tool.
    assert_eq!(entry["tool_count"], 1);
}

// ---------- harness ----------

async fn seed_org(ts: &guild_server::test_support::TestState) -> Uuid {
    let user_id = ts
        .store()
        .identity()
        .ensure_bootstrap_admin("admin@a.b", "hunter226")
        .await
        .unwrap();
    ts.store()
        .identity()
        .get_user(user_id)
        .await
        .unwrap()
        .org_id
}
