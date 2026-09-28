//! /faro/collect proxy: forwards to the configured receiver, swallows
//! upstream failures as 202, and honours GUILD_FARO_URL="" as disabled.

#![cfg(feature = "test-support")]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use guild_server::build_router;
use guild_server::config::Config;
use guild_server::state::AppState;
use std::sync::atomic::{AtomicUsize, Ordering};
use tower::ServiceExt;

fn state_with_faro_url(url: String) -> AppState {
    let mut cfg = Config::test_config();
    cfg.faro_url = url;
    AppState::from_config(cfg)
}

/// Mini upstream receiver; records hits and answers 200.
async fn spawn_upstream(hits: &'static AtomicUsize) -> String {
    let app = axum::Router::new().route(
        "/collect",
        post(move |body: axum::body::Bytes| async move {
            hits.fetch_add(1, Ordering::SeqCst);
            assert!(!body.is_empty());
            "ok"
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}/collect")
}

async fn post_collect(app: axum::Router, payload: &str) -> StatusCode {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/faro/collect")
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
    .status()
}

#[tokio::test]
async fn forwards_to_upstream() {
    static HITS: AtomicUsize = AtomicUsize::new(0);
    let url = spawn_upstream(&HITS).await;
    let app = build_router(state_with_faro_url(url));
    let status = post_collect(app, r#"{"logs":[{"level":"error","message":"t"}]}"#).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(HITS.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dead_upstream_answers_accepted() {
    // Nothing listens here.
    let app = build_router(state_with_faro_url("http://127.0.0.1:1/collect".into()));
    let status = post_collect(app, r#"{"logs":[]}"#).await;
    assert_eq!(status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn disabled_url_accepts_and_drops() {
    let app = build_router(state_with_faro_url(String::new()));
    let status = post_collect(app, r#"{"logs":[]}"#).await;
    assert_eq!(status, StatusCode::ACCEPTED);
}
