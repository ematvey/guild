use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state};
use serde_json::json;
use tower::ServiceExt;

// Ignored: gateway chat routes through the Restate ChatRunner and tests have
// no Restate runtime (placeholder restate_url). Un-ignore once tests embed Restate.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test]
async fn chat_roundtrip_streams_persists_and_records_usage() {
    let fs = full_state().await;
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
                        "messages": [{"role": "user", "content": "greet"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    eprintln!(
        "DEBUG status={status} body={}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(status, StatusCode::OK, "gateway chat should stream");
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("delta"), "should have delta events: {text}");
    assert!(
        text.contains("hi there"),
        "should carry model output: {text}"
    );
    assert!(text.contains("done"), "should terminate with done: {text}");

    // turn persisted as thread events: system + user + assistant
    let events = fs
        .store()
        .thread()
        .list_events(fs.org_id, fs.chat_id)
        .await
        .unwrap();
    let types: Vec<String> = events
        .iter()
        .map(|e| match &e.event {
            protocol::api::ThreadEvent::UserMessage { .. } => "user".to_string(),
            protocol::api::ThreadEvent::SystemMessage { .. } => "system".to_string(),
            protocol::api::ThreadEvent::AssistantMessage { blocks, .. } => blocks
                .iter()
                .filter_map(|b| match b {
                    protocol::api::Block::Text { text } => Some(format!("assistant:{text}")),
                    _ => None,
                })
                .collect(),
            _ => "other".to_string(),
        })
        .collect();
    assert_eq!(types, vec!["system", "user", "assistant:hi there"]);
    let usage = match &events[2].event {
        protocol::api::ThreadEvent::AssistantMessage { usage, .. } => usage.clone(),
        other => panic!("expected assistant event, got {other:?}"),
    };
    assert!(usage.cost_usd.unwrap() > 0.0);

    // usage recorded in clickhouse: exactly one event, positive cost
    let (count, cost) = clickhouse_usage_rows(&fs.state).await;
    assert_eq!(count, 1, "one usage event per model request");
    assert!(cost > 0.0);
}

// Ignored for the same missing-Restate reason as chat_roundtrip: the restate
// send happens before route validation errors can surface.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test]
async fn unknown_model_is_not_found() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "chat_id": fs.chat_id,
                        "model": "no-such-model",
                        "messages": [{"role": "user", "content": "greet"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn member_cannot_manage_keys() {
    let fs = full_state().await;
    let store = fs.store();
    let member = store
        .identity()
        .create_user(fs.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = store.identity().create_session(member.id).await.unwrap();

    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/gateway/keys")
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"provider": "openai", "base_url": "http://x", "key": "k"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn encrypted_key_roundtrips_through_resolve() {
    let fs = full_state().await;
    let store = fs.store();
    let master = fs.state.config.master_key().unwrap();
    let route = store
        .gateway()
        .resolve_route(fs.org_id, &fs.model, &master)
        .await
        .unwrap();
    assert_eq!(route.api_key, "sk-test", "decrypted key matches");
    assert_eq!(route.provider, "openai");
}

/// Context-window (migration 0024) roundtrip: stored on upsert, resolved on
/// the route, returned by the readout lookup; NULL (unset) and missing model
/// resolve to None (the thread readout then applies its 128000 fallback).
#[tokio::test]
async fn route_context_window_roundtrip() {
    let fs = full_state().await;
    let store = fs.store();
    let master = fs.state.config.master_key().unwrap();

    store
        .gateway()
        .upsert_route(
            fs.org_id, "ctx-model", "openai", true, 1.0, 2.0, None, false, Some(64000),
        )
        .await
        .unwrap();
    let route = store
        .gateway()
        .resolve_route(fs.org_id, "ctx-model", &master)
        .await
        .unwrap();
    assert_eq!(route.context_window, Some(64000));
    assert_eq!(
        store
            .gateway()
            .context_window(fs.org_id, "ctx-model")
            .await
            .unwrap(),
        Some(64000)
    );

    // unset column → None (seeded route has no context window)
    let seeded = store
        .gateway()
        .resolve_route(fs.org_id, &fs.model, &master)
        .await
        .unwrap();
    assert_eq!(seeded.context_window, None);
    assert_eq!(
        store
            .gateway()
            .context_window(fs.org_id, &fs.model)
            .await
            .unwrap(),
        None
    );

    // no route at all → None
    assert_eq!(
        store
            .gateway()
            .context_window(fs.org_id, "no-such-model")
            .await
            .unwrap(),
        None
    );

    // admin endpoint accepts an optional context_window
    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("PUT")
                .uri("/api/v1/admin/gateway/routes")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "model": "ctx-model",
                        "provider": "openai",
                        "price_in": 1.0,
                        "price_out": 2.0,
                        "context_window": 96000
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        store
            .gateway()
            .context_window(fs.org_id, "ctx-model")
            .await
            .unwrap(),
        Some(96000)
    );
}
