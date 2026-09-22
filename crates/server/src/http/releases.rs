//! Client release downloads (admin upload → user download via signed URLs).

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::http::gateway::AdminUser;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    // artifact uploads are large: lift the 2MiB default body limit for them
    let uploads = Router::new()
        .route("/api/v1/admin/releases", axum::routing::post(upload))
        .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024));
    Router::new()
        .merge(uploads)
        .route("/api/v1/admin/releases", axum::routing::get(admin_list))
        .route(
            "/api/v1/admin/releases/{id}",
            axum::routing::delete(delete_one),
        )
        .route("/api/v1/releases", axum::routing::get(list))
        .route(
            "/api/v1/releases/signing-key",
            axum::routing::get(signing_key),
        )
        .route(
            "/api/v1/releases/{id}/download-url",
            axum::routing::get(download_url),
        )
        .route(
            "/api/v1/releases/{id}/download",
            axum::routing::get(download),
        )
        .route(
            "/api/v1/updates/latest.json",
            axum::routing::get(updater_manifest),
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
    // Constant-time: the signature gates authenticated downloads.
    use subtle::ConstantTimeEq;
    if !bool::from(expected.as_bytes().ct_eq(sig.as_bytes())) {
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
    let updater_signature = q.get("updater_sig").cloned().unwrap_or_default();

    let id = Uuid::now_v7();
    let key = object_key(version, kind, platform, id, &filename);
    state
        .objects()
        .await?
        .put(&key, body.to_vec())
        .await
        .map_err(|e| ApiError::internal(format!("object store write failed: {e}")))?;
    // ed25519-sign the artifact digest so downloads are verifiable offline
    let digest = crate::store::releases::sha256_hex(&body);
    let mut digest_bytes = [0u8; 32];
    hex::decode_to_slice(&digest, &mut digest_bytes)
        .map_err(|e| ApiError::internal(format!("digest decode failed: {e}")))?;
    let keypair = crate::signing::signing_key(&state)
        .await
        .map_err(ApiError::from)?;
    let signature = crate::signing::sign_digest(&keypair, &digest_bytes);
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
            &digest,
            &signature,
            &updater_signature,
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

/// Public ed25519 verifying key for artifact signatures.
async fn signing_key(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let keypair = crate::signing::signing_key(&state)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(json!({
        "public_key": hex::encode(keypair.verifying_key().as_bytes()),
        "algorithm": "ed25519",
        "signs": "sha256 digest of the artifact (hex)",
    })))
}

/// Tauri desktop auto-updater manifest (`GET /api/v1/updates/latest.json`).
/// Public: static-JSON format from the updater plugin, pointing at
/// short-lived signed download URLs. Only platforms with a signed updater
/// artifact for the newest desktop version are listed.
async fn updater_manifest(State(state): State<AppState>) -> Result<Response, ApiError> {
    let rows = state.store().await?.releases().list().await?;
    let mut latest: Option<(String, chrono::DateTime<chrono::Utc>)> = None;
    for r in &rows {
        if r.kind != "desktop" || r.updater_signature.is_empty() {
            continue;
        }
        if latest
            .as_ref()
            .is_none_or(|(cur, _)| version_gt(&r.version, cur))
        {
            latest = Some((r.version.clone(), r.created_at));
        }
    }
    let Some((version, pub_date)) = latest else {
        return Ok(axum::http::StatusCode::NO_CONTENT.into_response());
    };
    let exp = chrono::Utc::now().timestamp() + 86_400;
    // the plugin needs absolute URLs: build them from the configured API base
    // URL — the request's Host header is attacker-controlled on the
    // direct-HTTP deployment, so it must not shape download origins
    let base = state.config.api_url.trim_end_matches('/').to_string();
    let mut platforms = serde_json::Map::new();
    for target in [
        "linux-x86_64",
        "windows-x86_64",
        "darwin-x86_64",
        "darwin-aarch64",
    ] {
        let Some(row) = rows.iter().find(|r| {
            r.kind == "desktop"
                && r.version == version
                && r.platform == target
                && !r.updater_signature.is_empty()
                && updater_artifact(target, &r.filename)
        }) else {
            continue;
        };
        platforms.insert(
            target.to_string(),
            json!({
                "signature": row.updater_signature,
                "url": format!("{}{}", base, sign_download(&state, row.id, exp)),
            }),
        );
    }
    if platforms.is_empty() {
        return Ok(axum::http::StatusCode::NO_CONTENT.into_response());
    }
    let notes = rows
        .iter()
        .find(|r| r.version == version && !r.notes.is_empty())
        .map(|r| r.notes.clone())
        .unwrap_or_default();
    Ok(Json(json!({
        "version": version,
        "notes": notes,
        "pub_date": pub_date.to_rfc3339(),
        "platforms": platforms,
    }))
    .into_response())
}

/// Whether `filename` is the updater bundle for `target` (plugin artifact kinds).
fn updater_artifact(target: &str, filename: &str) -> bool {
    match target {
        "linux-x86_64" => filename.ends_with(".AppImage"),
        "windows-x86_64" => filename.ends_with("-setup.exe"),
        "darwin-x86_64" | "darwin-aarch64" => filename.ends_with(".app.tar.gz"),
        _ => false,
    }
}

/// Semver ordering (semver.org §11): major/minor/patch numerically; a
/// prerelease ranks BELOW its release; prerelease identifiers compare
/// numerically when numeric, ASCII lexically otherwise, numeric <
/// alphanumeric, and a longer identifier set outranks a prefix; build
/// metadata is ignored. `gt(a, b)` = a > b strictly.
fn version_gt(a: &str, b: &str) -> bool {
    let (core_a, pre_a) = split_prerelease(a);
    let (core_b, pre_b) = split_prerelease(b);
    let nums = |core: &str| -> Vec<u64> {
        core
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (na, nb) = (nums(&core_a), nums(&core_b));
    for i in 0..na.len().max(nb.len()) {
        match na.get(i).unwrap_or(&0).cmp(nb.get(i).unwrap_or(&0)) {
            std::cmp::Ordering::Greater => return true,
            std::cmp::Ordering::Less => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    match (pre_a, pre_b) {
        (None, None) => false,
        // a release outranks any prerelease of the same core version.
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(pa), Some(pb)) => {
            let ids: Vec<Vec<&str>> =
                [pa, pb].iter().map(|p| p.split('.').collect()).collect();
            for i in 0..ids[0].len().max(ids[1].len()) {
                match (ids[0].get(i), ids[1].get(i)) {
                    (Some(x), Some(y)) => {
                        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
                            (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                            (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                            (Err(_), Err(_)) => x.cmp(y),
                        };
                        match ord {
                            std::cmp::Ordering::Greater => return true,
                            std::cmp::Ordering::Less => return false,
                            std::cmp::Ordering::Equal => {}
                        }
                    }
                    // All shared identifiers equal: the longer set outranks.
                    (Some(_), None) => return true,
                    (None, Some(_)) => return false,
                    (None, None) => return false,
                }
            }
            false
        }
    }
}

/// Splits `major.minor.patch[-prerelease][+build]`; build metadata is
/// dropped, the prerelease (if any) is returned separately.
fn split_prerelease(v: &str) -> (String, Option<&str>) {
    let no_build = v.split('+').next().unwrap_or(v);
    match no_build.split_once('-') {
        Some((core, pre)) => (core.to_string(), Some(pre)),
        None => (no_build.to_string(), None),
    }
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

#[cfg(test)]
mod tests {
    use super::version_gt;

    #[test]
    fn version_gt_orders_numerically_and_ignores_build_metadata() {
        assert!(version_gt("1.0.1", "1.0.0"));
        assert!(version_gt("2.0.0", "1.9.9"));
        assert!(version_gt("1.10.0", "1.9.0"), "numeric, not lexical");
        assert!(!version_gt("1.0.0", "1.0.0"));
        assert!(!version_gt("1.0.0", "1.0.1"));
        // build metadata is ignored: equal precedence either way
        assert!(!version_gt("1.0.0+build.9", "1.0.0"));
        assert!(!version_gt("1.0.0", "1.0.0+build.9"));
    }

    #[test]
    fn version_gt_ranks_a_prerelease_below_its_release() {
        assert!(!version_gt("1.0.0-beta", "1.0.0"));
        assert!(version_gt("1.0.0", "1.0.0-beta"));
        // Prerelease identifiers: numeric < alphanumeric, numeric numeric.
        assert!(version_gt("1.0.0-beta.2", "1.0.0-beta.1"));
        assert!(!version_gt("1.0.0-alpha", "1.0.0-beta"), "alpha < beta lexically");
        // numeric identifiers rank BELOW alphanumeric ones
        assert!(!version_gt("1.0.0-1", "1.0.0-alpha"));
        assert!(version_gt("1.0.0-alpha", "1.0.0-1"));
        assert!(version_gt("1.0.0-beta.2.1", "1.0.0-beta.2"), "longer set wins");
        // Prereleases of different cores still follow the core.
        assert!(version_gt("1.1.0-beta", "1.0.0"));
        assert!(!version_gt("1.0.0-beta", "1.1.0-alpha"));
    }
}
