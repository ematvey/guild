//! Registry API: publish, list, versions, review, download (spec §4.4).
//! Bundles are tar.gz; bytes live in object storage, metadata in Postgres.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::http::gateway::AdminUser;
use crate::http::internal::new_hook_token;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::{Json, Router};
use guild_core::registry::validate_manifest;
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub const MAX_BUNDLE_BYTES: usize = 50 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/registry/{kind}",
            axum::routing::post(publish).get(list_items),
        )
        .route(
            "/api/v1/registry/{kind}/{slug}",
            axum::routing::get(item_versions),
        )
        .route(
            "/api/v1/registry/{kind}/{slug}/{version}/bundle",
            axum::routing::get(download),
        )
        .route(
            "/api/v1/registry/{kind}/{slug}/install",
            axum::routing::post(install),
        )
        .route(
            "/api/v1/registry/{kind}/{slug}/review",
            axum::routing::post(review),
        )
}

fn valid_kind(kind: &str) -> Result<(), ApiError> {
    if matches!(kind, "skill" | "mcp" | "integration") {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "kind must be skill, mcp, or integration",
        ))
    }
}

fn object_key(org_id: Uuid, kind: &str, slug: &str, version: &str, sha256: &str) -> String {
    // Content-addressed: a republish with different bundle bytes lands at a
    // new key, so superseded and supersede-attempt bundles are never
    // overwritten in place.
    format!("registry/{org_id}/{kind}/{slug}/{version}/{sha256}.tar.gz")
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}

async fn publish(
    State(state): State<AppState>,
    user: AuthUser,
    Path(kind): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    valid_kind(&kind)?;
    let slug = q
        .get("slug")
        .ok_or_else(|| ApiError::bad_request("missing slug query param"))?;
    let version = q
        .get("version")
        .ok_or_else(|| ApiError::bad_request("missing version query param"))?;
    if body.len() > MAX_BUNDLE_BYTES {
        return Err(ApiError::bad_request("bundle exceeds 50 MiB"));
    }

    // parse + validate the bundle's manifest (extract into a throwaway dir)
    let inspect = std::env::temp_dir().join(format!("guild-inspect-{}", Uuid::now_v7()));
    let parsed = match guild_core::registry::extract(&body, &inspect) {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&inspect);
            return Err(ApiError::bad_request(format!("invalid bundle: {e}")));
        }
    };
    let has_skill_md = inspect.join("SKILL.md").is_file();
    let _ = std::fs::remove_dir_all(&inspect);

    if let Err(e) = validate_manifest(&parsed) {
        return Err(ApiError::bad_request(e.to_string()));
    }
    if kind == "integration" {
        if let Err(e) = guild_core::registry::validate_v2(&parsed) {
            return Err(ApiError::bad_request(e.to_string()));
        }
    }
    if parsed.kind != kind {
        return Err(ApiError::bad_request(format!(
            "manifest kind {} does not match path kind {kind}",
            parsed.kind
        )));
    }
    if parsed.slug != *slug {
        return Err(ApiError::bad_request(format!(
            "manifest slug {} does not match query slug {slug}",
            parsed.slug
        )));
    }
    if parsed.version != *version {
        return Err(ApiError::bad_request(format!(
            "manifest version {} does not match query version {version}",
            parsed.version
        )));
    }
    if kind == "skill" && !has_skill_md {
        return Err(ApiError::bad_request(
            "skill bundles must contain SKILL.md at the root",
        ));
    }

    let sha256 = sha256_hex(&body);
    let key = object_key(user.0.org_id, &kind, slug, version, &sha256);

    let store = state.store().await?;
    let manifest_json = serde_json::to_value(&parsed).expect("manifest serializes");
    // Metadata first: only an accepted upsert (new version, unchanged
    // republish) commits a row — a superseded publish is refused before any
    // bundle bytes land, so the old release's object stays intact.
    store
        .registry()
        .upsert_version(
            user.0.org_id,
            &kind,
            slug,
            version,
            &parsed.description,
            manifest_json,
            &key,
            &sha256,
            user.0.id,
        )
        .await?;
    // The content-addressed key was accepted by upsert_version; the bytes
    // are immutable and idempotent to re-write, so a failed put only leaves
    // the object missing until the publish is retried — nothing serves
    // attacker content through it (the binding requires the stored hash,
    // which equals the key's).
    let objects = state.objects().await?;
    objects
        .put(&key, body.to_vec())
        .await
        .map_err(ApiError::from)?;
    // org event: registry item published (spec §4.6); best-effort
    let _ = store
        .events()
        .emit(
            user.0.org_id,
            "registry.published",
            serde_json::json!({ "kind": kind, "slug": slug, "version": version }),
        )
        .await;
    Ok(Json(json!({"slug": slug, "version": version})))
}

