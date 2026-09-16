use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn events_list_shows_emitted_org_events() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let row = fs
        .store()
        .events()
        .emit(fs.org_id, "test.hello", json!({"message": "hello events"}))
        .await
        .unwrap();

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
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let events = v["events"].as_array().unwrap();
    assert!(events
        .iter()
        .any(|event| { event["kind"] == "test.hello" && event["id"] == row.id.to_string() }));
    for event in events {
        assert_eq!(event["org_id"], fs.org_id.to_string());
    }
}
