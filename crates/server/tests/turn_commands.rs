#![cfg(feature = "test-support")]
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use guild_server::{
    state::AppState,
    test_support::{full_state, note_generation},
};
use protocol::api::{Block, ThreadEvent, UsagePayload};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

fn post(token: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/gateway/chat")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}
fn command(chat: Uuid, id: Uuid, text: &str) -> Value {
    json!({"chat_id":chat,"model":"gpt-test","user_message_id":id,"messages":[{"role":"user","content":text}]})
}

#[tokio::test]
async fn concurrent_retries_commit_one_echo_and_reject_changed_payload() {
    let fs = full_state().await;
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());
    let id = Uuid::now_v7();
    let body = command(fs.chat_id, id, "original");
    let (a, b) = tokio::join!(
        app.clone().oneshot(post(&fs.token, &body)),
        app.clone().oneshot(post(&fs.token, &body))
    );
    assert_eq!(a.unwrap().status(), StatusCode::OK);
    assert_eq!(b.unwrap().status(), StatusCode::OK);
    let changed = command(fs.chat_id, id, "changed");
    assert_eq!(
        app.oneshot(post(&fs.token, &changed))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let store = fs.store();
    assert_eq!(
        store
            .thread()
            .list_events(fs.org_id, fs.chat_id)
            .await
            .unwrap()
            .len(),
        1
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM turn_commands")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert!(store
        .turn_commands()
        .existing(id, Uuid::now_v7(), fs.user_id, fs.chat_id, &body)
        .await
        .is_err());
}

#[tokio::test]
async fn ambiguous_ingress_retries_keep_one_idempotency_key_and_recover_from_outbox() {
    let fs = full_state().await;
    let ingress = wiremock::MockServer::start().await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = calls.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_: &wiremock::Request| {
            if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                // The ingress committed the invocation but its first reply was lost.
                wiremock::ResponseTemplate::new(502)
            } else {
                wiremock::ResponseTemplate::new(202)
                    .set_body_json(json!({"invocationId":"inv-stable"}))
            }
        })
        .mount(&ingress)
        .await;
    let mut config = (*fs.state.config).clone();
    config.restate_url = ingress.uri();
    let state = AppState::from_config(config);
    let app = guild_server::build_router(state.clone());
    let id = Uuid::now_v7();
    let body = command(fs.chat_id, id, "once");
    let response = app.oneshot(post(&fs.token, &body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let ack: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ack["generation_id"], json!(id));
    assert_eq!(ack["queued"], true);
    // A fresh pump can deliver after request/process cancellation, without a client retry.
    guild_server::http::gateway::dispatch_turn_commands(&state, Some(fs.chat_id))
        .await
        .unwrap();
    assert_eq!(state.generations.handle(fs.chat_id).unwrap().id, id);
    let requests = ingress.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].headers.get("idempotency-key"),
        requests[1].headers.get("idempotency-key")
    );
    assert_eq!(requests[0].body, requests[1].body);
    let store = fs.store();
    assert_eq!(
        store
            .thread()
            .list_events(fs.org_id, fs.chat_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .turn_commands()
            .begin(id, fs.chat_id, "inv-stable")
            .await
            .unwrap(),
        Some(true)
    );
    store
        .turn_commands()
        .finish(id, "inv-stable", false)
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .begin(id, fs.chat_id, "inv-after-retention")
            .await
            .unwrap(),
        Some(false)
    );
}

