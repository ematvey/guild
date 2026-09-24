use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state, standalone_listener};
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
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                        "data: [DONE]\n\n",
                    ))
            }
        })
        .mount(&server)
        .await;
    server
}

async fn issue_key(app: &axum::Router, token: &str) -> String {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/api-keys")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "public"}).to_string()))
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

#[tokio::test]
async fn openai_non_stream_with_tool_round_trip() {
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
    let key = issue_key(&app, &fs.token).await;

    // turn 1: non-stream, model requests a tool call
    let req_body = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "weather in oslo?"}],
        "tools": [{"type":"function", "function":{"name":"get_weather", "parameters":{"type":"object"}}}],
        "max_completion_tokens": 123,
        "max_tokens": 19,
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(req_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let requests = provider.received_requests().await.unwrap();
    let upstream: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(upstream["tools"][0]["function"]["name"], "get_weather");
    assert_eq!(upstream["max_tokens"], 123);

    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["object"], "chat.completion");
    let choice = &v["choices"][0];
    assert_eq!(choice["finish_reason"], "tool_calls");
    let tc = &choice["message"]["tool_calls"][0];
    assert_eq!(tc["id"], "call_x");
    assert_eq!(tc["function"]["name"], "get_weather");
    assert_eq!(tc["function"]["arguments"], "{\"city\":\"oslo\"}");
    assert_eq!(v["usage"]["total_tokens"], 0); // provider sent no usage on the tool-call turn

    // turn 2: with tool result content-array + system message
    let req_body = json!({
        "model": "gpt-test",
        "max_tokens": 77,
        "messages": [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "weather?"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_x", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"oslo\"}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_x", "content": [{"type": "text", "text": "snow"}]}
        ]
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(req_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let requests = provider.received_requests().await.unwrap();
    let upstream: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(upstream["max_tokens"], 77);

    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["choices"][0]["message"]["content"], "sunny, 12C");
    assert_eq!(v["choices"][0]["finish_reason"], "stop");
    assert_eq!(v["usage"]["prompt_tokens"], 5);
    assert_eq!(v["usage"]["completion_tokens"], 2);

    // usage recorded for both calls
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert!(count >= 2, "usage per request");
}

