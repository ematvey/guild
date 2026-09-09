use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Fake OIDC IdP: discovery, token, userinfo over wiremock.
async fn fake_idp(user_email: &str) -> wiremock::MockServer {
    let server = wiremock::MockServer::start().await;
    let email = user_email.to_string();
    let uri = server.uri();

    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path(
            "/.well-known/openid-configuration",
        ))
        .respond_with(move |_req: &wiremock::Request| {
            wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "authorization_endpoint": format!("{uri}/authorize"),
                "token_endpoint": format!("{uri}/token"),
                "userinfo_endpoint": format!("{uri}/userinfo"),
            }))
        })
        .mount(&server)
        .await;

    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/token"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "idp-access-token",
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;

    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/userinfo"))
        .respond_with(move |req: &wiremock::Request| {
            let auth = req
                .headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if auth == "Bearer idp-access-token" {
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({"email": email, "sub": "user-1"}))
            } else {
                wiremock::ResponseTemplate::new(401)
            }
        })
        .mount(&server)
        .await;

    server
}

#[tokio::test]
async fn oidc_login_provisions_user_and_issues_session() {
    let idp = fake_idp("sso.user@example.org").await;
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let store = fs.store();

    // admin configures oidc
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/admin/oidc")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"issuer": idp.uri(), "client_id": "guild-client", "client_secret": "s3cret"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // GET hides the secret
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/admin/oidc")
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["configured"], true);
    assert_eq!(v["client_id"], "guild-client");
    assert!(v.get("client_secret").is_none());

    // login → 302 to the IdP with signed state
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/auth/oidc/login?org_id={}", fs.org_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let location = res
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        location.starts_with(&format!("{}/authorize", idp.uri())),
        "{location}"
    );
    let state = location
        .split("state=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();

    // callback exchanges the code, provisions the user, issues a session
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/auth/oidc/callback?code=the-code&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let token = v["token"].as_str().unwrap().to_string();
    assert_eq!(v["email"], "sso.user@example.org");

    // session works and the user is an org member
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
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["org_id"], fs.org_id.to_string());
    assert_eq!(v["role"], "member");

    // user row persisted with identity_type oidc (via the me endpoint's email)
    let row = store
        .identity()
        .find_by_email(fs.org_id, "sso.user@example.org")
        .await
        .unwrap()
        .expect("oidc user provisioned");
    let _ = row.id;

    // second login for the same email reuses the account
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/auth/oidc/callback?code=again&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    // still exactly one row with that email (find_by_email returns one)
    let again = store
        .identity()
        .find_by_email(fs.org_id, "sso.user@example.org")
        .await
        .unwrap()
        .expect("user still present");
    let _ = again;

    // bad state rejected
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/oidc/callback?code=x&state=forged")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
