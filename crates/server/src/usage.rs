//! Usage-event sink — ClickHouse (spec §4.5). Unreachable ClickHouse must
//! never break chat: failures are logged and dropped.

use crate::s3::{ObjectStore, SharedObjectStore};
use crate::state::AppState;
use chrono::{DateTime, Utc};
use guild_core::usage::UsageEvent;
use std::sync::Arc;
use uuid::Uuid;

/// ClickHouse row mapping — separate from the domain type because guild-core
/// stays storage-agnostic.
#[derive(clickhouse::Row, serde::Serialize, Debug, Clone)]
pub struct UsageRow {
    #[serde(with = "clickhouse::serde::chrono::datetime")]
    pub ts: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub user_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid::option")]
    pub team_id: Option<Uuid>,
    #[serde(with = "clickhouse::serde::uuid")]
    pub session_id: Uuid,
    pub model: String,
    pub provider: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub cost_usd: f64,
    #[serde(with = "clickhouse::serde::uuid")]
    pub request_id: Uuid,
}

impl From<UsageEvent> for UsageRow {
    fn from(ev: UsageEvent) -> Self {
        Self {
            ts: ev.ts,
            org_id: ev.org_id,
            user_id: ev.user_id,
            team_id: ev.team_id,
            session_id: ev.session_id,
            model: ev.model,
            provider: ev.provider,
            tokens_in: ev.tokens_in,
            tokens_out: ev.tokens_out,
            cost_usd: ev.cost_usd,
            request_id: ev.request_id,
        }
    }
}

pub struct UsageSink {
    client: clickhouse::Client,
}

impl UsageSink {
    pub async fn connect(url: &str, database: &str) -> anyhow::Result<Self> {
        let client = clickhouse::Client::default()
            .with_url(url)
            .with_database(database);
        client
            .query(
                "CREATE TABLE IF NOT EXISTS usage_events (\
                   ts DateTime, org_id UUID, user_id UUID, team_id Nullable(UUID), \
                   session_id UUID, model String, provider String, \
                   tokens_in UInt32, tokens_out UInt32, cost_usd Float64, request_id UUID\
                 ) ENGINE = MergeTree ORDER BY (org_id, ts)",
            )
            .execute()
            .await?;
        Ok(Self { client })
    }

    pub async fn record(&self, ev: UsageEvent) {
        if let Err(e) = self.write(ev.into()).await {
            tracing::warn!("usage event dropped: {e}");
        }
    }

    async fn write(&self, row: UsageRow) -> anyhow::Result<()> {
        let mut insert = self.client.insert::<UsageRow>("usage_events").await?;
        insert.write(&row).await?;
        insert.end().await?;
        Ok(())
    }
}

pub type SharedUsageSink = Arc<UsageSink>;

impl AppState {
    /// Lazily connects to object storage on first use.
    pub async fn objects(&self) -> Result<SharedObjectStore, crate::http::error::ApiError> {
        self.objects_cell()
            .get_or_try_init(|| async {
                ObjectStore::connect(&self.config)
                    .map(Arc::new)
                    .map_err(|e| crate::http::error::ApiError::internal(e.to_string()))
            })
            .await
            .cloned()
    }

    /// Lazily connects to ClickHouse on first use.
    pub async fn usage(&self) -> Result<SharedUsageSink, crate::http::error::ApiError> {
        self.usage_cell()
            .get_or_try_init(|| async {
                UsageSink::connect(
                    &self.config.clickhouse_url,
                    &self.config.clickhouse_database,
                )
                .await
                .map(Arc::new)
                .map_err(|e| crate::http::error::ApiError::internal(e.to_string()))
            })
            .await
            .cloned()
    }
}
