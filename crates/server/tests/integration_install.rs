use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_core::registry::BundleManifest;
use guild_server::test_support::full_state;
use serde_json::json;
use tower::ServiceExt;

fn integration_bundle(slug: &str, version: &str) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!(
        "guild-integration-{slug}-{version}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("routine.json"),
        json!({
            "name": "Release notes poster",
            "prompt": "Post the release notes.",
            "model": "gpt-test",
            "trigger_kind": "webhook",
            "allowed_tools": ["http_call"]
        })
        .to_string(),
    )
    .unwrap();
    let manifest = guild_core::registry::BundleManifest {
        kind: "integration".into(),
        slug: slug.into(),
        version: version.into(),
        description: "posts release notes".into(),
        dependencies: vec![],
        ..Default::default()
    };
    let bytes = guild_core::registry::pack(&dir, &manifest).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    bytes
}

fn v2_bundle(slug: &str, version: &str, auth_kind: &str) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!(
        "guild-v2-bundle-{slug}-{version}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = BundleManifest {
        kind: "integration".into(),
        slug: slug.into(),
        version: version.into(),
        description: "HubSpot CRM tools".into(),
        dependencies: vec![],
        mcp: Some(guild_core::registry::McpManifest {
            url: "https://mcp.example.com/mcp".into(),
        }),
        auth: Some(guild_core::registry::AuthManifest {
            kind: auth_kind.into(),
            secret_names: vec!["api_key".into()],
            identity_key: "email".into(),
        }),
        tools: Some(guild_core::registry::ToolsManifest {
            classes: [("search_contacts".to_string(), "read".to_string())]
                .into_iter()
                .collect(),
        }),
        triggers: vec![guild_core::registry::TriggerSpec {
            kind: "webhook".into(),
            name: Some("digest".into()),
            trigger_config: json!({}),
            prompt: "digest it".into(),
            model: "gpt-4o-mini".into(),
            allowed_tools: None,
        }],
        skills: vec![],
    };
    let bytes = guild_core::registry::pack(&dir, &manifest).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    bytes
}

async fn get(app: &axum::Router, uri: &str, token: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn v2_publish_rejects_bad_auth_kind() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration?slug=bad-hubspot&version=1.0.0")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(v2_bundle("bad-hubspot", "1.0.0", "magic")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn v2_install_creates_disabled_plugin_row_and_routines() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // publish a valid v2 bundle
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration?slug=hubspot&version=1.2.0")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(v2_bundle("hubspot", "1.2.0", "org_secret")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // approve + install
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/hubspot/review")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"status": "approved"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/hubspot/install")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // the plugin row exists, disabled, with the mcp url in config
    let res = get(&app, "/api/v1/admin/integrations", &token).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let row = v["integrations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "hubspot")
        .expect("hubspot row listed")
        .clone();
    assert_eq!(row["enabled"], false);
    assert_eq!(
        row["config"]["mcp"]["url"],
        "https://mcp.example.com/mcp"
    );
    assert_eq!(row["config"]["auth"]["kind"], "org_secret");

    // the manifest trigger created a disabled routine
    let res = get(&app, "/api/v1/routines", &token).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let routine = v["routines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["slug"] == "hubspot")
        .expect("hubspot routine listed")
        .clone();
    assert_eq!(routine["enabled"], false);
    assert_eq!(routine["prompt"], "digest it");
    assert_eq!(routine["trigger_kind"], "webhook");

    // installing again is idempotent for the row
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/hubspot/install")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = get(&app, "/api/v1/admin/integrations", &token).await;
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let rows = v["integrations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"] == "hubspot")
        .count();
    assert_eq!(rows, 1);
}

#[tokio::test]
async fn integration_install_creates_disabled_routine() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // publish the integration bundle
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration?slug=release-notes&version=1.0.0")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(integration_bundle("release-notes", "1.0.0")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // draft → install forbidden for members
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/release-notes/install")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // admin approves
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/release-notes/review")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"status": "approved"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // install → creates a disabled routine from routine.json
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/release-notes/install")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let routine = &v["routine"];
    assert_eq!(routine["slug"], "release-notes");
    assert_eq!(routine["enabled"], false);
    assert_eq!(routine["prompt"], "Post the release notes.");
    assert_eq!(routine["trigger_kind"], "webhook");
    let routine_id = routine["id"].as_str().unwrap().to_string();

    // the routine exists in the routines API, still disabled
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/routines/{routine_id}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["enabled"], false);

    // installing again → conflict (slug taken)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/integration/release-notes/install")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // non-integration kinds are refused server-side
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/skill/some-skill/install")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}
