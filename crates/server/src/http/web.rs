//! Embedded web UI (spec §4.7): static bundle served by axum; non-API GETs
//! fall back to index.html (SPA routing). When the frontend hasn't been
//! built, API routes still work and pages return a 503 hint.

use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

static WEB_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/webui/dist");

fn serve_file(path: &str) -> Option<Response> {
    let file = WEB_DIST.get_file(path.trim_start_matches('/'))?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some(([(header::CONTENT_TYPE, mime.as_ref())], file.contents()).into_response())
}

pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return crate::http::error::not_found().await.into_response();
    }
    if path == "/" || !path.contains('.') {
        // SPA: index.html for routes
        if let Some(resp) = serve_file("index.html") {
            return resp;
        }
        return not_built();
    }
    match serve_file(path) {
        Some(resp) => resp,
        None => not_built(),
    }
}

fn not_built() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "web UI not built — run `npm --prefix apps/webui run build`",
    )
        .into_response()
}
