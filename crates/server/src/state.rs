//! Shared request state: config + lazily-connected record store and usage
//! sink (spec §4).

use crate::config::Config;
use crate::http::error::ApiError;
use crate::s3::SharedObjectStore;
use crate::store::Store;
use crate::usage::SharedUsageSink;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::OnceCell;
use uuid::Uuid;

#[derive(Clone)]
/// Liveness tracking for one machine executor (the desktop app running on
/// a specific machine). Machine tools run ONLY on the machine a chat is
/// bound to; the executor registry is the liveness source for fail-fast and
/// disconnect detection.
///
/// Liveness is heartbeat-based: TCP-level disconnect detection is unreliable
/// through docker-proxy (a dead client is not noticed until a server write
/// fails, which may never happen on an idle SSE stream). The desktop
/// heartbeats every few seconds; `last_seen` older than `EXECUTOR_TTL_SECS`
/// means offline. Dropping the stream body also marks the machine offline
/// immediately (best-effort fast path when the disconnect IS noticed).
pub struct ExecutorHandle {
    pub user_id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    /// Unix seconds of the last heartbeat; 0 = offline.
    pub last_seen: Arc<std::sync::atomic::AtomicI64>,
}

/// A machine is live while its heartbeats are fresher than this.
pub const EXECUTOR_TTL_SECS: i64 = 15;

/// Guard held for the lifetime of one machine-executor stream connection.
/// Dropping it marks the machine offline immediately.
pub struct ExecutorGuard {
    state: AppState,
    machine_id: String,
    last_seen: Arc<std::sync::atomic::AtomicI64>,
}

impl Drop for ExecutorGuard {
    fn drop(&mut self) {
        self.last_seen
            .store(0, std::sync::atomic::Ordering::Relaxed);
        let mut executors = self.state.executors.lock().unwrap();
        executors.remove(&self.machine_id);
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
    /// Connected machine executors (see `ExecutorGuard`), keyed by machine_id.
    pub executors: Arc<std::sync::Mutex<HashMap<String, Arc<ExecutorHandle>>>>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: Arc::new(OnceCell::new()),
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            executors: Arc::new(std::sync::Mutex::new(HashMap::new())),
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
            executors: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Registers one live machine-executor stream connection.
    pub fn executor_acquire(
        &self,
        machine_id: &str,
        user: &crate::store::identity::UserRow,
        name: &str,
    ) -> ExecutorGuard {
        let now = chrono::Utc::now().timestamp();
        let last_seen = {
            let mut executors = self.executors.lock().unwrap();
            let entry = executors.entry(machine_id.to_string());
            let h = match entry {
                std::collections::hash_map::Entry::Occupied(mut e) => {
                    let h = Arc::make_mut(e.get_mut());
                    if h.user_id != user.id {
                        // same machine_id re-registered by another user:
                        // last writer wins (single-user deployments in v1)
                        h.user_id = user.id;
                        h.org_id = user.org_id;
                        h.name = name.to_string();
                    }
                    h.last_seen.store(now, std::sync::atomic::Ordering::Relaxed);
                    e.get().clone()
                }
                std::collections::hash_map::Entry::Vacant(e) => {
                    let h = Arc::new(ExecutorHandle {
                        user_id: user.id,
                        org_id: user.org_id,
                        name: name.to_string(),
                        last_seen: Arc::new(std::sync::atomic::AtomicI64::new(now)),
                    });
                    e.insert(h.clone());
                    h
                }
            };
            h.last_seen.clone()
        };
        ExecutorGuard {
            state: self.clone(),
            machine_id: machine_id.to_string(),
            last_seen,
        }
    }

    /// Heartbeat from an executor: refreshes last_seen. Returns false for
    /// unknown machines (they re-register by reconnecting the event stream).
    pub fn executor_touch(&self, machine_id: &str, user_id: Uuid) -> bool {
        let executors = self.executors.lock().unwrap();
        match executors.get(machine_id) {
            Some(h) if h.user_id == user_id => {
                h.last_seen.store(
                    chrono::Utc::now().timestamp(),
                    std::sync::atomic::Ordering::Relaxed,
                );
                true
            }
            _ => false,
        }
    }

    /// True while the machine's heartbeats are fresh.
    pub fn machine_connected(&self, machine_id: &str) -> bool {
        let executors = self.executors.lock().unwrap();
        match executors.get(machine_id) {
            Some(h) => {
                let seen = h.last_seen.load(std::sync::atomic::Ordering::Relaxed);
                seen > 0 && chrono::Utc::now().timestamp() - seen <= EXECUTOR_TTL_SECS
            }
            None => false,
        }
    }

    pub fn machine_label(&self, machine_id: &str) -> Option<String> {
        self.executors
            .lock()
            .unwrap()
            .get(machine_id)
            .map(|h| h.name.clone())
    }

    /// Connected executors belonging to `user_id`.
    pub fn machines_of_user(&self, user_id: Uuid) -> Vec<(String, String)> {
        let now = chrono::Utc::now().timestamp();
        self.executors
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, h)| {
                if h.user_id != user_id {
                    return false;
                }
                let seen = h.last_seen.load(std::sync::atomic::Ordering::Relaxed);
                seen > 0 && now - seen <= EXECUTOR_TTL_SECS
            })
            .map(|(id, h)| (id.clone(), h.name.clone()))
            .collect()
    }
}
