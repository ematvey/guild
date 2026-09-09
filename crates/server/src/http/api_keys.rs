//! Org API keys for the public OpenAI-compatible endpoint (M6).

use crate::http::error::ApiError;
use crate::http::gateway::AdminUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::header::AUTHORIZATION;
use axum::{Json, Router};
use serde_json::json;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/admin/api-keys",
            axum::routing::post(create).get(list),
        )
        .route("/api/v1/admin/api-keys/{id}", axum::routing::delete(revoke))
}

async fn create(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"].as_str().unwrap_or("api key");
    let store = state.store().await?;
    let new = store
        .api_keys()
        .create(admin.0.org_id, admin.0.id, name)
        .await?;
    Ok(Json(json!({
        "key": serde_json::to_value(&new.key).expect("key serializes"),
        "plaintext": new.plaintext,
    })))
}

async fn list(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let keys = store.api_keys().list(admin.0.org_id).await?;
    Ok(Json(json!({ "keys": keys })))
}

async fn revoke(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.api_keys().revoke(admin.0.org_id, id).await?;
    Ok(Json(json!({})))
}

/// Extractor: bearer-auth org API key (`gk_…`) for the public endpoint.
pub struct ApiKeyUser(pub crate::store::api_keys::ApiKeyRow);

impl axum::extract::FromRequestParts<AppState> for ApiKeyUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::unauthorized("missing api key"))?;
        let store = state.store().await?;
        let row = store
            .api_keys()
            .authenticate(token)
            .await?
            .ok_or_else(|| ApiError::unauthorized("invalid api key"))?;
        Ok(ApiKeyUser(row))
    }
}
