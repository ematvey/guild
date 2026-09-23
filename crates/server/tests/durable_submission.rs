#![cfg(feature = "test-support")]

use axum::{body::Body, http::Request};
use guild_server::{state::AppState, test_support::full_state};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tower::ServiceExt;
use uuid::Uuid;

/// Run only against a disposable Restate instance: the test registers its own worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated GUILD_TEST_RESTATE_URL and GUILD_TEST_RESTATE_ADMIN_URL"]
async fn queued_commands_execute_once_in_order_through_real_restate() {
    let ingress = std::env::var("GUILD_TEST_RESTATE_URL").expect("isolated ingress URL");
    let admin = std::env::var("GUILD_TEST_RESTATE_ADMIN_URL").expect("isolated admin URL");
    assert!(
        !admin.ends_with(":9070"),
        "never register a test worker on the deployed admin port"
    );
    let fixture = full_state().await;
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let release_first = Arc::new(Semaphore::new(0));
    let provider = axum::Router::new().route("/v1/chat/completions", axum::routing::post({
        let calls = calls.clone();
        let release = release_first.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let calls = calls.clone();
            let release = release.clone();
            async move {
                let ordinal = { let mut calls = calls.lock().await; calls.push(body); calls.len() };
                if ordinal == 1 { release.acquire().await.unwrap().forget(); }
                if ordinal == 4 {
                    return ([("content-type", "text/event-stream")],
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"fixture-call\",\"type\":\"function\",\"function\":{\"name\":\"unknown_fixture_tool\",\"arguments\":\"{}\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n");
                }
                ([ ("content-type", "text/event-stream") ],
                    "data: {\"choices\":[{\"delta\":{\"content\":\"fixture answer\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
            }
        }
    }));
    let listener = guild_server::test_support::standalone_listener().await;
    let provider_url = format!("http://{}", listener.local_addr().unwrap());
    let provider_task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    fixture
        .store()
        .gateway()
        .upsert_provider_key(
            fixture.org_id,
            "openai",
            &provider_url,
            "fixture-key",
            &fixture.state.config.master_key().unwrap(),
        )
        .await
        .unwrap();

    let worker_socket = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let port = worker_socket.local_addr().unwrap().port();
    drop(worker_socket);
    let mut config = (*fixture.state.config).clone();
    config.restate_url = ingress;
    config.restate_admin_url = admin.clone();
    config.worker_bind = format!("0.0.0.0:{port}");
    let worker_host =
        std::env::var("GUILD_TEST_WORKER_HOST").unwrap_or_else(|_| "host.docker.internal".into());
    config.worker_advertised_url = format!("http://{worker_host}:{port}");
    let advertised = config.worker_advertised_url.clone();
    let state = AppState::from_config(config);
    let worker_state = state.clone();
    let worker_task =
        tokio::spawn(
            async move { guild_server::worker::restate::spawn_worker(worker_state).await },
        );
    let http = reqwest::Client::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(response) = http.get(format!("{admin}/deployments")).send().await {
                if response.status().is_success()
                    && response
                        .text()
                        .await
                        .unwrap_or_default()
                        .contains(&advertised)
                {
                    break;
                }
            }
            assert!(
                !worker_task.is_finished(),
                "worker exited before registration"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("worker registration");
    let app = guild_server::build_router(state);
    let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let payloads: Vec<Value> = ids
        .iter()
        .zip(["first command", "second command", "third command"])
        .map(|(id, text)| {
            json!({
                "chat_id":fixture.chat_id,"model":"gpt-test","user_message_id":id,
                "messages":[{"role":"user","content":text}]
            })
        })
        .collect();
    for (index, payload) in payloads.iter().enumerate() {
        let send = || {
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {}", fixture.token))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap()
        };
        let response = app.clone().oneshot(send()).await.unwrap();
        assert!(
            response.status().is_success(),
            "accept command {index}: {}",
            response.status()
        );
        // Simulate a lost acceptance response: repeat identical identity and body.
        let retry = app.clone().oneshot(send()).await.unwrap();
        assert!(
            retry.status().is_success(),
            "retry {index}: {}",
            retry.status()
        );
        if index == 0 {
            tokio::time::timeout(Duration::from_secs(30), async {
                while calls.lock().await.is_empty() {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("first model call");
        }
    }
    assert_eq!(
        calls.lock().await.len(),
        1,
        "later commands wait behind held first turn"
    );
    release_first.add_permits(1);
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let completed: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM turn_commands WHERE chat_id=$1 AND status='completed'",
            )
            .bind(fixture.chat_id)
            .fetch_one(fixture.store().pool())
            .await
            .unwrap();
            if completed == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("all commands completed");
    let calls = calls.lock().await.clone();
    assert_eq!(
        calls.len(),
        3,
        "HTTP retries must not create extra model requests"
    );
    for (index, body) in calls.iter().enumerate() {
        let users: Vec<&str> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_str())
            .collect();
        assert_eq!(
            users,
            ["first command", "second command", "third command"][..=index]
        );
    }
    let events = fixture
        .store()
        .thread()
        .list_events(fixture.org_id, fixture.chat_id)
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|row| matches!(row.event, protocol::api::ThreadEvent::UserMessage { .. }))
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|row| matches!(
                row.event,
                protocol::api::ThreadEvent::AssistantMessage { .. }
            ))
            .count(),
        3
    );

    // Another API process loses ingress connectivity after committing the command.
    // The healthy worker's outbox must discover it without a client retry.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_addr = closed.local_addr().unwrap();
    drop(closed);
    let mut offline_config = (*fixture.state.config).clone();
    offline_config.restate_url = format!("http://{closed_addr}");
    let offline_app = guild_server::build_router(AppState::from_config(offline_config));
    let fourth = Uuid::new_v4();
    let response = offline_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {}", fixture.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"chat_id":fixture.chat_id,"model":"gpt-test","user_message_id":fourth,
            "messages":[{"role":"user","content":"recover from ingress outage"}]})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "durable acceptance survives ingress outage"
    );
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let completed: bool =
                sqlx::query_scalar("SELECT status='completed' FROM turn_commands WHERE id=$1")
                    .bind(fourth)
                    .fetch_one(fixture.store().pool())
                    .await
                    .unwrap();
            if completed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("outbox recovered command after failed ingress send");
    let (requests, cost) = guild_server::test_support::clickhouse_usage_rows(&fixture.state).await;
    assert_eq!(
        requests, 5,
        "tool-call request and final answer each accrue usage"
    );
    assert!((cost - 0.00009).abs() < 1e-10);
    provider_task.abort();
    worker_task.abort();
}
