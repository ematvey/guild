//! Script-facing integration tool API (spec §7): the same policy-filtered
//! plugin tools the chat loop uses — built-in and MCP plugins alike —
//! reachable over HTTPS so scripts can call them with session or
//! org-API-key auth. Every operation is a controlled, audited server call.

use crate::http::error::ApiError;
use crate::integrations::{
    call_plugin, resolve_acting_as, resolve_plugins, tool_allowed, unnamespaced_tool,
};
use crate::state::AppState;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/integrations",
            axum::routing::get(list_integrations),
        )
        .route(
            "/api/v1/integrations/{slug}/tools",
            axum::routing::get(list_tools),
        )
        .route(
            "/api/v1/integrations/{slug}/tools/{tool}",
            axum::routing::post(execute_tool),
        )
}

/// The caller of the script API: an org member (session) or an org API key.
/// API keys act with their creating user's role (usage attributes the same
/// way); their acting identity is null unless declared.
pub struct IntegrationCaller {
    pub org: Uuid,
    pub user_id: Uuid,
    pub email: Option<String>,
    pub role: String,
}

impl FromRequestParts<AppState> for IntegrationCaller {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::unauthorized("missing authorization header"))?;
        let store = state.store().await?;
        // Session first (member or admin), then org API key.
        if let Ok(user) = store.identity().validate_session(token).await {
            return Ok(Self {
                org: user.org_id,
                user_id: user.id,
                email: Some(user.email),
                role: user.role,
            });
        }
        let key = store
            .api_keys()
            .authenticate(token)
            .await?
            .ok_or_else(|| ApiError::unauthorized("invalid credentials"))?;
        let role = store
            .identity()
            .get_user(key.created_by)
            .await
            .map(|u| u.role)
            .unwrap_or_else(|_| "member".to_string());
        Ok(Self {
            org: key.org_id,
            user_id: key.created_by,
            email: None,
            role,
        })
    }
}

/// The resolved plugins of the caller's org — a broken plugin contributes
/// nothing (spec §8).
async fn turns(state: &AppState, org: Uuid) -> Vec<crate::integrations::PluginTurn> {
    resolve_plugins(state, org).await.unwrap_or_default()
}

/// `GET /api/v1/integrations` — enabled plugins (built-in and MCP) for the
/// caller's org, policy-filtered to a count only.
async fn list_integrations(
    State(state): State<AppState>,
    caller: IntegrationCaller,
) -> Result<Json<Value>, ApiError> {
    let items: Vec<Value> = turns(&state, caller.org)
        .await
        .iter()
        .map(|t| {
            json!({
                "slug": t.slug,
                "description": t.description,
                "tool_count": t.allowed_infos(&caller.role).len(),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/integrations/{slug}/tools` — the full policy-filtered tool
/// list with JSON schemas and classes.
async fn list_tools(
    State(state): State<AppState>,
    caller: IntegrationCaller,
    Path(slug): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let turns = turns(&state, caller.org).await;
    let turn = turns
        .iter()
        .find(|t| t.slug == slug)
        .ok_or_else(|| ApiError::not_found("no such integration"))?;
    let tools: Vec<Value> = turn
        .allowed_infos(&caller.role)
        .iter()
        .map(|info| {
            json!({
                "name": info.spec.name,
                "description": info.spec.description,
                "parameters": info.spec.parameters,
                "class": info.class,
            })
        })
        .collect();
    Ok(Json(json!({ "tools": tools })))
}

/// `POST /api/v1/integrations/{slug}/tools/{tool}` — executes one tool with
/// the identity envelope; the body is the JSON arguments object.
async fn execute_tool(
    State(state): State<AppState>,
    caller: IntegrationCaller,
    Path((slug, tool)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    let turns = turns(&state, caller.org).await;
    let turn = turns
        .iter()
        .find(|t| t.slug == slug)
        .ok_or_else(|| ApiError::not_found("no such integration"))?;
    // The path carries the Guild-facing namespaced name; the raw connector
    // name is accepted too.
    let info = turn
        .tools
        .iter()
        .find(|info| {
            info.spec.name == tool
                || unnamespaced_tool(&turn.slug, &tool) == Some(info.spec.name.as_str())
        })
        .ok_or_else(|| ApiError::not_found("no such tool"))?;
    if !tool_allowed(info, &turn.row_config, &caller.role) {
        return Err(ApiError::forbidden());
    }
    // Identity (spec §5): acting as the caller's own mapped identity; an
    // override to another member's identity is admin-only.
    let override_ = headers
        .get("x-guild-acting-as")
        .and_then(|v| v.to_str().ok());
    let is_admin = caller.role == "admin" || caller.role == "owner";
    let acting_as = resolve_acting_as(caller.email.as_deref(), override_, is_admin)
        .map_err(|_| ApiError::forbidden())?;
    let raw = unnamespaced_tool(&turn.slug, &tool)
        .or_else(|| unnamespaced_tool(&turn.slug, &info.spec.name))
        .unwrap_or(info.spec.name.as_str());
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| ApiError::bad_request("body must be a JSON object"))?
    };
    if !args.is_object() {
        return Err(ApiError::bad_request("body must be a JSON object"));
    }
    let outcome = call_plugin(&state, turn, raw, args, caller.org, acting_as.as_deref()).await;
    // Journaled audit (spec §8): the identity record for the script call.
    let store = state.store().await?;
    let _ = store
        .events()
        .emit(
            caller.org,
            "integration.tool_called",
            json!({
                "slug": turn.slug,
                "tool": raw,
                "caller": caller.user_id,
                "acting_as": acting_as,
                "ok": outcome.is_ok(),
                "via": "script",
            }),
        )
        .await;
    Ok(Json(match outcome {
        Ok(out) => json!({ "ok": true, "content": out.content, "meta": out.meta }),
        Err(e) => json!({ "ok": false, "error": e }),
    }))
}
