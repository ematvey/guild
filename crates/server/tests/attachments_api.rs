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

/// A transient object-store read failure fails the send (retryable) instead
/// of silently stripping the attachment from the immutable user message —
/// one S3 error must not turn the attachment into "content not inlined"
/// forever. The store here is unreachable (closed port), so the read fails
/// with a non-NotFound error on the REAL submission path.
#[tokio::test]
async fn an_object_store_read_failure_fails_the_send() {
    use guild_server::config::Config;
    use guild_server::state::AppState;
    use std::sync::Arc;

    let db = guild_server::store::Store::connect_test().await.unwrap();
    let mut cfg = Config::test_config();
    cfg.database_url = db.url.clone();
    cfg.s3_url = "http://127.0.0.1:1".into();
    let state = AppState::with_store(Arc::new(db.store.clone()), cfg);
    let store = db.store.clone();

    let user = store
        .identity()
        .ensure_bootstrap_admin("att-fail@example.org", "hunter226")
        .await
        .unwrap();
    let user_row = store.identity().get_user(user).await.unwrap();
    let (_, token) = store.identity().create_session(user).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user_row.org_id, user, Some("att-fail"), None)
        .await
        .unwrap();
    store
        .gateway()
        .upsert_route(
            user_row.org_id,
            "gpt-test",
            "openai",
            true,
            1.0,
            2.0,
            None,
            false,
            None,
            None,
            &[],
        )
        .await
        .unwrap();
    let att = store
        .attachments()
        .create(
            uuid::Uuid::now_v7(),
            user_row.org_id,
            chat.id,
            "notes.txt",
            "text/plain",
            12,
            &guild_server::store::attachments::object_key(
                user_row.org_id,
                uuid::Uuid::now_v7(),
                "notes.txt",
            ),
        )
        .await
        .unwrap();

    let app = guild_server::build_router(state);
    let res = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "chat_id": chat.id,
                        "model": "gpt-test",
                        "messages": [{"role": "user", "content": "read this"}],
                        "attachment_ids": [att.id]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "a failed attachment read must fail the send, not strip the attachment"
    );
}
