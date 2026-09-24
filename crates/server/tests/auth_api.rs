use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

async fn post(
    app: axum::Router,
    uri: &str,
    token: Option<&str>,
    body: serde_json::Value,
) -> axum::response::Response {
    let mut req = Request::builder().method("POST").uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    app.oneshot(
        req.header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn bootstrap_login_me_flow() {
    let ts = guild_server::test_support::test_state_with_db().await;
    let app = guild_server::build_router(ts.state.clone());

    let res = post(
        app.clone(),
        "/api/v1/auth/bootstrap",
        None,
        json!({"email": "a@b.c", "password": "hunter226"}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let res = post(
        app.clone(),
        "/api/v1/auth/bootstrap",
        None,
        json!({"email": "x@y.z", "password": "hunter226"}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::CONFLICT);

    let res = post(
        app.clone(),
        "/api/v1/auth/login",
        None,
        json!({"email": "a@b.c", "password": "hunter226"}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let login: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(login["user"]["role"], "admin");
    let token = login["token"].as_str().unwrap().to_string();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/me")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // wrong password rejected
    let res = post(
        app.clone(),
        "/api/v1/auth/login",
        None,
        json!({"email": "a@b.c", "password": "nope"}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// The bootstrap credential cannot be shorter than the admin-account
/// minimum (8 chars) — it is often the org's only admin.
#[tokio::test]
async fn bootstrap_rejects_a_short_password() {
    let ts = guild_server::test_support::test_state_with_db().await;
    let app = guild_server::build_router(ts.state.clone());

    let res = post(
        app.clone(),
        "/api/v1/auth/bootstrap",
        None,
        json!({"email": "short@b.c", "password": "hunter2"}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // nothing was created: a proper bootstrap still succeeds afterwards
    let res = post(
        app,
        "/api/v1/auth/bootstrap",
        None,
        json!({"email": "short@b.c", "password": "hunter226"}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn logout_revokes_the_bearer_session() {
    let fs = guild_server::test_support::full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let res = post(
        app.clone(),
        "/api/v1/auth/logout",
        Some(&fs.token),
        json!({}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/me")
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn password_reset_revokes_pairing_codes_and_api_keys() {
    let fs = guild_server::test_support::full_state().await;
    let store = fs.store();
    let pair = store
        .pairing()
        .create(fs.org_id, fs.user_id, 60)
        .await
        .unwrap();
    let key = store
        .api_keys()
        .create(fs.org_id, fs.user_id, "stolen", Some(fs.user_id))
        .await
        .unwrap();
    store
        .identity()
        .update_user(fs.org_id, fs.user_id, None, Some("replacement123"))
        .await
        .unwrap();
    assert!(store.pairing().redeem(&pair.secret).await.is_err());
    assert!(store
        .api_keys()
        .authenticate(&key.plaintext)
        .await
        .unwrap()
        .is_none());
}
