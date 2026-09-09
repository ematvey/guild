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
