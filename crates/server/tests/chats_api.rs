use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{insert_org_with_chat, test_state_with_db};
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
        .append_event(chat_uuid, &ThreadEvent::UserMessage { content: "hello".into() })
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
                .body(Body::from(json!({"role": "user", "content": "x"}).to_string()))
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
