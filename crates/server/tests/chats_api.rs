use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{insert_org_with_chat, register_test_machine, test_state_with_db};
use protocol::api::{Block, ThreadEvent, UsagePayload};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_list_thread_and_org_isolation() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&token).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    // create chat via API
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "my chat"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let chat: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();
    let chat_uuid: uuid::Uuid = chat_id.parse().unwrap();

    // append events via the thread store (the ChatRunner normally does this)
    store
        .thread()
        .append_event(
            chat_uuid,
            &ThreadEvent::UserMessage {
                content: "hello".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat_uuid,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![Block::Text { text: "hi!".into() }],
                usage: UsagePayload {
                    tokens_in: Some(1),
                    tokens_out: Some(1),
                    cost_usd: Some(0.01),
                },
                model: "test-model".into(),
                interrupted: None,
            },
        )
        .await
        .unwrap();

    // read the thread via API: ordered, full payloads
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{chat_id}/thread"))
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
    let events = v["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["event"]["type"], "user_message");
    assert_eq!(events[0]["event"]["content"], "hello");
    assert_eq!(events[1]["event"]["type"], "assistant_message");
    assert_eq!(events[1]["event"]["blocks"][0]["text"], "hi!");
    assert_eq!(events[1]["event"]["usage"]["cost_usd"], 0.01);
    assert!(events[0]["id"].is_string());
    assert!(events[0]["seq"].is_i64());

    // the old /messages endpoints are gone (spec §E, §F): 404
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{chat_id}/messages"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/messages"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"role": "user", "content": "x"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // foreign org's chat is invisible on /thread: 404
    let foreign = insert_org_with_chat(&store).await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{foreign}/thread"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // list chats shows the created chat
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let _ = user_row;
}

/// Machine bindings must reference a live hub machine belonging to the
/// caller's user or org; unknown or foreign machines are rejected.
/// Unbinding stays open.
#[tokio::test]
async fn machine_binding_requires_a_registered_machine() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&token).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    register_test_machine(
        &ts.state,
        "desk-1",
        user_row.id,
        user_row.org_id,
        Some("Desk"),
    )
    .await;

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/machines")
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
    let machines: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        machines["machines"],
        json!([{"machine_id": "desk-1", "name": "Desk"}])
    );

    // bind at creation
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"title": "bound", "machine_id": "desk-1"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let chat: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(chat["machine_id"], "desk-1");
    assert_eq!(chat["machine_label"], "Desk");
    let chat_id = chat["id"].as_str().unwrap().to_string();

    // unknown machine → rejected, at creation and on bind
    for uri in [
        "/api/v1/chats".to_string(),
        format!("/api/v1/chats/{chat_id}/machine"),
    ] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(&uri)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"machine_id": "never-seen"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{uri}");
    }

    // a machine registered under another org is foreign
    let other_org = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'other')")
        .bind(other_org)
        .execute(store.pool())
        .await
        .unwrap();
    let outsider = store
        .identity()
        .create_user(other_org, "o@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_osid, _otok) = store.identity().create_session(outsider.id).await.unwrap();
    register_test_machine(&ts.state, "foreign-1", outsider.id, other_org, Some("F")).await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/machine"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"machine_id": "foreign-1"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // unbind still works
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/machine"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"machine_id": ""}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

/// Thread-list status over the API: the list carries generating/unread, a
/// read POST clears the dot, and a foreign member cannot mark someone
/// else's chat read.
#[tokio::test]
async fn chat_status_flags_and_read_endpoint() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("status@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid0, tok0) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&tok0).await.unwrap();
    let org_id = user_row.org_id;
    let member = store
        .identity()
        .create_user(org_id, "other@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let (_sid2, member_token) = store.identity().create_session(member.id).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let chat_id: uuid::Uuid = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    // fresh chat: idle, read
    let get_list = |app: axum::Router, token: String| async move {
        let res = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/chats")
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
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["chats"]
            .as_array()
            .unwrap()
            .clone()
    };
    let chats = get_list(app.clone(), token.clone()).await;
    assert!(!chats[0]["generating"].as_bool().unwrap());
    assert!(!chats[0]["unread"].as_bool().unwrap());

    // generating flag + an unseen assistant turn (flag suppresses unread)
    store
        .chats()
        .set_generating(org_id, chat_id, true)
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat_id,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![Block::Text {
                    text: "reply".into(),
                }],
                usage: UsagePayload::default(),
                model: "m".into(),
                interrupted: None,
            },
        )
        .await
        .unwrap();
    let chats = get_list(app.clone(), token.clone()).await;
    assert!(chats[0]["generating"].as_bool().unwrap());
    assert!(!chats[0]["unread"].as_bool().unwrap());

    // turn done: unread dot
    store
        .chats()
        .set_generating(org_id, chat_id, false)
        .await
        .unwrap();
    let chats = get_list(app.clone(), token.clone()).await;
    assert!(chats[0]["unread"].as_bool().unwrap());

    // a foreign member cannot mark it read; the owner can
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/read"))
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/read"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let chats = get_list(app, token).await;
    assert!(!chats[0]["unread"].as_bool().unwrap());
}

#[tokio::test]
async fn chat_approval_mode_roundtrip() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("approval-mode@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());
    let auth = format!("Bearer {token}");

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "policy chat"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let chat_id: String = v["id"].as_str().unwrap().to_string();

    // Default: no override.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    if status != StatusCode::OK {
        panic!("GET approval failed: {} {body:?}", status);
    }
    assert!(v["default"].is_null());

    // Set a mode; read it back.
    for mode in ["approve_for_me", "ask", "full_access"] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/chats/{chat_id}/approval"))
                    .header("authorization", &auth)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"default": mode}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/v1/chats/{chat_id}/approval"))
                    .header("authorization", &auth)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["default"], mode);
    }

    // Unknown mode rejected.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"default": "yolo"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Reset to the account default.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"default": "default"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["default"].is_null());
}
