use guild_app_server::cloud::{collect_turn, CloudClient};
use protocol::api::{Message, StreamEvent};
use protocol::ws::WsServerMsg;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

/// Hand-rolled member-socket hub: mints tickets, upgrades the member WS and
/// bootstraps it with a thread_list, forwards frames the test pushes into
/// the relay, and answers the gateway command with a fixed generation
/// identity (optionally delayed, so frames can arrive before the ack). The
/// gateway's own queuing and ingress semantics are server-side behavior,
/// owned and tested there.
#[derive(Clone)]
struct MockHub {
    commands_tx: tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
    ack_delay_ms: Arc<AtomicU64>,
    generation: Uuid,
}

async fn spawn_mock_hub(
    hub: MockHub,
    frames_rx: tokio::sync::mpsc::UnboundedReceiver<WsServerMsg>,
) -> (String, tokio::task::JoinHandle<()>) {
    let frames_rx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<WsServerMsg>>>> =
        Arc::new(Mutex::new(Some(frames_rx)));
    let app = axum::Router::new()
        .route(
            "/api/v1/ws/ticket",
            axum::routing::post(|| async { axum::Json(serde_json::json!({"ticket":"fixture"})) }),
        )
        .route(
            "/api/v1/auth/refresh",
            axum::routing::post(|| async { axum::http::StatusCode::OK }),
        )
        .route(
            "/api/v1/gateway/chat",
            axum::routing::post(
                move |axum::extract::Json(body): axum::extract::Json<serde_json::Value>| {
                    let commands_tx = hub.commands_tx.clone();
                    let ack_delay_ms = hub.ack_delay_ms.clone();
                    let generation = hub.generation;
                    async move {
                        let _ = commands_tx.send(body);
                        let delay = ack_delay_ms.load(Ordering::SeqCst);
                        if delay > 0 {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                        axum::Json(serde_json::json!({
                            "generation_id": generation.to_string()
                        }))
                    }
                },
            ),
        )
        .route(
            "/api/v1/ws",
            axum::routing::get(move |ws: axum::extract::ws::WebSocketUpgrade| {
                let frames_rx = frames_rx.clone();
                async move {
                    ws.on_upgrade(move |socket| async move {
                        use futures::{SinkExt, StreamExt};
                        let mut frames_rx =
                            frames_rx.lock().unwrap().take().expect("one member connection");
                        let (mut tx, mut rx) = socket.split();
                        // The bootstrap the client waits for before submitting
                        // the command.
                        let _ = tx
                            .send(axum::extract::ws::Message::text(
                                serde_json::to_string(&WsServerMsg::ThreadList { chats: vec![] })
                                    .unwrap(),
                            ))
                            .await;
                        loop {
                            tokio::select! {
                                frame = frames_rx.recv() => match frame {
                                    Some(msg) => {
                                        let text = serde_json::to_string(&msg).unwrap();
                                        if tx
                                            .send(axum::extract::ws::Message::text(text))
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                    }
                                    None => return,
                                },
                                incoming = rx.next() => match incoming {
                                    Some(Ok(_)) => {} // pongs
                                    _ => return,
                                },
                            }
                        }
                    })
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (base_url, server)
}

fn live_frame(
    chat: Uuid,
    generation: Uuid,
    seq: i64,
    event: StreamEvent,
) -> WsServerMsg {
    WsServerMsg::LiveFrame {
        chat_id: chat,
        generation_id: generation,
        seq,
        machine_id: None,
        event,
    }
}

#[tokio::test]
async fn cloud_command_uses_ws_for_output_and_json_for_acknowledgment() {
    let chat = Uuid::now_v7();
    let generation = Uuid::now_v7();
    let (frames_tx, frames_rx) = tokio::sync::mpsc::unbounded_channel();
    let (commands_tx, mut commands_rx) = tokio::sync::mpsc::unbounded_channel();
    let (base_url, server) = spawn_mock_hub(
        MockHub {
            commands_tx,
            ack_delay_ms: Arc::new(AtomicU64::new(0)),
            generation,
        },
        frames_rx,
    )
    .await;
    let cloud = CloudClient {
        base_url: base_url.clone(),
        token: "t".into(),
    };
    let stream = cloud
        .chat_stream(chat, "test", &[Message::user("hello")])
        .await
        .unwrap();
    // The command reached the gateway carrying the chat identity.
    let command = commands_rx.recv().await.unwrap();
    assert_eq!(command["chat_id"], chat.to_string());
    frames_tx
        .send(live_frame(
            chat,
            generation,
            1,
            StreamEvent::Delta {
                content: "WS answer".into(),
            },
        ))
        .unwrap();
    frames_tx
        .send(live_frame(
            chat,
            generation,
            2,
            StreamEvent::Done {
                message_id: Uuid::now_v7(),
                cost_usd: 0.0,
                tokens_in: 1,
                tokens_out: 2,
            },
        ))
        .unwrap();
    let (text, done) =
        tokio::time::timeout(Duration::from_secs(5), collect_turn(stream))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(text, "WS answer");
    assert!(done.is_some());
    server.abort();
}

/// The command ack can lag the output: frames that arrive on the socket
/// before the gateway acknowledgment are buffered and delivered on the
/// acknowledged stream identity, in order.
#[tokio::test]
async fn cloud_command_buffers_frames_that_arrive_before_the_ack() {
    let chat = Uuid::now_v7();
    let generation = Uuid::now_v7();
    let (frames_tx, frames_rx) = tokio::sync::mpsc::unbounded_channel();
    let (commands_tx, mut commands_rx) = tokio::sync::mpsc::unbounded_channel();
    let (base_url, server) = spawn_mock_hub(
        MockHub {
            commands_tx,
            ack_delay_ms: Arc::new(AtomicU64::new(500)),
            generation,
        },
        frames_rx,
    )
    .await;
    let cloud = CloudClient {
        base_url: base_url.clone(),
        token: "t".into(),
    };
    let messages = [Message::user("hello")];
    let stream_fut = cloud.chat_stream(chat, "test", &messages);
    tokio::pin!(stream_fut);
    // Drive the client until the command is in flight: the client socket is
    // up and the gateway holds the request while its ack is delayed.
    tokio::select! {
        command = commands_rx.recv() => {
            let _command = command.expect("gateway saw the command");
        }
        _ = &mut stream_fut => {
            panic!("chat_stream must not complete before the ack")
        }
    }
    frames_tx
        .send(live_frame(
            chat,
            generation,
            1,
            StreamEvent::Delta {
                content: "WS answer".into(),
            },
        ))
        .unwrap();
    frames_tx
        .send(live_frame(
            chat,
            generation,
            2,
            StreamEvent::Done {
                message_id: Uuid::now_v7(),
                cost_usd: 0.0,
                tokens_in: 1,
                tokens_out: 2,
            },
        ))
        .unwrap();
    let stream = tokio::time::timeout(Duration::from_secs(5), stream_fut)
        .await
        .unwrap()
        .unwrap();
    let (text, done) =
        tokio::time::timeout(Duration::from_secs(5), collect_turn(stream))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(text, "WS answer", "pre-ack frames must be buffered, not lost");
    assert!(done.is_some());
    server.abort();
}
