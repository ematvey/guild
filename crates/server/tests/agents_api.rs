use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state, standalone_listener};
use serde_json::{json, Value};
use tower::ServiceExt;

/// A turn submits the durable ChatRunner workflow (spec 2026-09-18
/// unification §4 phase 4): the endpoint acknowledges the invocation; the
/// server itself executes the turn's tools in the org workspace. The deep
/// execution behavior (tools run journaled, exec-policy-gated, history in
/// the thread journal) is verified by the live E2E — like every gateway
/// workflow path, in-repo tests would need an embedded Restate runtime
/// (see the gateway test notes).
#[tokio::test]
async fn workspace_turn_submits_the_durable_workflow() {
    // Accept every ingress POST (the workflow runs detached — the test only
    // asserts the submission contract).
    let restate = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(202)
                .set_body_json(json!({"invocationId":"inv-fixture"})),
        )
        .mount(&restate)
        .await;

    let fs = full_state().await;
    let mut cfg = (*fs.state.config).clone();
    cfg.restate_url = restate.uri();
    let state = guild_server::state::AppState::from_config(cfg);
    let app = guild_server::build_router(state);

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

    // submit a turn: the durable workflow is invoked, the ack carries the
    // invocation identity (submit + poll — history is the thread journal)
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
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["accepted"], true, "{v}");
    assert!(v["invocation_id"].as_str().is_some(), "{v}");

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

#[tokio::test]
async fn agent_turn_enforces_route_quota() {
    let fs = full_state().await;
    fs.store()
        .gateway()
        .upsert_route(
            fs.org_id,
            "gpt-test",
            "openai",
            true,
            1.0,
            2.0,
            Some(0.0),
            false,
            None,
            None,
            &[],
        )
        .await
        .unwrap();
    let app = guild_server::build_router(fs.state.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"workspace_name": "quota-ws"}).to_string(),
                ))
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

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/agents/sessions/{session_id}/turns"))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"message": "spend money", "model": "gpt-test"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);

    // The rejected turn persisted nothing.
    let res = app
        .oneshot(
            Request::builder()
                .method("GET")
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
    assert_eq!(v["events"].as_array().unwrap().len(), 0);
}
