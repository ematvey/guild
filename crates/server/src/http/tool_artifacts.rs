//! Tool-artifact endpoints (tool artifacts design): download spilled tool
//! results and list a chat's artifacts — symmetric to the attachments
//! endpoints. Clients never hold S3 credentials; the local engine fetches
//! through `GET /api/v1/tool_artifacts/{id}`.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::{Json, Router};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/chats/{chat_id}/tool_artifacts",
            axum::routing::get(list_for_chat),
        )
        .route("/api/v1/tool_artifacts/{id}", axum::routing::get(download))
}

async fn list_for_chat(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store
        .chats()
        .get_chat(user.0.org_id, chat_id, &user.0)
        .await?;
    let rows = store
        .tool_artifacts()
        .list_for_chat(user.0.org_id, chat_id)
        .await?;
    Ok(Json(serde_json::to_value(&rows).expect("rows serialize")))
}

async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.store().await?;
    // Org-scoped: a foreign org's artifact 404s here.
    let row = store.tool_artifacts().get(user.0.org_id, id).await?;
    let key = crate::store::tool_artifacts::object_key(row.org_id, row.id, &row.filename);
    let bytes = state
        .objects()
        .await?
        .get(&key)
        .await
        .map_err(|e| ApiError::internal(format!("object store read failed: {e}")))?;
    Ok((
        [
            (CONTENT_TYPE, row.content_type.clone()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", row.filename),
            ),
        ],
        bytes,
    ))
}
