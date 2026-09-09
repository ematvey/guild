pub mod error;

use crate::state::AppState;
use axum::routing::get;
use axum::{Json, Router};

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/api/v1/health",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .fallback(error::not_found)
        .with_state(state)
}
