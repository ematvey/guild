use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::json;
use tower::ServiceExt;

/// Sets the org route with a quota, seeds usage above/below it, and checks
/// the gateway rejects when the cap is reached.
#[tokio::test]
async fn route_quota_blocks_when_month_spend_reached() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());

    // route with a 0.000001 USD monthly quota (already-seeded usage events in
    // other tests don't share this org's clickhouse, so spend starts at 0 —
    // record one usage event first to exceed the cap)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/admin/gateway/routes")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "model": "gpt-test",
                        "provider": "openai",
                        "price_in": 2.0,
                        "price_out": 4.0,
                        "quota_monthly_usd": 0.000001
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // seed one usage event well above the quota
    let sink = fs.state.usage().await.unwrap();
    sink.record(guild_core::usage::UsageEvent {
        ts: chrono::Utc::now(),
        org_id: fs.org_id,
        user_id: fs.user_id,
        team_id: None,
        session_id: fs.chat_id,
        model: "gpt-test".into(),
        provider: "openai".into(),
        tokens_in: 1000,
        tokens_out: 1000,
        cost_usd: 0.01,
        request_id: uuid::Uuid::now_v7(),
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await; // clickhouse write visibility

    // internal gateway chat → 429 quota_exceeded
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
                        "model": "gpt-test",
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"]["code"], "quota_exceeded");

    // raise the quota above the spend → chat works again (provider is the
    // seeded fake; consume the SSE body so the stream runs)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/admin/gateway/routes")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "model": "gpt-test",
                        "provider": "openai",
                        "price_in": 2.0,
                        "price_out": 4.0,
                        "quota_monthly_usd": 1000.0
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
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
                        "model": "gpt-test",
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
}
