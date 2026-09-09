//! Auth API — managed accounts: bootstrap, login, me (spec §4.1).
//! SSO/OIDC is the same session model behind a second login path (later task).

use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::identity::UserRow;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::{Json, Router};
use protocol::api::{
    CreatePairingTokenRequest, LoginRequest, LoginResponse, PairRequest, PairResponse,
    PairingTokenInfo, PairingTokenResponse, UserInfo,
};
use std::sync::Arc;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/bootstrap", axum::routing::post(bootstrap))
        .route("/api/v1/auth/login", axum::routing::post(login))
        .route("/api/v1/auth/me", axum::routing::get(me))
        .route("/api/v1/auth/pair", axum::routing::post(pair))
        .route(
            "/api/v1/auth/pairing-tokens",
            axum::routing::post(create_pairing_token).get(list_pairing_tokens),
        )
        .route(
            "/api/v1/auth/pairing-tokens/{id}",
            axum::routing::delete(revoke_pairing_token),
        )
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

/// Redeems a one-time pairing code for a normal session. Unauthenticated:
/// the code IS the credential. Single-use and TTL-checked server-side.
async fn pair(
    State(state): State<AppState>,
    Json(req): Json<PairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    let secret = crate::store::pairing::secret_from_code(&req.code)
        .ok_or_else(|| ApiError::unauthorized("malformed pairing code"))?;
    let store = state.store().await?;
    let (_org_id, user_id) = store.pairing().redeem(secret).await?;
    let user = store.identity().get_user(user_id).await?;
    let (_sid, token) = store.identity().create_session(user.id).await?;
    Ok(Json(PairResponse {
        token,
        user: user_info(&user),
    }))
}

/// Issues a one-time pairing code for the calling user. The plaintext code
/// is returned once and composed client-side as
/// `g1.<b64url(server_url)>.<secret>` (the server URL is routing info).
async fn create_pairing_token(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreatePairingTokenRequest>,
) -> Result<Json<PairingTokenResponse>, ApiError> {
    let ttl = req.ttl_minutes.unwrap_or(30).clamp(1, 24 * 60);
    let store = state.store().await?;
    let created = store
        .pairing()
        .create(user.0.org_id, user.0.id, ttl)
        .await?;
    Ok(Json(PairingTokenResponse {
        id: created.token.id,
        secret: created.secret,
        expires_at: created.token.expires_at,
    }))
}

async fn list_pairing_tokens(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let rows = store.pairing().list_outstanding(user.0.id).await?;
    let tokens: Vec<PairingTokenInfo> = rows
        .into_iter()
        .map(|t| PairingTokenInfo {
            id: t.id,
            created_at: t.created_at,
            expires_at: t.expires_at,
        })
        .collect();
    Ok(Json(serde_json::json!({ "tokens": tokens })))
}

async fn revoke_pairing_token(
    State(state): State<AppState>,
    user: AuthUser,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.pairing().revoke(user.0.id, id).await?;
    Ok(Json(serde_json::json!({})))
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
