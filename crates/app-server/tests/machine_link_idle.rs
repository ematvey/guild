//! Regression: the machine link must notice a half-open connection and
//! reconnect. The server pings every ~15 s, but nothing reaches the client
//! if the route dies silently (suspend, NAT expiry, Wi-Fi blip) — the old
//! link had no liveness check of its own, so the session sat "connected"
//! forever while the server had already freed the executor slot: the
//! machine stayed offline until the daemon restarted.
//!
//! Own test binary (not machine_link_reconnect.rs) so the env-tuned
//! heartbeat knobs don't race the other file's tests: env is per-process.

use futures::{SinkExt, StreamExt};
use guild_app_server::auth_state::AuthState;
use guild_app_server::cloud::CloudClient;
use guild_app_server::jsonrpc_loop::{Session, Shared};
use guild_app_server::machine_link::run;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

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

/// HTTP + WS server: mints tickets, accepts the upgrade, says hello, then
/// goes silent — no pings, no close, socket held open. A healthy route
/// would keep receiving server pings; this one simulates a dead one.
async fn silent_server(listener: tokio::net::TcpListener, connects: Arc<AtomicU32>) {
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
                        let (mut sink, stream) = socket.split();
                        let _ = sink
                            .send(axum::extract::ws::Message::text(
                                serde_json::json!({"type": "hello"}).to_string(),
                            ))
                            .await;
                        // Hold the socket open without reading or writing
                        // another byte: tungstenite auto-pongs are only
                        // flushed by a read/write, so NOT reading is what
                        // makes this route genuinely silent (a dead route
                        // delivers nothing, loopback always could — the
                        // point is to starve the client's idle watchdog of
                        // inbound frames).
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        drop((sink, stream));
                    })
                }
            }),
        );
    axum::serve(listener, app).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn link_breaks_and_reconnects_when_the_route_goes_silent() {
    std::env::set_var("GUILD_LINK_HEARTBEAT_SECS", "1");
    std::env::set_var("GUILD_LINK_IDLE_SECS", "2");
    guild_app_server::machine_link::ensure_crypto_provider();
    let connects = Arc::new(AtomicU32::new(0));
    let listener = standalone_listener().await;
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(silent_server(listener, connects.clone()));

    let session = Session {
        auth: AuthState::from_parts(
            Some(CloudClient {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "tok".into(),
            }),
            None,
            Some("machine-idle".into()),
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
    shared.publish_machine_link();

    // The first connection lands, then the server goes silent: the idle
    // watchdog must break the link and reconnect — connects >= 2 proves
    // the dead half-open session was detected without any TCP error.
    let deadline = tokio::time::timeout(Duration::from_secs(20), async {
        while connects.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    shared.shutdown.send(true).ok();
    deadline.expect("the link must detect a silent route and reconnect");
}
