pub mod auth;
pub mod chats;
pub mod error;
pub mod gateway;
pub mod registry;

use crate::state::AppState;
use axum::routing::get;
use axum::{Json, Router};

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/api/v1/health",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .merge(auth::routes())
        .merge(chats::routes())
        .merge(gateway::routes())
        .merge(registry::routes())
        .fallback(error::not_found)
        .with_state(state)
}
