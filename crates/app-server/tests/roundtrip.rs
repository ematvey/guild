use guild_app_server::cloud::{collect_turn, CloudClient};
use guild_app_server::jsonrpc_loop::{self, Session};
use protocol::api::{Message, StreamEvent};
use std::io::Cursor;

fn input(lines: &[serde_json::Value]) -> Cursor<Vec<u8>> {
    let mut buf = String::new();
    for l in lines {
        buf.push_str(&l.to_string());
        buf.push('\n');
    }
    Cursor::new(buf.into_bytes())
}

fn collect_written(written: Vec<u8>) -> Vec<serde_json::Value> {
    String::from_utf8(written)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// Full login → chat round-trip through the real server stack.
#[tokio::test(flavor = "multi_thread")]
async fn login_create_chat_stream_roundtrip() {
    let srv = guild_server::test_support::serve_full().await;
    let (token, user) = CloudClient::login(&srv.base_url, "a@b.c", "hunter226")
        .await
        .unwrap();
    assert_eq!(user.role, "admin");
    let client = CloudClient {
        base_url: srv.base_url.clone(),
        token,
    };
    let chat_id = client.create_chat(Some("t")).await.unwrap();
    let stream = client
        .chat_stream(chat_id, &srv.model, &[Message::user("greet")])
        .await
        .unwrap();
    let (text, done) = collect_turn(stream).await.unwrap();
    assert_eq!(text, "hi there");
    match done {
        Some(StreamEvent::Done {
            cost_usd,
            tokens_in,
            tokens_out,
            ..
        }) => {
            assert!(cost_usd > 0.0);
            assert_eq!(tokens_in, 5);
            assert_eq!(tokens_out, 2);
        }
        other => panic!("expected done, got {other:?}"),
    }
    let msgs = srv
        .store()
        .chats()
        .list_messages(user.org_id, chat_id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 2);
}

/// The stdio JSON-RPC loop handles login and chat.send end-to-end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jsonrpc_loop_login_and_chat_send() {
    let srv = guild_server::test_support::serve_full().await;

    let requests = vec![
        serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "protocol": 1,
            "method": "login",
            "params": {"base_url": srv.base_url, "email": "a@b.c", "password": "hunter226"}
        }),
        serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "protocol": 1,
            "method": "chat.send",
            "params": {"text": "greet", "model": "gpt-test"}
        }),
        // desktop-only RPCs: admin-console handoff + model selector
        serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "protocol": 1,
            "method": "session.info", "params": {}
        }),
        serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "protocol": 1,
            "method": "models.list", "params": {}
        }),
    ];
    // keep the token file out of the developer's real config dir during tests
    let tmp = std::env::temp_dir().join(format!("guild-jsonrpc-test-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &tmp);

    let (_session, written) = jsonrpc_loop::serve(input(&requests), Vec::new(), Session::default())
        .await
        .unwrap();

    let msgs = collect_written(written);
    let login = msgs
        .iter()
        .find(|m| m.get("id") == Some(&serde_json::json!(1)))
        .expect("login response");
    assert_eq!(login["result"]["ok"], true);
    let events: Vec<&serde_json::Value> =
        msgs.iter().filter(|m| m.get("event").is_some()).collect();
    assert!(events
        .iter()
        .any(|e| e["event"] == "chat.delta" && e["payload"]["content"] == "hi there"));
    let done = events
        .iter()
        .find(|e| e["event"] == "chat.done")
        .expect("chat.done event");
    assert!(done["payload"]["cost_usd"].as_f64().unwrap() > 0.0);
    let resp2 = msgs
        .iter()
        .find(|m| m.get("id") == Some(&serde_json::json!(2)))
        .expect("chat.send response");
    assert_eq!(resp2["result"]["tokens_in"], 5);
    // session.info exposes what the Admin-console handoff link needs
    let info = msgs
        .iter()
        .find(|m| m.get("id") == Some(&serde_json::json!(3)))
        .expect("session.info response");
    assert_eq!(info["result"]["base_url"], srv.base_url);
    assert_eq!(info["result"]["email"], "a@b.c");
    assert!(info["result"]["token"].as_str().unwrap().len() > 20);
    // models.list drives the desktop model selector
    let models = msgs
        .iter()
        .find(|m| m.get("id") == Some(&serde_json::json!(4)))
        .expect("models.list response");
    assert!(models["result"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m.as_str() == Some("gpt-test")));
}
