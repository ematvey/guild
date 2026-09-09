//! Client release downloads (admin upload → user download via signed URLs).

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::http::gateway::AdminUser;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/admin/releases",
            axum::routing::post(upload).get(admin_list),
        )
        .route(
            "/api/v1/admin/releases/{id}",
            axum::routing::delete(delete_one),
        )
        .route("/api/v1/releases", axum::routing::get(list))
        .route(
            "/api/v1/releases/{id}/download-url",
            axum::routing::get(download_url),
        )
        .route(
            "/api/v1/releases/{id}/download",
            axum::routing::get(download),
        )
}

fn object_key(version: &str, kind: &str, platform: &str, id: Uuid, filename: &str) -> String {
    format!("releases/{version}/{kind}/{platform}/{id}/{filename}")
}

/// Short-lived signed download URL: `/dl?exp=<unix>&sig=<hmac(id,exp)>`.
fn sign_download(state: &AppState, id: Uuid, exp: i64) -> String {
    use hmac::{Hmac, Mac};
    let mut mac =
        Hmac::<sha2::Sha256>::new_from_slice(state.config.jwt_secret.as_bytes()).expect("hmac key");
    mac.update(format!("{id}:{exp}").as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    format!("/api/v1/releases/{id}/download?exp={exp}&sig={sig}")
}

fn verify_signature(state: &AppState, id: Uuid, exp: i64, sig: &str) -> Result<(), ApiError> {
    use hmac::{Hmac, Mac};
    if exp < chrono::Utc::now().timestamp() {
        return Err(ApiError::unauthorized("download link expired"));
    }
    let mut mac =
        Hmac::<sha2::Sha256>::new_from_slice(state.config.jwt_secret.as_bytes()).expect("hmac key");
    mac.update(format!("{id}:{exp}").as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    if expected != sig {
        return Err(ApiError::unauthorized("bad download signature"));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct SigQuery {
    exp: i64,
    sig: String,
}

async fn upload(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let version = q
        .get("version")
        .ok_or_else(|| ApiError::bad_request("missing version"))?;
    if version.is_empty()
        || version.len() > 64
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(ApiError::bad_request("bad version"));
    }
    let kind = q
        .get("kind")
        .ok_or_else(|| ApiError::bad_request("missing kind"))?;
    if kind != "cli" && kind != "desktop" {
        return Err(ApiError::bad_request("kind must be cli or desktop"));
    }
    let platform = q
        .get("platform")
        .ok_or_else(|| ApiError::bad_request("missing platform"))?;
    if !crate::store::releases::valid_platform(platform) {
        return Err(ApiError::bad_request("unknown platform"));
    }
    let filename = crate::store::releases::safe_filename(
        q.get("filename")
            .ok_or_else(|| ApiError::bad_request("missing filename"))?,
    )
    .ok_or_else(|| ApiError::bad_request("bad filename"))?;
    if body.is_empty() {
        return Err(ApiError::bad_request("empty body"));
    }
    if body.len() > 512 * 1024 * 1024 {
        return Err(ApiError::bad_request("artifact too large (max 512MiB)"));
    }
    let content_type = q
        .get("content_type")
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".into());
    let notes = q.get("notes").cloned().unwrap_or_default();

    let id = Uuid::now_v7();
    let key = object_key(version, kind, platform, id, &filename);
    state
        .objects()
        .await?
        .put(&key, body.to_vec())
        .await
        .map_err(|e| ApiError::internal(format!("object store write failed: {e}")))?;
    let row = state
        .store()
        .await?
        .releases()
        .create(
            id,
            version,
            kind,
            platform,
            &filename,
            &content_type,
            body.len() as i64,
            &crate::store::releases::sha256_hex(&body),
            &notes,
            &key,
        )
        .await?;
    Ok(Json(
        serde_json::to_value(&row).expect("release serializes"),
    ))
}

async fn admin_list(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let rows = state.store().await?.releases().list().await?;
    Ok(Json(json!({ "releases": rows })))
}

async fn delete_one(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let row = store.releases().delete(id).await?;
    let key = object_key(
        &row.version,
        &row.kind,
        &row.platform,
        row.id,
        &row.filename,
    );
    let _ = state.objects().await?.delete(&key).await;
    Ok(Json(json!({})))
}

async fn list(State(state): State<AppState>, _user: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = state.store().await?.releases().list().await?;
    Ok(Json(json!({ "releases": rows })))
}

/// Hands out a short-lived signed URL usable from plain <a href> links.
async fn download_url(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    state.store().await?.releases().get(id).await?;
    let exp = chrono::Utc::now().timestamp() + 3600;
    Ok(Json(json!({
        "url": sign_download(&state, id, exp),
        "expires_at": exp,
    })))
}

/// Accepts either a valid signature (query) or a session bearer token.
async fn download(
    State(state): State<AppState>,
    path: Path<Uuid>,
    Query(sig): Query<SigQuery>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let id = path.0;
    let signed = verify_signature(&state, id, sig.exp, &sig.sig).is_ok();
    if !signed {
        // fall back to session bearer auth (UIs that fetch with credentials)
        let token = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::unauthorized("expired link and no bearer token"))?;
        state
            .store()
            .await?
            .identity()
            .validate_session(token)
            .await?;
    }
    let store = state.store().await?;
    let row = store.releases().get(id).await?;
    let key = object_key(
        &row.version,
        &row.kind,
        &row.platform,
        row.id,
        &row.filename,
    );
    let bytes = state
        .objects()
        .await?
        .get(&key)
        .await
        .map_err(|e| ApiError::internal(format!("object store read failed: {e}")))?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, row.content_type.clone()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", row.filename),
            ),
        ],
        bytes,
    ))
}
