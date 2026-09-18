//! Stop / queue / steer (chat turn control): sending while a turn generates
//! queues by default and steers on request; the stop endpoint interrupts.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{full_state, generation_cancel, note_generation};
use protocol::api::ThreadEvent;
use serde_json::{json, Value};
use std::sync::atomic::Ordering::SeqCst;
use tower::ServiceExt;

fn req(method: &str, uri: String, token: &str, body: Option<Value>) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    match body {
        Some(v) => builder
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn body_json(res: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn user_events(fs: &guild_server::test_support::FullState) -> Vec<(String, String)> {
    fs.store()
        .thread()
        .list_events(fs.org_id, fs.chat_id)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|r| match r.event {
            ThreadEvent::UserMessage { content, .. } => {
                Some(("user".to_string(), content))
            }
            _ => None,
        })
        .collect()
}

/// A send while a turn generates queues by default: the user turn commits to
/// the thread log at once (the running turn flushes it at its exit) and no
/// ChatRunner invocation happens (with full_state's placeholder restate_url
/// an invocation would fail the request loudly).
#[tokio::test]
async fn send_while_generating_queues_by_default() {
    let fs = full_state().await;
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());

    let res = app
        .clone()
        .oneshot(req(
            "POST",
            "/api/v1/gateway/chat".into(),
            &fs.token,
            Some(json!({
                "chat_id": fs.chat_id,
                "model": fs.model,
                "messages": [{"role": "user", "content": "second thought"}]
            })),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["queued"], json!(true));

    let events = user_events(&fs).await;
    assert_eq!(events.len(), 1, "the queued turn commits immediately");
    assert_eq!(events[0].1, "second thought");
}

/// A steered send queues AND requests the running turn's interruption.
#[tokio::test]
async fn steered_send_sets_the_cancel_flag() {
    let fs = full_state().await;
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());

    assert!(!generation_cancel(&fs.state, fs.chat_id)
        .unwrap()
        .load(SeqCst));
    let res = app
        .clone()
        .oneshot(req(
            "POST",
            "/api/v1/gateway/chat".into(),
            &fs.token,
            Some(json!({
                "chat_id": fs.chat_id,
                "model": fs.model,
                "messages": [{"role": "user", "content": "do this instead"}],
                "send_mode": "steer"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["queued"], json!(true));
    assert!(
        generation_cancel(&fs.state, fs.chat_id).unwrap().load(SeqCst),
        "steer must request the running turn's interruption"
    );
    let events = user_events(&fs).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].1, "do this instead");
}

/// The stop endpoint sets the cancel flag on a running turn and conflicts
/// when the chat is idle.
#[tokio::test]
async fn stop_sets_the_flag_and_conflicts_when_idle() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let uri = format!("/api/v1/gateway/chat/{}/stop", fs.chat_id);

    // Idle: nothing to stop.
    let res = app.clone().oneshot(req("POST", uri.clone(), &fs.token, None)).await.unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // Generating: the flag flips and the endpoint confirms.
    note_generation(&fs.state, fs.chat_id);
    let res = app
        .clone()
        .oneshot(req("POST", uri.clone(), &fs.token, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["stopped"], json!(true));
    assert!(generation_cancel(&fs.state, fs.chat_id).unwrap().load(SeqCst));

    fs.state.generations.remove(fs.chat_id);
    let res = app.oneshot(req("POST", uri, &fs.token, None)).await.unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
}