#[tokio::test]
async fn openai_stream_and_auth_failures() {
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
    let key = issue_key(&app, &fs.token).await;

    let req_body = json!({
        "model": "gpt-test",
        "stream": true,
        "messages": [{"role": "user", "content": "weather?"}],
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(req_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("chat.completion.chunk"));
    assert!(text.contains("call_x"));
    assert!(text.contains("tool_calls"));
    assert!(text.trim_end().ends_with("data: [DONE]"));

    // bad key → 401 in OpenAI error shape
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", "Bearer gk_nope")
                .header("content-type", "application/json")
                .body(Body::from(req_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert!(v["error"]["type"].is_string());

    // unknown model → 404
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"model": "nope", "messages": []}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

/// A client's tool-call `arguments` arrive as a JSON-encoded string; the
/// internal Message must carry them parsed, so an Anthropic-shaped upstream
/// receives a `tool_use.input` object (a string input is a 400) instead of
/// a double-encoded one.
#[tokio::test]
async fn ingress_tool_call_arguments_are_unpacked_to_objects() {
    let anthropic = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"sunny\"}}\n\n",
                    "data: {\"type\":\"message_stop\"}\n\n",
                )),
        )
        .mount(&anthropic)
        .await;
    let fs = full_state().await;
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(
            fs.org_id,
            "anthropic",
            anthropic.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();
    fs.store()
        .gateway()
        .upsert_route(
            fs.org_id,
            "claude-test",
            "anthropic",
            true,
            2.0,
            4.0,
            None,
            false,
            None,
            None,
            &[],
        )
        .await
        .unwrap();
    let app = guild_server::build_router(fs.state.clone());
    let key = issue_key(&app, &fs.token).await;

    let req_body = json!({
        "model": "claude-test",
        "messages": [
            {"role": "user", "content": "weather?"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_x", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"oslo\"}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_x", "content": "snow"}
        ]
    });
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(req_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let upstream = anthropic.received_requests().await.unwrap();
    let body: Value = serde_json::from_slice(&upstream[0].body).unwrap();
    let blocks = body["messages"].as_array().unwrap();
    let tool_use = blocks
        .iter()
        .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
        .find(|b| b["type"] == "tool_use")
        .expect("tool_use block in upstream");
    assert!(
        tool_use["input"].is_object(),
        "input must be an object, got {tool_use}"
    );
    assert_eq!(tool_use["input"]["city"], "oslo");
}

/// A client that disconnects mid-stream still gets billed: the usage guard
/// records at the stream's drop instead of only after the final frame.
#[tokio::test]
async fn aborted_stream_still_records_usage() {
    let provider = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                    "data: [DONE]\n\n",
                )),
        )
        .mount(&provider)
        .await;
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
    let key = issue_key(&app, &fs.token).await;

    // Connects the usage sink (creates the ClickHouse table).
    fs.state.usage().await.unwrap();
    let (before, _) = clickhouse_usage_rows(&fs.state).await;
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"model":"gpt-test","stream":true,
                           "messages":[{"role":"user","content":"hi"}]})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    // Read frames until real content arrives (so the gateway has pulled a
    // provider chunk — a request was served), then disconnect (drop the
    // body). An abort before any provider frame is the
    // provider_error_before_any_usage_frame_records_nothing case.
    let mut stream = res.into_body().into_data_stream();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let frame = futures::StreamExt::next(&mut stream)
            .await
            .expect("stream frames")
            .expect("frame ok");
        let text = frame;
        if String::from_utf8_lossy(&text).contains("content") {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "no content frame");
    }
    drop(stream);

    // The guard's drop spawns the record; poll until it lands.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (count, _) = clickhouse_usage_rows(&fs.state).await;
        if count > before {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "aborted stream never recorded usage"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// A provider error before any real chunk bills nothing: the guard's
/// drop path skips the row when no Ok provider frame was observed (a
/// 0-token row would inflate per-request counts). The provider here
/// accepts the stream (200) and then errors as its first SSE event — an
/// HTTP-level failure never reaches the guard, so it proves nothing.
#[tokio::test]
async fn provider_error_before_any_usage_frame_records_nothing() {
    let provider = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"error\": {\"message\": \"mid-stream boom\"}}\n\n",
                    "data: [DONE]\n\n",
                )),
        )
        .mount(&provider)
        .await;
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
    let key = issue_key(&app, &fs.token).await;
    fs.state.usage().await.unwrap();
    let (before, _) = clickhouse_usage_rows(&fs.state).await;
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"model":"gpt-test","stream":true,
                           "messages":[{"role":"user","content":"hi"}]})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "the stream itself is accepted"
    );
    let body_text = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_text = String::from_utf8_lossy(&body_text);
    assert!(
        body_text.contains("mid-stream boom"),
        "the provider error must surface on the stream: {body_text}"
    );
    // Give any (wrongly) spawned record time to land, then assert absence.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert_eq!(count, before, "0-token error rows must not be written");
}

#[tokio::test]
async fn non_stream_provider_error_records_observed_usage() {
    let provider = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                    "data: {\"error\": {\"message\": \"mid-stream boom\"}}\n\n",
                    "data: [DONE]\n\n",
                )),
        )
        .mount(&provider)
        .await;
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
    let key = issue_key(&app, &fs.token).await;
    fs.state.usage().await.unwrap();
    let (before, _) = clickhouse_usage_rows(&fs.state).await;
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/openai/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"model":"gpt-test","stream":false,
                           "messages":[{"role":"user","content":"hi"}]})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_GATEWAY,
        "provider failure surfaces in non-streaming mode"
    );
    let body_text = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_text = String::from_utf8_lossy(&body_text);
    assert!(
        body_text.contains("mid-stream boom"),
        "the provider error must surface on the stream: {body_text}"
    );
    // Allow the detached error-path insert to finish.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert_eq!(count, before + 1, "observed usage must be written on error");
}
