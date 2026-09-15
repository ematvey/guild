//! The stuck-generation deploy sweep: record format (version-stamped by the
//! gateway), kill-only-after-success, and current-version records dropped
//! without a kill call.

use axum::extract::State;
use guild_server::test_support::{purge_stale_chat_generations, workflow_schema_version};
use std::sync::{Arc, Mutex};

type Captured = Arc<Mutex<Vec<String>>>;

/// Mock Restate admin API: records DELETE request uris; answers 500 for
/// invocation ids starting with `killfail`, 200 otherwise.
async fn spawn_mock_admin() -> (String, Captured) {
    let captured: Captured = Default::default();
    let app =
        axum::Router::new()
            .fallback(
                |method: axum::http::Method,
                 uri: axum::http::Uri,
                 State(captured): State<Captured>| async move {
                    if method == axum::http::Method::DELETE {
                        captured.lock().unwrap().push(uri.to_string());
                    }
                    let stale = uri.path().contains("killfail");
                    if stale {
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR
                    } else {
                        axum::http::StatusCode::OK
                    }
                },
            )
            .with_state(captured.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), captured)
}

#[tokio::test]
async fn sweep_kills_stale_records_only_after_a_successful_kill() {
    let db = guild_server::store::Store::connect_test()
        .await
        .expect("postgres");
    let (admin_url, captured) = spawn_mock_admin().await;
    let mut config = guild_server::config::Config::test_config();
    config.restate_admin_url = admin_url;
    let state = guild_server::state::AppState::with_store(Arc::new(db.store.clone()), config);
    let store = db.store.clone();

    let current = workflow_schema_version();
    store
        .kv()
        .put("chatgen_inv:current-ver", &format!("{current}:inv-ok"))
        .await
        .unwrap();
    store
        .kv()
        .put("chatgen_inv:stale-ver", "oldver:inv-killme")
        .await
        .unwrap();
    // Bare value: written before version stamping — treated as stale.
    store
        .kv()
        .put("chatgen_inv:bare", "inv-bare")
        .await
        .unwrap();
    // The mock admin refuses this kill: the record must survive for retry.
    store
        .kv()
        .put("chatgen_inv:retry", "oldver:killfail-1")
        .await
        .unwrap();

    purge_stale_chat_generations(&state).await;

    let kept: Vec<String> = store
        .kv()
        .list_prefix("chatgen_inv:")
        .await
        .unwrap()
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    // Current-version record dropped (no kill needed); killed records
    // dropped; the failed-kill record kept.
    assert_eq!(kept, vec!["chatgen_inv:retry".to_string()], "{kept:?}");

    let killed = captured.lock().unwrap().clone();
    assert_eq!(killed.len(), 3, "{killed:?}");
    assert!(killed.iter().any(|u| u.contains("/invocations/inv-killme")));
    assert!(killed.iter().any(|u| u.contains("/invocations/inv-bare")));
    assert!(killed.iter().any(|u| u.contains("/invocations/killfail-1")));
    // The current-version invocation is never killed.
    assert!(!killed.iter().any(|u| u.contains("/invocations/inv-ok")));

    // A second sweep retries the kept record; with the kill now
    // succeeding, the record goes.
    store
        .kv()
        .put("chatgen_inv:retry", "oldver:inv-retryok")
        .await
        .unwrap();
    purge_stale_chat_generations(&state).await;
    let kept: Vec<String> = store
        .kv()
        .list_prefix("chatgen_inv:")
        .await
        .unwrap()
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    assert!(kept.is_empty(), "{kept:?}");
    assert!(captured
        .lock()
        .unwrap()
        .iter()
        .any(|u| u.contains("/invocations/inv-retryok")));
}
