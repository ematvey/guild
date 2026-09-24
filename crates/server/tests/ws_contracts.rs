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
            .create_chat(u.org_id, u.id, Some("contract"), None)
            .await
            .unwrap()
            .id;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = guild_server::build_router(ts.state.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
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
        let extra = match machine {
            Some((id, instance, resume)) => {
                format!("&machine_id={id}&instance_id={instance}&resume={resume}")
            }
            None => String::new(),
        };
        self.connect_raw(&extra).await
    }
    async fn ticket(&self) -> String {
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
        ticket["ticket"].as_str().unwrap().to_string()
    }
    async fn connect_raw(&self, extra: &str) -> Socket {
        let url = format!(
            "{}/api/v1/ws?ticket={}{}",
            self.base.replace("http:", "ws:"),
            self.ticket().await,
            extra
        );
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
    )
    .await;
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
    note_client_tool(&f.ts.state, f.chat, "call", "execute", "{}", "executor").await;
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
    // Acceptance commits the durable echo and outbox atomically. The ACK
    // is still only command metadata; views fan out the committed event.
    assert!(body.get("event").is_none());
    assert!(body.get("content").is_none());
    let rows =
        f.ts.store()
            .thread()
            .list_events(u.org_id, f.chat)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, message_id);
    let retry = reqwest::Client::new().post(format!("{}/api/v1/gateway/chat", f.base)).bearer_auth(&f.token)
        .json(&json!({"chat_id": f.chat, "user_message_id": message_id, "model": "test", "messages": [{"role": "user", "content": "hello"}]})).send().await.unwrap();
    assert_eq!(retry.status(), 200);
    assert_eq!(
        retry.json::<Value>().await.unwrap()["generation_id"],
        message_id.to_string()
    );
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
    assert_eq!(
        f.ts.store()
            .thread()
            .list_events(u.org_id, f.chat)
            .await
            .unwrap()
            .len(),
        1
    );
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
#[tokio::test]
async fn machine_connect_registers_in_the_durable_registry() {
    let f = Fixture::new().await;
    let instance = Uuid::now_v7();
    let mut socket = f
        .connect_raw(&format!(
            "&machine_id=reg-desktop&instance_id={instance}&resume=false\
             &machine_name=WORKSTATION&machine_fingerprint=FP-1&machine_os=Windows\
             &machine_os_version=11&machine_app_version=0.4.0"
        ))
        .await;
    until(&mut socket, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;

    let row: guild_server::store::machines::MachineRow =
        sqlx::query_as("SELECT * FROM machines WHERE machine_id = 'reg-desktop'")
            .fetch_one(f.ts.store().pool())
            .await
            .unwrap();
    assert_eq!(row.label.as_deref(), Some("WORKSTATION"));
    assert_eq!(row.hardware_fingerprint.as_deref(), Some("FP-1"));
    assert_eq!(row.os.as_deref(), Some("Windows"));
    assert_eq!(row.os_version.as_deref(), Some("11"));
    assert_eq!(row.app_version.as_deref(), Some("0.4.0"));
    assert!(
        row.last_ip
            .as_deref()
            .is_some_and(|ip| ip.starts_with("127.0.0.1")),
        "peer ip must be captured from the socket, got {row:?}"
    );
    assert!(row.re_paired_at.is_none());
    // The live hub slot stays registered under the connect id.
    assert!(f.ts.state.hub.machine_online("reg-desktop"));
}

#[tokio::test]
async fn re_pair_adoption_rekeys_the_row_and_displaces_the_old_socket() {
    let f = Fixture::new().await;
    let old_instance = Uuid::now_v7();
    let mut old = f
        .connect_raw(&format!(
            "&machine_id=old-id&machine_name=OLD&machine_fingerprint=FP-9&instance_id={old_instance}"
        ))
        .await;
    until(&mut old, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    assert!(f.ts.state.hub.machine_online("old-id"));

    // Same physical machine re-pairs under a new local id: the registry row
    // is adopted and the still-live old registration is displaced.
    let instance = Uuid::now_v7();
    let mut new = f
        .connect_raw(&format!(
            "&machine_id=new-id&machine_name=NEW&machine_fingerprint=FP-9&instance_id={instance}"
        ))
        .await;
    until(&mut new, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    until(&mut old, |m| matches!(m, WsServerMsg::Displaced)).await;

    assert!(!f.ts.state.hub.machine_online("old-id"));
    assert!(f.ts.state.hub.machine_online("new-id"));
    let row: guild_server::store::machines::MachineRow =
        sqlx::query_as("SELECT * FROM machines WHERE machine_id = 'new-id'")
            .fetch_one(f.ts.store().pool())
            .await
            .unwrap();
    assert_eq!(row.hardware_fingerprint.as_deref(), Some("FP-9"));
    assert!(
        row.re_paired_at.is_some(),
        "adoption must stamp re_paired_at"
    );
    let old_left: Option<guild_server::store::machines::MachineRow> =
        sqlx::query_as("SELECT * FROM machines WHERE machine_id = 'old-id'")
            .fetch_optional(f.ts.store().pool())
            .await
            .unwrap();
    assert!(old_left.is_none(), "old id must be re-keyed away");
}

/// An org-shared machine executes another member's chat (the binding is
/// explicitly permitted) — its connection must be able to return the tool
/// result to that chat: authorization rides the pending dispatch + org
/// identity, not chat ownership.
#[tokio::test]
async fn org_shared_machine_returns_results_to_another_members_chat() {
    let (ts, ingress) = test_state_with_mock_ingress().await;
    let store = ts.store();
    let org = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
        .bind(org)
        .execute(store.pool())
        .await
        .unwrap();
    // Member B owns the chat; member A owns the org-shared machine.
    let owner = store
        .identity()
        .create_user(org, &format!("b-{org}@ws.test"), "hunter226", "member")
        .await
        .unwrap();
    let machine_user = store
        .identity()
        .create_user(org, &format!("a-{org}@ws.test"), "hunter226", "member")
        .await
        .unwrap();
    let chat = store
        .chats()
        .create_chat(org, owner.id, Some("b-chat"), None)
        .await
        .unwrap()
        .id;
    store
        .machines()
        .upsert_connected(
            org,
            machine_user.id,
            "shared-1",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let (_, machine_token) = store
        .identity()
        .create_session(machine_user.id)
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = guild_server::build_router(ts.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // The machine's connection, authenticated as its member (not the chat
    // owner, not an admin).
    let ticket: Value = reqwest::Client::new()
        .post(format!("{base}/api/v1/ws/ticket"))
        .bearer_auth(&machine_token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!(
        "{}/api/v1/ws?ticket={}&machine_id=shared-1&instance_id={}&resume=false",
        base.replace("http:", "ws:"),
        ticket["ticket"].as_str().unwrap(),
        Uuid::now_v7()
    );
    let mut machine = connect_async(url).await.unwrap().0;
    until(&mut machine, |m| {
        matches!(m, WsServerMsg::ThreadList { .. })
    })
    .await;

    // The turn suspends on a client tool dispatched to the shared machine.
    note_generation(&ts.state, chat);
    note_client_tool(&ts.state, chat, "call-1", "execute", "{}", "shared-1").await;
    until(&mut machine, |m| {
        matches!(m, WsServerMsg::ToolDispatch { .. })
    })
    .await;

    // The machine posts the result for the member's chat.
    let reply = serde_json::to_string(&json!({
        "type": "tool_result",
        "chat_id": chat,
        "call_id": "call-1",
        "content": "done",
        "is_error": false,
    }))
    .unwrap();
    machine.send(Message::Text(reply.into())).await.unwrap();

    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if ingress
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, body)| path.contains("complete_tool") && body["call_id"] == "call-1")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the shared machine's result reached the chat turn");
    server.abort();
}

#[tokio::test]
async fn demoted_admin_cannot_sync_another_users_chat_on_existing_socket() {
    let f = Fixture::new().await;
    let store = f.ts.store();
    let user = store.identity().get_user(f.user).await.unwrap();
    let owner = store
        .identity()
        .create_user(user.org_id, "owner@ws.test", "test-password", "admin")
        .await
        .unwrap();
    let chat = store
        .chats()
        .create_chat(user.org_id, owner.id, Some("private"), None)
        .await
        .unwrap();
    let mut socket = f.socket(None).await;
    until(&mut socket, |m| matches!(m, WsServerMsg::ThreadList { .. })).await;
    store
        .identity()
        .update_user(user.org_id, f.user, Some("member"), None)
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({"type":"sync", "chat_id":chat.id}).to_string().into(),
        ))
        .await
        .unwrap();
    until(&mut socket, |m| matches!(m, WsServerMsg::Error { .. })).await;
}
