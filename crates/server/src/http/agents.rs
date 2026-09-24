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

pub fn workspace_dir(
    state: &AppState,
    org_id: Uuid,
    workspace_name: &str,
) -> Result<PathBuf, ApiError> {
    if !crate::store::agent_sessions::valid_workspace_name(workspace_name) {
        return Err(ApiError::bad_request("invalid workspace name"));
    }
    Ok(workspace_root(state, org_id).join(workspace_name))
}

async fn create_session(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body["workspace_name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing workspace_name"))?;
    let dir = workspace_dir(&state, user.0.org_id, name)?;
    let store = state.store().await?;
    let chat = store
        .chats()
        .create_chat(user.0.org_id, user.0.id, Some(name), None)
        .await?;
    let session = match store
        .agent_sessions()
        .create(user.0.org_id, user.0.id, chat.id, name)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            // A taken workspace name must not leave an orphan chat behind.
            sqlx::query("DELETE FROM chats WHERE id = $1")
                .bind(chat.id)
                .execute(store.pool())
                .await
                .map_err(|del| ApiError::internal(format!("orphan chat cleanup failed: {del}")))?;
            return Err(e);
        }
    };
    // The row exists, so no live session of this org holds the name: any
    // dir still on disk is an orphan a deleted account left behind.
    // Reclaim it — the next user of the same workspace name must not
    // inherit its files. A reclaim that cannot run (permissions, mounted
    // files) must fail the request loudly: silently inheriting a foreign
    // directory is the failure this reclaim exists to prevent — and the
    // session + chat rows are removed again, so no usable session is left
    // over the dirty workspace and a retry is not blocked by the name.
    let prepared = async {
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(ApiError::internal(format!(
                    "orphan workspace dir reclaim failed: {e}"
                )));
            }
        }
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| ApiError::internal(format!("workspace dir create failed: {e}")))
    }
    .await;
    if let Err(e) = prepared {
        sqlx::query("DELETE FROM agent_sessions WHERE id = $1")
            .bind(session.id)
            .execute(store.pool())
            .await
            .map_err(|del| ApiError::internal(format!("session rollback failed: {del}")))?;
        sqlx::query("DELETE FROM chats WHERE id = $1")
            .bind(chat.id)
            .execute(store.pool())
            .await
            .map_err(|del| ApiError::internal(format!("chat rollback failed: {del}")))?;
        return Err(e);
    }
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

#[cfg(test)]
mod workspace_boundary_tests {
    use super::*;
    #[test]
    fn workspace_paths_reject_absolute_traversal_and_empty_names() {
        let state = AppState::from_config(crate::config::Config::test_config());
        let org = Uuid::nil();
        for name in ["/", "../other", "a/b", "", "C:\\Windows"] {
            assert!(workspace_dir(&state, org, name).is_err(), "{name}");
        }
        assert_eq!(
            workspace_dir(&state, org, "repo-1").unwrap(),
            workspace_root(&state, org).join("repo-1")
        );
    }
}
