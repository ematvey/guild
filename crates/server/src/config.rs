//! Server configuration from environment, spec §4.9.

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub clickhouse_url: String,
    pub clickhouse_database: String,
    /// 64 hex chars = 32-byte AES-256-GCM master key for provider secrets.
    pub master_key_hex: String,
    pub jwt_secret: String,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn env_req(name: &str) -> anyhow::Result<String> {
    std::env::var(name).map_err(|_| anyhow::anyhow!("missing required env var {name}"))
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let cfg = Self {
            bind_addr: env_or("GUILD_BIND_ADDR", "0.0.0.0:8080"),
            database_url: env_or(
                "GUILD_DATABASE_URL",
                "postgres://guild:guild@localhost:5432/guild",
            ),
            clickhouse_url: env_or("GUILD_CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_database: env_or("GUILD_CLICKHOUSE_DATABASE", "guild"),
            master_key_hex: env_req("GUILD_MASTER_KEY_HEX")?,
            jwt_secret: env_req("GUILD_JWT_SECRET")?,
        };
        cfg.validate()?;
        Ok(cfg)
    }

    /// For tests: builds a config without requiring real env vars.
    pub fn test_config() -> Self {
        Self {
            bind_addr: "127.0.0.1:0".into(),
            database_url: "postgres://placeholder".into(),
            clickhouse_url: "http://placeholder:8123".into(),
            clickhouse_database: "guild".into(),
            master_key_hex: "00".repeat(32),
            jwt_secret: "test-secret".into(),
        }
    }

    pub fn master_key(&self) -> anyhow::Result<[u8; 32]> {
        let bytes = hex::decode(&self.master_key_hex)?;
        bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("master key must decode to 32 bytes"))
    }

    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.master_key().is_ok(),
            "GUILD_MASTER_KEY_HEX must be 64 hex chars"
        );
        Ok(())
    }
}
