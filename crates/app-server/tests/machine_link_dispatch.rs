//! Regression (review 2026-09-22 server.md #1 / core.md F2): tool dispatch
//! must run OFF the reader loop, and unknown/display server frames must not
//! kill the link. The first link version executed tools inline in the
//! reader select-arm: any tool slower than the server's 10 s pong deadline
//! starved the reader, the server tore the link down, and the finished
//! result was lost. It also parsed every frame strictly, so one new
//! `StreamEvent` variant flapped every deployed daemon.

use futures::{SinkExt, StreamExt};
use guild_app_server::auth_state::AuthState;
use guild_app_server::cloud::CloudClient;
use guild_app_server::jsonrpc_loop::{Session, Shared};
use guild_app_server::machine_link::run;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// Collision-proof loopback listener (see tests/agent_rpc.rs).
async fn standalone_listener() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut ports = std::collections::HashSet::<u16>::new();
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines().skip(1) {
                    if let Some(p) = line.split_whitespace().nth(1) {
                        if let Ok(n) = u64::from_str_radix(p.rsplit(':').next().unwrap_or("0"), 16)
                        {
                            if n as u16 != port {
                                ports.insert(n as u16);
                            }
                        }
                    }
                }
            }
        }
        if !ports.contains(&port) {
            return listener;
        }
    }
}

/// What the server observed on its side of one session.
#[derive(Debug)]
struct SessionObs {
    pong_while_tool_running: bool,
    results: Vec<(String, String)>,
}

