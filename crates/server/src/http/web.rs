//! Embedded web UI (spec §4.7): static bundle served by axum; non-API GETs
//! fall back to index.html (SPA routing). When the frontend hasn't been
//! built, API routes still work and pages return a 503 hint.

use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

/// The shared chat app (tauri frontend) at `/`.
static CHAT_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/desktop/dist");
/// The admin console (separate app) at `/admin`.
static WEB_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/webui/dist");

fn serve_file(dist: &include_dir::Dir<'static>, path: &str) -> Option<Response> {
    let file = dist.get_file(path.trim_start_matches('/'))?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some(([(header::CONTENT_TYPE, mime.as_ref())], file.contents()).into_response())
}

pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return crate::http::error::not_found().await.into_response();
    }
    // /admin -> the admin console app (separate frontend, shared auth)
    if path == "/admin" || path.starts_with("/admin/") {
        let sub = path.trim_start_matches("/admin");
        if sub.is_empty() || sub == "/" || !sub.contains('.') {
            if let Some(resp) = serve_file(&WEB_DIST, "index.html") {
                return resp;
            }
            return not_built("admin UI not built — run `npm --prefix apps/webui run build`");
        }
        return match serve_file(&WEB_DIST, sub) {
            Some(resp) => resp,
            None => not_built("admin UI not built — run `npm --prefix apps/webui run build`"),
        };
    }
    // everything else -> the shared chat app
    if path == "/" || !path.contains('.') {
        if let Some(resp) = serve_file(&CHAT_DIST, "index.html") {
            return resp;
        }
        return not_built("chat app not built — run `npm --prefix apps/desktop run build`");
    }
    match serve_file(&CHAT_DIST, path) {
        Some(resp) => resp,
        None => not_built("chat app not built — run `npm --prefix apps/desktop run build`"),
    }
}

fn not_built(hint: &str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, hint.to_string()).into_response()
}
