//! Shared request state: config + lazily-connected record store and usage
//! sink (spec §4).

use crate::config::Config;
use crate::http::error::ApiError;
use crate::http::hub::Hub;
use crate::s3::SharedObjectStore;
use crate::store::Store;
use crate::usage::SharedUsageSink;
use crate::worker::mcp_pool::McpPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::OnceCell;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    db: Arc<OnceCell<Arc<Store>>>,
    usage: Arc<OnceCell<SharedUsageSink>>,
    objects: Arc<OnceCell<SharedObjectStore>>,
    /// Server-side generations in flight, keyed by chat. Detached from any
    /// client connection: a disconnect does not stop them; clients reconcile
    /// through authoritative WebSocket state.
    pub generations: Arc<std::sync::Mutex<HashMap<Uuid, crate::http::gateway::ActiveGeneration>>>,
    /// Cached MCP client connections for integration plugins (outside the
    /// Restate journal — reconnecting on replay is safe, spec §8).
    pub mcp_pool: Arc<McpPool>,
    pub ws_tickets: crate::http::ws::TicketStore,
    pub hub: Arc<Hub>,
    /// One live-frame feed per user, shared by all of their sockets.
    pub feeds: Arc<std::sync::Mutex<HashMap<Uuid, crate::http::feed::FeedHandle>>>,
    pub thread_sync: Arc<tokio::sync::Mutex<()>>,
    /// Machine-fetched AGENTS.md chains per project folder (web parity, spec
    /// 2026-09-18 unification §4 phase 5a): the machine channel exposes no
    /// mtime verb, so freshness is a TTL bound instead. Outside the Restate
    /// journal — a cache miss just re-dispatches the read.
    pub agents_md_cache:
        Arc<std::sync::Mutex<HashMap<String, (std::time::Instant, String)>>>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            thread_sync: Arc::new(tokio::sync::Mutex::new(())),
            db: Arc::new(OnceCell::new()),
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            mcp_pool: Arc::new(McpPool::new()),
            ws_tickets: Default::default(),
            hub: Arc::new(Hub::default()),
            feeds: Arc::new(std::sync::Mutex::new(HashMap::new())),
            agents_md_cache: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Lazily connects to Postgres on first use; shared thereafter. The
    /// legacy-secret migration runs once with the store.
    pub async fn store(&self) -> Result<Arc<Store>, ApiError> {
        self.db
            .get_or_try_init(|| async {
                let s = Store::connect(&self.config.database_url)
                    .await
                    .map_err(ApiError::from)?;
                if let Ok(master) = self.config.master_key() {
                    if let Err(e) =
                        crate::integrations::migrate_legacy_credential_secrets(&s, &master).await
                    {
                        tracing::warn!("legacy credential-secret migration failed: {e:?}");
                    }
                }
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
            thread_sync: Arc::new(tokio::sync::Mutex::new(())),
            db: {
                let cell = OnceCell::new();
                cell.set(store).unwrap_or_else(|_| panic!("fresh OnceCell"));
                Arc::new(cell)
            },
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            mcp_pool: Arc::new(McpPool::new()),
            ws_tickets: Default::default(),
            hub: Arc::new(Hub::default()),
            feeds: Arc::new(std::sync::Mutex::new(HashMap::new())),
            agents_md_cache: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn machine_label(&self, machine_id: &str) -> Option<String> {
        self.hub.machine_label(machine_id)
    }

    /// True when the machine is durably registered (any pairing) to the
    /// given user or organization. DB-known, not hub-live: offline machines
    /// stay bindable.
    pub async fn machine_bindable(&self, machine_id: &str, user_id: Uuid, org_id: Uuid) -> bool {
        match self.store().await {
            Ok(store) => store
                .machines()
                .bindable(machine_id, user_id, org_id)
                .await
                .unwrap_or(false),
            Err(_) => false,
        }
    }
}
