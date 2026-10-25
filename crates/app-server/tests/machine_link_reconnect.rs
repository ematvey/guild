//! Regression: the machine link must reconnect after a server-side close.
//! The first link version deadlocked in its shutdown tail (Close sent, but
//! the outbound sender was never dropped, so `writer.await` blocked on the
//! channel forever) — every loop break (config change, server close)
//! permanently killed the executor link while the daemon looked healthy.

use futures::{SinkExt, StreamExt};
use guild_app_server::auth_state::AuthState;
use guild_app_server::cloud::CloudClient;
use guild_app_server::jsonrpc_loop::{Session, Shared};
use guild_app_server::machine_link::run;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Collision-proof loopback listener.
async fn standalone_listener() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // tokio's bind listens immediately, so OUR port is already in
        // /proc — exclude it before the collision check.
        let mut ports = std::collections::HashSet::<u16>::new();
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines().skip(1) {
                    if let Some(p) = line.split_whitespace().nth(1) {
                        if let Ok(p) = u64::from_str_radix(p.rsplit(':').next().unwrap_or("0"), 16)
                        {
                            if p as u16 != port {
                                ports.insert(p as u16);
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

/// HTTP + WS server: mints tickets, accepts the machine upgrade, says
/// hello, then closes — the link must come back for a second connection.
async fn flaky_server(listener: tokio::net::TcpListener, connects: Arc<AtomicU32>) {
    let app = axum::Router::new()
        .route(
            "/api/v1/ws/ticket",
            axum::routing::post(|| async { axum::Json(serde_json::json!({"ticket": "t"})) }),
        )
        .route(
            "/api/v1/ws",
            axum::routing::get(move |ws: axum::extract::WebSocketUpgrade| {
                let connects = connects.clone();
                async move {
                    connects.fetch_add(1, Ordering::SeqCst);
                    ws.on_upgrade(|socket| async move {
                        let (mut sink, mut stream) = socket.split();
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({"type": "hello"}).to_string(),
                            ))
                            .await;
                        // Drain until the client goes away or we decide it
                        // has seen enough.
                        let _ = tokio::time::timeout(Duration::from_millis(200), async {
                            while let Some(Ok(_)) = stream.next().await {}
                        })
                        .await;
                        let _ = sink.close().await;
                    })
                }
            }),
        );
    axum::serve(listener, app).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn link_reconnects_after_a_server_side_close() {
    eprintln!("[test] begin");
    guild_app_server::machine_link::ensure_crypto_provider();
    let connects = Arc::new(AtomicU32::new(0));
    eprintln!("[test] listener…");
    let listener = standalone_listener().await;
    eprintln!("[test] listener bound");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(flaky_server(listener, connects.clone()));

    let session = Session {
        auth: AuthState::from_parts(
            Some(CloudClient {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "tok".into(),
            }),
            None,
            Some("machine-reconnect".into()),
            None,
        ),
        ..Default::default()
    };
    let shared = Shared::new(session);

    let link_shared = shared.clone();
    let rx = shared
        .links
        .subscribe_or_create(&format!("http://127.0.0.1:{port}"));
    tokio::spawn(run(link_shared, rx));
    eprintln!("[test] publishing link config");
    shared.publish_machine_link();
    eprintln!("[test] published");

    eprintln!("[test] waiting for the first connection");
    let first = tokio::time::timeout(Duration::from_secs(10), async {
        while connects.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    first.expect("the first machine connection must land");

    // Re-publish the SAME config (what machine.identify does when the
    // webview re-identifies after a daemon restart): the healthy session
    // must drop and reconnect — this is where the shutdown tail deadlocked
    // (Close sent, outbound sender never dropped, writer.await blocked).
    eprintln!("[test] re-publishing; waiting for the reconnect");
    shared.publish_machine_link();
    let deadline = tokio::time::timeout(Duration::from_secs(15), async {
        while connects.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    eprintln!("[test] deadline resolved: {:?}", deadline.is_ok());
    shared.shutdown.send(true).ok();
    deadline.expect("the link must reconnect after a server-side close");
}
