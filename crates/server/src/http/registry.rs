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

fn object_key(org_id: Uuid, kind: &str, slug: &str, version: &str) -> String {
    format!("registry/{org_id}/{kind}/{slug}/{version}.tar.gz")
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

    let key = object_key(user.0.org_id, &kind, slug, version);
    let objects = state.objects().await?;
    objects
        .put(&key, body.to_vec())
        .await
        .map_err(ApiError::from)?;

    let store = state.store().await?;
    let manifest_json = serde_json::to_value(&parsed).expect("manifest serializes");
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
            user.0.id,
        )
        .await?;
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
    // members can only download approved items
    if user.0.role != "admin" {
        let status = store
            .registry()
            .review_status(user.0.org_id, &kind, &slug)
            .await?;
        if status != "approved" {
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
    let store = state.store().await?;
    store
        .registry()
        .set_review(admin.0.org_id, &kind, &slug, status)
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
    let version = match q.get("version") {
        Some(v) => v.clone(),
        None => {
            let status = store
                .registry()
                .review_status(user.0.org_id, &kind, &slug)
                .await?;
            if status != "approved" {
                return Err(ApiError::forbidden());
            }
            store
                .registry()
                .item_versions(user.0.org_id, &kind, &slug)
                .await?
                .into_iter()
                .next()
                .map(|v| v.version)
                .ok_or_else(|| ApiError::not_found("no versions"))?
        }
    };
    // only approved items are installable
    let status = store
        .registry()
        .review_status(user.0.org_id, &kind, &slug)
        .await?;
    if status != "approved" && user.0.role != "admin" {
        return Err(ApiError::forbidden());
    }
    let stored = store
        .registry()
        .get_version(user.0.org_id, &kind, &slug, &version)
        .await?;
    let bytes = state
        .objects()
        .await?
        .get(&stored.object_key)
        .await
        .map_err(|e| ApiError::internal(format!("bundle read failed: {e}")))?;
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
    Ok(Json(
        json!({"routine": serde_json::to_value(&routine).expect("routine serializes")}),
    ))
}
