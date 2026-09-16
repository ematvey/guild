pub mod admin;
pub mod agents;
pub mod api_keys;
pub mod attachments;
pub mod auth;
pub mod chats;
pub mod error;
pub mod events;
pub mod gateway;
pub mod integration_tools;
pub mod internal;
pub mod oidc;
pub mod openai;
pub mod registry;
pub mod releases;
pub mod usage;
pub mod web;
pub mod ws;

use crate::state::AppState;
use axum::extract::Request;
use axum::routing::get;
use axum::{Json, Router};

/// Access log for every request (method, path, status, duration) at info
/// level — the primary operational signal for the API.
async fn log_requests(req: Request, next: axum::middleware::Next) -> axum::response::Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = std::time::Instant::now();
    let res = next.run(req).await;
    tracing::info!(
        method = %method,
        path = %path,
        status = res.status().as_u16(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "http request"
    );
    res
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/api/v1/health",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .merge(auth::routes())
        .merge(crate::http::ws::routes())
        .merge(chats::routes())
        .merge(gateway::routes())
        .merge(registry::routes())
        .merge(admin::routes())
        .merge(agents::routes())
        .merge(attachments::routes())
        .merge(events::routes())
        .merge(oidc::routes())
        .merge(api_keys::routes())
        .merge(openai::routes())
        .merge(integration_tools::routes())
        .merge(releases::routes())
        .merge(internal::routines_routes())
        .merge(internal::internal_routes())
        .merge(usage::routes())
        .fallback(web::fallback)
        .layer(axum::middleware::from_fn(log_requests))
        // Origin allow-list: same-origin requests don't hit CORS at all;
        // the desktop webview (tauri://localhost on macOS,
        // http(s)://tauri.localhost elsewhere) and the vite dev server are
        // the only cross-origin clients. Blanket-permissive CORS let any
        // page drive an authenticated session's API from a browser.
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin([
                    "tauri://localhost"
                        .parse::<axum::http::HeaderValue>()
                        .unwrap(),
                    "http://tauri.localhost".parse().unwrap(),
                    "https://tauri.localhost".parse().unwrap(),
                    "http://localhost:1420".parse().unwrap(),
                ])
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        .with_state(state)
}
