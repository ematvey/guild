pub mod agent_sessions;
pub mod api_keys;
pub mod attachments;
pub mod chats;
pub mod events;
pub mod gateway;
pub mod identity;
pub mod integration_secrets;
pub mod integrations;
pub mod kv;
pub mod oidc;
pub mod org_kv;
pub mod pairing;
pub mod registry;
pub mod releases;
pub mod routines;
pub mod teams;
pub mod thread;

#[cfg(feature = "test-support")]
pub use test_db::TestDb;

use sqlx::PgPool;

/// Record store — Postgres is the source of truth (spec §2).
#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

impl Store {
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        Self::run_migrations(&pool).await?;
        Ok(Self { pool })
    }

    /// Applies embedded migrations in filename order, tracked in
    /// `schema_history` (idempotent, locked, checksummed): a
    /// transaction-scoped advisory lock serializes concurrent migrators
    /// (api and worker processes share the database); each migration's
    /// sha256 is stored at apply time and compared on every boot, so an
    /// edited file errors instead of silently drifting.
    ///
    /// Migrations are append-only: editing an applied file fails the boot.
    async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_history (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "ALTER TABLE schema_history ADD COLUMN IF NOT EXISTS content_hash TEXT",
        )
        .execute(pool)
        .await?;
        const MIGRATIONS: [(&str, &str); 41] = [
            (
                "0001_identity",
                include_str!("../../migrations/0001_identity.sql"),
            ),
            (
                "0002_gateway",
                include_str!("../../migrations/0002_gateway.sql"),
            ),
            (
                "0003_chats",
                include_str!("../../migrations/0003_chats.sql"),
            ),
            (
                "0004_chats_tool_columns",
                include_str!("../../migrations/0004_chats_tool_columns.sql"),
            ),
            (
                "0005_registry",
                include_str!("../../migrations/0005_registry.sql"),
            ),
            (
                "0006_teams",
                include_str!("../../migrations/0006_teams.sql"),
            ),
            (
                "0007_routines",
                include_str!("../../migrations/0007_routines.sql"),
            ),
            (
                "0008_api_keys",
                include_str!("../../migrations/0008_api_keys.sql"),
            ),
            (
                "0009_agent_sessions",
                include_str!("../../migrations/0009_agent_sessions.sql"),
            ),
            ("0010_oidc", include_str!("../../migrations/0010_oidc.sql")),
            (
                "0011_route_quota",
                include_str!("../../migrations/0011_route_quota.sql"),
            ),
            (
                "0012_attachments",
                include_str!("../../migrations/0012_attachments.sql"),
            ),
            (
                "0013_events",
                include_str!("../../migrations/0013_events.sql"),
            ),
            (
                "0014_releases",
                include_str!("../../migrations/0014_releases.sql"),
            ),
            (
                "0015_release_signing",
                include_str!("../../migrations/0015_release_signing.sql"),
            ),
            (
                "0016_pairing",
                include_str!("../../migrations/0016_pairing.sql"),
            ),
            (
                "0017_updater",
                include_str!("../../migrations/0017_updater.sql"),
            ),
            (
                "0018_integrations",
                include_str!("../../migrations/0018_integrations.sql"),
            ),
            (
                "0019_machine_binding",
                include_str!("../../migrations/0019_machine_binding.sql"),
            ),
            (
                "0020_thread_events",
                include_str!("../../migrations/0020_thread_events.sql"),
            ),
            (
                "0021_reasoning_flag",
                include_str!("../../migrations/0021_reasoning_flag.sql"),
            ),
            (
                "0022_drop_messages",
                include_str!("../../migrations/0022_drop_messages.sql"),
            ),
            (
                "0023_chat_approval",
                include_str!("../../migrations/0023_chat_approval.sql"),
            ),
            (
                "0024_context_window",
                include_str!("../../migrations/0024_context_window.sql"),
            ),
            (
                "0025_route_modalities",
                include_str!("../../migrations/0025_route_modalities.sql"),
            ),
            (
                "0026_user_approval",
                include_str!("../../migrations/0026_user_approval.sql"),
            ),
            (
                "0027_user_profile",
                include_str!("../../migrations/0027_user_profile.sql"),
            ),
            (
                "0028_org_kv",
                include_str!("../../migrations/0028_org_kv.sql"),
            ),
            (
                "0029_integration_secrets",
                include_str!("../../migrations/0029_integration_secrets.sql"),
            ),
            (
                "0030_integration_ids",
                include_str!("../../migrations/0030_integration_ids.sql"),
            ),
            (
                "0031_client_tool_names",
                include_str!("../../migrations/0031_client_tool_names.sql"),
            ),
            (
                "0032_session_token_hash",
                include_str!("../../migrations/0032_session_token_hash.sql"),
            ),
            (
                "0033_routine_webhook_token_hash",
                include_str!("../../migrations/0033_routine_webhook_token_hash.sql"),
            ),
            (
                "0034_user_fk_actions",
                include_str!("../../migrations/0034_user_fk_actions.sql"),
            ),
            (
                "0035_max_output_tokens",
                include_str!("../../migrations/0035_max_output_tokens.sql"),
            ),
            (
                "0036_org_fks",
                include_str!("../../migrations/0036_org_fks.sql"),
            ),
            (
                "0037_registry_reviewed_version",
                include_str!("../../migrations/0037_registry_reviewed_version.sql"),
            ),
            (
                "0038_registry_bundle_sha256",
                include_str!("../../migrations/0038_registry_bundle_sha256.sql"),
            ),
            (
                "0039_integration_secret_masked",
                include_str!("../../migrations/0039_integration_secret_masked.sql"),
            ),
            (
                "0040_provider_name_protocol",
                include_str!("../../migrations/0040_provider_name_protocol.sql"),
            ),
            (
                "0041_chat_status",
                include_str!("../../migrations/0041_chat_status.sql"),
            ),
        ];
        for (name, sql) in MIGRATIONS {
            let hash = migration_hash(sql);
            let mut tx = pool.begin().await?;
            // Advisory lock held to the end of the transaction: a second
            // boot waits here, then re-checks history inside the lock, so
            // two processes never apply the same migration twice.
            sqlx::query("SELECT pg_advisory_xact_lock($1)")
                .bind(MIGRATION_LOCK_ID)
                .execute(&mut *tx)
                .await?;
            let stored: Option<Option<String>> =
                sqlx::query_scalar("SELECT content_hash FROM schema_history WHERE name = $1")
                    .bind(name)
                    .fetch_optional(&mut *tx)
                    .await?;
            match stored {
                // Applied and hashed: same content → done, changed content
                // → refuse (migrations are append-only; revert the edit or
                // add a new file).
                Some(Some(h)) => {
                    if h != hash {
                        anyhow::bail!(
                            "migration {name} drifted: applied checksum {h}, embedded {hash} — \
                             migrations are append-only; revert the edit or add a new file"
                        );
                    }
                    tx.rollback().await?;
                    continue;
                }
                // Applied before hashes were recorded: grandfather the file
                // (it matches what shipped) by recording its hash.
                Some(None) => {
                    sqlx::query(
                        "UPDATE schema_history SET content_hash = $2 \
                         WHERE name = $1 AND content_hash IS NULL",
                    )
                    .bind(name)
                    .bind(&hash)
                    .execute(&mut *tx)
                    .await?;
                    tx.commit().await?;
                    continue;
                }
                None => {}
            }
            // Split on ';'. Comment lines are stripped first — a ';' inside a
            // `--` comment would otherwise break the statement split.
            let sql = sql
                .lines()
                .filter(|l| !l.trim_start().starts_with("--"))
                .collect::<Vec<_>>()
                .join("\n");
            for stmt in sql.split(';') {
                let stmt = stmt.trim();
                if stmt.is_empty() {
                    continue;
                }
                sqlx::query(stmt).execute(&mut *tx).await?;
            }
            sqlx::query("INSERT INTO schema_history (name, content_hash) VALUES ($1, $2)")
                .bind(name)
                .bind(&hash)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
        Ok(())
    }

    pub fn identity(&self) -> identity::IdentityStore<'_> {
        identity::IdentityStore { pool: &self.pool }
    }

    pub fn integrations(&self) -> integrations::IntegrationStore<'_> {
        integrations::IntegrationStore { pool: &self.pool }
    }

    pub fn integration_secrets(&self) -> integration_secrets::IntegrationSecretStore<'_> {
        integration_secrets::IntegrationSecretStore { pool: &self.pool }
    }

    pub fn chats(&self) -> chats::ChatStore<'_> {
        chats::ChatStore { pool: &self.pool }
    }

    pub fn thread(&self) -> thread::ThreadStore<'_> {
        thread::ThreadStore { pool: &self.pool }
    }

    pub fn gateway(&self) -> gateway::GatewayStore<'_> {
        gateway::GatewayStore { pool: &self.pool }
    }

    pub fn registry(&self) -> registry::RegistryStore<'_> {
        registry::RegistryStore { pool: &self.pool }
    }

    pub fn agent_sessions(&self) -> agent_sessions::AgentSessionStore<'_> {
        agent_sessions::AgentSessionStore { pool: &self.pool }
    }

    pub fn api_keys(&self) -> api_keys::ApiKeyStore<'_> {
        api_keys::ApiKeyStore { pool: &self.pool }
    }

    pub fn pairing(&self) -> pairing::PairingStore<'_> {
        pairing::PairingStore { pool: &self.pool }
    }

    pub fn teams(&self) -> teams::TeamStore<'_> {
        teams::TeamStore { pool: &self.pool }
    }

    pub fn kv(&self) -> kv::KvStore<'_> {
        kv::KvStore { pool: &self.pool }
    }

    pub fn org_kv(&self) -> org_kv::OrgKvStore<'_> {
        org_kv::OrgKvStore { pool: &self.pool }
    }

    pub fn releases(&self) -> releases::ReleaseStore<'_> {
        releases::ReleaseStore { pool: &self.pool }
    }

    pub fn events(&self) -> events::EventStore<'_> {
        events::EventStore { pool: &self.pool }
    }

    pub fn attachments(&self) -> attachments::AttachmentStore<'_> {
        attachments::AttachmentStore { pool: &self.pool }
    }

    pub fn oidc(&self) -> oidc::OidcStore<'_> {
        oidc::OidcStore { pool: &self.pool }
    }

    pub fn routines(&self) -> routines::RoutineStore<'_> {
        routines::RoutineStore { pool: &self.pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

/// Advisory-lock id for the migration runner: one fixed bigint every
/// instance of this binary agrees on (ASCII "GUILDMGR" for recognizability
/// in pg_locks).
const MIGRATION_LOCK_ID: i64 = 0x4755_494C_444D_4752;

/// sha256 hex of one migration file — the checksum stored in schema_history.
fn migration_hash(sql: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(sql.as_bytes());
    hex::encode(h.finalize())
}

#[cfg(feature = "test-support")]
mod test_db {
    use super::Store;
    use tokio::sync::OnceCell;

    /// Host Postgres shared by all tests on this box: the neutral host
    /// service at /srv/postgres (published on 127.0.0.1:5432, see
    /// /srv/postgres/docker-compose.yml). No testcontainer is started; each
    /// `connect_test` caller gets an isolated database on the shared server.
    /// Override with GUILD_TEST_PG_URL (must point at a role that can CREATE
    /// DATABASE). Stale test databases from crashed runs are reaped on first
    /// use: ones with no live connections are dropped.
    static BASE_URL: OnceCell<String> = OnceCell::const_new();

    async fn base_url() -> anyhow::Result<&'static String> {
        BASE_URL
            .get_or_try_init(|| async {
                // No default: a host credential must not live in source.
                // Point GUILD_TEST_PG_URL at a role that can CREATE DATABASE.
                let url = std::env::var("GUILD_TEST_PG_URL").map_err(|_| {
                    anyhow::anyhow!(
                        "GUILD_TEST_PG_URL is not set — tests need a Postgres server \
                         the test user can create databases on"
                    )
                })?;
                let admin = sqlx::PgPool::connect(&format!("{url}/postgres")).await?;
                // Reap leftovers from crashed runs: databases no process is
                // connected to. Concurrent test processes keep theirs (they
                // hold live connections).
                let stale: Vec<String> = sqlx::query_scalar(
                    "SELECT datname FROM pg_database d \
                     WHERE datname LIKE 'test\\_%' AND NOT EXISTS (\
                       SELECT 1 FROM pg_stat_activity a \
                       WHERE a.datname = d.datname AND a.pid <> pg_backend_pid())",
                )
                .fetch_all(&admin)
                .await
                .unwrap_or_default();
                for name in stale {
                    let _ = sqlx::query(&format!("DROP DATABASE {name}"))
                        .execute(&admin)
                        .await;
                }
                admin.close().await;
                anyhow::Ok(url)
            })
            .await
    }

    /// Owns one isolated database on the shared host Postgres.
    pub struct TestDb {
        pub store: Store,
        /// Full connection URL of this test's isolated database.
        pub url: String,
        #[allow(dead_code)] // keep the name alive for debugging
        db_name: String,
    }

    impl std::ops::Deref for TestDb {
        type Target = Store;
        fn deref(&self) -> &Store {
            &self.store
        }
    }

    impl Store {
        /// Returns a store backed by a fresh database on the shared host
        /// Postgres (no container; see `base_url`).
        pub async fn connect_test() -> anyhow::Result<TestDb> {
            let base = base_url().await?;
            let db_name = format!("test_{}", uuid::Uuid::now_v7().simple());
            let admin = sqlx::PgPool::connect(&format!("{base}/postgres")).await?;
            sqlx::query(&format!("CREATE DATABASE {db_name}"))
                .execute(&admin)
                .await?;
            admin.close().await;
            let url = format!("{base}/{db_name}");
            let store = Self::connect(&url).await?;
            Ok(TestDb { store, url, db_name })
        }
    }
}
