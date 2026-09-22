use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state, standalone_listener};
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

/// Scripted provider: first call → tool call (http_call); second → text.
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
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"h1\",\"function\":{\"name\":\"http_call\",\"arguments\":\"{\\\"url\\\":\\\"https://example.org/x\\\",\\\"method\\\":\\\"GET\\\"}\"}}]}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                        "data: [DONE]\n\n",
                    ))
            } else {
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"done with the run\"}}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n",
                        "data: [DONE]\n\n",
                    ))
            }
        })
        .mount(&server)
        .await;
    server
}

async fn create_routine(
    app: &axum::Router,
    token: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/routines")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "routine create");
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn routine_crud_hook_auth_and_internal_completion() {
    let fake = scripted_provider().await;
    let restate = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(wiremock::ResponseTemplate::new(202))
        .mount(&restate)
        .await;

    let fs = full_state().await;
    // point the org's openai key at the scripted provider
    let master = fs.state.config.master_key().unwrap();
    fs.store()
        .gateway()
        .upsert_provider_key(fs.org_id, "openai", &fake.uri(), "sk-test", &master)
        .await
        .unwrap();
    let mut cfg = (*fs.state.config).clone();
    cfg.restate_url = restate.uri();
    let state = guild_server::state::AppState::from_config(cfg);
    let app = guild_server::build_router(state.clone());

    let member = fs
        .store()
        .identity()
        .create_user(fs.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = fs
        .store()
        .identity()
        .create_session(member.id)
        .await
        .unwrap();

    // a member cannot create an enabled routine (default enabled): provider
    // spend is an admin-gated channel
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/routines")
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "slug": "nightly-digest",
                        "name": "Nightly digest",
                        "trigger_kind": "webhook",
                        "prompt": "Summarize the news.",
                        "model": "gpt-test",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // a member CAN create a disabled routine, but re-enabling it is admin-only
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/routines")
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "slug": "member-disabled",
                        "name": "Member disabled",
                        "trigger_kind": "webhook",
                        "prompt": "p",
                        "model": "gpt-test",
                        "enabled": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let routine = create_routine(
        &app,
        &fs.token, // enabled routines are admin-gated
        json!({
            "slug": "nightly-digest",
            "name": "Nightly digest",
            "trigger_kind": "webhook",
            "prompt": "Summarize the news.",
            "model": "gpt-test",
        }),
    )
    .await;
    let routine_id: Uuid = routine["id"].as_str().unwrap().parse().unwrap();
    let hook_token = routine["webhook_token"].as_str().unwrap().to_string();

    // interval routine with too-small interval → 400
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/routines")
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "slug": "fast",
                        "trigger_kind": "interval",
                        "trigger_config": {"interval_secs": 1},
                        "prompt": "p", "model": "gpt-test"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // member re-enable of a routine → 403 (same spend gate as creation)
    let member_routine_id: Uuid = {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/routines")
                    .header("authorization", format!("Bearer {member_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        v["routines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["slug"] == "member-disabled")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    };
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/routines/{member_routine_id}"))
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"enabled": true}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // hook with wrong token → 401
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/hooks/{}/nightly-digest", fs.org_id))
                .header("x-guild-hook-token", "wrong")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // hook with the right token → 202 and forwarded fire-and-forget
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/hooks/{}/nightly-digest", fs.org_id))
                .header("x-guild-hook-token", &hook_token)
                .header("content-type", "application/json")
                .body(Body::from("{\"text\":\"go\"}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::ACCEPTED);
    let seen = restate.received_requests().await.unwrap();
    // Stray container health/S3 probes can land on this mock via the
    // docker-proxy listener collision (see standalone_listener) — assert on
    // the forwarded webhook, not on the total.
    let webhook_hits = seen
        .iter()
        .filter(|r| {
            r.url
                .path()
                .contains(&format!("RoutineRunner/{routine_id}/handle_webhook/send"))
        })
        .count();
    assert_eq!(
        webhook_hits,
        1,
        "requests: {:?}",
        seen.iter()
            .map(|r| (r.method.as_str(), r.url.path()))
            .collect::<Vec<_>>()
    );

    // internal completion drives the scripted provider; usage recorded
    let internal_req = json!({
        "org_id": fs.org_id,
        "user_id": member.id,
        "model": "gpt-test",
        "system": "be brief",
        "messages": [{"role": "user", "content": "call the tool"}],
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/internal/completion")
                .header("authorization", "Bearer test-internal")
                .header("content-type", "application/json")
                .body(Body::from(internal_req.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("tool_call_done"), "{text}");
    assert!(text.contains("done"));

    let (count, _) = clickhouse_usage_rows(&state).await;
    assert!(count >= 1, "usage recorded for internal completion");

    // run record via internal API, visible through the user API
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/internal/runs")
                .header("authorization", "Bearer test-internal")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"routine_id": routine_id, "trigger": "webhook"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let run_id: Uuid = v["run_id"].as_str().unwrap().parse().unwrap();

    // bad internal token → 401
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/internal/runs")
                .header("authorization", "Bearer nope")
                .header("content-type", "application/json")
                .body(Body::from(json!({"routine_id": routine_id}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // storage write lands in minio
    let objects = state.objects().await.unwrap();
    objects
        .put("runs/probe", b"payload".to_vec())
        .await
        .unwrap();
    assert_eq!(objects.get("runs/probe").await.unwrap(), b"payload");

    // runs list via the user-facing API
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/routines/{routine_id}/runs"))
                .header("authorization", format!("Bearer {member_token}"))
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
    assert_eq!(v["runs"][0]["id"], run_id.to_string());
    assert_eq!(v["runs"][0]["status"], "running");

    // re-enable of an interval routine forwards a tick
    // interval routines default to enabled: admin-gated, like any creation
    let interval_routine = create_routine(
        &app,
        &fs.token,
        json!({
            "slug": "periodic",
            "trigger_kind": "interval",
            "trigger_config": {"interval_secs": 10},
            "prompt": "Check things.",
            "model": "gpt-test",
        }),
    )
    .await;
    let interval_id: Uuid = interval_routine["id"].as_str().unwrap().parse().unwrap();
    let res = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/routines/{interval_id}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"enabled": true}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let seen = restate.received_requests().await.unwrap();
    assert!(seen.iter().any(|r| r
        .url
        .path()
        .contains(&format!("RoutineRunner/{interval_id}/tick/send"))));
}
