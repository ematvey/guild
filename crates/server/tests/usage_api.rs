use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{clickhouse_usage_rows, full_state};
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

async fn chat_once(app: &axum::Router, token: &str, chat_id: Uuid, prompt: &str) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "chat_id": chat_id,
                        "model": "gpt-test",
                        "messages": [{"role": "user", "content": prompt}],
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    // consume the stream: usage + persistence happen as it drains
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("done"));
}

// Ignored: usage accrues inside the Restate ChatRunner turn; tests have no
// Restate runtime. Un-ignore once tests embed Restate.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test]
async fn summary_and_grouped_usage_reflect_gateway_calls() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());

    // two calls by the admin user
    chat_once(&app, &fs.token, fs.chat_id, "one").await;
    chat_once(&app, &fs.token, fs.chat_id, "two").await;
    let (count, _) = clickhouse_usage_rows(&fs.state).await;
    assert_eq!(count, 2);

    // summary (admin sees org scope)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/usage/summary")
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
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["today_cost_usd"].as_f64().unwrap() > 0.0);
    assert!(v["month_cost_usd"].as_f64().unwrap() >= v["today_cost_usd"].as_f64().unwrap());

    // group by model
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/usage?group_by=model")
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
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["rows"][0]["group"], "gpt-test");
    assert_eq!(v["rows"][0]["requests"], 2);

    // member sees nothing (made no calls) — not the org's rows
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
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/usage?group_by=user")
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
    assert_eq!(v["rows"].as_array().unwrap().len(), 0, "member isolation");

    // date filtering works
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/usage?group_by=model&from=1970-01-01&to=1970-01-02")
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
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["rows"].as_array().unwrap().len(), 0, "outside the window");
}

#[tokio::test]
async fn bad_group_by_is_rejected() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/usage?group_by=color")
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}
