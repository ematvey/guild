//! Project routes (spec §2): CRUD over the caller's named workspace folders.
//! Owner-scoped with admin bypass; a duplicate name is a 409.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::{CreateProjectRequest, Project, UpdateProjectRequest};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/projects",
            axum::routing::post(create).get(list),
        )
        .route(
            "/api/v1/projects/{id}",
            axum::routing::put(update).delete(delete),
        )
}

impl From<crate::store::projects::ProjectRow> for Project {
    fn from(p: crate::store::projects::ProjectRow) -> Self {
        Self {
            id: p.id,
            name: p.name,
            folder: p.folder,
            machine_id: p.machine_id,
            machine_label: p.machine_label,
            created_at: p.created_at,
        }
    }
}

/// Creates a project. The machine must be registered to the caller or their
/// org — a folder on an unregistered machine can never execute anything.
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateProjectRequest>,
) -> Result<Json<Project>, ApiError> {
    let name = req.name.trim();
    let folder = req.folder.trim();
    if name.is_empty() || folder.is_empty() || req.machine_id.is_empty() {
        return Err(ApiError::bad_request("name, folder, and machine_id are required"));
    }
    if !state
        .machine_bindable(&req.machine_id, user.0.id, user.0.org_id)
        .await
    {
        return Err(ApiError::bad_request("unknown machine"));
    }
    let store = state.store().await?;
    let row = store
        .projects()
        .create(user.0.org_id, user.0.id, name, folder, &req.machine_id)
        .await?;
    Ok(Json(row.into()))
}

/// Lists the caller's projects (admin: the whole org's).
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let rows = store
        .projects()
        .list(user.0.org_id, user.0.id, &user.0)
        .await?;
    Ok(Json(serde_json::json!({
        "projects": rows.into_iter().map(Project::from).collect::<Vec<_>>()
    })))
}

/// Updates the editable fields. Only present fields change.
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
    Json(req): Json<UpdateProjectRequest>,
) -> Result<Json<Project>, ApiError> {
    let name = req.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let folder = req
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(mid) = &req.machine_id {
        if !state.machine_bindable(mid, user.0.id, user.0.org_id).await {
            return Err(ApiError::bad_request("unknown machine"));
        }
    }
    let store = state.store().await?;
    let row = store
        .projects()
        .update(
            user.0.org_id,
            project_id,
            &user.0,
            name,
            folder,
            req.machine_id.as_deref(),
        )
        .await?;
    Ok(Json(row.into()))
}

/// Deletes the project. Referencing chats survive folderless (their
/// project_id is nulled in the same transaction).
async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .projects()
        .delete(user.0.org_id, project_id, &user.0)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
