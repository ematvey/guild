//! Org API keys for the public OpenAI-compatible endpoint (M6).

use crate::http::auth::AuthUser;
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
        // User-level: every member manages their own gateway keys from
        // settings.
        .route(
            "/api/v1/api-keys",
            axum::routing::post(create_own).get(list_own),
        )
        .route("/api/v1/api-keys/{id}", axum::routing::delete(revoke_own))
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
        .create(admin.0.org_id, admin.0.id, name, None)
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

async fn create_own(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"].as_str().unwrap_or("api key");
    let store = state.store().await?;
    let new = store
        .api_keys()
        .create(user.0.org_id, user.0.id, name, Some(user.0.id))
        .await?;
    Ok(Json(json!({
        "key": serde_json::to_value(&new.key).expect("key serializes"),
        "plaintext": new.plaintext,
    })))
}

async fn list_own(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let keys = store.api_keys().list_for_user(user.0.id).await?;
    Ok(Json(json!({ "keys": keys })))
}

async fn revoke_own(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.api_keys().revoke_owned(user.0.id, id).await?;
    Ok(Json(json!({})))
}

/// Extractor: bearer-auth org API key (`gk_…`) for the public endpoint.
pub struct ApiKeyUser(pub crate::store::api_keys::ApiKeyRow);

/// Rejection rendered in the OpenAI error shape (the public endpoint's
/// error contract).
pub struct OpenAiAuthError(pub ApiError);

impl axum::response::IntoResponse for OpenAiAuthError {
    fn into_response(self) -> axum::response::Response {
        (
            self.0.status,
            Json(serde_json::json!({
                "error": {"message": self.0.message, "type": "invalid_request_error", "code": self.0.code}
            })),
        )
            .into_response()
    }
}

impl axum::extract::FromRequestParts<AppState> for ApiKeyUser {
    type Rejection = OpenAiAuthError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // OpenAI SDKs send `Authorization: Bearer gk_…`; Anthropic SDKs
        // send `x-api-key: gk_…`.
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .or_else(|| {
                parts
                    .headers
                    .get("x-api-key")
                    .and_then(|v| v.to_str().ok())
            })
            .filter(|t| !t.is_empty())
            .ok_or_else(|| OpenAiAuthError(ApiError::unauthorized("missing api key")))?;
        let row = state
            .store()
            .await
            .map_err(OpenAiAuthError)?
            .api_keys()
            .authenticate(token)
            .await
            .map_err(OpenAiAuthError)?
            .ok_or_else(|| OpenAiAuthError(ApiError::unauthorized("invalid api key")))?;
        Ok(ApiKeyUser(row))
    }
}
