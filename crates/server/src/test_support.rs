//! Test helpers for guild-server and downstream crates. Compiled only with
//! the `test-support` feature.

use crate::config::Config;
use crate::state::AppState;
use crate::store::{Store, TestDb};
use uuid::Uuid;

/// Bind a loopback listener on a port that is not referenced anywhere in
/// /proc/net/tcp{,6}. Docker's userland proxy wildcard-binds published
/// container ports with SO_REUSEADDR, which `bind("127.0.0.1:0")` (also
/// SO_REUSEADDR) happily collides with — the kernel then delivers the
/// container's traffic to whoever holds the specific bind. /proc/net/* sees
/// every bound port regardless of address family and reuse flags, so
/// requiring an unreferenced port makes test servers collision-proof
/// against concurrently running testcontainers and the deployed compose
/// stack.
pub async fn standalone_listener() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        if !proc_net_ports().contains(&port) {
            return listener;
        }
        // port referenced somewhere (docker-proxy, another test) — retry
    }
}

fn proc_net_ports() -> std::collections::HashSet<u16> {
    let mut ports = std::collections::HashSet::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines().skip(1) {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() > 1 {
                    if let Some(port) = fields[1].rsplit(':').next().and_then(|p| p.parse().ok()) {
                        ports.insert(port);
                    }
                }
            }
        }
    }
    ports
}

pub fn test_state() -> AppState {
    AppState::from_config(Config::test_config())
}

/// State backed by an isolated database on the shared host Postgres.
pub struct TestState {
    pub state: AppState,
    pub db: TestDb,
}

impl TestState {
    pub fn store(&self) -> Store {
        self.db.store.clone()
    }
}

pub async fn test_state_with_db() -> TestState {
    let db = Store::connect_test().await.expect("postgres testcontainer");
    let state = AppState::with_store(std::sync::Arc::new(db.store.clone()), Config::test_config());
    TestState { state, db }
}

/// Local mock Restate ingress that records one-way sends as
/// `(path, body)` pairs and answers 200 with an invocation id.
pub struct MockIngress {
    pub url: String,
    pub requests: std::sync::Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
}

/// State backed by an isolated database, with `restate_url` pointed at a
/// local mock ingress so one-way invokes (`complete_tool`,
/// `complete_approval`, …) succeed and can be asserted on.
pub async fn test_state_with_mock_ingress() -> (TestState, MockIngress) {
    let db = Store::connect_test().await.expect("postgres testcontainer");
    let requests: std::sync::Arc<
        std::sync::Mutex<Vec<(String, serde_json::Value)>>,
    > = Default::default();
    let captures = requests.clone();
    let app = axum::Router::new()
        .fallback(
            |uri: axum::http::Uri,
             axum::extract::State(captures): axum::extract::State<
                std::sync::Arc<
                    std::sync::Mutex<Vec<(String, serde_json::Value)>>,
                >,
             >,
             body: axum::body::Bytes| async move {
                let parsed = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
                captures
                    .lock()
                    .unwrap()
                    .push((uri.path().to_string(), parsed));
                axum::Json(serde_json::json!({ "invocationId": "mock" }))
            },
        )
        .with_state(requests.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut config = Config::test_config();
    config.restate_url = format!("http://{addr}");
    let state = AppState::with_store(std::sync::Arc::new(db.store.clone()), config);
    (
        TestState { state, db },
        MockIngress {
            url: format!("http://{addr}"),
            requests,
        },
    )
}

/// Registers an (empty) in-flight generation for `chat_id` so attach tests
/// exercise the in-flight path (pending-tool and approval replay, catch-up)
/// instead of the immediate Idle frame.
pub fn note_generation(state: &AppState, chat_id: uuid::Uuid) {
    crate::http::gateway::ensure_generation(state, chat_id);
}

/// Full stack for gateway tests: Postgres + ClickHouse + a wiremock provider
/// registered as an "openai" route serving model `gpt-test`.
pub struct FullState {
    pub state: AppState,
    pub db: TestDb,
    #[allow(dead_code)]
    provider: wiremock::MockServer,
    pub token: String,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub chat_id: Uuid,
    pub model: String,
}

impl FullState {
    pub fn store(&self) -> Store {
        self.db.store.clone()
    }
}

/// Host-level ClickHouse + object storage shared by all tests on this box
/// (the same neutral services prod uses: /srv/clickhouse on :8123 and
/// rustfs on :9950 — see docs/deploy-nuances.md). No testcontainers: each
/// `full_state()` call gets an isolated ClickHouse database and S3 bucket on
/// the shared servers. Override endpoints/creds via GUILD_TEST_* env vars.
struct SharedInfra {
    ch_url: String,
    ch_user: String,
    ch_password: String,
    s3_url: String,
    s3_access_key_id: String,
    s3_secret_access_key: String,
}

static SHARED_INFRA: tokio::sync::OnceCell<SharedInfra> = tokio::sync::OnceCell::const_new();

/// Test ClickHouse databases (`t_<uuid-v7>`) and rustfs buckets (`t<uuid-v7>`)
/// embed their creation time in the uuid; drop ones older than this on first
/// fixture use, so crashed test runs don't leak databases/buckets on the
/// shared host services. Concurrent test processes keep theirs (they're young).
const REAP_AFTER_SECS: u64 = 6 * 3600;

/// Age in seconds of a `t`-prefixed name's embedded uuid-v7 timestamp.
fn name_age_secs(name: &str) -> Option<u64> {
    let hex = name.strip_prefix('t')?.trim_start_matches('_');
    let id = Uuid::parse_str(hex).ok()?;
    let (secs, _) = id.get_timestamp()?.to_unix();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now.saturating_sub(secs))
}

