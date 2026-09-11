use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_core::registry::BundleManifest;
use guild_server::test_support::full_state;
use serde_json::json;
use tower::ServiceExt;

fn v2_bundle(slug: &str, version: &str) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!(
        "guild-policy-bundle-{slug}-{version}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = BundleManifest {
        kind: "integration".into(),
        slug: slug.into(),
        version: version.into(),
        description: "HubSpot CRM tools".into(),
        mcp: Some(guild_core::registry::McpManifest {
            url: "https://mcp.example.com/mcp".into(),
        }),
        auth: Some(guild_core::registry::AuthManifest {
            kind: "org_secret".into(),
            secret_names: vec!["api_key".into()],
            identity_key: "email".into(),
        }),
        tools: Some(guild_core::registry::ToolsManifest {
            classes: [("search_contacts".to_string(), "read".to_string())]
                .into_iter()
                .collect(),
        }),
        ..Default::default()
    };
    let bytes = guild_core::registry::pack(&dir, &manifest).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    bytes
}

async fn publish_and_install(
    app: &axum::Router,
    token: &str,
    slug: &str,
    version: &str,
    install: bool,
) -> StatusCode {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/registry/integration?slug={slug}&version={version}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(v2_bundle(slug, version)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "publish {slug} failed");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/registry/integration/{slug}/review"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"status": "approved"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "review {slug} failed");
    if !install {
        return StatusCode::OK;
    }
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/registry/integration/{slug}/install"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

async fn put_json(
    app: &axum::Router,
    uri: &str,
    token: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
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
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(json!({}));
    (status, v)
}

async fn get_json(app: &axum::Router, uri: &str, token: &str) -> serde_json::Value {
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

fn hubspot_row(v: &serde_json::Value) -> serde_json::Value {
    v["integrations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "hubspot")
        .expect("hubspot row listed")
        .clone()
}

#[tokio::test]
async fn policy_validation_enable_gate_and_secrets_lifecycle() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    let status = publish_and_install(&app, &token, "hubspot", "1.0.0", true).await;
    assert_eq!(status, StatusCode::OK);

    // invalid tool_policy role keys and class names → 400
    let (status, _) = put_json(
        &app,
        "/api/v1/admin/integrations/hubspot",
        &token,
        json!({"config": {"tool_policy": {"ghost": ["read"]}}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = put_json(
        &app,
        "/api/v1/admin/integrations/hubspot",
        &token,
        json!({"config": {"tool_policy": {"member": ["sudo"]}}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // invalid mcp url → 400
    let (status, _) = put_json(
        &app,
        "/api/v1/admin/integrations/hubspot",
        &token,
        json!({"config": {"mcp": {"url": "ftp://x"}}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // enabling without the declared secret → 409 missing_secrets with names
    let (status, body) = put_json(
        &app,
        "/api/v1/admin/integrations/hubspot",
        &token,
        json!({"enabled": true}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "missing_secrets");
    assert!(
        body["error"]["message"].to_string().contains("api_key"),
        "missing names listed: {}",
        body["error"]["message"]
    );

    // store the secret, then enabling succeeds
    let (status, _) = put_json(
        &app,
        "/api/v1/admin/integrations/hubspot/secrets",
        &token,
        json!({"name": "api_key", "value": "sk-live-123"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // listing exposes names + updated_at only, never values
    let v = get_json(&app, "/api/v1/admin/integrations/hubspot/secrets", &token).await;
    let items = v["secrets"].as_array().expect("secrets list");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "api_key");
    assert!(items[0]["updated_at"].is_string());
    assert!(items[0].get("value").is_none());
    assert!(!v.to_string().contains("sk-live-123"));

    let (status, _) = put_json(
        &app,
        "/api/v1/admin/integrations/hubspot",
        &token,
        json!({"enabled": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let v = get_json(&app, "/api/v1/admin/integrations", &token).await;
    assert_eq!(hubspot_row(&v)["enabled"], true);

    // deleting the declared secret auto-disables the row
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/admin/integrations/hubspot/secrets/api_key")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v = get_json(&app, "/api/v1/admin/integrations", &token).await;
    assert_eq!(hubspot_row(&v)["enabled"], false);
}

#[tokio::test]
async fn available_lists_unconfigured_v2_plugins() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // approved v2 item, not installed → shows up in available as mcp
    let status = publish_and_install(&app, &token, "freshdesk", "1.0.0", false).await;
    assert_eq!(status, StatusCode::OK);
    let v = get_json(&app, "/api/v1/admin/integrations", &token).await;
    let available = v["available"].as_array().expect("available list");
    let entry = available
        .iter()
        .find(|e| e["name"] == "freshdesk")
        .expect("freshdesk in available");
    assert_eq!(entry["category"], "mcp");

    // installed (configured) plugins do not appear in available
    let status = publish_and_install(&app, &token, "hubspot", "1.0.0", true).await;
    assert_eq!(status, StatusCode::OK);
    let v = get_json(&app, "/api/v1/admin/integrations", &token).await;
    let available = v["available"].as_array().expect("available list");
    assert!(
        available.iter().all(|e| e["name"] != "hubspot"),
        "configured hubspot must not be in available: {available:?}"
    );
}
