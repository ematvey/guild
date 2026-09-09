//! Shared request state: config + lazily-connected record store (spec §4).

use crate::config::Config;
use crate::http::error::ApiError;
use crate::store::Store;
use std::sync::Arc;
use tokio::sync::OnceCell;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    db: Arc<OnceCell<Arc<Store>>>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: Arc::new(OnceCell::new()),
        }
    }

    /// Lazily connects to Postgres on first use; shared thereafter.
    pub async fn store(&self) -> Result<Arc<Store>, ApiError> {
        self.db
            .get_or_try_init(|| async {
                let s = Store::connect(&self.config.database_url)
                    .await
                    .map_err(ApiError::from)?;
                Ok(Arc::new(s))
            })
            .await
            .cloned()
    }

    /// Test constructor: state pre-seeded with an existing store.
    #[cfg(feature = "test-support")]
    pub fn with_store(store: Arc<Store>, cfg: Config) -> Self {
        let cell = OnceCell::new();
        cell.set(store).unwrap_or_else(|_| panic!("fresh OnceCell"));
        Self {
            config: Arc::new(cfg),
            db: Arc::new(cell),
        }
    }
}