async fn reap_stale_ch_databases(infra: &SharedInfra) {
    let client = clickhouse::Client::default()
        .with_url(&infra.ch_url)
        .with_user(&infra.ch_user)
        .with_password(&infra.ch_password);
    let names: Vec<String> = client
        .query("SELECT name FROM system.databases WHERE name LIKE 't\\_%'")
        .fetch_all()
        .await
        .unwrap_or_default();
    for name in names {
        if name_age_secs(&name).is_some_and(|age| age > REAP_AFTER_SECS) {
            let _ = client
                .query(&format!("DROP DATABASE IF EXISTS {name}"))
                .execute()
                .await;
        }
    }
}

async fn reap_stale_s3_buckets(infra: &SharedInfra) {
    let creds = aws_sdk_s3::config::Credentials::new(
        &infra.s3_access_key_id,
        &infra.s3_secret_access_key,
        None,
        None,
        "test",
    );
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .endpoint_url(&infra.s3_url)
        .credentials_provider(creds)
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .build();
    let s3 = aws_sdk_s3::Client::from_conf(conf);
    let Ok(buckets) = s3.list_buckets().send().await else {
        return;
    };
    for name in buckets
        .buckets()
        .iter()
        .filter_map(|b| b.name().map(str::to_string))
        .collect::<Vec<_>>()
    {
        if !name_age_secs(&name).is_some_and(|age| age > REAP_AFTER_SECS) {
            continue;
        }
        // delete_bucket fails on non-empty buckets: empty first.
        let Ok(pages) = s3
            .list_objects_v2()
            .bucket(&name)
            .into_paginator()
            .send()
            .collect::<Result<Vec<_>, _>>()
            .await
        else {
            continue;
        };
        let keys: Vec<String> = pages
            .iter()
            .flat_map(|p| p.contents().iter().filter_map(|o| o.key().map(str::to_string)))
            .collect();
        for batch in keys.chunks(1000) {
            let Ok(objs) = batch
                .iter()
                .map(|k| aws_sdk_s3::types::ObjectIdentifier::builder().key(k).build())
                .collect::<Result<Vec<_>, _>>()
            else {
                break;
            };
            let Ok(delete) =
                aws_sdk_s3::types::Delete::builder().set_objects(Some(objs)).build()
            else {
                break;
            };
            let _ = s3
                .delete_objects()
                .bucket(&name)
                .delete(delete)
                .send()
                .await;
        }
        let _ = s3.delete_bucket().bucket(&name).send().await;
    }
}

async fn shared_infra() -> anyhow::Result<&'static SharedInfra> {
    SHARED_INFRA
        .get_or_try_init(|| async {
            let infra = SharedInfra {
                ch_url: std::env::var("GUILD_TEST_CLICKHOUSE_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8123".into()),
                ch_user: std::env::var("GUILD_TEST_CLICKHOUSE_USER")
                    .unwrap_or_else(|_| "ch_user".into()),
                ch_password: std::env::var("GUILD_TEST_CLICKHOUSE_PASSWORD")
                    .unwrap_or_else(|_| "ch_test_pass".into()),
                s3_url: std::env::var("GUILD_TEST_S3_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:9950".into()),
                s3_access_key_id: std::env::var("GUILD_TEST_S3_ACCESS_KEY_ID")
                    .unwrap_or_else(|_| "rustfsadmin".into()),
                s3_secret_access_key: std::env::var("GUILD_TEST_S3_SECRET_ACCESS_KEY")
                    .unwrap_or_else(|_| "rustfsadmin".into()),
            };
            reap_stale_ch_databases(&infra).await;
            reap_stale_s3_buckets(&infra).await;
            Ok(infra)
        })
        .await
}

