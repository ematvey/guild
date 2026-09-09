use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

fn demo_bundle(slug: &str, version: &str) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!(
        "guild-reg-api-{slug}-{version}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(slug)).unwrap();
    std::fs::write(
        dir.join(slug).join("SKILL.md"),
        "---\nname: demo\ndescription: demo skill\n---\nbody",
    )
    .unwrap();
    std::fs::create_dir_all(dir.join(slug).join("assets")).unwrap();
    std::fs::write(dir.join(slug).join("assets/a.txt"), "content-a").unwrap();
    let (bytes, _m) = guild_core::registry::pack_skill(&dir.join(slug), version).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    bytes
}

async fn publish(
    app: &axum::Router,
    kind: &str,
    slug: &str,
    version: &str,
    token: &str,
) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!(
                    "/api/v1/registry/{kind}?slug={slug}&version={version}"
                ))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(demo_bundle(slug, version)))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn publish_list_download_roundtrip() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    let res = publish(&app, "skill", "demo", "1.0.0", &token).await;
    assert_eq!(res.status(), StatusCode::OK, "publish should succeed");

    // list shows the item (draft until reviewed)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/registry/skill")
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
    assert_eq!(v["items"][0]["slug"], "demo");
    assert_eq!(v["items"][0]["latest_version"], "1.0.0");
    assert_eq!(v["items"][0]["review_status"], "draft");

    // versions list
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/registry/skill/demo")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["versions"][0]["version"], "1.0.0");

    // republish same version replaces content
    let res = publish(&app, "skill", "demo", "1.0.0", &token).await;
    assert_eq!(res.status(), StatusCode::OK);

    // draft is not downloadable by a member...
    let member = fs
        .store()
        .identity()
        .create_user(fs.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = fs
        .store()
        .identity()
        .create_session(member.id)
        .await
        .unwrap();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/registry/skill/demo/1.0.0/bundle")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // ...but the admin can
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/registry/skill/demo/1.0.0/bundle")
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
    let dest = std::env::temp_dir().join(format!("guild-reg-dl-{}", Uuid::now_v7()));
    let m = guild_core::registry::extract(&body, &dest).unwrap();
    assert_eq!(m.slug, "demo");
    assert_eq!(
        std::fs::read_to_string(dest.join("assets/a.txt")).unwrap(),
        "content-a"
    );
    std::fs::remove_dir_all(&dest).unwrap();
}

#[tokio::test]
async fn review_flow_gates_member_download() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();
    let member = fs
        .store()
        .identity()
        .create_user(fs.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = fs
        .store()
        .identity()
        .create_session(member.id)
        .await
        .unwrap();

    assert_eq!(
        publish(&app, "skill", "demo", "1.0.0", &token)
            .await
            .status(),
        StatusCode::OK
    );

    // member cannot review
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/registry/skill/demo/review")
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"status": "approved"}).to_string()))
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
                .uri("/api/v1/registry/skill/demo/review")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"status": "approved"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // now the member downloads fine
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/registry/skill/demo/1.0.0/bundle")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // a NEW version resets to draft
    assert_eq!(
        publish(&app, "skill", "demo", "1.1.0", &token)
            .await
            .status(),
        StatusCode::OK
    );
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/registry/skill/demo/1.1.0/bundle")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn publish_validates_manifest_against_query() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    // manifest says slug "demo" but query says "other" → 400
    let res = publish(&app, "skill", "other", "1.0.0", &fs.token).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    // invalid kind
    let res = publish(&app, "weapons", "demo", "1.0.0", &fs.token).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}
