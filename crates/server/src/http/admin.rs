//! Admin API: user and team management (spec §4.7 admin console backing).

use crate::http::error::ApiError;
use crate::http::gateway::AdminUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use serde_json::json;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/admin/users",
            axum::routing::get(list_users).post(create_user),
        )
        .route(
            "/api/v1/admin/users/{id}",
            axum::routing::delete(delete_user),
        )
        .route(
            "/api/v1/admin/teams",
            axum::routing::get(list_teams).post(create_team),
        )
        .route(
            "/api/v1/admin/teams/{id}/members",
            axum::routing::post(add_member),
        )
}

async fn list_users(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let users = store.identity().list_users(admin.0.org_id).await?;
    Ok(Json(json!({ "users": users })))
}

async fn create_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let email = body["email"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing email"))?;
    let password = body["password"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing password"))?;
    let role = body["role"].as_str().unwrap_or("member");
    if !matches!(role, "admin" | "member") {
        return Err(ApiError::bad_request("role must be admin or member"));
    }
    let store = state.store().await?;
    let user = store
        .identity()
        .create_user(admin.0.org_id, email, password, role)
        .await?;
    Ok(Json(
        json!({ "id": user.id, "email": user.email, "role": user.role }),
    ))
}

async fn delete_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .identity()
        .delete_user(admin.0.org_id, user_id)
        .await?;
    Ok(Json(json!({})))
}

async fn list_teams(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let teams = store.teams().list_teams(admin.0.org_id).await?;
    Ok(Json(json!({ "teams": teams })))
}

async fn create_team(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing name"))?;
    let store = state.store().await?;
    let team = store.teams().create_team(admin.0.org_id, name).await?;
    Ok(Json(json!({ "id": team.id, "name": team.name })))
}

async fn add_member(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id: Uuid = body["user_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing user_id"))?;
    let store = state.store().await?;
    store
        .teams()
        .add_member(admin.0.org_id, team_id, user_id)
        .await?;
    Ok(Json(json!({})))
}