async fn list_items(
    State(state): State<AppState>,
    user: AuthUser,
    Path(kind): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    valid_kind(&kind)?;
    let store = state.store().await?;
    let items = store.registry().list_items(user.0.org_id, &kind).await?;
    Ok(Json(json!({ "items": items })))
}

async fn item_versions(
    State(state): State<AppState>,
    user: AuthUser,
    Path((kind, slug)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    valid_kind(&kind)?;
    let store = state.store().await?;
    let versions = store
        .registry()
        .item_versions(user.0.org_id, &kind, &slug)
        .await?;
    Ok(Json(json!({ "versions": versions })))
}

async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    Path((kind, slug, version)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    valid_kind(&kind)?;
    let store = state.store().await?;
    let stored = store
        .registry()
        .get_version(user.0.org_id, &kind, &slug, &version)
        .await?;
    // members can only download the exact approved bundle: the requested
    // version must be the approval's version and its stored hash must equal
    // the approved one — a byte-swapped republish is undownloadable.
    if user.0.role != "admin" {
        let Some((approved_version, approved_sha)) = store
            .registry()
            .approved_bundle(user.0.org_id, &kind, &slug)
            .await?
        else {
            return Err(ApiError::forbidden());
        };
        if approved_version != version
            || stored.bundle_sha256.as_deref() != Some(approved_sha.as_str())
        {
            return Err(ApiError::forbidden());
        }
    }
    let objects = state.objects().await?;
    let bytes = objects
        .get(&stored.object_key)
        .await
        .map_err(ApiError::from)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/gzip")],
        bytes,
    ))
}

