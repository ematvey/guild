use axum::body::Body;
use axum::http::{Request, StatusCode};
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
    };
    let bytes = guild_core::registry::pack(&dir, &manifest).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    bytes
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
