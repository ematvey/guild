//! Workspace settings routes: name + logo (org.rs). The logo GET is public
//! (an `<img>` tag cannot send a bearer); every mutation is admin-gated.

#![cfg(feature = "test-support")]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{full_state, FullState};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn call(
    app: &axum::Router,
    token: &str,
    method: &str,
    uri: &str,
    body: Option<Vec<u8>>,
    content_type: Option<&str>,
) -> (StatusCode, Value, Vec<u8>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    if let Some(ct) = content_type {
        builder = builder.header("content-type", ct);
    }
    let res = app
        .clone()
        .oneshot(builder.body(Body::from(body.unwrap_or_default())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, bytes.to_vec())
}

/// A member session in the fixture org (member-scoped assertions need a
/// non-admin bearer).
async fn member_token(fs: &FullState) -> String {
    let store = fs.store();
    let member = store
        .identity()
        .create_user(fs.org_id, "member@x.test", "password123", "member")
        .await
        .unwrap();
    store.identity().create_session(member.id).await.unwrap().1
}

const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
];

#[tokio::test]
async fn org_name_roundtrip_and_admin_gate() {
    let fs = full_state().await;
    let app = guild_server::http::build_router(fs.state.clone());
    let member = member_token(&fs).await;

    // Admin renames the workspace; any member reads it back.
    let (status, body, _) = call(
        &app,
        &fs.token,
        "PUT",
        "/api/v1/org",
        Some(json!({"name": " Acme "}).to_string().into_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "Acme", "name is trimmed");

    let (status, body, _) = call(&app, &member, "GET", "/api/v1/org", None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "Acme");
    assert_eq!(body["logo_url"], Value::Null);

    // A member cannot rename; blank and oversized names are rejected.
    let (status, body, _) = call(
        &app,
        &member,
        "PUT",
        "/api/v1/org",
        Some(json!({"name": "nope"}).to_string().into_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let (status, _, _) = call(
        &app,
        &fs.token,
        "PUT",
        "/api/v1/org",
        Some(json!({"name": "   "}).to_string().into_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn logo_upload_serves_publicly_and_clears() {
    let fs = full_state().await;
    let app = guild_server::http::build_router(fs.state.clone());
    let member = member_token(&fs).await;

    // Member cannot upload; admin can.
    let (status, _, _) = call(
        &app,
        &member,
        "PUT",
        "/api/v1/org/logo?content_type=image/png",
        Some(TINY_PNG.to_vec()),
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body, _) = call(
        &app,
        &fs.token,
        "PUT",
        "/api/v1/org/logo?content_type=image/png",
        Some(TINY_PNG.to_vec()),
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let url = body["logo_url"].as_str().unwrap().to_string();
    assert!(url.contains(&fs.org_id.to_string()), "{url}");

    // Public GET: NO authorization header, bytes + content type come back.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(&url)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()["content-type"],
        "image/png",
        "public logo GET must serve the stored type"
    );
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&bytes[..], TINY_PNG);

    // A non-image type is rejected before anything is stored.
    let (status, _, _) = call(
        &app,
        &fs.token,
        "PUT",
        "/api/v1/org/logo?content_type=application/pdf",
        Some(b"pdf".to_vec()),
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Admin clears: the public GET turns 404.
    let (status, _, _) = call(&app, &fs.token, "DELETE", "/api/v1/org/logo", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(&url)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}
