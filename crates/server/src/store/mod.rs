pub mod chats;
pub mod gateway;
pub mod identity;
pub mod registry;

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
        let migrations = "";
        let _ = migrations;
        Self::run_migrations(&pool).await?;
        Ok(Self { pool })
    }

    /// Applies embedded migrations in filename order, tracked in
    /// `schema_history` (idempotent).
    async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_history (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
        )
        .execute(pool)
        .await?;
        const MIGRATIONS: [(&str, &str); 5] = [
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
        ];
        for (name, sql) in MIGRATIONS {
            let applied: Option<i64> =
                sqlx::query_scalar("SELECT 1::int8 FROM schema_history WHERE name = $1")
                    .bind(name)
                    .fetch_optional(pool)
                    .await?;
            if applied.is_some() {
                continue;
            }
            let mut tx = pool.begin().await?;
            for stmt in sql.split(';') {
                let stmt = stmt.trim();
                if stmt.is_empty() {
                    continue;
                }
                sqlx::query(stmt).execute(&mut *tx).await?;
            }
            sqlx::query("INSERT INTO schema_history (name) VALUES ($1)")
                .bind(name)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
        Ok(())
    }

    pub fn identity(&self) -> identity::IdentityStore<'_> {
        identity::IdentityStore { pool: &self.pool }
    }

    pub fn chats(&self) -> chats::ChatStore<'_> {
        chats::ChatStore { pool: &self.pool }
    }

    pub fn gateway(&self) -> gateway::GatewayStore<'_> {
        gateway::GatewayStore { pool: &self.pool }
    }

    pub fn registry(&self) -> registry::RegistryStore<'_> {
        registry::RegistryStore { pool: &self.pool }
    }

    /// Access for stores added in later tasks; unused until then.
    #[allow(dead_code)]
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }
}

#[cfg(feature = "test-support")]
mod test_db {
    use super::Store;

    /// Owns the testcontainer so it lives as long as the store.
    pub struct TestDb {
        pub store: Store,
        #[allow(dead_code)]
        container: testcontainers_modules::testcontainers::ContainerAsync<
            testcontainers_modules::postgres::Postgres,
        >,
    }

    impl std::ops::Deref for TestDb {
        type Target = Store;
        fn deref(&self) -> &Store {
            &self.store
        }
    }

    impl TestDb {
        /// Host port of the containerized Postgres.
        pub async fn get_host_port(&self) -> u16 {
            self.container.get_host_port_ipv4(5432).await.unwrap()
        }
    }

    impl Store {
        /// Spins a Postgres testcontainer and returns a store backed by it.
        pub async fn connect_test() -> anyhow::Result<TestDb> {
            use testcontainers_modules::testcontainers::runners::AsyncRunner;
            let container = testcontainers_modules::postgres::Postgres::default()
                .start()
                .await?;
            let port = container.get_host_port_ipv4(5432).await?;
            let url = format!("postgres://postgres:postgres@127.0.0.1:{port}/postgres");
            let store = Self::connect(&url).await?;
            Ok(TestDb { store, container })
        }
    }
}
