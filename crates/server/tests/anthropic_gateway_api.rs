//! Public Anthropic-compatible endpoint `/anthropic/v1/messages`: request
//! conversion (system, content blocks, tool_use/tool_result, images), both
//! response modes in the Anthropic wire shape, `x-api-key` auth, and
//! org-route model scoping.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{full_state, standalone_listener};
use serde_json::{json, Value};
use tower::ServiceExt;

/// OpenAI SSE provider: first call emits a tool call, second a final text.
async fn scripted_provider() -> wiremock::MockServer {
    let server = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = calls.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_req: &wiremock::Request| {
            let n = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_x\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"oslo\\\"}\"}}]}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                        "data: [DONE]\n\n",
                    ))
            } else {
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"sunny, 12C\"}}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n",
                        "data: [DONE]\n\n",
                    ))
            }
        })
        .mount(&server)
        .await;
    server
}

async fn issue_user_key(app: &axum::Router, token: &str) -> String {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/api-keys")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "claude code"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    v["plaintext"].as_str().unwrap().to_string()
}

async fn post_messages(
    app: &axum::Router,
    key: &str,
    auth_header: Option<String>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01");
    builder = match auth_header {
        Some(h) => builder.header("x-api-key", h),
        None => builder.header("authorization", format!("Bearer {key}")),
    };
    let res = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

/// The mock also catches stray health/S3 probes (docker-proxy listener
/// collision — see standalone_listener); keep only the provider chat calls.
async fn chat_calls(provider: &wiremock::MockServer) -> Vec<wiremock::Request> {
    provider
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path().contains("chat/completions"))
        .collect()
}

#[tokio::test]
async fn non_stream_tool_round_trip() {
    let provider = scripted_provider().await;
    let fs = full_state().await;
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(
            fs.org_id,
            "openai",
            provider.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();
    let app = guild_server::build_router(fs.state.clone());
    let key = issue_user_key(&app, &fs.token).await;

    // turn 1: system + user text → tool_use block in Anthropic shape
    let req_body = json!({
        "model": "gpt-test",
        "max_tokens": 1024,
        "system": "be terse",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "weather in oslo?"}]}],
    });
    let (status, v) = post_messages(&app, &key, None, req_body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["type"], "message");
    assert_eq!(v["role"], "assistant");
    assert_eq!(v["stop_reason"], "tool_use");
    let block = &v["content"][0];
    assert_eq!(block["type"], "tool_use");
    assert_eq!(block["id"], "call_x");
    assert_eq!(block["name"], "get_weather");
    assert_eq!(block["input"], json!({"city": "oslo"}));

    // the upstream saw the Anthropic request converted to the internal
    // OpenAI shape (system message, string content)
    let upstream = chat_calls(&provider).await.remove(0);
    let upstream_body: Value = serde_json::from_slice(&upstream.body).unwrap();
    assert_eq!(
        upstream_body["messages"][0]["role"],
        "system",
        "top-level system lands as the system message"
    );
    assert_eq!(upstream_body["messages"][0]["content"], "be terse");
    assert_eq!(upstream_body["messages"][1]["content"], "weather in oslo?");

    // turn 2: assistant tool_use + user tool_result (content array) convert
    let req_body = json!({
        "model": "gpt-test",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "weather?"},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "call_x", "name": "get_weather", "input": {"city": "oslo"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_x", "content": [{"type": "text", "text": "snow"}]}
            ]}
        ]
    });
    let (status, v) = post_messages(&app, &key, None, req_body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["content"][0]["type"], "text");
    assert_eq!(v["content"][0]["text"], "sunny, 12C");
    assert_eq!(v["stop_reason"], "end_turn");
    assert_eq!(v["usage"]["input_tokens"], 7);
    assert_eq!(v["usage"]["output_tokens"], 3);

    // tool_result became a role="tool" message upstream
    let upstream = chat_calls(&provider).await.remove(1);
    let upstream_body: Value = serde_json::from_slice(&upstream.body).unwrap();
    let tool_msgs: Vec<&Value> = upstream_body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .collect();
    assert_eq!(tool_msgs.len(), 1);
    assert_eq!(tool_msgs[0]["tool_call_id"], "call_x");
    assert_eq!(tool_msgs[0]["content"], "snow");
}

#[tokio::test]
async fn stream_emits_anthropic_events() {
    let provider = scripted_provider().await;
    let fs = full_state().await;
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(
            fs.org_id,
            "openai",
            provider.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();
    let app = guild_server::build_router(fs.state.clone());
    let key = issue_user_key(&app, &fs.token).await;

    let req_body = json!({
        "model": "gpt-test",
        "max_tokens": 1024,
        "stream": true,
        "messages": [{"role": "user", "content": "weather in oslo?"}],
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/anthropic/v1/messages")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(req_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();

    let events: Vec<(String, Value)> = text
        .split("\n\n")
        .filter_map(|chunk| {
            let mut event = None;
            let mut data = None;
            for line in chunk.lines() {
                if let Some(e) = line.strip_prefix("event: ") {
                    event = Some(e.to_string());
                } else if let Some(d) = line.strip_prefix("data: ") {
                    data = Some(serde_json::from_str(d).unwrap());
                }
            }
            event.map(|e| (e, data.unwrap_or(Value::Null)))
        })
        .collect();
    let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
    );
    let start = &events[0].1["message"];
    assert_eq!(start["type"], "message");
    assert_eq!(start["role"], "assistant");
    assert_eq!(events[1].1["content_block"]["type"], "tool_use");
    assert_eq!(events[1].1["content_block"]["name"], "get_weather");
    assert_eq!(
        events[2].1["delta"],
        json!({"type": "input_json_delta", "partial_json": "{\"city\":\"oslo\"}"})
    );
    assert_eq!(events[4].1["delta"]["stop_reason"], "tool_use");
}

#[tokio::test]
async fn x_api_key_auth_and_error_shapes() {
    let provider = scripted_provider().await;
    let fs = full_state().await;
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(
            fs.org_id,
            "openai",
            provider.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();
    let app = guild_server::build_router(fs.state.clone());
    let key = issue_user_key(&app, &fs.token).await;

    // x-api-key works (Anthropic SDK style)
    let (status, v) = post_messages(
        &app,
        &key,
        Some(key.clone()),
        json!({"model": "gpt-test", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["type"], "message");

    // missing key → Anthropic-shaped 401
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/anthropic/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"model": "gpt-test", "max_tokens": 16, "messages": []}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["error"]["type"], "authentication_error");

    // unknown model → 404 not_found_error (same route scoping as in-app)
    let (status, v) = post_messages(
        &app,
        &key,
        Some(key.clone()),
        json!({"model": "no-such-model", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(v["error"]["type"], "not_found_error");
}

#[tokio::test]
async fn openai_models_list_needs_key() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let key = issue_user_key(&app, &fs.token).await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/openai/v1/models")
                .header("authorization", format!("Bearer {key}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["object"], "list");
    let ids: Vec<&str> = v["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"gpt-test"));
}
