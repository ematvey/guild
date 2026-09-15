use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures::StreamExt;
use guild_server::test_support::full_state;
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn events_stream_fans_out_and_list_shows_emitted() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());

    // subscribe to the SSE stream in the background
    let sub_app = app.clone();
    let token = fs.token.clone();
    let sse = tokio::spawn(async move {
        let res = sub_app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/events/stream")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        // read the first real frame; the stream is infinite and may emit
        // keepalive comment chunks (":" …) first when delivery is delayed
        // under full-suite load
        let mut stream = res.into_body().into_data_stream();
        let text = loop {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next())
                .await
                .expect("first sse frame in 30s")
                .expect("stream alive")
                .unwrap();
            let text = String::from_utf8(chunk.to_vec()).unwrap();
            if text.starts_with(":") {
                continue; // keepalive comment
            }
            break text;
        };
        text
    });

    // give the subscription a moment to attach its LISTEN
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // emit an org event
    let row = fs
        .store()
        .events()
        .emit(fs.org_id, "test.hello", json!({"message": "hello events"}))
        .await
        .unwrap();

    // read the first SSE frame (30s: the full suite loads the shared
    // postgres hard enough to push LISTEN delivery past 10s occasionally)
    let text = tokio::time::timeout(std::time::Duration::from_secs(30), sse)
        .await
        .expect("stream should produce a frame")
        .unwrap();
    assert!(text.contains("event: org_event"), "{text}");
    assert!(text.contains("test.hello"), "{text}");
    assert!(text.contains(&row.id.to_string()), "{text}");

    // the list endpoint shows it too
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/events")
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
    let kinds: Vec<&str> = v["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"test.hello"));

    // org-scoping is enforced in SQL (list) and in the stream filter; the
    // list must not contain anything outside this org
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/events")
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    for e in v["events"].as_array().unwrap() {
        assert_eq!(e["org_id"], fs.org_id.to_string());
    }
}
