//! The user fan-out bus (events/stream with machine params): a device's
//! standing connection receives every generation frame of the user's chats
//! (active or tray-inactive device), with the chat's bound machine marked on
//! tool frames — the matching device executes, the rest render. Web clients
//! (no machine params) see none of it.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures::StreamExt;
use guild_server::test_support::{emit_live_delta, full_state, note_client_tool, note_generation};
use tower::ServiceExt;

/// Drains SSE frames from the stream until a frame's data matches `pred`,
/// or the deadline passes (returns None).
async fn first_app_frame(
    app: axum::Router,
    token: &str,
    machine: &str,
    pred: impl Fn(&str) -> bool + Send + 'static,
) -> Option<String> {
    let res = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/events/stream?machine_id={machine}&machine_name={machine}"
                ))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut stream = res.into_body().into_data_stream();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut pending_app = false;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        match tokio::time::timeout(left, stream.next()).await {
            Ok(Some(Ok(frame))) => {
                let text = String::from_utf8(frame.to_vec()).unwrap();
                // An SSE event may arrive as one chunk ("event: app\ndata: …")
                // or as separate field lines.
                if text.starts_with("event: app") {
                    if let Some(data) = text.split("\ndata: ").nth(1) {
                        if pred(data.trim_end()) {
                            return Some(data.trim_end().to_string());
                        }
                        continue;
                    }
                    pending_app = true;
                    continue;
                }
                if pending_app {
                    if let Some(data) = text.strip_prefix("data: ") {
                        pending_app = false;
                        if pred(data.trim_end()) {
                            return Some(data.trim_end().to_string());
                        }
                    }
                }
            }
            Ok(Some(Err(_))) | Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

#[tokio::test]
async fn all_frames_fan_out_to_every_device_with_target_marked() {
    let fs = full_state().await;
    fs.store()
        .chats()
        .set_machine(fs.org_id, fs.chat_id, Some("M-A"), Some("ALPHA"))
        .await
        .unwrap();
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());

    let want_chat = fs.chat_id.to_string();
    let app_a = app.clone();
    let token = fs.token.clone();
    let want = want_chat.clone();
    let got_a = tokio::spawn(async move {
        first_app_frame(app_a, &token, "M-A", move |d: &str| d.contains(&want)).await
    });
    let app_b = app.clone();
    let token_b = fs.token.clone();
    let want_b = want_chat.clone();
    let got_b = tokio::spawn(async move {
        first_app_frame(app_b, &token_b, "M-B", move |d: &str| d.contains(&want_b)).await
    });

    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    note_client_tool(
        &fs.state,
        fs.chat_id,
        "call-1",
        "bash",
        r#"{"command":"ls"}"#,
        "M-A",
    );

    let frame_a = tokio::time::timeout(std::time::Duration::from_secs(10), got_a)
        .await
        .expect("dispatch within deadline")
        .expect("reader task joined")
        .expect("bound machine got the frame");
    assert!(frame_a.contains("call-1"), "{frame_a}");
    assert!(frame_a.contains("M-A"), "{frame_a}");

    // Device B is in sync too (multiplexed), with the target machine marked:
    // it renders the call but must not execute it.
    let frame_b = tokio::time::timeout(std::time::Duration::from_secs(10), got_b)
        .await
        .expect("sync within deadline")
        .expect("reader task joined")
        .expect("second device got the frame");
    assert!(frame_b.contains("call-1"), "{frame_b}");
    assert!(frame_b.contains("M-A"), "{frame_b}");
}

#[tokio::test]
async fn pending_tool_replays_to_connecting_device() {
    let fs = full_state().await;
    fs.store()
        .chats()
        .set_machine(fs.org_id, fs.chat_id, Some("M-A"), Some("ALPHA"))
        .await
        .unwrap();
    note_generation(&fs.state, fs.chat_id);
    // the tool is registered while NO device is connected
    note_client_tool(&fs.state, fs.chat_id, "call-late", "edit", "{}", "M-A");
    let app = guild_server::build_router(fs.state.clone());

    let frame = first_app_frame(app, &fs.token, "M-A", |d: &str| d.contains("call-late")).await;
    let frame = frame.expect("connecting device gets the suspended tool");
    assert!(frame.contains("M-A"), "{frame}");
}

#[tokio::test]
async fn deltas_fan_out_with_snap_replay_for_late_device() {
    let fs = full_state().await;
    note_generation(&fs.state, fs.chat_id);
    // a live delta emitted while no device is connected
    emit_live_delta(&fs.state, fs.chat_id, "hello fan-out");
    let app = guild_server::build_router(fs.state.clone());
    let frame = first_app_frame(app, &fs.token, "M-A", |d: &str| d.contains("hello fan-out")).await;
    let frame = frame.expect("late device gets the accumulated delta");
    assert!(frame.contains("\"type\":\"delta\""), "{frame}");
}
