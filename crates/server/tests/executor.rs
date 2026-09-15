use guild_server::test_support::{clickhouse_usage_rows, serve_full, standalone_listener};
use guild_server::worker::executor::RoutineExecutor;
use guild_server::worker::run::run_routine;
use serde_json::json;

/// Scripted provider: turn 1 → http_call tool; turn 2 → final text.
async fn scripted_provider(external_url: String) -> wiremock::MockServer {
    let server = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = calls.clone();
    let tool_args = json!({"url": external_url, "method": "GET"}).to_string();
    let first_body = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"h1","function":{"name":"http_call","arguments":tool_args}}]}}]})
    );
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_req: &wiremock::Request| {
            let n = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(first_body.clone())
            } else {
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"routine finished\"}}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n",
                        "data: [DONE]\n\n",
                    ))
            }
        })
        .mount(&server)
        .await;
    server
}

async fn setup() -> (guild_server::test_support::ServedFull, wiremock::MockServer) {
    let external = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string("hello from the web"))
        .mount(&external)
        .await;

    let served = serve_full().await;
    let master = served.full.state.config.master_key().unwrap();
    served
        .full
        .store()
        .gateway()
        .upsert_provider_key(
            served.full.org_id,
            "openai",
            external.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();
    (served, external)
}

#[tokio::test]
async fn routine_run_completes_with_tool_use_and_records_run() {
    let (served, external) = setup().await;
    let external_url = format!("{}/data", external.uri());
    let provider = scripted_provider(external_url).await;
    let master = served.full.state.config.master_key().unwrap();
    served
        .full
        .store()
        .gateway()
        .upsert_provider_key(
            served.full.org_id,
            "openai",
            provider.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();

    let store = served.full.store();
    let creator = store
        .identity()
        .create_user(served.full.org_id, "r@b.c", "hunter226", "member")
        .await
        .unwrap();
    let routine = store
        .routines()
        .create(
            served.full.org_id,
            creator.id,
            "digest",
            "Digest",
            "webhook",
            json!({}),
            "You are a digest agent.",
            "gpt-test",
            json!(["http_call"]),
            "hook_x",
            true,
        )
        .await
        .unwrap();

    let exec = RoutineExecutor {
        api_base: served.base_url.clone(),
        internal_token: "test-internal".into(),
        allow_http_tool: true, // the external mock is http://
    };
    let summary = run_routine(&exec, routine.id, "webhook", json!({}))
        .await
        .unwrap();
    assert_eq!(summary, "routine finished");

    // the external site was actually fetched by the tool. Other GETs can
    // leak in: container health/S3 probes occasionally land on the mock via
    // the docker-proxy listener collision (see standalone_listener) — assert
    // on the tool's request, not on the total.
    let seen = external.received_requests().await.unwrap();
    let data_hits = seen
        .iter()
        .filter(|r| r.method == "GET" && r.url.path() == "/data")
        .count();
    assert_eq!(
        data_hits,
        1,
        "external requests: {:?}",
        seen.iter()
            .map(|r| (r.method.as_str(), r.url.path()))
            .collect::<Vec<_>>()
    );

    // run recorded as succeeded with the summary
    let runs = store
        .routines()
        .list_runs(served.full.org_id, routine.id)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "succeeded");
    assert_eq!(runs[0].summary.as_deref(), Some("routine finished"));

    // usage recorded (two model turns)
    let (count, _) = clickhouse_usage_rows(&served.full.state).await;
    assert!(count >= 2, "usage recorded per model call");
}

#[tokio::test]
async fn routine_run_records_failure_when_tool_fails_repeatedly() {
    let (served, _external) = setup().await;
    // provider that always requests the same tool call (http scheme → refused
    // by default), until the step limit
    let provider = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    let tool_args = json!({"url": "http://insecure.example/x", "method": "GET"}).to_string();
    let body = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"h1","function":{"name":"http_call","arguments":tool_args}}]}}]})
    );
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(body),
        )
        .mount(&provider)
        .await;
    let master = served.full.state.config.master_key().unwrap();
    served
        .full
        .store()
        .gateway()
        .upsert_provider_key(
            served.full.org_id,
            "openai",
            provider.uri().as_str(),
            "sk-test",
            &master,
        )
        .await
        .unwrap();

    let store = served.full.store();
    let creator = store
        .identity()
        .create_user(served.full.org_id, "r2@b.c", "hunter226", "member")
        .await
        .unwrap();
    let routine = store
        .routines()
        .create(
            served.full.org_id,
            creator.id,
            "loopy",
            "Loopy",
            "interval",
            json!({"interval_secs": 10}),
            "Loop.",
            "gpt-test",
            json!(["http_call"]), // no allow_http → https only
            "hook_y",
            true,
        )
        .await
        .unwrap();

    let exec = RoutineExecutor {
        api_base: served.base_url.clone(),
        internal_token: "test-internal".into(),
        allow_http_tool: false,
    };
    let err = run_routine(&exec, routine.id, "manual", json!({}))
        .await
        .expect_err("step limit hit");
    assert!(err.to_string().contains("step limit"), "{err}");

    let runs = store
        .routines()
        .list_runs(served.full.org_id, routine.id)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    let error = runs[0].error.clone().unwrap();
    assert!(error.contains("step limit"), "{error}");
}

#[test]
fn parses_done_frame_directly() {
    use protocol::api::StreamEvent;
    let frame = r#"{"type":"done","message_id":"01a0a595-0c9b-7be2-8ed4-81f50bdc9907","cost_usd":0.0,"tokens_in":0,"tokens_out":0}"#;
    let val: serde_json::Value = serde_json::from_str(frame).unwrap();
    let v2 = serde_json::from_value::<StreamEvent>(val.clone());
    #[derive(serde::Deserialize, Debug)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum Probe {
        Done { cost_usd: f64 },
        Idle,
    }
    let probe: Result<Probe, _> = serde_json::from_str(r#"{"type":"done","cost_usd":1.5}"#);
    assert!(probe.is_ok(), "probe: {probe:?}");
    let idle: Result<StreamEvent, _> = serde_json::from_str(r#"{"type":"idle"}"#);
    assert!(idle.is_ok(), "idle: {idle:?}");
    let with_cost: Result<StreamEvent, _> = serde_json::from_str(
        r#"{"type":"done","message_id":"01a0a595-0c9b-7be2-8ed4-81f50bdc9907","cost_usd":1.5,"tokens_in":2,"tokens_out":3}"#,
    );
    assert!(with_cost.is_ok(), "cost 1.5: {with_cost:?}");
    let v: Result<StreamEvent, _> = serde_json::from_str(frame);
    assert!(v.is_ok(), "from_str: {v:?}");
    assert!(v2.is_ok(), "from_value: {v2:?}");
    let s: String = serde_json::to_string(&val).unwrap();
    let v3: Result<StreamEvent, _> = serde_json::from_str(&s);
    assert!(v3.is_ok(), "roundtrip from_str on {s}: {v3:?}");
}
