//! Server-side execution backend: workspace agent sessions (spec §10.6, M6
//! task 3; re-homed onto the durable gateway workflow — unification spec
//! 2026-09-18 §4 phase 4). A turn submits the same ChatRunner workflow every
//! chat uses, with `server_workspace` naming the org workspace the server
//! itself executes tools in (journaled, exec-policy-gated, pre-approved —
//! the batch contract). Callers submit and poll: history is the thread
//! journal (`GET /api/v1/agents/sessions/{id}`).

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{Json, Router};
use protocol::api::ChatCompletionRequest;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/agents/sessions",
            axum::routing::post(create_session).get(list_sessions),
        )
        .route(
            "/api/v1/agents/sessions/{id}",
            axum::routing::get(session_history),
        )
        .route(
            "/api/v1/agents/sessions/{id}/turns",
            axum::routing::post(run_turn),
        )
}

fn workspace_root(state: &AppState, org_id: Uuid) -> PathBuf {
    std::path::Path::new(&state.config.data_dir)
        .join("workspaces")
        .join(org_id.to_string())
}

pub fn workspace_dir(state: &AppState, org_id: Uuid, workspace_name: &str) -> PathBuf {
    workspace_root(state, org_id).join(workspace_name)
}

async fn create_session(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body["workspace_name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing workspace_name"))?;
    let store = state.store().await?;
    let chat = store
        .chats()
        .create_chat(user.0.org_id, user.0.id, Some(name), None)
        .await?;
    let session = store
        .agent_sessions()
        .create(user.0.org_id, user.0.id, chat.id, name)
        .await?;
    let dir = workspace_dir(&state, user.0.org_id, name);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::internal(format!("workspace dir create failed: {e}")))?;
    Ok(Json(
        serde_json::to_value(&session).expect("session serializes"),
    ))
}

async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let sessions = store
        .agent_sessions()
        .list(user.0.org_id, user.0.id)
        .await?;
    Ok(Json(json!({ "sessions": sessions })))
}

async fn session_history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let session = store
        .agent_sessions()
        .get(user.0.org_id, id, &user.0)
        .await?;
    let rows = store
        .thread()
        .list_events(user.0.org_id, session.chat_id)
        .await?;
    Ok(Json(json!({ "events": rows })))
}

// ---------- turn submission ----------

async fn run_turn(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let message = body["message"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing message"))?
        .to_string();
    let model = body["model"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing model"))?
        .to_string();

    let store = state.store().await?;
    let session = store
        .agent_sessions()
        .get(user.0.org_id, id, &user.0)
        .await?;
    // Same spend gate as the chat gateway: an agent turn is a model call,
    // so the route's monthly quota applies before any tokens flow.
    let master = state.config.master_key()?;
    let route = store
        .gateway()
        .resolve_route(user.0.org_id, &model, &master)
        .await?;
    crate::http::gateway::enforce_quota(&state, user.0.org_id, &model, &route).await?;

    let req = ChatCompletionRequest {
        send_mode: None,
        user_message_id: None,
        chat_id: session.chat_id,
        model,
        messages: vec![protocol::api::Message::user(message)],
        tools: None,
        system: None,
        // The executor is the server itself: `server_workspace` names the
        // org workspace the workflow runs tools in.
        client_tools: false,
        attachment_ids: Vec::new(),
        project_id: None,
        server_workspace: Some(session.workspace_name.clone()),
        skills_index: None,
        agents_md: None,
    };
    crate::http::gateway::submit_turn(&state, &user.0, req, None, None).await
}
