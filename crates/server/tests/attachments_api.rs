use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn attachment_upload_list_download_round_trip() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());

    // upload into the seeded chat
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/chats/{}/attachments?filename=report.txt&content_type=text/plain",
                    fs.chat_id
                ))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/octet-stream")
                .body(Body::from("attachment body bytes"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["filename"], "report.txt");
    assert_eq!(v["size_bytes"], 21);
    let attachment_id = v["id"].as_str().unwrap().to_string();

    // list for the chat shows it
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{}/attachments", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8(body.to_vec())
        .unwrap()
        .contains("report.txt"));

    // download returns the original bytes + content type
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/attachments/{attachment_id}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get("content-type").unwrap(), "text/plain");
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], b"attachment body bytes");

    // another org's admin cannot see it (foreign 404); a second bootstrap
    // admin requires an empty users table, so verify cross-org scoping via a
    // fresh Store is out of scope here — instead assert a wrong-id lookup 404s
    let store = fs.store();
    let missing = uuid::Uuid::now_v7();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/attachments/{missing}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    let _ = store;
    // unsafe filenames rejected
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/chats/{}/attachments?filename=../evil&content_type=text/plain",
                    fs.chat_id
                ))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/octet-stream")
                .body(Body::from("x"))
                .unwrap(),
        )
        .await
        .unwrap();
    // "../evil" is sanitized to ".._evil" which starts with '.' → rejected
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

/// Member A must not list or download member B's attachment; the org admin
/// can. Same owner+admin-bypass predicate as the other chat routes.
#[tokio::test]
async fn attachment_access_is_owner_scoped_with_admin_bypass() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());

    // member B owns a chat and uploads into it
    let member_b = fs
        .store()
        .identity()
        .create_user(fs.org_id, "b@x.y", "hunter226", "member")
        .await
        .unwrap();
    let (_sid_b, token_b) = fs
        .store()
        .identity()
        .create_session(member_b.id)
        .await
        .unwrap();
    let member_a = fs
        .store()
        .identity()
        .create_user(fs.org_id, "a@x.y", "hunter226", "member")
        .await
        .unwrap();
    let (_sid_a, token_a) = fs
        .store()
        .identity()
        .create_session(member_a.id)
        .await
        .unwrap();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token_b}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "b-chat"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let chat: Value = serde_json::from_slice(&body).unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/chats/{chat_id}/attachments?filename=secret.txt&content_type=text/plain"
                ))
                .header("authorization", format!("Bearer {token_b}"))
                .header("content-type", "application/octet-stream")
                .body(Body::from("b's bytes"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let att: Value = serde_json::from_slice(&body).unwrap();
    let attachment_id = att["id"].as_str().unwrap().to_string();

    // member A: list and download both 404
    for (method, uri) in [
        ("GET", format!("/api/v1/chats/{chat_id}/attachments")),
        ("GET", format!("/api/v1/attachments/{attachment_id}")),
    ] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("authorization", format!("Bearer {token_a}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // org admin passes
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/attachments/{attachment_id}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], b"b's bytes");
}
