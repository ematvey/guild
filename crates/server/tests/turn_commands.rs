#![cfg(feature = "test-support")]
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use guild_server::{
    state::AppState,
    test_support::{full_state, note_generation},
};
use protocol::api::{Block, ThreadEvent, UsagePayload};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

fn post(token: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/gateway/chat")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}
fn command(chat: Uuid, id: Uuid, text: &str) -> Value {
    json!({"chat_id":chat,"model":"gpt-test","user_message_id":id,"messages":[{"role":"user","content":text}]})
}

#[tokio::test]
async fn concurrent_retries_commit_one_echo_and_reject_changed_payload() {
    let fs = full_state().await;
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());
    let id = Uuid::now_v7();
    let body = command(fs.chat_id, id, "original");
    let (a, b) = tokio::join!(
        app.clone().oneshot(post(&fs.token, &body)),
        app.clone().oneshot(post(&fs.token, &body))
    );
    assert_eq!(a.unwrap().status(), StatusCode::OK);
    assert_eq!(b.unwrap().status(), StatusCode::OK);
    let changed = command(fs.chat_id, id, "changed");
    assert_eq!(
        app.oneshot(post(&fs.token, &changed))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let store = fs.store();
    assert_eq!(
        store
            .thread()
            .list_events(fs.org_id, fs.chat_id)
            .await
            .unwrap()
            .len(),
        1
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM turn_commands")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert!(store
        .turn_commands()
        .existing(id, Uuid::now_v7(), fs.user_id, fs.chat_id, &body)
        .await
        .is_err());
}

#[tokio::test]
async fn ambiguous_ingress_retries_keep_one_idempotency_key_and_recover_from_outbox() {
    let fs = full_state().await;
    let ingress = wiremock::MockServer::start().await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = calls.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_: &wiremock::Request| {
            if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                // The ingress committed the invocation but its first reply was lost.
                wiremock::ResponseTemplate::new(502)
            } else {
                wiremock::ResponseTemplate::new(202)
                    .set_body_json(json!({"invocationId":"inv-stable"}))
            }
        })
        .mount(&ingress)
        .await;
    let mut config = (*fs.state.config).clone();
    config.restate_url = ingress.uri();
    let state = AppState::from_config(config);
    let app = guild_server::build_router(state.clone());
    let id = Uuid::now_v7();
    let body = command(fs.chat_id, id, "once");
    let response = app.oneshot(post(&fs.token, &body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let ack: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ack["generation_id"], json!(id));
    assert_eq!(ack["queued"], true);
    // A fresh pump can deliver after request/process cancellation, without a client retry.
    guild_server::http::gateway::dispatch_turn_commands(&state, Some(fs.chat_id))
        .await
        .unwrap();
    assert_eq!(state.generations.handle(fs.chat_id).unwrap().id, id);
    let requests = ingress.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].headers.get("idempotency-key"),
        requests[1].headers.get("idempotency-key")
    );
    assert_eq!(requests[0].body, requests[1].body);
    let store = fs.store();
    assert_eq!(
        store
            .thread()
            .list_events(fs.org_id, fs.chat_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .turn_commands()
            .begin(id, fs.chat_id, "inv-stable")
            .await
            .unwrap(),
        Some(true)
    );
    store
        .turn_commands()
        .finish(id, "inv-stable", false)
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .begin(id, fs.chat_id, "inv-after-retention")
            .await
            .unwrap(),
        Some(false)
    );
}

#[tokio::test]
async fn queue_consumption_ignores_interleaved_assistant_and_tool_events() {
    let fs = full_state().await;
    let store = fs.store();
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());
    let a = Uuid::now_v7();
    let b = Uuid::now_v7();
    let c = Uuid::now_v7();
    for (id, text) in [(a, "A"), (b, "B"), (c, "C")] {
        assert_eq!(
            app.clone()
                .oneshot(post(&fs.token, &command(fs.chat_id, id, text)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        store
            .turn_commands()
            .begin(a, fs.chat_id, "inv-a")
            .await
            .unwrap(),
        Some(true)
    );
    store
        .thread()
        .append_event(
            fs.chat_id,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![Block::Text {
                    text: "answer A".into(),
                }],
                usage: UsagePayload::default(),
                model: "gpt-test".into(),
                interrupted: Some(true),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            fs.chat_id,
            &ThreadEvent::ToolResult {
                turn: 1,
                step: 0,
                call_id: "tool".into(),
                name: "probe".into(),
                content: "result A".into(),
                is_error: false,
                meta: None,
                images: vec![],
                kind: None,
                artifact_id: None,
            },
        )
        .await
        .unwrap();
    assert!(store
        .turn_commands()
        .pending_heads(Some(fs.chat_id))
        .await
        .unwrap()
        .is_empty());
    store
        .turn_commands()
        .finish(a, "inv-a", false)
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .pending_heads(Some(fs.chat_id))
            .await
            .unwrap()[0]
            .id,
        b
    );
    assert_eq!(
        store
            .turn_commands()
            .begin(b, fs.chat_id, "inv-b")
            .await
            .unwrap(),
        Some(true)
    );
    let events = store
        .thread()
        .model_events(fs.org_id, fs.chat_id, None)
        .await
        .unwrap();
    let labels: Vec<String> = events
        .iter()
        .filter_map(|row| match &row.event {
            ThreadEvent::UserMessage { content, .. } => Some(content.clone()),
            ThreadEvent::AssistantMessage { .. } => Some("answer A".into()),
            ThreadEvent::ToolResult { .. } => Some("result A".into()),
            _ => None,
        })
        .collect();
    assert_eq!(labels, ["A", "answer A", "result A", "B"]);
    store
        .turn_commands()
        .finish(b, "inv-b", false)
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .pending_heads(Some(fs.chat_id))
            .await
            .unwrap()[0]
            .id,
        c
    );
    store
        .turn_commands()
        .cancel_waiting_head(fs.chat_id)
        .await
        .unwrap();
    assert!(store
        .turn_commands()
        .pending_heads(Some(fs.chat_id))
        .await
        .unwrap()
        .is_empty());
}
