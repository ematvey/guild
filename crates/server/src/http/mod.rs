pub mod admin;
pub mod agents;
pub mod api_keys;
pub mod auth;
pub mod chats;
pub mod error;
pub mod gateway;
pub mod internal;
pub mod oidc;
pub mod openai;
pub mod registry;
pub mod usage;
pub mod web;

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
        .merge(admin::routes())
        .merge(agents::routes())
        .merge(oidc::routes())
        .merge(api_keys::routes())
        .merge(openai::routes())
        .merge(internal::routines_routes())
        .merge(internal::internal_routes())
        .merge(usage::routes())
        .fallback(web::fallback)
        .with_state(state)
}
