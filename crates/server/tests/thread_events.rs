use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{insert_org_with_chat, test_state_with_db};
use protocol::api::{Block, ThreadEvent, UsagePayload};
use serde_json::json;
use tower::ServiceExt;

/// Store roundtrip: appended events come back in id order with identical
/// payloads, and a foreign org sees nothing (spec §A.3, §F).
#[tokio::test]
async fn thread_store_append_list_roundtrip_and_org_scope() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user_id = store
        .identity()
        .ensure_bootstrap_admin("thread@a.b", "hunter226")
        .await
        .unwrap();
    let (_sid, _token) = store.identity().create_session(user_id).await.unwrap();
    let user = store.identity().validate_session(&_token).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user.org_id, user.id, Some("thread store"), None)
        .await
        .unwrap();

    let user_event = ThreadEvent::UserMessage {
        content: "hello thread".into(),
        attachments: Vec::new(),
    };
    let assistant_event = ThreadEvent::AssistantMessage {
        turn: 1,
        step: 2,
        blocks: vec![
            Block::Reasoning {
                text: "thinking hard".into(),
            },
            Block::Text {
                text: "answer".into(),
            },
            Block::ToolCall {
                id: "call_1".into(),
                name: "execute".into(),
                arguments: "{\"cmd\":\"ls\"}".into(),
            },
        ],
        usage: UsagePayload {
            tokens_in: Some(11),
            tokens_out: Some(22),
            cost_usd: Some(0.5),
        },
        model: "deepseek-test".into(),
        interrupted: None,
    };
    let tool_event = ThreadEvent::ToolResult {
        turn: 1,
        step: 2,
        call_id: "call_1".into(),
        name: "execute".into(),
        content: "file.rs".into(),
        is_error: false,
        meta: Some(json!({"card": "terminal", "exit_code": 0})),
        images: Vec::new(),
        kind: None,
    };

    let row0 = store
        .thread()
        .append_event(chat.id, &user_event)
        .await
        .unwrap();
    let row1 = store
        .thread()
        .append_event(chat.id, &assistant_event)
        .await
        .unwrap();
    let row2 = store
        .thread()
        .append_event(chat.id, &tool_event)
        .await
        .unwrap();

    // rows echo the appended event and carry the id/seq/created_at envelope
    assert_eq!(row0.event, user_event);
    assert_eq!(row1.event, assistant_event);
    assert_eq!(row2.event, tool_event);
    assert_eq!(row0.chat_id, chat.id);
    assert!(
        row0.seq < row1.seq && row1.seq < row2.seq,
        "seq is monotone"
    );

    let events = store
        .thread()
        .list_events(user.org_id, chat.id)
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event, user_event);
    assert_eq!(events[1].event, assistant_event);
    assert_eq!(events[2].event, tool_event);
    assert_eq!(events[0].id, row0.id);
    assert_eq!(events[2].seq, row2.seq);

    // org scoping: another org's chat yields nothing for this org, and its
    // own events stay visible to it.
    let foreign_chat = insert_org_with_chat(&store).await;
    store
        .thread()
        .append_event(
            foreign_chat,
            &ThreadEvent::UserMessage {
                content: "foreign".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();
    assert!(store
        .thread()
        .list_events(user.org_id, foreign_chat)
        .await
        .unwrap()
        .is_empty());
}

/// API: GET /api/v1/chats/{id}/thread returns the event rows
/// (id/seq/event/created_at) and 404s for foreign-org chats (spec §E).
#[tokio::test]
async fn thread_endpoint_returns_events_and_is_org_scoped() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("thread2@a.b", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "thread api"}).to_string()))
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

    store
        .thread()
        .append_event(
            chat["id"].as_str().unwrap().parse().unwrap(),
            &ThreadEvent::UserMessage {
                content: "hi via api".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();

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
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"]["type"], "user_message");
    assert_eq!(events[0]["event"]["content"], "hi via api");
    assert!(events[0]["id"].is_string());
    assert!(events[0]["seq"].is_i64());
    assert!(events[0]["created_at"].is_string());
    assert_eq!(events[0]["chat_id"], chat["id"]);

    // foreign org's chat is invisible: 404
    let foreign = insert_org_with_chat(&store).await;
    let res = app
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
}

/// Context-usage snapshot in GET /thread (feat/gauge): `context` carries the
/// tokens_in of the LATEST assistant event, the model name, and the route's
/// context window — falling back to 128000 when the model has no route or
/// its window is NULL.
#[tokio::test]
async fn thread_endpoint_context_snapshot_and_fallback() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user_id = store
        .identity()
        .ensure_bootstrap_admin("gauge@a.b", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user_id).await.unwrap();
    let user = store.identity().validate_session(&token).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user.org_id, user.id, Some("gauge"), None)
        .await
        .unwrap();
    // A route with an explicit context window for the model used below.
    store
        .gateway()
        .upsert_route(
            user.org_id,
            "ctx-model",
            "openai",
            true,
            1.0,
            2.0,
            None,
            false,
            Some(64000),
            None,
            &[],
        )
        .await
        .unwrap();
    let app = guild_server::build_router(ts.state.clone());
    let get_thread = |chat_id: uuid::Uuid| {
        let app = app.clone();
        let token = token.clone();
        async move {
            app.oneshot(
                Request::builder()
                    .uri(format!("/api/v1/chats/{chat_id}/thread"))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        }
    };

    // No turns yet: 0 tokens, model null, fallback window.
    let res = get_thread(chat.id).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["context"]["tokens"], 0);
    assert_eq!(v["context"]["max"], 128000);
    assert!(v["context"]["model"].is_null());

    // Assistant turn on a routed model: tokens_in surfaces, max from route.
    store
        .thread()
        .append_event(
            chat.id,
            &ThreadEvent::UserMessage {
                content: "hi".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat.id,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 1,
                blocks: vec![Block::Text {
                    text: "answer".into(),
                }],
                usage: UsagePayload {
                    tokens_in: Some(5000),
                    tokens_out: Some(50),
                    cost_usd: None,
                },
                model: "ctx-model".into(),
                interrupted: None,
            },
        )
        .await
        .unwrap();
    let res = get_thread(chat.id).await;
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["context"]["tokens"], 5000);
    assert_eq!(v["context"]["max"], 64000);
    assert_eq!(v["context"]["model"], "ctx-model");

    // A later assistant event wins (latest, not first): NULL tokens_in → 0,
    // and an unrouted model → 128000 fallback window.
    store
        .thread()
        .append_event(
            chat.id,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 2,
                blocks: vec![Block::Text {
                    text: "more".into(),
                }],
                usage: UsagePayload {
                    tokens_in: None,
                    tokens_out: None,
                    cost_usd: None,
                },
                model: "unrouted-model".into(),
                interrupted: None,
            },
        )
        .await
        .unwrap();
    let res = get_thread(chat.id).await;
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["context"]["tokens"], 0);
    assert_eq!(v["context"]["max"], 128000);
    assert_eq!(v["context"]["model"], "unrouted-model");
}
