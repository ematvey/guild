//! Embedded web UI (spec §4.7): static bundle served by axum; non-API GETs
//! fall back to index.html (SPA routing). When the frontend hasn't been
//! built, API routes still work and pages return a 503 hint.

use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// The web app (tauri frontend) at `/`.
static CHAT_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/desktop/dist");

/// Base CSP (no script directives): websockets for the live feed, no remote
/// image/script channels for model/tool-controlled content.
const WEB_CSP_BASE: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; \
    font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' data: blob:; \
    connect-src 'self' ws: wss:";

/// CSP for an HTML document: `script-src 'self'` plus a sha256 hash for
/// every inline `<script>` block in the served bytes. The hashes are
/// computed from the bytes actually served at request time, so the policy
/// can never drift from the bundle (index.html carries the pre-paint theme
/// script, the iOS pinch-zoom guard and the service-worker unregister —
/// a bare `'self'` would block all three).
fn html_csp(html: &[u8]) -> String {
    let mut script_src = String::from("script-src 'self'");
    let body = std::str::from_utf8(html).unwrap_or("");
    let mut rest = body;
    while let Some(open) = rest.find("<script") {
        let tag_end = match rest[open..].find('>') {
            Some(i) => open + i,
            None => break,
        };
        let tag = &rest[open..tag_end];
        let after_close = match rest[tag_end..].find("</script>") {
            Some(i) => tag_end + i + "</script>".len(),
            None => break,
        };
        // An external script (src=) needs no hash; only inline bodies do.
        if !tag.contains(" src=") {
            let digest = Sha256::digest(&rest[tag_end + 1..after_close - "</script>".len()]);
            script_src.push_str(" 'sha256-");
            script_src.push_str(&base64::engine::general_purpose::STANDARD.encode(digest));
            script_src.push('\'');
        }
        rest = &rest[after_close..];
    }
    format!("{WEB_CSP_BASE}; {script_src}")
}

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
    let csp = if mime.type_() == "text" && mime.subtype() == "html" {
        html_csp(file.contents())
    } else {
        format!("{WEB_CSP_BASE}; script-src 'self'")
    };
    Some(
        (
            [
                (header::CONTENT_TYPE, mime.as_ref()),
                (header::CACHE_CONTROL, cache),
                (header::CONTENT_SECURITY_POLICY, csp.as_str()),
            ],
            file.contents(),
        )
            .into_response(),
    )
}

pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return crate::http::error::not_found().await.into_response();
    }
    // A real bundled file wins; every other non-API path is an SPA route and
    // serves index.html — including paths with dots (model ids, provider
    // slugs), which the old contains('.') shortcut sent to a 404.
    if path != "/" {
        if let Some(resp) = serve_file(&CHAT_DIST, path) {
            return resp;
        }
    }
    if let Some(resp) = serve_file(&CHAT_DIST, "index.html") {
        return resp;
    }
    not_built("chat app not built — run `npm --prefix apps/desktop run build`")
}

fn not_built(hint: &str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, hint.to_string()).into_response()
}