pub async fn full_state() -> FullState {
    let infra = shared_infra().await.expect("host clickhouse/s3 config");
    let db = Store::connect_test().await.expect("postgres test db");

    // per-test isolated ClickHouse database
    let ch_database = format!("t_{}", Uuid::now_v7().simple());
    clickhouse::Client::default()
        .with_url(&infra.ch_url)
        .with_user(&infra.ch_user)
        .with_password(&infra.ch_password)
        .query(&format!("CREATE DATABASE {ch_database}"))
        .execute()
        .await
        .expect("create clickhouse test database");

    // per-test isolated S3 bucket
    let s3_bucket = format!("t{}", Uuid::now_v7().simple());
    {
        let creds = aws_sdk_s3::config::Credentials::new(
            &infra.s3_access_key_id,
            &infra.s3_secret_access_key,
            None,
            None,
            "test",
        );
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
            .endpoint_url(&infra.s3_url)
            .credentials_provider(creds)
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .build();
        aws_sdk_s3::Client::from_conf(conf)
            .create_bucket()
            .bucket(&s3_bucket)
            .send()
            .await
            .expect("bucket create");
    }

    let provider = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/v1/chat/completions"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"hi there\"}}]}\n\n\
                     data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n\
                     data: [DONE]\n\n",
                ),
        )
        .mount(&provider)
        .await;

    let cfg = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: db.url.clone(),
        clickhouse_url: infra.ch_url.clone(),
        clickhouse_database: ch_database,
        clickhouse_user: infra.ch_user.clone(),
        clickhouse_password: infra.ch_password.clone(),
        master_key_hex: "00".repeat(32),
        jwt_secret: "test-secret".into(),
        s3_url: infra.s3_url.clone(),
        s3_bucket: s3_bucket,
        s3_access_key_id: infra.s3_access_key_id.clone(),
        s3_secret_access_key: infra.s3_secret_access_key.clone(),
        restate_url: "http://placeholder:8080".into(),
        restate_admin_url: "http://placeholder:9070".into(),
        api_url: "http://localhost:8080".into(),
        role: "all".into(),
        data_dir: "./data-test".into(),
        allow_shell_tools: false,
        internal_token: Some("test-internal".into()),
        worker_bind: "127.0.0.1:0".into(),
        worker_advertised_url: "http://localhost:9080".into(),
    };
    let master = cfg.master_key().unwrap();

    let store = db.store.clone();
    let user_id = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .expect("bootstrap admin");
    let user = store
        .identity()
        .authenticate("a@b.c", "hunter226")
        .await
        .unwrap();
    let org_id = user.org_id;
    store
        .gateway()
        .upsert_provider_key(org_id, "openai", &provider.uri(), "sk-test", &master)
        .await
        .unwrap();
    store
        .gateway()
        .upsert_route(org_id, "gpt-test", "openai", true, 2.0, 4.0, None, false, None)
        .await
        .unwrap();
    let chat = store
        .chats()
        .create_chat(org_id, user_id, Some("t"))
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user_id).await.unwrap();

    let state = AppState::from_config(cfg);
    FullState {
        state,
        db,
        provider,
        token,
        org_id,
        user_id,
        chat_id: chat.id,
        model: "gpt-test".into(),
    }
}

/// Creates a second org with a chat, for cross-org access tests.
pub async fn insert_org_with_chat(store: &Store) -> Uuid {
    let org = Uuid::now_v7();
    let user = Uuid::now_v7();
    let chat = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'other')")
        .bind(org)
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) \
         VALUES ($1, $2, 'x@y.z', 'x', 'member', 'managed')",
    )
    .bind(user)
    .bind(org)
    .execute(store.pool())
    .await
    .unwrap();
    sqlx::query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, 'foreign')")
        .bind(chat)
        .bind(org)
        .bind(user)
        .execute(store.pool())
        .await
        .unwrap();
    chat
}

/// `(row_count, total_cost)` from the usage_events table.
pub async fn clickhouse_usage_rows(state: &AppState) -> (u64, f64) {
    let client = state.config.clickhouse_client();
    let count: u64 = client
        .query("SELECT count() FROM usage_events")
        .fetch_one()
        .await
        .expect("clickhouse count");
    let cost: f64 = client
        .query("SELECT sum(cost_usd) FROM usage_events")
        .fetch_one()
        .await
        .expect("clickhouse sum");
    (count, cost)
}

/// full_state() plus a real HTTP listener; for client round-trip tests.
pub struct ServedFull {
    pub full: FullState,
    pub base_url: String,
}

impl std::ops::Deref for ServedFull {
    type Target = FullState;
    fn deref(&self) -> &FullState {
        &self.full
    }
}

pub async fn serve_full() -> ServedFull {
    let full = full_state().await;
    let app = crate::build_router(full.state.clone());
    let listener = standalone_listener().await;
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    ServedFull {
        full,
        base_url: format!("http://{addr}"),
    }
}
