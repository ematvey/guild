//! Test helpers. Compiled only in tests (cfg test) or with the
//! `test-support` feature, which integration tests of *other* crates use.

use crate::config::Config;
use crate::state::AppState;

pub fn test_state() -> AppState {
    AppState::from_config(Config::test_config())
}
