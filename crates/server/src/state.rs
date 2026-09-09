//! Shared request state.

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: std::sync::Arc<Config>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: std::sync::Arc::new(cfg),
        }
    }
}
