//! Workspace settings API: display name and logo of the caller's
//! organization (the "workspace" in the UI). The logo endpoint is public —
//! `<img>` tags cannot send bearer tokens, and a logo is not sensitive.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

/// Accepted logo content types → file extension in the object key.
const LOGO_TYPES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/svg+xml", "svg"),
];
const LOGO_MAX_BYTES: usize = 2 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/org", axum::routing::get(get_org).put(set_name))
        .route(
            "/api/v1/org/logo",
            axum::routing::put(upload_logo).delete(clear_logo),
        )
        .route(
            "/api/v1/orgs/{org_id}/logo",
            axum::routing::get(download_logo),
        )
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.role != "admin" {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

async fn get_org(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let org = store.orgs().get(user.0.org_id).await?;
    Ok(Json(json!({
        "name": org.name,
        "logo_url": org.logo_url,
    })))
}

async fn set_name(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing name"))?;
    if name.len() > 100 {
        return Err(ApiError::bad_request("name too long (max 100 chars)"));
    }
    let store = state.store().await?;
    store.orgs().set_name(user.0.org_id, name).await?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

async fn upload_logo(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let content_type = q
        .get("content_type")
        .map(String::as_str)
        .unwrap_or("image/png");
    let ext = LOGO_TYPES
        .iter()
        .find(|(ct, _)| *ct == content_type)
        .map(|(_, ext)| *ext)
        .ok_or_else(|| {
            ApiError::bad_request("unsupported image type (png, jpeg, webp, gif, svg)")
        })?;
    if body.is_empty() {
        return Err(ApiError::bad_request("empty upload"));
    }
    if body.len() > LOGO_MAX_BYTES {
        return Err(ApiError::bad_request("logo too large (max 2 MiB)"));
    }
    let key = format!("orgs/{}/logo.{ext}", user.0.org_id);
    state
        .objects()
        .await?
        .put(&key, body.to_vec())
        .await
        .map_err(|e| ApiError::internal(format!("object store write failed: {e}")))?;
    let url = format!("/api/v1/orgs/{}/logo", user.0.org_id);
    let store = state.store().await?;
    store.orgs().set_logo_url(user.0.org_id, Some(&url)).await?;
    Ok(Json(json!({ "ok": true, "logo_url": url })))
}

async fn clear_logo(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let store = state.store().await?;
    store.orgs().set_logo_url(user.0.org_id, None).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Serves the logo bytes publicly. A stale object after a re-upload with a
/// different extension 404s only until the new key is written — the URL is
/// stable, so <img> tags never need refreshing.
async fn download_logo(
    State(state): State<AppState>,
    axum::extract::Path(org_id): axum::extract::Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.store().await?;
    let org = store.orgs().get(org_id).await?;
    let Some(_url) = org.logo_url else {
        return Err(ApiError::not_found("no logo set"));
    };
    // Read whatever extension currently exists (re-uploads may switch type).
    for (_, ext) in LOGO_TYPES {
        let key = format!("orgs/{org_id}/logo.{ext}");
        if let Ok(bytes) = state.objects().await?.get(&key).await {
            let ct = LOGO_TYPES
                .iter()
                .find(|(_, e)| e == ext)
                .map(|(ct, _)| *ct)
                .unwrap_or("application/octet-stream");
            return Ok((
                [
                    (CONTENT_TYPE, ct.to_string()),
                    (
                        axum::http::header::CACHE_CONTROL,
                        "public, max-age=60".to_string(),
                    ),
                ],
                bytes,
            ));
        }
    }
    Err(ApiError::not_found("no logo set"))
}
