use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn api_key_issue_use_revoke() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let admin_token = fs.token.clone();
    let store = fs.store();

    // create
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/api-keys")
                .header("authorization", format!("Bearer {admin_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "ci"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let plaintext = v["plaintext"].as_str().unwrap().to_string();
    assert!(plaintext.starts_with("gk_"));
    let key_id: Uuid = v["key"]["id"].as_str().unwrap().parse().unwrap();

    // plaintext authenticates (store level)
    let row = store
        .api_keys()
        .authenticate(&plaintext)
        .await
        .unwrap()
        .expect("valid key");
    assert_eq!(row.id, key_id);

    // member tokens cannot manage api keys
    let member = store
        .identity()
        .create_user(fs.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = store.identity().create_session(member.id).await.unwrap();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/admin/api-keys")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // list shows prefix only (no plaintext/unicode hash leak)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/admin/api-keys")
                .header("authorization", format!("Bearer {admin_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains(&plaintext[..10]));
    assert!(!text.contains(&plaintext));

    // revoke → authentication fails
    let res = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/admin/api-keys/{key_id}"))
                .header("authorization", format!("Bearer {admin_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(store
        .api_keys()
        .authenticate(&plaintext)
        .await
        .unwrap()
        .is_none());
}
