//! Auth API — managed accounts: bootstrap, login, me (spec §4.1).
//! SSO/OIDC is the same session model behind a second login path (later task).

use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::identity::UserRow;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::{Json, Router};
use protocol::api::{LoginRequest, LoginResponse, UserInfo};
use std::sync::Arc;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/bootstrap", axum::routing::post(bootstrap))
        .route("/api/v1/auth/login", axum::routing::post(login))
        .route("/api/v1/auth/me", axum::routing::get(me))
}

async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let email = body["email"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing email"))?
        .to_string();
    let password = body["password"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing password"))?
        .to_string();
    let store = state.store().await?;
    if store.identity().any_users().await? {
        return Err(ApiError::conflict(
            "already_bootstrapped",
            "org already has users",
        ));
    }
    store
        .identity()
        .ensure_bootstrap_admin(&email, &password)
        .await?;
    Ok(Json(serde_json::json!({})))
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let store = state.store().await?;
    let user = store
        .identity()
        .authenticate(&req.email, &req.password)
        .await?;
    let (_sid, token) = store.identity().create_session(user.id).await?;
    Ok(Json(LoginResponse {
        token,
        user: user_info(&user),
    }))
}

fn user_info(u: &UserRow) -> UserInfo {
    UserInfo {
        id: u.id,
        email: u.email.clone(),
        org_id: u.org_id,
        role: u.role.clone(),
    }
}

async fn me(user: AuthUser) -> Result<Json<UserInfo>, ApiError> {
    Ok(Json(user_info(&user.0)))
}

/// Extractor: validates the bearer token and yields the user row.
pub struct AuthUser(pub UserRow);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::unauthorized("missing authorization header"))?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or_else(|| ApiError::unauthorized("expected Bearer token"))?;
        let store: Arc<crate::store::Store> = state.store().await?;
        let user = store.identity().validate_session(token).await?;
        Ok(AuthUser(user))
    }
}

/// Role guard: rejects non-admins (used by admin endpoints).
pub async fn require_admin(user: AuthUser) -> Result<UserRow, ApiError> {
    if user.0.role != "admin" {
        return Err(ApiError::forbidden());
    }
    Ok(user.0)
}
