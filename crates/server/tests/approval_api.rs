//! Phase 2 approvals (docs/plans/2026-09-12-approvals-design.md §D, §E, §H):
//! approval-policy settings endpoints (user-scoped, migration 0026), the
//! approvals decision endpoint's org scoping, and the attach replay of
//! unresolved approval requests.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures::{SinkExt, StreamExt};
use guild_server::test_support::{
    insert_org_with_chat, note_generation, test_state_with_mock_ingress, MockIngress,
};
use protocol::api::ThreadEvent;
use serde_json::{json, Value};
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

/// Bootstrap admin + session token + app router, with one chat owned by the
/// admin and a mock Restate ingress. Returns (state, token, app, chat_id,
/// mock ingress).
#[allow(clippy::type_complexity)]
async fn setup() -> (
    guild_server::test_support::TestState,
    String,
    axum::Router,
    Uuid,
    MockIngress,
) {
    let (ts, ingress) = test_state_with_mock_ingress().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&token).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user_row.org_id, user_row.id, Some("approval test"), None)
        .await
        .unwrap();
    let app = guild_server::build_router(ts.state.clone());
    (ts, token, app, chat.id, ingress)
}

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

#[tokio::test]
async fn approval_settings_roundtrip_and_validation() {
    let (_ts, token, app, _chat, _ingress) = setup().await;

    // Fresh user: no stored policy → null (server default applies).
    let res = app
        .clone()
        .oneshot(req("GET", format!("/api/v1/me/approval"), &token, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["approval"], Value::Null);

    // Save a valid policy for the user (bare JSON shape) and read it back.
    let policy = json!({"default": "ask", "overrides": {"read_file": "allow"}});
    let res = app
        .clone()
        .oneshot(req(
            "PUT",
            format!("/api/v1/me/approval"),
            &token,
            Some(policy.clone()),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["approval"], policy);
    let res = app
        .clone()
        .oneshot(req("GET", format!("/api/v1/me/approval"), &token, None))
        .await
        .unwrap();
    assert_eq!(body_json(res).await["approval"], policy);

    // The {"approval": …} wrapper shape works too.
    let policy2 = json!({"default": "allow"});
    let res = app
        .clone()
        .oneshot(req(
            "PUT",
            format!("/api/v1/me/approval"),
            &token,
            Some(json!({"approval": policy2})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .clone()
        .oneshot(req("GET", format!("/api/v1/me/approval"), &token, None))
        .await
        .unwrap();
    assert_eq!(body_json(res).await["approval"], policy2);

    // Invalid policy JSON is rejected with 400 and not stored.
    for bad in [
        json!({"default": "bogus"}),
        json!({"overrides": {"read_file": "maybe"}}),
        json!({"default": 7}),
    ] {
        let res = app
            .clone()
            .oneshot(req(
                "PUT",
                format!("/api/v1/me/approval"),
                &token,
                Some(bad.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "for {bad}");
    }
    let res = app
        .clone()
        .oneshot(req("GET", format!("/api/v1/me/approval"), &token, None))
        .await
        .unwrap();
    assert_eq!(body_json(res).await["approval"], policy2);

    // {"approval": null} resets to the server default.
    let res = app
        .clone()
        .oneshot(req(
            "PUT",
            format!("/api/v1/me/approval"),
            &token,
            Some(json!({"approval": null})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["approval"], Value::Null);
}

#[tokio::test]
async fn approval_endpoints_are_org_scoped() {
    let (_ts, token, app, _chat, ingress) = setup().await;
    let foreign = insert_org_with_chat(&_ts.store()).await;

    // The policy settings endpoints are user-scoped (/api/v1/me/approval) —
    // no chat/org scoping to test there anymore; only the decision endpoint
    // takes a foreign chat id.
    for (method, uri, body) in [(
        "POST",
        format!("/api/v1/gateway/chat/{foreign}/approvals/call-1"),
        Some(json!({"approved": true})),
    )] {
        let res = app
            .clone()
            .oneshot(req(method, uri, &token, body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // Own chat: the decision endpoint rejects a body without `approved`.
    let res = app
        .clone()
        .oneshot(req(
            "POST",
            format!("/api/v1/gateway/chat/{_chat}/approvals/call-1"),
            &token,
            Some(json!({"reason": "no flag"})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // And accepts a well-formed decision for a LIVE turn: the endpoint
    // forwards and sends exactly one one-way invoke to
    // ChatRunner/{chat}/complete_approval with the shared ApprovalReq shape
    // (design §D); the card settles through the stream, not the response.
    note_generation(&_ts.state, _chat);
    let res = app
        .clone()
        .oneshot(req(
            "POST",
            format!("/api/v1/gateway/chat/{_chat}/approvals/call-1"),
            &token,
            Some(json!({"approved": true, "reason": "ok"})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["settled"], false);
    let sent = ingress.requests.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].0,
        format!("/ChatRunner/{_chat}/complete_approval/send")
    );
    assert_eq!(
        sent[0].1,
        json!({"call_id": "call-1", "approved": true, "reason": "ok"})
    );
}

/// A decision whose call already carries a recorded decision is echoed from
/// the thread log — first answer wins, and a late click settles its card
/// from the response without contacting the ChatRunner.
#[tokio::test]
async fn recorded_decision_is_echoed_verbatim() {
    let (ts, token, app, chat, ingress) = setup().await;
    let store = ts.store();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalRequest {
                call_id: "a1".into(),
                name: "execute".into(),
                arguments: "\"ls\"".into(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalDecision {
                call_id: "a1".into(),
                approved: true,
                reason: Some("judge".into()),
                expired: false,
            },
        )
        .await
        .unwrap();

    let res = app
        .clone()
        .oneshot(req(
            "POST",
            format!("/api/v1/gateway/chat/{chat}/approvals/a1"),
            &token,
            Some(json!({"approved": false})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!(v["settled"], true);
    assert_eq!(v["approved"], true); // the recorded decision, not the click
    assert_eq!(v["reason"], "judge");
    assert_eq!(v["expired"], false);
    assert!(ingress.requests.lock().unwrap().is_empty());
}

/// A call with no recorded decision and no live turn is orphaned: its turn
/// ended before the card was answered and it can never execute. The
/// endpoint journals the expired decision and settles the caller's card;
/// it still forwards so a gate suspended in Restate after a restart can
/// accept the decision.
#[tokio::test]
async fn orphaned_decision_is_journaled_expired() {
    let (ts, token, app, chat, ingress) = setup().await;
    let store = ts.store();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalRequest {
                call_id: "a1".into(),
                name: "execute".into(),
                arguments: "\"ls\"".into(),
            },
        )
        .await
        .unwrap();
    let user = store
        .identity()
        .find_by_email_any("a@b.c")
        .await
        .unwrap()
        .expect("bootstrap admin exists");

    let res = app
        .clone()
        .oneshot(req(
            "POST",
            format!("/api/v1/gateway/chat/{chat}/approvals/a1"),
            &token,
            Some(json!({"approved": true})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!(v["settled"], true);
    assert_eq!(v["approved"], false);
    assert_eq!(v["expired"], true);

    // the expired marker is durable in the thread log
    let events = store.thread().list_events(user.org_id, chat).await.unwrap();
    let expired = events
        .iter()
        .filter_map(|ev| match &ev.event {
            ThreadEvent::ApprovalDecision { expired, .. } => Some(*expired),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(expired, vec![true]);

    // and the forward still went out (restart-suspended gate accepts it)
    let sent = ingress.requests.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].0,
        format!("/ChatRunner/{chat}/complete_approval/send")
    );
}

#[tokio::test]
async fn attach_replays_unresolved_approval_requests() {
    let (ts, token, app, chat, _ingress) = setup().await;
    note_generation(&ts.state, chat);

    // a1: decided → not replayed. a2: unresolved → replayed. a3: request
    // without a decision but with a later tool result → not replayed.
    let store = ts.store();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalRequest {
                call_id: "a1".into(),
                name: "execute".into(),
                arguments: "\"ls\"".into(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalDecision {
                call_id: "a1".into(),
                approved: true,
                reason: None,
                expired: false,
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalRequest {
                call_id: "a2".into(),
                name: "write_file".into(),
                arguments: "\"{}\"".into(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ApprovalRequest {
                call_id: "a3".into(),
                name: "edit_file".into(),
                arguments: "\"{}\"".into(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat,
            &ThreadEvent::ToolResult {
                turn: 1,
                step: 0,
                call_id: "a3".into(),
                name: "edit_file".into(),
                content: "done".into(),
                is_error: false,
                meta: None,
                images: Vec::new(),
                kind: None,
                artifact_id: None,
            },
        )
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let ticket: Value = reqwest::Client::new()
        .post(format!("http://{addr}/api/v1/ws/ticket"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{addr}/api/v1/ws?ticket={}",
        ticket["ticket"].as_str().unwrap()
    ))
    .await
    .unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({"type":"sync", "chat_id":chat}).to_string().into(),
        ))
        .await
        .unwrap();
    let events = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                tokio_tungstenite::tungstenite::Message::Ping(payload) => {
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Pong(payload))
                        .await
                        .unwrap();
                }
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    if let Ok(protocol::ws::WsServerMsg::ThreadState { events, .. }) =
                        serde_json::from_str(&text)
                    {
                        break events;
                    }
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let settled: std::collections::HashSet<_> = events
        .iter()
        .filter(|row| {
            matches!(
                row["event"]["type"].as_str(),
                Some("approval_decision" | "tool_result")
            )
        })
        .filter_map(|row| row["event"]["call_id"].as_str())
        .collect();
    let pending: Vec<_> = events
        .iter()
        .filter(|row| row["event"]["type"] == "approval_request")
        .filter_map(|row| row["event"]["call_id"].as_str())
        .filter(|call| !settled.contains(call))
        .collect();
    assert_eq!(pending, vec!["a2"]);
    server.abort();
}
