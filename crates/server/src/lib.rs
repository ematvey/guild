pub mod config;
pub mod crypto;
pub mod http;
pub mod s3;
pub mod state;
pub mod store;
pub mod usage;

pub use http::build_router;

pub async fn main_entry() -> anyhow::Result<()> {
    let cfg = config::Config::from_env()?;
    let bind_addr = cfg.bind_addr.clone();
    let state = state::AppState::from_config(cfg);
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(feature = "test-support")]
pub mod test_support;
