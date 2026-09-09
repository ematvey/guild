pub mod config;
pub mod crypto;
pub mod http;
pub mod s3;
pub mod signing;
pub mod state;
pub mod store;
pub mod usage;
pub mod worker;

pub use http::build_router;

pub async fn main_entry() -> anyhow::Result<()> {
    let cfg = config::Config::from_env()?;
    let bind_addr = cfg.bind_addr.clone();
    let role = cfg.role.clone();
    let state = state::AppState::from_config(cfg);

    let api_task = async {
        let app = build_router(state.clone());
        let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
        axum::serve(listener, app).await?;
        Ok(())
    };
    let worker_task = async { worker::restate::spawn_worker(state.clone()).await };

    match role.as_str() {
        "api" => api_task.await,
        "worker" => worker_task.await,
        "all" => tokio::try_join!(api_task, worker_task).map(|_| ()),
        other => anyhow::bail!("unknown GUILD_ROLE {other:?} (api | worker | all)"),
    }
}

#[cfg(feature = "test-support")]
pub mod test_support;