/// HTTP + WS server: mints tickets, accepts the machine upgrade, then (in
/// order) sends display/unknown frames the executor must ignore, a slow
/// tool dispatch, a Ping (which must be answered while the tool is still
/// running), and a second dispatch that must complete first.
async fn dispatch_server(
    listener: tokio::net::TcpListener,
    connects: Arc<AtomicU32>,
    workdir: String,
    done: tokio::sync::mpsc::UnboundedSender<SessionObs>,
) {
    let app = axum::Router::new()
        .route(
            "/api/v1/ws/ticket",
            axum::routing::post(|| async { axum::Json(serde_json::json!({"ticket": "t"})) }),
        )
        .route(
            "/api/v1/ws",
            axum::routing::get(move |ws: axum::extract::WebSocketUpgrade| {
                let connects = connects.clone();
                let workdir = workdir.clone();
                let done = done.clone();
                async move {
                    connects.fetch_add(1, Ordering::SeqCst);
                    eprintln!("[srv] upgrade accepted");
                    ws.on_upgrade(move |socket| async move {
                        let (mut sink, mut stream) = socket.split();
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({"type": "hello"}).to_string(),
                            ))
                            .await;
                        // Display frames and unknown variants ride the same
                        // socket: none of these may end the session.
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({"type": "thread_list", "chats": []})
                                    .to_string(),
                            ))
                            .await;
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({
                                    "type": "live_frame",
                                    "chat_id": Uuid::nil(),
                                    "generation_id": Uuid::nil(),
                                    "seq": 1,
                                    "machine_id": null,
                                    "event": {"type": "future_stream_event", "x": 1}
                                })
                                .to_string(),
                            ))
                            .await;
                        let _ = sink
                            .send(axum::extract::ws::Message::text("not json at all"))
                            .await;
                        // Slow dispatch: the reader must NOT wait for it.
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({
                                    "type": "tool_dispatch",
                                    "chat_id": Uuid::nil(),
                                    "call_id": "slow",
                                    "name": "execute",
                                    "arguments": serde_json::json!({"command": "sleep 8"}).to_string(),
                                    "workdir": workdir
                                })
                                .to_string(),
                            ))
                            .await;
                        // A pong must arrive while the tool is still running
                        // — this is exactly what the server's 10 s pong
                        // deadline checks in production.
                        let _ = sink.send(axum::extract::ws::Message::Ping(vec![].into())).await;
                        let mut pong_seen = false;
                        let pong_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                        while !pong_seen && tokio::time::Instant::now() < pong_deadline {
                            match tokio::time::timeout(Duration::from_millis(250), stream.next())
                                .await
                            {
                                Ok(Some(Ok(axum::extract::ws::Message::Pong(_)))) => {
                                    pong_seen = true;
                                    eprintln!("[srv] pong seen while tool running");
                                }
                                Ok(Some(Ok(_))) => {}
                                // Timeout: keep waiting; only a socket error
                                // or close ends the phase.
                                Err(_) => {}
                                _ => break,
                            }
                        }
                        eprintln!("[srv] pong phase done ({pong_seen}); sending quick dispatch");
                        // Second dispatch while the first still runs: with
                        // spawned execution it completes first.
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({
                                    "type": "tool_dispatch",
                                    "chat_id": Uuid::nil(),
                                    "call_id": "quick",
                                    "name": "read_file",
                                    "arguments": serde_json::json!({"path": "a.txt"}).to_string(),
                                    "workdir": workdir
                                })
                                .to_string(),
                            ))
                            .await;
                        let mut results: Vec<(String, String)> = Vec::new();
                        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
                        while results.len() < 2 && tokio::time::Instant::now() < deadline {
                            match tokio::time::timeout(Duration::from_millis(250), stream.next())
                                .await
                            {
                                Ok(Some(Ok(axum::extract::ws::Message::Text(t)))) => {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                        if v["type"] == "tool_result" {
                                            results.push((
                                                v["call_id"].as_str().unwrap_or("").to_string(),
                                                v["content"].as_str().unwrap_or("").to_string(),
                                            ));
                                        }
                                    }
                                }
                                Ok(Some(Ok(_))) => {}
                                // Timeout: keep waiting — the slow result
                                // lands seconds after the quick one.
                                Err(_) => {}
                                _ => break,
                            }
                        }
                        let _ = done.send(SessionObs {
                            pong_while_tool_running: pong_seen,
                            results,
                        });
                        let _ = sink.close().await;
                    })
                }
            }),
        );
    axum::serve(listener, app).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reader_stays_live_during_tool_execution_and_ignores_unknown_frames() {
    guild_app_server::machine_link::ensure_crypto_provider();
    let connects = Arc::new(AtomicU32::new(0));
    let listener = standalone_listener().await;
    let port = listener.local_addr().unwrap().port();

    let workdir = std::env::temp_dir().join(format!("guild-link-dispatch-{}", std::process::id()));
    std::fs::create_dir_all(&workdir).unwrap();
    std::fs::write(workdir.join("a.txt"), "hello from a.txt").unwrap();

    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(dispatch_server(
        listener,
        connects.clone(),
        workdir.to_string_lossy().into_owned(),
        done_tx,
    ));

    let mut session = Session::default();
    session.auth = AuthState::from_parts(
        Some(CloudClient {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "tok".into(),
        }),
        None,
        Some("machine-dispatch".into()),
        None,
    );
    let shared = Shared::new(session);
    let link_shared = shared.clone();
    let rx = shared
        .links
        .subscribe_or_create(&format!("http://127.0.0.1:{port}"));
    tokio::spawn(run(link_shared, rx));
    shared.publish_machine_link();

    let obs = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            match done_rx.recv().await {
                Some(o) if o.results.len() >= 2 => break o,
                Some(_) => continue,
                None => panic!("server task ended before the session completed"),
            }
        }
    })
    .await
    .expect("session must complete: unknown frames must not kill the link");
    shared.shutdown.send(true).ok();

    // Reader not blocked: the pong answered while the slow tool was running.
    assert!(
        obs.pong_while_tool_running,
        "the reader must keep ponging while a tool executes"
    );
    let ids: Vec<&str> = obs.results.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["quick", "slow"],
        "the fast dispatch completes first; the slow one is not lost"
    );
    assert!(
        obs.results[1].1.contains("exit code: 0"),
        "the slow tool's result must arrive intact after the pings: {:?}",
        obs.results[1]
    );
    // Exactly one session: the unknown frames caused no reconnect flap.
    assert_eq!(connects.load(Ordering::SeqCst), 1);
    std::fs::remove_dir_all(&workdir).ok();
}
