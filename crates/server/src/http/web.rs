//! Embedded web UI (spec §4.7): static bundle served by axum; non-API GETs
//! fall back to index.html (SPA routing). When the frontend hasn't been
//! built, API routes still work and pages return a 503 hint.

use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

/// The web app (tauri frontend) at `/`.
static CHAT_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/desktop/dist");

fn serve_file(dist: &include_dir::Dir<'static>, path: &str) -> Option<Response> {
    let file = dist.get_file(path.trim_start_matches('/'))?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Hashed bundle assets are immutable; everything else (index.html, sw.js)
    // must revalidate on every load or deploys leave stale shells behind.
    let cache = if path.contains("/assets/") && path.contains(".") && !path.ends_with(".html") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Some((
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        file.contents(),
    )
        .into_response())
}

/// Missing file: an honest 404 when the dist is actually built; the 503
/// "not built" hint only when the dist is empty (see spec §4.7).
fn not_built_or_404(dist: &include_dir::Dir<'static>, hint: &str) -> Response {
    if dist.get_file("index.html").is_some() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    not_built(hint)
}

pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return crate::http::error::not_found().await.into_response();
    }
    // everything else -> the web app
    if path == "/" || !path.contains('.') {
        if let Some(resp) = serve_file(&CHAT_DIST, "index.html") {
            return resp;
        }
        return not_built("chat app not built — run `npm --prefix apps/desktop run build`");
    }
    match serve_file(&CHAT_DIST, path) {
        Some(resp) => resp,
        None => not_built_or_404(&CHAT_DIST, "chat app not built — run `npm --prefix apps/desktop run build`"),
    }
}

fn not_built(hint: &str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, hint.to_string()).into_response()
}
