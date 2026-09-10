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

    // history persisted: user + assistant messages
    let msgs = fs
        .store()
        .chats()
        .list_messages(fs.org_id, fs.chat_id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 2, "user message + assistant message");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[1].role, "assistant");
    assert_eq!(msgs[1].content, "hi there");
    assert!(msgs[1].cost_usd.unwrap() > 0.0);

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
