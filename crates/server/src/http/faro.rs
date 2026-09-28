//! Faro telemetry collector proxy: the web UI (same origin) and the desktop
//! webview (paired server URL) POST Faro Web SDK payloads to /faro/collect;
//! the server forwards them to the org's Faro receiver (GUILD_FARO_URL,
//! default the shared collector on the host). Intentionally unauthenticated —
//! telemetry must work pre-login and pre-pairing — and fire-and-forget: an
//! unreachable collector answers 202 so clients never surface telemetry
//! errors.

use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use std::sync::OnceLock;
use std::time::Duration;

/// Upstream timeout: telemetry is best-effort; never hold a browser long.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(5);
/// Faro payloads are small (batched browser events); hard cap anyway.
const MAX_BODY: usize = 1024 * 1024;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(UPSTREAM_TIMEOUT)
            .build()
            .expect("reqwest client")
    })
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/faro/collect", axum::routing::post(collect))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
}

async fn collect(State(state): State<AppState>, body: Bytes) -> Response {
    let url = state.config.faro_url.trim();
    if url.is_empty() {
        // Telemetry disabled at the server: accept and drop quietly.
        return StatusCode::ACCEPTED.into_response();
    }
    match http_client()
        .post(url)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )
        .body(body)
        .send()
        .await
    {
        Ok(res) => StatusCode::from_u16(res.status().as_u16())
            .unwrap_or(StatusCode::ACCEPTED)
            .into_response(),
        // Collector down is a server ops problem, not an app problem.
        Err(_) => StatusCode::ACCEPTED.into_response(),
    }
}
