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
    /// client connection: a disconnect does not stop them; clients re-attach
    /// via the gateway stream endpoint.
    pub generations: Arc<std::sync::Mutex<HashMap<Uuid, crate::http::gateway::ActiveGeneration>>>,
    /// Cached MCP client connections for integration plugins (outside the
    /// Restate journal — reconnecting on replay is safe, spec §8).
    pub mcp_pool: Arc<McpPool>,
    pub ws_tickets: crate::http::ws::TicketStore,
    pub hub: Arc<Hub>,
    /// One live-frame feed per user, shared by all of their sockets.
    pub feeds: Arc<std::sync::Mutex<HashMap<Uuid, crate::http::feed::FeedHandle>>>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: Arc::new(OnceCell::new()),
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: Arc::new(std::sync::Mutex::new(HashMap::new())),
            mcp_pool: Arc::new(McpPool::new()),
            ws_tickets: Default::default(),
            hub: Arc::new(Hub::default()),
            feeds: Arc::new(std::sync::Mutex::new(HashMap::new())),
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
        }
    }

    pub fn machine_label(&self, machine_id: &str) -> Option<String> {
        self.hub.machine_label(machine_id)
    }

    /// True when a live machine belongs to the given user or organization.
    pub fn machine_bindable(&self, machine_id: &str, user_id: Uuid, org_id: Uuid) -> bool {
        self.hub.machine_bindable(machine_id, user_id, org_id)
    }

    /// Connected machines belonging to `user_id`.
    pub fn machines_of_user(&self, user_id: Uuid) -> Vec<(String, String)> {
        self.hub.machines_of_user(user_id)
    }
}
