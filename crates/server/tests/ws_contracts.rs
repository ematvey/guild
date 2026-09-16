#![cfg(feature = "test-support")]
use futures::{SinkExt, StreamExt};
use guild_server::test_support::{
    note_client_tool, note_generation, test_state_with_mock_ingress, MockIngress, TestState,
};
use protocol::api::ThreadEvent;
use protocol::ws::WsServerMsg;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Fixture {
    ts: TestState,
    ingress: MockIngress,
    base: String,
    token: String,
    chat: Uuid,
    user: Uuid,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let (ts, ingress) = test_state_with_mock_ingress().await;
        let store = ts.store();
        let user = store
            .identity()
            .ensure_bootstrap_admin("ws@example.test", "test-password")
            .await
            .unwrap();
        let (_, token) = store.identity().create_session(user).await.unwrap();
        let u = store.identity().validate_session(&token).await.unwrap();
        let chat = store
            .chats()
            .create_chat(u.org_id, u.id, Some("contract"))
            .await
            .unwrap()
            .id;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = guild_server::build_router(ts.state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            ts,
            ingress,
            base,
            token,
            chat,
            user,
            server,
        }
    }
    async fn socket(&self, machine: Option<(&str, Uuid, bool)>) -> Socket {
        let ticket: Value = reqwest::Client::new()
            .post(format!("{}/api/v1/ws/ticket", self.base))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let mut url = format!(
            "{}/api/v1/ws?ticket={}&client_id=test",
            self.base.replace("http:", "ws:"),
            ticket["ticket"].as_str().unwrap()
        );
        if let Some((id, instance, resume)) = machine {
            url += &format!("&machine_id={id}&instance_id={instance}&resume={resume}");
        }
        connect_async(url).await.unwrap().0
    }
}
async fn until(socket: &mut Socket, predicate: impl Fn(&WsServerMsg) -> bool) -> WsServerMsg {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                Message::Text(text) => {
                    let message: WsServerMsg = serde_json::from_str(&text).unwrap();
                    if predicate(&message) {
                        return message;
                    }
                }
                other => panic!("unexpected frame: {other:?}"),
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn established_session_revocation_emits_auth_required() {
    let f = Fixture::new().await;
    let mut socket = f.socket(None).await;
    until(&mut socket, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    f.ts.store()
        .identity()
        .revoke_session(&f.token)
        .await
        .unwrap();
    until(&mut socket, |m| matches!(m, WsServerMsg::AuthRequired)).await;
    let refresh = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/refresh", f.base))
        .bearer_auth(&f.token)
        .send()
        .await
        .unwrap();
    assert_eq!(refresh.status(), 401);
}

#[tokio::test]
async fn established_session_expiry_emits_auth_required() {
    let f = Fixture::new().await;
    let mut socket = f.socket(None).await;
    until(&mut socket, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1")
        .bind(f.user)
        .execute(f.ts.store().pool())
        .await
        .unwrap();
    until(&mut socket, |m| matches!(m, WsServerMsg::AuthRequired)).await;
}

#[tokio::test]
async fn silent_open_machine_goes_offline_and_pending_tool_settles() {
    let f = Fixture::new().await;
    let _socket = f.socket(Some(("silent", Uuid::now_v7(), false))).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(f.ts.state.hub.machine_online("silent"));
    note_generation(&f.ts.state, f.chat);
    guild_server::test_support::note_watched_client_tool(
        &f.ts.state,
        f.chat,
        "silent-call",
        "silent",
    );
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if f.ingress
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, body)| {
                    path.contains("complete_tool") && body["call_id"] == "silent-call"
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(!f.ts.state.hub.machine_online("silent"));
}

#[tokio::test]
async fn reconnect_fails_unknown_execution_with_member_keeping_feed_alive() {
    let f = Fixture::new().await;
    let mut member = f.socket(None).await;
    until(&mut member, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    let member_reader = tokio::spawn(async move {
        while let Some(Ok(frame)) = member.next().await {
            if let Message::Ping(p) = frame {
                let _ = member.send(Message::Pong(p)).await;
            }
        }
    });
    let instance = Uuid::now_v7();
    let mut old = f.socket(Some(("executor", instance, false))).await;
    until(&mut old, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    note_generation(&f.ts.state, f.chat);
    note_client_tool(&f.ts.state, f.chat, "call", "execute", "{}", "executor");
    until(&mut old, |m| matches!(m, WsServerMsg::ToolDispatch { .. })).await;
    drop(old);
    let mut new = f.socket(Some(("executor", instance, true))).await;
    until(&mut new, |m| {
        assert!(
            !matches!(m, WsServerMsg::ToolDispatch { .. }),
            "uncertain execution must not be replayed"
        );
        matches!(m, WsServerMsg::ThreadList { .. })
    })
    .await;
    assert!(f
        .ingress
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(_, body)| body["call_id"] == "call"
            && body["is_error"] == true
            && body["content"].as_str().unwrap().contains("unknown")));
    member_reader.abort();
}

#[tokio::test]
async fn displacement_is_terminal_on_stale_resume() {
    let f = Fixture::new().await;
    let first = Uuid::now_v7();
    let mut old = f.socket(Some(("singleton", first, false))).await;
    until(&mut old, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    let mut new = f.socket(Some(("singleton", Uuid::now_v7(), false))).await;
    until(&mut new, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    until(&mut old, |m| matches!(m, WsServerMsg::Displaced)).await;
    let holder = f.ts.state.hub.machine_connection("singleton");
    let mut stale = f.socket(Some(("singleton", first, true))).await;
    until(&mut stale, |m| matches!(m, WsServerMsg::Displaced)).await;
    assert_eq!(f.ts.state.hub.machine_connection("singleton"), holder);
}

#[tokio::test]
async fn command_ack_is_not_a_user_echo_and_commits_fan_out_to_other_tabs() {
    let f = Fixture::new().await;
    let mut tab = f.socket(None).await;
    until(&mut tab, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    let message_id = Uuid::now_v7();
    let response = reqwest::Client::new().post(format!("{}/api/v1/gateway/chat", f.base)).bearer_auth(&f.token)
        .json(&json!({"chat_id": f.chat, "user_message_id": message_id, "model": "test", "messages": [{"role": "user", "content": "hello"}]})).send().await.unwrap();
    assert_eq!(response.headers()["content-type"], "application/json");
    let status = response.status();
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["accepted"], true, "{body}");
    let u =
        f.ts.store()
            .identity()
            .validate_session(&f.token)
            .await
            .unwrap();
    assert!(f
        .ts
        .store()
        .thread()
        .list_events(u.org_id, f.chat)
        .await
        .unwrap()
        .is_empty());
    assert!(f
        .ingress
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(_, body)| body["user_message_id"] == message_id.to_string()));
    for _ in 0..2 {
        f.ts.store()
            .thread()
            .append_event_with_id(
                f.chat,
                &ThreadEvent::UserMessage {
                    content: "hello".into(),
                    attachments: vec![],
                },
                message_id,
            )
            .await
            .unwrap();
    }
    let view = until(
        &mut tab,
        |m| matches!(m, WsServerMsg::ThreadState { events, .. } if !events.is_empty()),
    )
    .await;
    let WsServerMsg::ThreadState { seq, events, .. } = view else {
        unreachable!()
    };
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], message_id.to_string());
    assert_eq!(events[0]["event"]["content"], "hello");
    assert!(seq > events[0]["seq"].as_i64().unwrap());
}

#[tokio::test]
async fn legacy_transport_routes_are_retired() {
    let f = Fixture::new().await;
    for (method, path) in [
        (
            reqwest::Method::GET,
            format!("/api/v1/gateway/chat/{}/stream", f.chat),
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/gateway/chat/{}/tools/call/result", f.chat),
        ),
    ] {
        let response = reqwest::Client::new()
            .request(method, format!("{}{path}", f.base))
            .bearer_auth(&f.token)
            .json(&json!({"content":"x"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
    }
}
