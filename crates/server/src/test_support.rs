//! Test helpers for guild-server and downstream crates. Compiled only with
//! the `test-support` feature.

use crate::config::Config;
use crate::state::AppState;
use crate::store::{Store, TestDb};
use uuid::Uuid;

pub fn test_state() -> AppState {
    AppState::from_config(Config::test_config())
}

/// State backed by a real Postgres testcontainer. The container lives as
/// long as the returned `TestState`.
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

/// Full stack for gateway tests: Postgres + ClickHouse + a wiremock provider
/// registered as an "openai" route serving model `gpt-test`.
pub struct FullState {
    pub state: AppState,
    pub db: TestDb,
    #[allow(dead_code)]
    ch_container: testcontainers_modules::testcontainers::ContainerAsync<
        testcontainers_modules::clickhouse::ClickHouse,
    >,
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

pub async fn full_state() -> FullState {
    use testcontainers_modules::testcontainers::runners::AsyncRunner;

    let db = Store::connect_test().await.expect("postgres testcontainer");
    let ch = testcontainers_modules::clickhouse::ClickHouse::default()
        .start()
        .await
        .expect("clickhouse testcontainer");
    let ch_port = ch.get_host_port_ipv4(8123).await.unwrap();

    let provider = wiremock::MockServer::start().await;
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
        database_url: format!(
            "postgres://postgres:postgres@127.0.0.1:{}/postgres",
            db.get_host_port().await
        ),
        clickhouse_url: format!("http://127.0.0.1:{ch_port}"),
        clickhouse_database: "default".into(),
        master_key_hex: "00".repeat(32),
        jwt_secret: "test-secret".into(),
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
        .upsert_route(org_id, "gpt-test", "openai", true, 2.0, 4.0)
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
        ch_container: ch,
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
    let client = clickhouse::Client::default()
        .with_url(&state.config.clickhouse_url)
        .with_database(&state.config.clickhouse_database);
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
