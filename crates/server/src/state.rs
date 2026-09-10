//! Shared request state: config + lazily-connected record store and usage
//! sink (spec §4).

use crate::config::Config;
use crate::http::error::ApiError;
use crate::s3::SharedObjectStore;
use crate::store::Store;
use crate::usage::SharedUsageSink;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{watch, OnceCell};
use uuid::Uuid;

/// Live-connection tracking for one client app instance (identified by a
/// stable `client_id`). Presence is app-lifetime, not per-stream: thread
/// switching tears per-chat streams down by design, so client-tool
/// termination detection must not key off them.
pub struct PresenceHandle {
    /// Number of live app-level connections (e.g. `/api/v1/events/stream`).
    pub count_tx: watch::Sender<usize>,
}

/// Guard held for the lifetime of one app-level connection. Dropping it
/// decrements the count; watchers observe the change via the watch channel.
pub struct PresenceGuard {
    state: AppState,
    client_id: String,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let presence = self.state.presence.lock().unwrap();
        if let Some(h) = presence.get(&self.client_id) {
            let next = h.count_tx.borrow().saturating_sub(1);
            let _ = h.count_tx.send(next);
            // The handle stays in the map (watchers may hold receivers);
            // the count reaching 0 is the "client gone" signal.
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    db: Arc<OnceCell<Arc<Store>>>,
    usage: Arc<OnceCell<SharedUsageSink>>,
    objects: Arc<OnceCell<SharedObjectStore>>,
    /// Server-side generations in flight, keyed by chat. Detached from any
    /// client connection: a disconnect does not stop them; clients re-attach
    /// via the gateway stream endpoint.
    pub generations:
        Arc<std::sync::Mutex<HashMap<Uuid, crate::http::gateway::ActiveGeneration>>>,
    /// App-level client presence (see `PresenceGuard`), keyed by client_id.
    pub presence: Arc<std::sync::Mutex<HashMap<String, Arc<PresenceHandle>>>>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: Arc::new(OnceCell::new()),
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            presence: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Registers one live app-level connection for `client_id`. The returned
    /// guard must live as long as the connection.
    pub fn presence_acquire(&self, client_id: &str) -> PresenceGuard {
        let handle = {
            let mut presence = self.presence.lock().unwrap();
            presence
                .entry(client_id.to_string())
                .or_insert_with(|| {
                    let (count_tx, _) = watch::channel(0usize);
                    Arc::new(PresenceHandle { count_tx })
                })
                .clone()
        };
        let next = *handle.count_tx.borrow() + 1;
        let _ = handle.count_tx.send(next);
        PresenceGuard {
            state: self.clone(),
            client_id: client_id.to_string(),
        }
    }

    /// Watcher-side view of a client's presence; `None` if the client was
    /// never seen connected (its tools fall back to the timeout path).
    pub fn presence_watch(&self, client_id: &str) -> Option<watch::Receiver<usize>> {
        self.presence
            .lock()
            .unwrap()
            .get(client_id)
            .map(|h| h.count_tx.subscribe())
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

    pub(crate) fn usage_cell(&self) -> &OnceCell<SharedUsageSink> {
        &self.usage
    }

    pub(crate) fn objects_cell(&self) -> &OnceCell<SharedObjectStore> {
        &self.objects
    }

    /// Test constructor: state pre-seeded with an existing store.
    #[cfg(feature = "test-support")]
    pub fn with_store(store: Arc<Store>, cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: {
                let cell = OnceCell::new();
                cell.set(store).unwrap_or_else(|_| panic!("fresh OnceCell"));
                Arc::new(cell)
            },
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            presence: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }
}
