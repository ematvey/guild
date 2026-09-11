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
            axum::routing::put(update_user).delete(delete_user),
        )
        .route(
            "/api/v1/admin/teams",
            axum::routing::get(list_teams).post(create_team),
        )
        .route(
            "/api/v1/admin/teams/{id}",
            axum::routing::put(rename_team).delete(delete_team),
        )
        .route(
            "/api/v1/admin/teams/{id}/members",
            axum::routing::get(list_members).post(add_member),
        )
        .route(
            "/api/v1/admin/teams/{id}/members/{user_id}",
            axum::routing::delete(remove_member),
        )
        .route(
            "/api/v1/admin/integrations",
            axum::routing::get(list_integrations),
        )
        .route(
            "/api/v1/admin/integrations/{name}",
            axum::routing::put(upsert_integration).delete(delete_integration),
        )
}

/// Lists this org's integration plugins (configured and unconfigured).
async fn list_integrations(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let rows = store.integrations().list(admin.0.org_id).await?;
    let available: Vec<serde_json::Value> = ["searxng", "superproxy"]
        .iter()
        .map(|n| {
            let category = crate::integrations::integration_by_name(n)
                .map(|p| p.category().to_string())
                .unwrap_or_else(|| "other".to_string());
            json!({ "name": n, "category": category })
        })
        .collect();
    Ok(Json(json!({ "integrations": rows, "available": available })))
}

/// Configures one integration. The integration contributes tools to the chat
/// loop only while enabled; config is validated on save.
/// Removes an integration's configuration entirely.
async fn delete_integration(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.integrations().delete(admin.0.org_id, &name).await?;
    Ok(Json(json!({})))
}

async fn upsert_integration(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(name): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Some(plugin) = crate::integrations::integration_by_name(&name) else {
        return Err(ApiError::not_found(format!("unknown integration {name}")));
    };
    let config = body.get("config").cloned().unwrap_or(json!({}));
    let enabled = body["enabled"].as_bool().unwrap_or(false);
    // Validate via the plugin's own config check before saving.
    if let Err(e) = plugin.tools(&config) {
        return Err(ApiError::bad_request(format!("invalid integration config: {e}")));
    }
    let store = state.store().await?;
    store
        .integrations()
        .upsert(admin.0.org_id, &name, &config, enabled)
        .await?;
    Ok(Json(json!({ "ok": true })))
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

/// Updates a managed user: role change and/or password reset; omitted
/// fields stay unchanged.
async fn update_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let role = match body["role"].as_str() {
        Some(r) if !r.is_empty() => {
            if !matches!(r, "admin" | "member") {
                return Err(ApiError::bad_request("role must be admin or member"));
            }
            Some(r)
        }
        _ => None,
    };
    let password = body["password"].as_str().filter(|p| !p.is_empty());
    if role.is_none() && password.is_none() {
        return Err(ApiError::bad_request("nothing to update"));
    }
    let store = state.store().await?;
    let user = store
        .identity()
        .update_user(admin.0.org_id, user_id, role, password)
        .await?;
    Ok(Json(
        json!({ "id": user.id, "email": user.email, "role": user.role }),
    ))
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

async fn rename_team(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(team_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing name"))?;
    let store = state.store().await?;
    let team = store
        .teams()
        .rename_team(admin.0.org_id, team_id, name)
        .await?;
    Ok(Json(json!({ "id": team.id, "name": team.name })))
}

async fn delete_team(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.teams().delete_team(admin.0.org_id, team_id).await?;
    Ok(Json(json!({})))
}

async fn list_members(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let users = store.teams().list_members(admin.0.org_id, team_id).await?;
    Ok(Json(json!({ "members": users })))
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

async fn remove_member(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((team_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .teams()
        .remove_member(admin.0.org_id, team_id, user_id)
        .await?;
    Ok(Json(json!({})))
}
