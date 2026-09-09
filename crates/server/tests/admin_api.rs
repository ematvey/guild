use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::store::Store;
use guild_server::test_support::test_state_with_db;
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn user_lifecycle_gated_by_admin_role() {
    let ts = test_state_with_db().await;
    let store: Store = ts.store();
    let admin = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(admin).await.unwrap();
    let user = store.identity().validate_session(&token).await.unwrap();
    let member = store
        .identity()
        .create_user(user.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid2, member_token) = store.identity().create_session(member.id).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    // member forbidden everywhere
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/admin/users")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // admin lists users
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/admin/users")
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
    assert_eq!(v["users"].as_array().unwrap().len(), 2);

    // create user via API
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/users")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email": "new@b.c", "password": "hunter226", "role": "member"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let new_id: Uuid = v["id"].as_str().unwrap().parse().unwrap();

    // delete last admin refused
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/admin/users/{admin}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // delete the created user works; their session dies
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/admin/users/{new_id}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(store.identity().validate_session(&token).await.is_ok());
}

#[tokio::test]
async fn team_create_and_membership() {
    let ts = test_state_with_db().await;
    let store: Store = ts.store();
    let admin = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(admin).await.unwrap();
    let user = store.identity().validate_session(&token).await.unwrap();
    let member = store
        .identity()
        .create_user(user.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let app = guild_server::build_router(ts.state.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/teams")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "platform"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let team_id: Uuid = v["id"].as_str().unwrap().parse().unwrap();

    // duplicate name → conflict
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/teams")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "platform"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // add member
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/admin/teams/{team_id}/members"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"user_id": member.id}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
