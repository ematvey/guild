#![cfg(feature = "test-support")]
use guild_server::{
    state::AppState,
    store::routines::{RoutineRow, UpdatePatch},
    test_support::{full_state, FullState},
};
use serde_json::{json, Value};
use uuid::Uuid;

async fn create(fs: &FullState, slug: &str) -> RoutineRow {
    fs.store()
        .routines()
        .create(
            fs.org_id,
            fs.user_id,
            slug,
            "routine",
            "interval",
            json!({"interval_secs":5}),
            "prompt",
            "gpt-test",
            json!([]),
            "token",
            true,
        )
        .await
        .unwrap()
}
fn generation(row: &RoutineRow) -> Uuid {
    row.trigger_config["schedule_generation"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}
fn patch(config: Option<Value>, enabled: Option<bool>) -> UpdatePatch {
    UpdatePatch {
        prompt: None,
        model: None,
        enabled,
        trigger_config: config,
    }
}

#[tokio::test]
async fn concurrent_starters_claim_once_and_superseded_or_disabled_schedules_retire() {
    let fs = full_state().await;
    let row = create(&fs, "concurrent").await;
    let store = fs.store();
    let gen = generation(&row);
    assert_eq!(
        store
            .routines()
            .pending_schedules(Some(row.id))
            .await
            .unwrap()
            .len(),
        1
    );
    let routines = store.routines();
    let (a, b) = tokio::join!(
        routines.claim_schedule(row.id, gen, "a"),
        routines.claim_schedule(row.id, gen, "b")
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a, b);
    let winner = if a { "a" } else { "b" };
    assert!(store
        .routines()
        .claim_schedule(row.id, gen, winner)
        .await
        .unwrap());
    assert!(!store
        .routines()
        .claim_schedule(row.id, gen, "beyond-retention")
        .await
        .unwrap());
    let (updated, changed) = store
        .routines()
        .update(
            fs.org_id,
            row.id,
            &patch(Some(json!({"interval_secs":10})), None),
            true,
        )
        .await
        .unwrap();
    assert!(changed);
    assert!(!store
        .routines()
        .claim_schedule(row.id, gen, winner)
        .await
        .unwrap());
    store
        .routines()
        .schedule_dispatched(gen, "late-ack")
        .await
        .unwrap();
    let status: String =
        sqlx::query_scalar("SELECT status FROM routine_schedule_starts WHERE generation=$1")
            .bind(gen)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(status, "retired");
    let new_gen = generation(&updated);
    assert_eq!(
        store
            .routines()
            .pending_schedules(Some(row.id))
            .await
            .unwrap()[0]
            .generation,
        new_gen
    );
    store
        .routines()
        .update(fs.org_id, row.id, &patch(None, Some(false)), true)
        .await
        .unwrap();
    assert!(!store
        .routines()
        .claim_schedule(row.id, new_gen, "disabled-start")
        .await
        .unwrap());
    assert!(store
        .routines()
        .pending_schedules(Some(row.id))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn failed_or_ambiguous_delivery_retries_identical_starter() {
    let fs = full_state().await;
    let row = create(&fs, "outage").await;
    let ingress = wiremock::MockServer::start().await;
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = count.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(move |_: &wiremock::Request| {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                wiremock::ResponseTemplate::new(502)
            } else {
                wiremock::ResponseTemplate::new(202)
                    .set_body_json(json!({"invocationId":"accepted-starter"}))
            }
        })
        .mount(&ingress)
        .await;
    let mut config = (*fs.state.config).clone();
    config.restate_url = ingress.uri();
    let state = AppState::from_config(config);
    guild_server::http::internal::dispatch_routine_schedules(&state, Some(row.id))
        .await
        .unwrap();
    assert_eq!(
        fs.store()
            .routines()
            .pending_schedules(Some(row.id))
            .await
            .unwrap()
            .len(),
        1
    );
    guild_server::http::internal::dispatch_routine_schedules(&state, Some(row.id))
        .await
        .unwrap();
    assert!(fs
        .store()
        .routines()
        .pending_schedules(Some(row.id))
        .await
        .unwrap()
        .is_empty());
    let requests = ingress.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].headers.get("idempotency-key"),
        requests[1].headers.get("idempotency-key")
    );
    assert_eq!(requests[0].body, requests[1].body);
    assert!(fs
        .store()
        .routines()
        .claim_schedule(row.id, generation(&row), "accepted-starter")
        .await
        .unwrap());
    fs.store()
        .routines()
        .schedule_dispatched(generation(&row), "late-other-invocation")
        .await
        .unwrap();
    assert!(fs
        .store()
        .routines()
        .claim_schedule(row.id, generation(&row), "accepted-starter")
        .await
        .unwrap());
    assert!(!fs
        .store()
        .routines()
        .claim_schedule(row.id, generation(&row), "late-other-invocation")
        .await
        .unwrap());
}