async fn review(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((kind, slug)): Path<(String, String)>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    valid_kind(&kind)?;
    let status = body["status"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing status"))?;
    if !matches!(status, "draft" | "approved") {
        return Err(ApiError::bad_request("status must be draft or approved"));
    }
    // The approval must name the content the admin inspected: the reviewed
    // version and its bundle hash. A drift between click and commit (a
    // republish in flight) is refused, never applied.
    let reviewed_version = body["reviewed_version"].as_str();
    let reviewed_bundle_sha256 = body["reviewed_bundle_sha256"].as_str();
    if status == "approved" && (reviewed_version.is_none() || reviewed_bundle_sha256.is_none()) {
        return Err(ApiError::bad_request(
            "approval requires reviewed_version and reviewed_bundle_sha256",
        ));
    }
    let store = state.store().await?;
    store
        .registry()
        .set_review(
            admin.0.org_id,
            &kind,
            &slug,
            status,
            reviewed_version,
            reviewed_bundle_sha256,
        )
        .await?;
    Ok(Json(json!({})))
}

/// Server-side install for `integration` registry items (spec §4.4): reads
/// the bundle's `routine.json` and creates a disabled routine; enabling it
/// via the routines API activates the trigger.
async fn install(
    State(state): State<AppState>,
    user: AuthUser,
    Path((kind, slug)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    valid_kind(&kind)?;
    if kind != "integration" {
        return Err(ApiError::bad_request(
            "only integration items are installed server-side; pull skills/mcp with the client",
        ));
    }
    let store = state.store().await?;
    // No explicit version: only an approval that still covers the latest
    // version and its exact bundle bytes yields a default — the item-level
    // status alone is not a content guarantee.
    let version = match q.get("version") {
        Some(v) => v.clone(),
        None => {
            let Some((approved_version, _)) = store
                .registry()
                .approved_bundle(user.0.org_id, &kind, &slug)
                .await?
            else {
                return Err(ApiError::forbidden());
            };
            approved_version
        }
    };
    let stored = store
        .registry()
        .get_version(user.0.org_id, &kind, &slug, &version)
        .await?;
    // Members can only install the exact approved bundle: the requested
    // version must be the approval's version and its stored hash must equal
    // the approved one (admins keep the review-surface bypass).
    if user.0.role != "admin" {
        let Some((approved_version, approved_sha)) = store
            .registry()
            .approved_bundle(user.0.org_id, &kind, &slug)
            .await?
        else {
            return Err(ApiError::forbidden());
        };
        if approved_version != version
            || stored.bundle_sha256.as_deref() != Some(approved_sha.as_str())
        {
            return Err(ApiError::forbidden());
        }
    }
    let bytes = state
        .objects()
        .await?
        .get(&stored.object_key)
        .await
        .map_err(|e| ApiError::internal(format!("bundle read failed: {e}")))?;
    let manifest: guild_core::registry::BundleManifest = serde_json::from_slice(
        &guild_core::registry::read_bundle_file(&bytes, "manifest.json")
            .map_err(ApiError::from)?
            .ok_or_else(|| ApiError::bad_request("bundle has no manifest.json"))?,
    )
    .map_err(|e| ApiError::bad_request(format!("bad manifest.json: {e}")))?;
    if manifest.mcp.is_some() {
        return install_mcp_plugin(state, &user, &slug, manifest).await;
    }
    let routine_json = guild_core::registry::read_bundle_file(&bytes, "routine.json")
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::bad_request("bundle has no routine.json"))?;
    let cfg: Value = serde_json::from_slice(&routine_json)
        .map_err(|e| ApiError::bad_request(format!("bad routine.json: {e}")))?;
    let trigger_kind = cfg["trigger_kind"].as_str().unwrap_or("webhook");
    if !matches!(trigger_kind, "webhook" | "interval") {
        return Err(ApiError::bad_request(
            "routine.json trigger_kind must be webhook or interval",
        ));
    }
    let prompt = cfg["prompt"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("routine.json missing prompt"))?;
    let model = cfg["model"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("routine.json missing model"))?;
    let webhook_token = new_hook_token();
    let allowed_tools = if cfg["allowed_tools"].is_null() {
        json!(["http_call", "storage_put"])
    } else {
        cfg["allowed_tools"].clone()
    };
    let routine = store
        .routines()
        .create(
            user.0.org_id,
            user.0.id,
            &slug,
            cfg["name"].as_str().unwrap_or(&slug),
            trigger_kind,
            if cfg["trigger_config"].is_null() {
                json!({})
            } else {
                cfg["trigger_config"].clone()
            },
            prompt,
            model,
            allowed_tools,
            &webhook_token,
            false, // disabled until the owner enables it
        )
        .await?;
    let mut value = json!({"routine": serde_json::to_value(&routine).expect("routine serializes")});
    // The plaintext webhook token is shown once, at install; only its hash
    // is stored (same shape as the routines create endpoint).
    if routine.trigger_kind == "webhook" {
        value["routine"]["webhook_token"] = json!(webhook_token);
    }
    Ok(Json(value))
}

/// Install path for v2 MCP plugin bundles (spec §9): creates a disabled
/// `integrations` row carrying the mcp/auth/tool_policy config (skipped when
/// the row already exists) and disabled routines from the manifest triggers.
async fn install_mcp_plugin(
    state: AppState,
    user: &AuthUser,
    slug: &str,
    manifest: guild_core::registry::BundleManifest,
) -> Result<Json<Value>, ApiError> {
    guild_core::registry::validate_v2(&manifest)
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    let store = state.store().await?;

    let auth = manifest.auth.clone().unwrap_or_default();
    let config = json!({
        "mcp": manifest.mcp.clone().expect("mcp checked by caller"),
        "auth": auth,
        "tool_policy": {},
    });
    let existing = store
        .integrations()
        .list(user.0.org_id)
        .await?
        .into_iter()
        .find(|r| r.name == slug);
    let row = match existing {
        Some(row) => row,
        None => {
            store
                .integrations()
                .upsert(user.0.org_id, slug, &config, false)
                .await?;
            store
                .integrations()
                .list(user.0.org_id)
                .await?
                .into_iter()
                .find(|r| r.name == slug)
                .expect("row just upserted")
        }
    };

    let mut routines = Vec::new();
    for (i, t) in manifest.triggers.iter().enumerate() {
        let routine_slug = if i == 0 {
            slug.to_string()
        } else {
            format!("{slug}-{i}")
        };
        if store
            .routines()
            .get_by_slug(user.0.org_id, &routine_slug)
            .await
            .is_ok()
        {
            continue;
        }
        let allowed_tools = t
            .allowed_tools
            .clone()
            .unwrap_or_else(|| vec!["http_call".into(), "storage_put".into()]);
        let webhook_token = new_hook_token();
        let routine = store
            .routines()
            .create(
                user.0.org_id,
                user.0.id,
                &routine_slug,
                t.name.as_deref().unwrap_or(slug),
                &t.kind,
                t.trigger_config.clone(),
                &t.prompt,
                &t.model,
                serde_json::to_value(&allowed_tools).expect("tool list serializes"),
                &webhook_token,
                false, // disabled until an admin enables it
            )
            .await?;
        // The plaintext token is shown once here: only its hash is stored
        // and no rotate endpoint exists, so dropping it would leave the
        // webhook trigger permanently unusable.
        let mut rv = serde_json::to_value(&routine).expect("routine serializes");
        rv["webhook_token"] = json!(webhook_token);
        routines.push(rv);
    }
    Ok(Json(json!({
        "integration": serde_json::to_value(&row).expect("row serializes"),
        "routines": routines,
    })))
}
