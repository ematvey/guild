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
    pub s3_url: String,
    pub s3_bucket: String,
    pub s3_access_key_id: String,
    pub s3_secret_access_key: String,
    pub restate_url: String,
    /// Restate admin API (endpoint registration); defaults to restate_url.
    pub restate_admin_url: String,
    /// Base URL other components use to reach this server's API.
    pub api_url: String,
    /// api | worker | all (default all).
    pub role: String,
    /// Root for server-side workspace execution backends (M6).
    pub data_dir: String,
    /// Allow run_command in server-side agent sessions (default: off).
    pub allow_shell_tools: bool,
    /// Static bearer token for /api/v1/internal/* (worker -> server).
    pub internal_token: Option<String>,
    pub worker_bind: String,
    pub worker_advertised_url: String,
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
            s3_url: env_or("GUILD_S3_URL", "http://localhost:9000"),
            s3_bucket: env_or("GUILD_S3_BUCKET", "guild"),
            s3_access_key_id: env_or("GUILD_S3_ACCESS_KEY_ID", "minioadmin"),
            s3_secret_access_key: env_or("GUILD_S3_SECRET_ACCESS_KEY", "minioadmin"),
            restate_url: env_or("GUILD_RESTATE_URL", "http://localhost:8080"),
            restate_admin_url: std::env::var("GUILD_RESTATE_ADMIN_URL")
                .unwrap_or_else(|_| env_or("GUILD_RESTATE_URL", "http://localhost:8080")),
            api_url: env_or("GUILD_API_URL", "http://localhost:8080"),
            role: env_or("GUILD_ROLE", "all"),
            data_dir: env_or("GUILD_DATA_DIR", "./data"),
            allow_shell_tools: std::env::var("GUILD_ALLOW_SHELL_TOOLS")
                .is_ok_and(|v| v == "1" || v == "true"),
            internal_token: std::env::var("GUILD_INTERNAL_TOKEN").ok(),
            worker_bind: env_or("GUILD_WORKER_BIND", "0.0.0.0:9080"),
            worker_advertised_url: env_or("GUILD_WORKER_ADVERTISED_URL", "http://localhost:9080"),
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
            s3_url: "http://placeholder:9000".into(),
            s3_bucket: "guild".into(),
            s3_access_key_id: "minioadmin".into(),
            s3_secret_access_key: "minioadmin".into(),
            restate_url: "http://placeholder:8080".into(),
            restate_admin_url: "http://placeholder:9070".into(),
            api_url: "http://localhost:8080".into(),
            role: "all".into(),
            data_dir: "./data".into(),
            allow_shell_tools: false,
            internal_token: Some("test-internal".into()),
            worker_bind: "127.0.0.1:0".into(),
            worker_advertised_url: "http://localhost:9080".into(),
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