#[tokio::test]
async fn migration_replaces_existing_enabled_chains_atomically() {
    let fs = full_state().await;
    let row = create(&fs, "existing").await;
    let store = fs.store();
    let old = generation(&row);
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("DROP TABLE routine_schedule_starts")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0056_routine_schedule_starts.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let current = store.routines().get_for_internal(row.id).await.unwrap();
    assert_ne!(generation(&current), old);
    assert_eq!(
        store
            .routines()
            .pending_schedules(Some(row.id))
            .await
            .unwrap()[0]
            .generation,
        generation(&current)
    );
    assert!(!store
        .routines()
        .claim_schedule(row.id, old, "legacy")
        .await
        .unwrap());
    assert!(guild_server::worker::executor::schedule_interval(
        &current.trigger_config,
        &json!({"generation":old})
    )
    .is_none());
    assert!(
        guild_server::worker::executor::schedule_interval(&current.trigger_config, &json!(5))
            .is_none()
    );
}

/// Must run against a disposable runtime with global inactivity timeout zero.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated always-replay Restate runtime"]
async fn routine_outbox_recovers_and_starts_one_chain_under_forced_replay() {
    use std::time::Duration;
    let ingress = std::env::var("GUILD_TEST_RESTATE_URL").expect("isolated Restate ingress");
    let admin = std::env::var("GUILD_TEST_RESTATE_ADMIN_URL").expect("isolated Restate admin");
    assert!(
        !admin.ends_with(":9070"),
        "never register against deployed Restate"
    );
    let fs = full_state().await;
    let provider = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST")).respond_with(
        wiremock::ResponseTemplate::new(200).insert_header("content-type","text/event-stream").set_body_string(
            "data: {\"choices\":[{\"delta\":{\"content\":\"scheduled answer\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n"
        )).mount(&provider).await;
    fs.store()
        .gateway()
        .upsert_provider_key(
            fs.org_id,
            "openai",
            &provider.uri(),
            "fixture-key",
            &fs.state.config.master_key().unwrap(),
        )
        .await
        .unwrap();
    let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", api_listener.local_addr().unwrap());
    let worker_listener = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let port = worker_listener.local_addr().unwrap().port();
    drop(worker_listener);
    let unavailable = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let unavailable_url = format!("http://{}", unavailable.local_addr().unwrap());
    drop(unavailable);
    // The first recovered ingress delivery is accepted by Restate but its
    // acknowledgement is lost, exercising the real ambiguous-acceptance path.
    let forwarded = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = forwarded.clone();
    let upstream = ingress.clone();
    let proxy = axum::Router::new().fallback(
        move |uri: axum::http::Uri, headers: axum::http::HeaderMap, body: axum::body::Bytes| {
            let upstream = upstream.clone();
            let count = count.clone();
            async move {
                let Some(key) = headers.get("idempotency-key") else {
                    return (axum::http::StatusCode::NOT_FOUND, axum::body::Bytes::new());
                };
                let response = reqwest::Client::new()
                    .post(format!("{upstream}{uri}"))
                    .header("Idempotency-Key", key)
                    .header("Content-Type", "application/json")
                    .body(body)
                    .send()
                    .await
                    .unwrap();
                let status = response.status();
                let bytes = response.bytes().await.unwrap();
                if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    (
                        axum::http::StatusCode::BAD_GATEWAY,
                        axum::body::Bytes::new(),
                    )
                } else {
                    (status, bytes)
                }
            }
        },
    );
    let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy_listener.local_addr().unwrap());
    let proxy_task = tokio::spawn(async move { axum::serve(proxy_listener, proxy).await.unwrap() });
    let mut config = (*fs.state.config).clone();
    config.api_url = api_url.clone();
    config.internal_token = Some("routine-fixture-internal".into());
    config.restate_url = proxy_url;
    config.restate_admin_url = admin.clone();
    config.worker_bind = format!("0.0.0.0:{port}");
    let worker_host =
        std::env::var("GUILD_TEST_WORKER_HOST").unwrap_or_else(|_| "host.docker.internal".into());
    config.worker_advertised_url = format!("http://{worker_host}:{port}");
    let advertised = config.worker_advertised_url.clone();
    let state = AppState::from_config(config.clone());
    config.restate_url = unavailable_url;
    let api_state = AppState::from_config(config);
    let router = guild_server::build_router(api_state);
    let api_task = tokio::spawn(async move {
        axum::serve(
            api_listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let http = reqwest::Client::new();
    let response=http.post(format!("{api_url}/api/v1/routines")).bearer_auth(&fs.token)
        .json(&json!({"slug":"replay-outbox","name":"Replay outbox","trigger_kind":"interval","trigger_config":{"interval_secs":5},"prompt":"Answer briefly","model":"gpt-test","allowed_tools":[],"enabled":true}))
        .send().await.unwrap();
    assert!(
        response.status().is_success(),
        "creation remains accepted during ingress failure"
    );
    let row: Value = response.json().await.unwrap();
    let id: Uuid = row["id"].as_str().unwrap().parse().unwrap();
    let gen: Uuid = row["trigger_config"]["schedule_generation"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        fs.store()
            .routines()
            .pending_schedules(Some(id))
            .await
            .unwrap()
            .len(),
        1
    );
    let worker_state = state.clone();
    let worker_task =
        tokio::spawn(
            async move { guild_server::worker::restate::spawn_worker(worker_state).await },
        );
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(response) = http.get(format!("{admin}/deployments")).send().await {
                if response
                    .text()
                    .await
                    .unwrap_or_default()
                    .contains(&advertised)
                {
                    break;
                }
            }
            assert!(!worker_task.is_finished());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("worker registration");
    let service: Value = http
        .get(format!("{admin}/services/RoutineRunner"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // The runtime fixture config supplies zero globally; there must be no
    // service override reintroducing a normal inactivity window.
    assert_eq!(
        service["inactivity_timeout"], "0s",
        "test requires forced replay"
    );
    let store = fs.store();
    async fn wait_runs(store: &guild_server::store::Store, id: Uuid, expected: i64) {
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM routine_runs WHERE routine_id=$1 AND status='succeeded'",
                )
                .bind(id)
                .fetch_one(store.pool())
                .await
                .unwrap();
                if count >= expected {
                    assert_eq!(count, expected, "exactly one chain");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("scheduled run completed");
    }
    wait_runs(&store, id, 1).await;
    // Bypass ingress dedup to simulate delivery after its retention window.
    for _ in 0..2 {
        assert!(http
            .post(format!("{ingress}/RoutineRunner/{id}/start_schedule/send"))
            .json(&json!({"generation":gen}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
    }
    wait_runs(&store, id, 2).await;
    let (replacement, _) = store
        .routines()
        .update(
            fs.org_id,
            id,
            &patch(Some(json!({"interval_secs":60})), None),
            true,
        )
        .await
        .unwrap();
    let replacement_gen = generation(&replacement);
    guild_server::http::internal::dispatch_routine_schedules(&state, Some(id))
        .await
        .unwrap();
    wait_runs(&store, id, 3).await;
    store
        .routines()
        .update(fs.org_id, id, &patch(None, Some(false)), true)
        .await
        .unwrap();
    for schedule in [
        json!({"generation":gen}),
        json!({"generation":replacement_gen}),
        json!(5),
    ] {
        assert!(http
            .post(format!("{ingress}/RoutineRunner/{id}/tick/send"))
            .json(&schedule)
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
    }
    tokio::time::sleep(Duration::from_secs(6)).await;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM routine_runs WHERE routine_id=$1")
        .bind(id)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(
        total, 3,
        "duplicate starters and retired ticks never create extra runs"
    );
    let requests = provider.received_requests().await.unwrap();
    let paths: Vec<_> = requests
        .iter()
        .map(|request| format!("{} {}", request.method, request.url.path()))
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(
                |request| request.method == "POST" && request.url.path() == "/v1/chat/completions"
            )
            .count(),
        3,
        "journal replay does not repeat provider calls: {paths:?}"
    );
    assert!(store
        .routines()
        .pending_schedules(Some(id))
        .await
        .unwrap()
        .is_empty());
    store.routines().delete(fs.org_id, id).await.unwrap();
    let deleted = http
        .post(format!("{ingress}/RoutineRunner/{id}/tick"))
        .timeout(Duration::from_secs(5))
        .json(&json!({"generation":replacement_gen}))
        .send()
        .await
        .expect("deleted timer terminates instead of retrying");
    assert!(!deleted.status().is_success());
    assert!(deleted.text().await.unwrap().contains("routine deleted"));
    assert!(forwarded.load(std::sync::atomic::Ordering::SeqCst) >= 2);
    worker_task.abort();
    api_task.abort();
    proxy_task.abort();
}

#[tokio::test]
async fn missing_config_is_distinct_from_transient_failure() {
    use guild_server::worker::executor::{RoutineExecutor, RoutineMissing};
    let server = wiremock::MockServer::start().await;
    let id = Uuid::now_v7();
    let exec = RoutineExecutor {
        api_base: server.uri(),
        internal_token: "fixture".into(),
        allow_http_tool: false,
        http_tool_allow_hosts: vec![],
    };
    let missing = exec.load_config(id).await.unwrap_err();
    assert!(missing.is::<RoutineMissing>());
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let transient = exec.load_config(id).await.unwrap_err();
    assert!(!transient.is::<RoutineMissing>());
}
