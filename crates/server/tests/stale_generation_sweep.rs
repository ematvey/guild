//! The stuck-generation deploy sweep: record format (version-stamped by the
//! worker), kill-only-after-success, and current-version records retained
//! for hard stop during replay without a kill call.

use axum::extract::State;
use guild_server::test_support::{purge_stale_chat_generations, workflow_schema_version};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

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
    // Current-version replay still needs its invocation pointer for hard
    // stop; failed stale kills retain theirs for retry.
    assert_eq!(
        kept,
        vec![
            "chatgen_inv:current-ver".to_string(),
            "chatgen_inv:retry".to_string()
        ],
        "{kept:?}"
    );

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
    assert_eq!(
        kept,
        vec!["chatgen_inv:current-ver".to_string()],
        "{kept:?}"
    );
    assert!(captured
        .lock()
        .unwrap()
        .iter()
        .any(|u| u.contains("/invocations/inv-retryok")));
}

/// The paused-invocation kill sweep: paused ChatRunner generate invocations
/// found through the admin's query endpoint are killed and their chats'
/// generating flags cleared — this is the only net that catches stuck
/// invocations with no `chatgen_inv` record (the shape the forever-spinner
/// bug took: Restate paused the turn, the record was long gone).
#[tokio::test]
async fn paused_invocations_are_killed_and_flags_cleared() {
    use guild_server::test_support::kill_stuck_chat_invocations;

    let db = guild_server::store::Store::connect_test()
        .await
        .expect("postgres");
    let chat_row = guild_server::test_support::insert_org_with_chat(&db.store).await;
    let killed: Arc<Mutex<Vec<String>>> = Default::default();
    let killed_clone = killed.clone();

    // Mock admin: the query returns one paused generate invocation; the
    // kill endpoint answers 200 and records the call.
    let app = axum::Router::new()
        .route(
            "/query",
            axum::routing::post(move || async move {
                axum::Json(serde_json::json!({ "rows": [
                    {
                        "id": "inv-paused-generate",
                        "target": format!("ChatRunner/{chat_row}/generate"),
                    },
                ]}))
            }),
        )
        .fallback(move |method: axum::http::Method, uri: axum::http::Uri| {
            let killed = killed_clone.clone();
            async move {
                if method == axum::http::Method::PATCH {
                    killed.lock().unwrap().push(uri.to_string());
                }
                axum::http::StatusCode::OK
            }
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut config = guild_server::config::Config::test_config();
    config.restate_admin_url = format!("http://{addr}");
    let state = guild_server::state::AppState::with_store(Arc::new(db.store.clone()), config);
    let org_id: uuid::Uuid = sqlx::query_scalar("SELECT org_id FROM chats WHERE id = $1")
        .bind(chat_row)
        .fetch_one(db.store.pool())
        .await
        .unwrap();
    db.store
        .chats()
        .set_generating(org_id, chat_row, true)
        .await
        .unwrap();

    kill_stuck_chat_invocations(&state).await;

    let killed = killed.lock().unwrap().clone();
    assert_eq!(killed.len(), 1, "{killed:?}");
    assert!(killed[0].contains("/invocations/inv-paused-generate/kill"));

    // The killed invocation's chat flag is cleared: the sweep resolved the
    // target's chat id and ran the trusted clear.
    let generating: bool = sqlx::query_scalar("SELECT generating FROM chats WHERE id = $1")
        .bind(chat_row)
        .fetch_one(db.store.pool())
        .await
        .unwrap();
    assert!(!generating);
}

/// A failed hard stop (transient Restate admin outage) keeps the invocation
/// record and the generating flag and reports the failure, instead of
/// deleting the record behind a success report — the next stop retries the
/// kill against the same recorded address and clears the state only once
/// the invocation actually terminates.
#[tokio::test]
async fn failed_stop_preserves_the_invocation_record_until_the_kill_succeeds() {
    use std::collections::HashMap;

    // Mock admin: the FIRST delete of each invocation fails (the transient
    // outage), any retry succeeds.
    let counts: Arc<Mutex<HashMap<String, usize>>> = Default::default();
    let app = axum::Router::new()
        .fallback(
            |method: axum::http::Method,
             uri: axum::http::Uri,
             State(counts): State<Arc<Mutex<HashMap<String, usize>>>>| async move {
                if method == axum::http::Method::DELETE {
                    let mut c = counts.lock().unwrap();
                    let n = c.entry(uri.to_string()).or_insert(0);
                    *n += 1;
                    if *n == 1 {
                        return axum::http::StatusCode::SERVICE_UNAVAILABLE;
                    }
                }
                axum::http::StatusCode::OK
            },
        )
        .with_state(counts.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let db = guild_server::store::Store::connect_test()
        .await
        .expect("postgres");
    let mut config = guild_server::config::Config::test_config();
    config.restate_admin_url = format!("http://{addr}");
    let state = guild_server::state::AppState::with_store(Arc::new(db.store.clone()), config);
    let store = db.store.clone();

    let user = store
        .identity()
        .ensure_bootstrap_admin("stopper@example.org", "hunter226")
        .await
        .unwrap();
    let user_row = store.identity().get_user(user).await.unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user_row.org_id, user, Some("stopchat"), None)
        .await
        .unwrap();
    store
        .chats()
        .set_generating(user_row.org_id, chat.id, true)
        .await
        .unwrap();
    let current = guild_server::test_support::workflow_schema_version();
    store
        .kv()
        .put(
            &format!("chatgen_inv:{}", chat.id),
            &format!("{current}:inv-outage"),
        )
        .await
        .unwrap();

    let app = guild_server::build_router(state);
    let stop = || {
        let app = app.clone();
        let token = token.clone();
        async move {
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(format!("/api/v1/gateway/chat/{}/stop", chat.id))
                        .header("authorization", format!("Bearer {token}"))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        }
    };

    // First stop: the kill fails → 503, the record and generating flag stay.
    let res = stop().await;
    assert_eq!(res.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    let record = store
        .kv()
        .get(&format!("chatgen_inv:{}", chat.id))
        .await
        .unwrap();
    assert!(
        record.is_some(),
        "the invocation record must survive a failed kill"
    );
    let row = store
        .chats()
        .get_chat(user_row.org_id, chat.id, &user_row)
        .await
        .unwrap();
    assert!(
        row.generating,
        "the generating flag must survive a failed kill"
    );

    // Retry: the kill succeeds, and only then is the state cleared.
    let res = stop().await;
    assert_eq!(res.status(), axum::http::StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap()
        )
        .unwrap()["stopped"],
        serde_json::json!(true)
    );
    let record = store
        .kv()
        .get(&format!("chatgen_inv:{}", chat.id))
        .await
        .unwrap();
    assert!(record.is_none(), "a confirmed kill clears the record");
    let row = store
        .chats()
        .get_chat(user_row.org_id, chat.id, &user_row)
        .await
        .unwrap();
    assert!(!row.generating);
}