#[tokio::test]
async fn queue_consumption_ignores_interleaved_assistant_and_tool_events() {
    let fs = full_state().await;
    let store = fs.store();
    note_generation(&fs.state, fs.chat_id);
    let app = guild_server::build_router(fs.state.clone());
    let a = Uuid::now_v7();
    let b = Uuid::now_v7();
    let c = Uuid::now_v7();
    for (id, text) in [(a, "A"), (b, "B"), (c, "C")] {
        assert_eq!(
            app.clone()
                .oneshot(post(&fs.token, &command(fs.chat_id, id, text)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        store
            .turn_commands()
            .begin(a, fs.chat_id, "inv-a")
            .await
            .unwrap(),
        Some(true)
    );
    store
        .thread()
        .append_event(
            fs.chat_id,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![Block::Text {
                    text: "answer A".into(),
                }],
                usage: UsagePayload::default(),
                model: "gpt-test".into(),
                interrupted: Some(true),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            fs.chat_id,
            &ThreadEvent::ToolResult {
                turn: 1,
                step: 0,
                call_id: "tool".into(),
                name: "probe".into(),
                content: "result A".into(),
                is_error: false,
                meta: None,
                images: vec![],
                kind: None,
                artifact_id: None,
            },
        )
        .await
        .unwrap();
    assert!(store
        .turn_commands()
        .pending_heads(Some(fs.chat_id))
        .await
        .unwrap()
        .is_empty());
    store
        .turn_commands()
        .finish(a, "inv-a", false)
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .pending_heads(Some(fs.chat_id))
            .await
            .unwrap()[0]
            .id,
        b
    );
    assert_eq!(
        store
            .turn_commands()
            .begin(b, fs.chat_id, "inv-b")
            .await
            .unwrap(),
        Some(true)
    );
    let events = store
        .thread()
        .model_events(fs.org_id, fs.chat_id, None)
        .await
        .unwrap();
    let labels: Vec<String> = events
        .iter()
        .filter_map(|row| match &row.event {
            ThreadEvent::UserMessage { content, .. } => Some(content.clone()),
            ThreadEvent::AssistantMessage { .. } => Some("answer A".into()),
            ThreadEvent::ToolResult { .. } => Some("result A".into()),
            _ => None,
        })
        .collect();
    assert_eq!(labels, ["A", "answer A", "result A", "B"]);
    store
        .turn_commands()
        .finish(b, "inv-b", false)
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .pending_heads(Some(fs.chat_id))
            .await
            .unwrap()[0]
            .id,
        c
    );
    store
        .turn_commands()
        .cancel_waiting_head(fs.chat_id)
        .await
        .unwrap();
    assert!(store
        .turn_commands()
        .pending_heads(Some(fs.chat_id))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn archiving_a_chat_settles_its_waiting_commands_and_the_dispatcher_never_claims_them() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    // Two queued commands; the ingress is unreachable in the fixture, so
    // delivery stays pending exactly as between a send and its dispatch.
    for text in ["first", "second"] {
        let id = Uuid::now_v7();
        let res = app
            .clone()
            .oneshot(post(&fs.token, &command(fs.chat_id, id, text)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
    let store = fs.store();
    let pending: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM turn_commands WHERE chat_id = $1 AND status = 'pending'",
    )
    .bind(fs.chat_id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(pending.0, 2);
    assert_eq!(
        store
            .turn_commands()
            .pending_heads(Some(fs.chat_id))
            .await
            .unwrap()
            .len(),
        1
    );

    // Archiving settles every waiting command in the archive transaction.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/chats/{}", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"archived": true}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let cancelled: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM turn_commands WHERE chat_id = $1 AND status = 'cancelled'",
    )
    .bind(fs.chat_id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(cancelled.0, 2);
    // The dispatcher cannot claim against an archived chat.
    assert!(store
        .turn_commands()
        .pending_heads(Some(fs.chat_id))
        .await
        .unwrap()
        .is_empty());

    // A send to an archived chat is rejected (409) and creates no command:
    // acceptance holds the chats row lock, so it cannot race the settle.
    let res = app
        .clone()
        .oneshot(post(
            &fs.token,
            &command(fs.chat_id, Uuid::now_v7(), "after archive"),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let total: (i64,) = sqlx::query_as("SELECT count(*) FROM turn_commands WHERE chat_id = $1")
        .bind(fs.chat_id)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(total.0, 2);

    // Unarchive never resurrects settled commands, and sends work again.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/chats/{}", fs.chat_id))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"archived": false}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .clone()
        .oneshot(post(
            &fs.token,
            &command(fs.chat_id, Uuid::now_v7(), "after unarchive"),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let waiting: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM turn_commands WHERE chat_id = $1 AND finished_at IS NULL",
    )
    .bind(fs.chat_id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(waiting.0, 1);
    assert_eq!(
        store
            .turn_commands()
            .pending_heads(Some(fs.chat_id))
            .await
            .unwrap()
            .len(),
        1
    );
}

/// The archive-vs-accept race: the archive must take the chats row lock in
/// its own statement BEFORE the settle runs. A send that holds the lock (the
/// same lock accept holds) and commits its command while the archive waits
/// must have that command settled — a shared statement snapshot would miss it
/// and strand it undispatched in the archived chat.
#[tokio::test]
async fn archive_sees_a_command_committed_while_it_waited_on_the_row_lock() {
    let fs = full_state().await;
    let store = fs.store();
    // The "send" side: a second connection holds the chats row lock and
    // inserts its pending command mid-transaction, exactly as acceptance does.
    let send_pool = sqlx::PgPool::connect(&fs.db.url).await.unwrap();
    let mut send_tx = send_pool.begin().await.unwrap();
    let _: (Uuid,) =
        sqlx::query_as("SELECT id FROM chats WHERE id = $1 AND org_id = $2 FOR UPDATE")
            .bind(fs.chat_id)
            .bind(fs.org_id)
            .fetch_one(&mut *send_tx)
            .await
            .unwrap();
    let command_id = Uuid::now_v7();
    let check_store = store.clone();
    sqlx::query(
        "INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(command_id)
    .bind(fs.org_id)
    .bind(fs.user_id)
    .bind(fs.chat_id)
    .bind(serde_json::json!({}))
    .bind(serde_json::json!({}))
    .execute(&mut *send_tx)
    .await
    .unwrap();

    // The archive starts while the lock is held: its first statement blocks.
    let user = store.identity().get_user(fs.user_id).await.unwrap();
    let archiver = tokio::spawn(async move {
        store
            .chats()
            .update_chat(fs.org_id, fs.chat_id, &user, None, Some(true))
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        !archiver.is_finished(),
        "archive must block on the chats row lock"
    );

    // The send commits; the archive proceeds and must settle the fresh
    // command (a snapshot taken at the settle statement sees it).
    send_tx.commit().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), archiver)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let status: (String,) = sqlx::query_as("SELECT status FROM turn_commands WHERE id = $1")
        .bind(command_id)
        .fetch_one(check_store.pool())
        .await
        .unwrap();
    assert_eq!(status.0, "cancelled");
}

/// The archive-vs-begin race: a command the archive settles after its
/// delivery already succeeded must not strand the dispatcher's reservation
/// (the chat wedges after unarchive), and a running command caught by the
/// archive must resume for its own invocation instead of being abandoned
/// unfinished.
#[tokio::test]
async fn archive_race_releases_the_reservation_and_resumes_running_commands() {
    let fs = full_state().await;
    let store = fs.store();
    let user = store.identity().get_user(fs.user_id).await.unwrap();

    // Scenario b: the command committed `running`, the chat was archived
    // mid-turn; the same invocation's replay resumes it instead of
    // abandoning the row unfinished.
    let second = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(second)
    .bind(fs.org_id)
    .bind(fs.user_id)
    .bind(fs.chat_id)
    .bind(serde_json::json!({}))
    .bind(serde_json::json!({}))
    .execute(store.pool())
    .await
    .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .begin(second, fs.chat_id, "inv-running")
            .await
            .unwrap(),
        Some(true)
    );
    store
        .chats()
        .update_chat(fs.org_id, fs.chat_id, &user, None, Some(true))
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .begin(second, fs.chat_id, "inv-running")
            .await
            .unwrap(),
        Some(true)
    );
    store
        .turn_commands()
        .finish(second, "inv-running", false)
        .await
        .unwrap();
    let row: (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT status, finished_at FROM turn_commands WHERE id = $1")
            .bind(second)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(row.0, "completed");
    assert!(row.1.is_some());

    // Scenario a: the dispatcher reserved under the command id, the archive
    // committed and settled the command, then the delivery succeeded.
    let chat2 = Uuid::now_v7();
    sqlx::query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, 'race')")
        .bind(chat2)
        .bind(fs.org_id)
        .bind(fs.user_id)
        .execute(store.pool())
        .await
        .unwrap();
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(fs.org_id)
    .bind(fs.user_id)
    .bind(chat2)
    .bind(serde_json::json!({}))
    .bind(serde_json::json!({}))
    .execute(store.pool())
    .await
    .unwrap();
    let _reservation = fs
        .state
        .generations
        .try_begin_with_id(chat2, id)
        .unwrap();
    store
        .chats()
        .update_chat(fs.org_id, chat2, &user, None, Some(true))
        .await
        .unwrap();
    assert_eq!(
        store
            .turn_commands()
            .begin(id, chat2, "inv-raced")
            .await
            .unwrap(),
        Some(false)
    );
    guild_server::worker::restate::release_claim_reservation(&fs.state, chat2, id);
    assert!(fs.state.generations.handle(chat2).is_none());
}
