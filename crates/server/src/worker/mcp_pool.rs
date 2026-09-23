//! Cached MCP client connections for integration plugins. A connection is
//! keyed by (org, slug, url, acting_as, secrets fingerprint): the identity
//! envelope and secret headers ride on the connection, so a changed identity
//! or secret set creates a new pooled connection. Entries unused for
//! `POOL_TTL` are evicted on the next access scan.

use anyhow::Context as _;
use axum::http::HeaderMap;
use rmcp::model::{ClientInfo, Implementation, InitializeRequestParams};
use rmcp::service::{serve_client, Peer, RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// Idle connections older than this are evicted on the next insert/lookup.
pub const POOL_TTL: Duration = Duration::from_secs(600);

/// Connect timeout: an unreachable MCP server must fail the plugin, not the
/// turn (spec §8 — the turn continues without the plugin's tools).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PoolKey {
    pub org: uuid::Uuid,
    pub slug: String,
    pub url: String,
    pub acting_as: Option<String>,
    pub secrets_fingerprint: u64,
}

/// Stable fingerprint of the resolved secret set — equal sets share a pool
/// key without the values ever entering the key.
pub fn secrets_fingerprint(secrets: &[(String, String)]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut pairs: Vec<(&String, &String)> = secrets.iter().map(|(k, v)| (k, v)).collect();
    pairs.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (k, v) in pairs {
        k.hash(&mut h);
        v.hash(&mut h);
    }
    h.finish()
}

struct PoolEntry {
    /// Keeps the connection's task alive — dropping the service closes the
    /// connection.
    service: RunningService<RoleClient, InitializeRequestParams>,
    last_used: Instant,
}

#[derive(Default)]
pub struct McpPool {
    entries: std::sync::Mutex<HashMap<PoolKey, PoolEntry>>,
}

impl McpPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of live pooled connections.
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    /// True when no connection is pooled.
    pub fn is_empty(&self) -> bool {
        self.entries.lock().unwrap().is_empty()
    }

    /// Returns a pooled peer for `key`, connecting (and caching) on miss.
    pub async fn get_or_connect(
        &self,
        key: &PoolKey,
        url: &str,
        headers: HeaderMap,
    ) -> anyhow::Result<Peer<RoleClient>> {
        if let Some(peer) = self.lookup(key) {
            return Ok(peer);
        }
        let service = Self::connect(url, headers).await?;
        let peer = service.peer().clone();
        self.insert(key.clone(), service);
        Ok(peer)
    }

    fn lookup(&self, key: &PoolKey) -> Option<Peer<RoleClient>> {
        let mut entries = self.entries.lock().unwrap();
        Self::evict_stale(&mut entries);
        if entries
            .get(key)
            .is_some_and(|e| e.service.is_closed() || e.service.peer().is_transport_closed())
        {
            entries.remove(key);
            return None;
        }
        entries.get_mut(key).map(|e| {
            e.last_used = Instant::now();
            e.service.peer().clone()
        })
    }

    fn insert(&self, key: PoolKey, service: RunningService<RoleClient, InitializeRequestParams>) {
        let mut entries = self.entries.lock().unwrap();
        Self::evict_stale(&mut entries);
        entries.insert(
            key,
            PoolEntry {
                service,
                last_used: Instant::now(),
            },
        );
    }

    fn evict_stale(entries: &mut HashMap<PoolKey, PoolEntry>) {
        let cutoff = Instant::now() - POOL_TTL;
        let stale: VecDeque<PoolKey> = entries
            .iter()
            .filter(|(_, e)| e.last_used < cutoff)
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            entries.remove(&k);
        }
    }

    pub async fn connect(
        url: &str,
        headers: HeaderMap,
    ) -> anyhow::Result<RunningService<RoleClient, InitializeRequestParams>> {
        let mut info = ClientInfo::default();
        info.client_info = Implementation::new("guild", "0.1.0");
        let custom: HashMap<axum::http::HeaderName, axum::http::HeaderValue> = headers
            .into_iter()
            .filter_map(|(k, v)| k.map(|k| (k, v)))
            .collect();
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url).custom_headers(custom),
        );
        let service = tokio::time::timeout(CONNECT_TIMEOUT, serve_client(info, transport))
            .await
            .context("mcp connect timed out")?
            .context("mcp handshake failed")?;
        Ok(service)
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use rmcp::handler::server::ServerHandler;
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager,
        tower::{StreamableHttpServerConfig, StreamableHttpService},
    };
    use std::sync::Arc;

    struct Fixture;
    impl ServerHandler for Fixture {}

    #[tokio::test]
    async fn orgs_are_isolated_and_closed_peers_are_reconnected() {
        let service = StreamableHttpService::new(
            || Ok(Fixture),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let app = axum::Router::new().nest_service("/mcp", service);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let pool = McpPool::new();
        let key = PoolKey {
            org: uuid::Uuid::now_v7(),
            slug: "same".into(),
            url: url.clone(),
            acting_as: None,
            secrets_fingerprint: 0,
        };
        pool.get_or_connect(&key, &url, HeaderMap::new())
            .await
            .unwrap();
        let other = PoolKey {
            org: uuid::Uuid::now_v7(),
            ..key.clone()
        };
        pool.get_or_connect(&other, &url, HeaderMap::new())
            .await
            .unwrap();
        assert_eq!(pool.len(), 2);
        pool.entries
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .service
            .cancellation_token()
            .cancel();
        let peer = pool
            .get_or_connect(&key, &url, HeaderMap::new())
            .await
            .unwrap();
        assert!(!peer.is_transport_closed());
        assert_eq!(pool.len(), 2);
        server.abort();
    }
}
