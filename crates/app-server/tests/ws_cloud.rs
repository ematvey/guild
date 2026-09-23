use guild_app_server::cloud::{collect_turn, CloudClient};
use guild_server::test_support::{generation_tx, test_state_with_mock_ingress};
use protocol::api::StreamEvent;
use uuid::Uuid;

#[tokio::test]
async fn cloud_command_uses_ws_for_output_and_json_for_acknowledgment() {
    cloud_command_contract(false).await;
}

#[tokio::test]
async fn cloud_command_keeps_its_stream_identity_during_ingress_outage() {
    cloud_command_contract(true).await;
}

async fn cloud_command_contract(ingress_outage: bool) {
    let (fixture, ingress) = test_state_with_mock_ingress().await;
    let store = fixture.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("cloud@test", "test-password")
        .await
        .unwrap();
    let (_, token) = store.identity().create_session(user).await.unwrap();
    let user = store.identity().validate_session(&token).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user.org_id, user.id, Some("cloud"), None)
        .await
        .unwrap()
        .id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let mut api_state = fixture.state.clone();
    if ingress_outage {
        let mut config = (*api_state.config).clone();
        let unavailable = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        config.restate_url = format!("http://{}", unavailable.local_addr().unwrap());
        drop(unavailable);
        api_state.config = std::sync::Arc::new(config);
    }
    let app = guild_server::build_router(api_state);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let cloud = CloudClient { base_url, token };
    let stream = cloud
        .chat_stream(chat, "test", &[protocol::api::Message::user("hello")])
        .await
        .unwrap();
    if ingress_outage {
        assert!(ingress.requests.lock().unwrap().is_empty());
        // The accepted command already returned a usable stream to the CLI.
        // Delivery resumes with the same identity after ingress recovers.
        guild_server::http::gateway::dispatch_turn_commands(&fixture.state, Some(chat))
            .await
            .unwrap();
    }
    assert!(ingress
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(path, _)| path.contains("generate")));
    let tx = generation_tx(&fixture.state, chat);
    tx.send(StreamEvent::Delta {
        content: "WS answer".into(),
    })
    .unwrap();
    tx.send(StreamEvent::Done {
        message_id: Uuid::now_v7(),
        cost_usd: 0.0,
        tokens_in: 1,
        tokens_out: 2,
    })
    .unwrap();
    let (text, done) =
        tokio::time::timeout(std::time::Duration::from_secs(5), collect_turn(stream))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(text, "WS answer");
    assert!(done.is_some());
    server.abort();
}
