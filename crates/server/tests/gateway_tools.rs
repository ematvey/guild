use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state, standalone_listener};
use serde_json::json;
use tower::ServiceExt;

/// Provider that streams a tool call for read_file.
async fn tool_provider() -> wiremock::MockServer {
    let server = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\": \\\"README.md\\\"}\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                    "data: [DONE]\n\n",
                )),
        )
        .mount(&server)
        .await;
    server
}

// Ignored: gateway chat routes through the Restate ChatRunner and tests have
// no Restate runtime (placeholder restate_url). Un-ignore once tests embed Restate.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test]
async fn tool_call_streams_persists_and_usage_records() {
    let fake = tool_provider().await;
    let fs = full_state().await;
    // point the org's openai key at the tool-calling fake
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(fs.org_id, "openai", &fake.uri(), "sk-test", &master)
        .await
        .unwrap();

    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "chat_id": fs.chat_id,
                        "model": fs.model,
                        "messages": [{"role": "user", "content": "read the readme"}],
                        "tools": [{"name": "read_file", "description": "read a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}]
                    })
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
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("tool_call_delta"), "{text}");
    assert!(text.contains("tool_call_done"), "{text}");
    assert!(text.contains("read_file"), "{text}");

    // assistant turn persisted as a thread event with tool_call blocks
    let events = fs
        .store()
        .thread()
        .list_events(fs.org_id, fs.chat_id)
        .await
        .unwrap();
    assert_eq!(events.len(), 2, "system + assistant events for the turn");
    let (assistant_id, assistant_event) = match &events[1].event {
        protocol::api::ThreadEvent::AssistantMessage { blocks, .. } => {
            (events[1].id, blocks.clone())
        }
        other => panic!("expected assistant event, got {other:?}"),
    };
    let _ = assistant_id;
    let call_block = assistant_event
        .iter()
        .find_map(|b| match b {
            protocol::api::Block::ToolCall {
                id,
                name,
                arguments,
            } => Some((id.clone(), name.clone(), arguments.clone())),
            _ => None,
        })
        .expect("tool_call block persisted");
    assert_eq!(call_block.0, "c1");
    assert_eq!(call_block.1, "read_file");
    assert_eq!(
        call_block.2, "{\"path\": \"README.md\"}",
        "raw arguments string as the model produced it"
    );

    // client appends the tool result via the gateway result RPC (with meta)
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/gateway/chat/{}/tools/c1/result",
                    fs.chat_id
                ))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"content": "# readme contents", "is_error": false,
                           "meta": {"card": "read", "path": "README.md"}})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // (the result itself is persisted by the journaled ChatRunner, which
    // needs a live Restate runtime — out of scope for this harness; the
    // meta plumbing is unit-checked in the worker's own tests)
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert!(count >= 1);
}

#[tokio::test]
async fn messages_endpoints_are_gone() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    // GET /messages removed (spec §E, §F): 404
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{}/messages", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    // POST /messages removed: 404 (any body, any role)
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{}/messages", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"role": "tool", "content": "x"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

// Ignored like the test above: needs an embedded Restate runtime.
// Regression coverage for the overflow-retry path: the provider rejects the
// first model call with a context-overflow error, compaction runs, and the
// retried call succeeds — the compacted history must carry into the rest of
// the turn instead of the stale pre-compaction messages.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test]
async fn overflow_retry_completes_turn_with_compacted_history() {
    let fake = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    // First request → overflow error frame; second → text completion.
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(|req: &wiremock::Request| {
            static FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
            let _ = req;
            if FIRST.swap(false, std::sync::atomic::Ordering::SeqCst) {
                wiremock::ResponseTemplate::new(400).set_body_string(
                    "prompt is too long: 900000 tokens > 8192 maximum context length",
                )
            } else {
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
                    )
            }
        })
        .mount(&fake)
        .await;
    let fs = full_state().await;
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(fs.org_id, "openai", &fake.uri(), "sk-test", &master)
        .await
        .unwrap();

    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    json!({
                        "chat_id": fs.chat_id,
                        "model": fs.model,
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("delta"), "{text}");
    assert!(!text.contains("error"), "{text}");
}
