//! Test helpers for guild-server and downstream crates. Compiled only with
//! the `test-support` feature.

use crate::config::Config;
use crate::state::AppState;
use crate::store::{Store, TestDb};

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
