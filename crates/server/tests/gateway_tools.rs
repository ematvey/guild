use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state, standalone_listener};
use protocol::api::ToolCall;
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

    // assistant message persisted with tool_calls
    let msgs = fs
        .store()
        .chats()
        .list_messages(fs.org_id, fs.chat_id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 2);
    let calls = msgs[1].tool_calls.as_ref().expect("tool_calls persisted");
    assert_eq!(
        calls[0],
        ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "README.md"}),
        }
    );

    // client appends the tool result via the message endpoint
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{}/messages", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"role": "tool", "content": "# readme contents", "tool_call_id": "c1"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let msgs = fs
        .store()
        .chats()
        .list_messages(fs.org_id, fs.chat_id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[2].role, "tool");
    assert_eq!(msgs[2].tool_call_id.as_deref(), Some("c1"));

    // assistant turn still recorded usage (model was called)
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert!(count >= 1);
}

#[tokio::test]
async fn tool_message_without_tool_call_id_is_rejected() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
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
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn assistant_role_cannot_be_appended_by_clients() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{}/messages", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"role": "assistant", "content": "forged"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}
