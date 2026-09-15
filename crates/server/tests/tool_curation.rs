//! Per-tool admin curation (adapters spec §5/§6): the stored per-tool
//! config on integration rows is the single source of truth for tool
//! exposure and approval. Covers the curation read rules (one default per
//! kind), the turn-start/script-API filter, and the admin endpoints.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::integrations::{resolve_plugins, tool_allowed, tool_curate};
use guild_server::test_support::{full_state, test_state_with_db};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

const SLUG: &str = "testplug";

async fn req(
    app: &axum::Router,
    method: &str,
    uri: String,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json");
    let req = match body {
        Some(b) => builder.body(Body::from(b.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

// ---------- curation read rules ----------

#[test]
fn builtin_absent_config_defaults_enabled_with_user_policy() {
    let cur = tool_curate(&json!({}), false, "any_tool");
    assert!(cur.enabled);
    assert!(!cur.always_ask);
}

#[test]
fn mcp_absent_config_defaults_disabled() {
    // Fail-closed curation (spec §6): a live-discovered tool the admin has
    // not configured is invisible, and remote drift lands in this state.
    let cur = tool_curate(&json!({}), true, "any_tool");
    assert!(!cur.enabled);
    assert!(!cur.always_ask);
}

#[test]
fn stored_curation_reads_enabled_and_always_ask() {
    let cfg = json!({ "tools": {
        "a": { "enabled": false, "approval": "always_ask" },
        "b": { "enabled": true },
        "c": { "enabled": true, "approval": "bogus" },
    }});
    let a = tool_curate(&cfg, false, "a");
    assert!(!a.enabled);
    assert!(a.always_ask);
    let b = tool_curate(&cfg, false, "b");
    assert!(b.enabled);
    assert!(!b.always_ask);
    // Unknown approval values read as the default, never as always-ask.
    let c = tool_curate(&cfg, false, "c");
    assert!(c.enabled);
    assert!(!c.always_ask);
}

// ---------- turn-start / script-API filter ----------

#[tokio::test]
async fn disabled_builtin_tool_is_invisible_at_turn_start() {
    let ts = test_state_with_db().await;
    let org: Uuid = {
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
    };
    ts.store()
        .integrations()
        .upsert(
            org,
            SLUG,
            &json!({ "tools": { "secret_echo": { "enabled": false } } }),
            true,
        )
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
    // The disabled tool is not declared to the model, for any role.
    for role in ["member", "admin", "owner"] {
        let specs = turn.allowed_specs(role);
        assert!(
            !specs.iter().any(|s| s.name == "testplug_secret_echo"),
            "{role} still sees the disabled tool"
        );
    }
    // The enabled sibling is untouched (zero-config default for built-ins).
    assert!(turn
        .allowed_specs("admin")
        .iter()
        .any(|s| s.name == "testplug_admin_op"));
    // The same filter guards the call path.
    let info = turn
        .tools
        .iter()
        .find(|t| t.spec.name == "testplug_secret_echo")
        .unwrap();
    assert!(!tool_allowed(turn, info, "admin"));
    let admin_op = turn
        .tools
        .iter()
        .find(|t| t.spec.name == "testplug_admin_op")
        .unwrap();
    assert!(tool_allowed(turn, admin_op, "admin"));
}

// ---------- admin endpoints ----------

#[tokio::test]
async fn admin_tools_endpoints_roundtrip_and_survive_settings_save() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // Create the row (disabled stub), then curate one tool.
    let (status, body) = req(
        &app,
        "POST",
        "/api/v1/admin/integrations".into(),
        &token,
        Some(json!({ "name": SLUG, "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["id"].as_str().unwrap().to_string();

    // Unfiltered list: every declared tool with its curation (absent =
    // enabled for built-ins).
    let (status, body) = req(
        &app,
        "GET",
        format!("/api/v1/admin/integrations/{id}/tools"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["resolved"], true);
    assert_eq!(body["kind"], "builtin");
    let tools = body["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], "secret_echo");
    assert_eq!(tools[0]["enabled"], true);
    assert_eq!(tools[0]["approval"], "default");
    assert_eq!(tools[0]["tool"], "testplug_secret_echo");

    // Disable one tool and force always-ask on the other.
    let (status, body) = req(
        &app,
        "PUT",
        format!("/api/v1/admin/integrations/{id}/tools/secret_echo"),
        &token,
        Some(json!({ "enabled": false, "approval": "default" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);
    let (status, _) = req(
        &app,
        "PUT",
        format!("/api/v1/admin/integrations/{id}/tools/admin_op"),
        &token,
        Some(json!({ "enabled": true, "approval": "always_ask" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // The curation lands in the row config and the GET reflects it.
    let (status, body) = req(
        &app,
        "GET",
        format!("/api/v1/admin/integrations/{id}/tools"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tools = body["tools"].as_array().unwrap();
    let echo = tools.iter().find(|t| t["name"] == "secret_echo").unwrap();
    assert_eq!(echo["enabled"], false);
    let op = tools.iter().find(|t| t["name"] == "admin_op").unwrap();
    assert_eq!(op["approval"], "always_ask");

    // A settings save that omits the tools map keeps the stored curation.
    let (status, _) = req(
        &app,
        "PUT",
        format!("/api/v1/admin/integrations/{id}"),
        &token,
        Some(json!({ "config": {}, "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = req(
        &app,
        "GET",
        format!("/api/v1/admin/integrations/{id}/tools"),
        &token,
        None,
    )
    .await;
    let tools = body["tools"].as_array().unwrap();
    let echo = tools.iter().find(|t| t["name"] == "secret_echo").unwrap();
    assert_eq!(echo["enabled"], false, "curation lost on settings save");
    let op = tools.iter().find(|t| t["name"] == "admin_op").unwrap();
    assert_eq!(op["approval"], "always_ask");

    // Validation: unknown approval value and bogus tool name are rejected.
    let (status, _) = req(
        &app,
        "PUT",
        format!("/api/v1/admin/integrations/{id}/tools/secret_echo"),
        &token,
        Some(json!({ "enabled": true, "approval": "yolo" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = req(
        &app,
        "PUT",
        format!("/api/v1/admin/integrations/{id}/tools/bad-name"),
        &token,
        Some(json!({ "enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn admin_tools_endpoints_are_admin_only() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let (status, _) = req(
        &app,
        "GET",
        format!("/api/v1/admin/integrations/{}/tools", Uuid::now_v7()),
        "not-a-token",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
