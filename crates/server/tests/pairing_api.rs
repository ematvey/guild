//! Pairing-token API (desktop enrollment): create (authed), redeem
//! (unauthenticated exchange), single-use + TTL semantics, revocation.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::test_state_with_db;
use serde_json::json;
use tower::ServiceExt;

struct Fix {
    app: axum::Router,
    token: String,
    /// Keeps the Postgres testcontainer alive for the whole test.
    _ts: guild_server::test_support::TestState,
}

impl Fix {
    async fn serve() -> Self {
        let ts = test_state_with_db().await;
        ts.store()
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let user = ts
            .store()
            .identity()
            .find_by_email_any("a@b.c")
            .await
            .unwrap()
            .unwrap();
        let (_sid, token) = ts.store().identity().create_session(user.id).await.unwrap();
        Self {
            app: guild_server::build_router(ts.state.clone()),
            token,
            _ts: ts,
        }
    }

    async fn req(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> axum::response::Response {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        if body.is_some() {
            b = b.header("content-type", "application/json");
        }
        self.app
            .clone()
            .oneshot(
                b.body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn body(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}

/// Creates a pairing token and returns (id, full code).
async fn create_token(fx: &Fix) -> (String, String) {
    let res = fx
        .req(
            "POST",
            "/api/v1/auth/pairing-tokens",
            Some(&fx.token),
            Some(json!({"ttl_minutes": 30})),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = Fix::body(res).await;
    let secret = v["secret"].as_str().unwrap().to_string();
    assert_eq!(secret.len(), 64);
    // client composes the full code: g1|<server_url>|<secret> — any URL works
    // server-side (routing info only)
    (
        v["id"].as_str().unwrap().to_string(),
        format!("g1|https://guild.example|{secret}"),
    )
}

#[tokio::test]
async fn create_redeem_and_reuse_rejected() {
    let fx = Fix::serve().await;
    let (_id, code) = create_token(&fx).await;

    // redeem (no auth header): returns a working session
    let res = fx
        .req(
            "POST",
            "/api/v1/auth/pair",
            None,
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = Fix::body(res).await;
    let token = v["token"].as_str().unwrap();
    assert_eq!(v["user"]["email"], "a@b.c");
    let me = fx.req("GET", "/api/v1/auth/me", Some(token), None).await;
    assert_eq!(me.status(), StatusCode::OK);

    // second redemption of the same code fails
    let res = fx
        .req(
            "POST",
            "/api/v1/auth/pair",
            None,
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn malformed_codes_rejected() {
    let fx = Fix::serve().await;
    for bad in [
        "not-a-code",
        "g1|https://x|",
        "g1|https://x|zzz",
        "g1|https://x|a1|extra",
        "",
        "g1|ftp://x|a1b2",
    ] {
        let res = fx
            .req(
                "POST",
                "/api/v1/auth/pair",
                None,
                Some(json!({"code": bad})),
            )
            .await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "code {bad:?}");
    }
}

#[tokio::test]
async fn expired_token_rejected() {
    let ts = test_state_with_db().await;
    ts.store()
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let user = ts
        .store()
        .identity()
        .find_by_email_any("a@b.c")
        .await
        .unwrap()
        .unwrap();
    let created = ts
        .store()
        .pairing()
        .create(user.org_id, user.id, 1, None)
        .await
        .unwrap();
    let code = format!("g1|https://guild.example|{}", created.secret);

    // rewind expiry directly (TTL enforcement is in SQL; the API only
    // accepts positive TTLs)
    sqlx::query("UPDATE pairing_tokens SET expires_at = now() - interval '1 minute'")
        .execute(ts.store().pool())
        .await
        .unwrap();

    let app = guild_server::build_router(ts.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/pair")
                .header("content-type", "application/json")
                .body(Body::from(json!({"code": code}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoke_and_list() {
    let fx = Fix::serve().await;
    let (id, code) = create_token(&fx).await;

    // listed as outstanding
    let res = fx
        .req("GET", "/api/v1/auth/pairing-tokens", Some(&fx.token), None)
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let list = Fix::body(res).await;
    assert_eq!(list["tokens"].as_array().unwrap().len(), 1);
    assert_eq!(list["tokens"][0]["id"], json!(id));

    // revoke
    let res = fx
        .req(
            "DELETE",
            &format!("/api/v1/auth/pairing-tokens/{id}"),
            Some(&fx.token),
            None,
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);

    // gone from the list; redemption fails
    let res = fx
        .req("GET", "/api/v1/auth/pairing-tokens", Some(&fx.token), None)
        .await;
    let list = Fix::body(res).await;
    assert_eq!(list["tokens"].as_array().unwrap().len(), 0);
    let res = fx
        .req(
            "POST",
            "/api/v1/auth/pair",
            None,
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unauthenticated_create_rejected() {
    let fx = Fix::serve().await;
    let res = fx
        .req("POST", "/api/v1/auth/pairing-tokens", None, Some(json!({})))
        .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
