use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state, standalone_listener};
use serde_json::{json, Value};
use tower::ServiceExt;

/// Provider script: model call 1 → write_file; call 2 → run_command (must be
/// refused); call 3 → final text.
async fn scripted_provider() -> wiremock::MockServer {
    let server = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = calls.clone();
    let sse = |body: String| {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body)
    };
    let call_frame = |id: &str, name: &str, args: &str| {
        format!(
            "data: {}\n\ndata: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":id,"function":{"name":name,"arguments":args}}]}}]})
        )
    };
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_req: &wiremock::Request| {
            let n = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match n {
                0 => sse(call_frame(
                    "w1",
                    "write_file",
                    "{\"path\":\"hello.txt\",\"content\":\"hi from workspace\"}",
                )),
                1 => sse(call_frame("r1", "run_command", "{\"command\":\"ls\"}")),
                _ => sse(String::from(concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"workspace updated\"}}]}\n\n",
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4}}\n\n",
                    "data: [DONE]\n\n",
                ))),
            }
        })
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn workspace_session_turn_executes_tools_and_persists() {
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

    // create a session
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": "repo-a"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let session_id = v["id"].as_str().unwrap().to_string();

    // duplicate name → 409
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": "repo-a"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // invalid name → 400
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"workspace_name": "../escape"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // run a turn: the scripted provider writes a file, tries run_command, finishes
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/agents/sessions/{session_id}/turns"))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"message": "set up the repo", "model": "gpt-test"}).to_string(),
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
    assert!(text.contains("event: tool_call"), "{text}");
    assert!(text.contains("write_file"));
    assert!(text.contains("event: tool_result"));
    // run_command is refused by default
    assert!(text.contains("\"ok\":false"), "{text}");
    assert!(text.contains("event: done"), "{text}");

    // the file was written into the workspace dir
    let dir = guild_server::http::agents::workspace_dir(&fs.state, fs.org_id, "repo-a");
    let written = tokio::fs::read_to_string(dir.join("hello.txt"))
        .await
        .unwrap();
    assert_eq!(written, "hi from workspace");

    // history persisted as thread events: user + assistant(tool_calls) + tool + assistant final
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/agents/sessions/{session_id}"))
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
    let v: Value = serde_json::from_slice(&body).unwrap();
    let types: Vec<String> = v["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"]["type"].as_str().unwrap().to_string())
        .collect();
    // user turn + two assistant turns with tool calls, two tool results, final text
    assert_eq!(
        types,
        vec![
            "user_message",
            "assistant_message",
            "tool_result",
            "assistant_message",
            "tool_result",
            "assistant_message"
        ]
    );
    let events = v["events"].as_array().unwrap();
    assert_eq!(
        events[4]["event"]["content"],
        "tool failed: execution failed: denied by user: disabled by policy"
    );
    assert_eq!(events[4]["event"]["name"], "run_command");
    assert_eq!(events[5]["event"]["blocks"][0]["text"], "workspace updated");
    // step numbering: 0-based model call index within the turn
    assert_eq!(events[1]["event"]["step"], 0);
    assert_eq!(events[3]["event"]["step"], 1);
    assert_eq!(events[5]["event"]["step"], 2);

    // usage recorded for the run
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert!(count >= 1, "usage recorded");

    // session appears in the list
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("repo-a"));
}
