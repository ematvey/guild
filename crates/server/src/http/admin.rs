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
            "/api/v1/admin/integrations/{name}/secrets",
            axum::routing::put(set_integration_secret).get(list_integration_secrets),
        )
        .route(
            "/api/v1/admin/integrations/{name}/secrets/{secret}",
            axum::routing::delete(delete_integration_secret),
        )
        .route(
            "/api/v1/admin/integrations/{name}",
            axum::routing::put(upsert_integration).delete(delete_integration),
        )
        .route(
            "/api/v1/admin/assistant-prompt",
            axum::routing::get(get_assistant_prompt).put(set_assistant_prompt),
        )
}

// Org KV key holding the admin-configured assistant persona prompt.
use crate::worker::restate::ASSISTANT_PROMPT_KEY;
/// Upper bound on a custom prompt — personas are short; this is abuse
/// protection, not a context-window budget.
const ASSISTANT_PROMPT_MAX: usize = 10_000;

/// Returns the org's assistant system prompt; `null` = using the built-in
/// default. Operational instructions (tools, workspace) are appended
/// server-side regardless and are not part of this setting.
async fn get_assistant_prompt(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let prompt = store
        .org_kv()
        .get(admin.0.org_id, ASSISTANT_PROMPT_KEY)
        .await?;
    Ok(Json(json!({ "prompt": prompt })))
}

/// Sets the org's assistant system prompt. An empty string resets to the
/// built-in default.
async fn set_assistant_prompt(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Some(prompt) = body.get("prompt").and_then(|p| p.as_str()) else {
        return Err(ApiError::bad_request("missing \"prompt\" string"));
    };
    if prompt.chars().count() > ASSISTANT_PROMPT_MAX {
        return Err(ApiError::bad_request(
            "prompt exceeds 10,000 characters",
        ));
    }
    let store = state.store().await?;
    if prompt.is_empty() {
        store
            .org_kv()
            .delete(admin.0.org_id, ASSISTANT_PROMPT_KEY)
            .await?;
    } else {
        store
            .org_kv()
            .put(admin.0.org_id, ASSISTANT_PROMPT_KEY, prompt)
            .await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// Lists this org's integration plugins (configured and unconfigured).
/// `available` holds the compiled-in kinds plus approved registry v2 plugins
/// that have no configured row yet.
async fn list_integrations(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let rows = store.integrations().list(admin.0.org_id).await?;
    let mut available: Vec<serde_json::Value> = crate::integrations::integration_names()
        .iter()
        .map(|n| {
            let category = crate::integrations::integration_by_name(n)
                .map(|p| p.category().to_string())
                .unwrap_or_else(|| "other".to_string());
            json!({ "name": n, "category": category })
        })
        .collect();
    for item in store
        .registry()
        .list_items(admin.0.org_id, "integration")
        .await?
    {
        if item.review_status != "approved" || rows.iter().any(|r| r.name == item.slug) {
            continue;
        }
        if let Some(manifest) = latest_integration_manifest(&store, admin.0.org_id, &item.slug).await? {
            if manifest.mcp.is_some() {
                available.push(json!({ "name": item.slug, "category": "mcp" }));
            }
        }
    }
    Ok(Json(json!({ "integrations": rows, "available": available })))
}

/// Latest published manifest of one registry integration item, if any.
async fn latest_integration_manifest(
    store: &crate::store::Store,
    org_id: Uuid,
    slug: &str,
) -> Result<Option<guild_core::registry::BundleManifest>, ApiError> {
    let Some(v) = store
        .registry()
        .item_versions(org_id, "integration", slug)
        .await?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let stored = store
        .registry()
        .get_version(org_id, "integration", slug, &v.version)
        .await?;
    serde_json::from_value(stored.manifest)
        .map(Some)
        .map_err(|e| ApiError::internal(format!("stored manifest unparsable: {e}")))
}

/// Validates an MCP plugin row's config: mcp.url must be an absolute http(s)
/// URL when present; tool_policy role keys ⊆ {member, admin} with class
/// lists ⊆ {read, write, admin}.
fn validate_mcp_config(config: &serde_json::Value) -> Result<(), ApiError> {
    if let Some(url) = config["mcp"]["url"].as_str() {
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(ApiError::bad_request(
                "mcp.url must be an absolute http(s) URL",
            ));
        }
    }
    if let Some(policy) = config["tool_policy"].as_object() {
        for (role, classes) in policy {
            if !matches!(role.as_str(), "member" | "admin") {
                return Err(ApiError::bad_request(
                    "tool_policy role keys must be member or admin",
                ));
            }
            let Some(classes) = classes.as_array() else {
                return Err(ApiError::bad_request(
                    "tool_policy role value must be a class list",
                ));
            };
            for c in classes {
                if !matches!(c.as_str(), Some("read") | Some("write") | Some("admin")) {
                    return Err(ApiError::bad_request(
                        "tool_policy classes must be read, write, or admin",
                    ));
                }
            }
        }
    }
    Ok(())
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
    let store = state.store().await?;
    let rows = store.integrations().list(admin.0.org_id).await?;
    let existing = rows.iter().find(|r| r.name == name);
    let enabled = body["enabled"].as_bool().unwrap_or(false);
    match crate::integrations::integration_by_name(&name) {
        Some(plugin) => {
            let config = body
                .get("config")
                .cloned()
                .unwrap_or_else(|| existing.map(|r| r.config.clone()).unwrap_or(json!({})));
            // Validate via the plugin's own config check before saving.
            if let Err(e) = plugin.tools(&config) {
                return Err(ApiError::bad_request(format!(
                    "invalid integration config: {e}"
                )));
            }
            // Enable gate (spec §9): a built-in row enables only when every
            // secret its manifest declares is stored — same rule as MCP
            // plugins. Secrets CRUD covers built-in slugs.
            if enabled {
                let declared = plugin
                    .manifest()
                    .auth
                    .map(|a| a.secret_names)
                    .unwrap_or_default();
                let stored = store
                    .integration_secrets()
                    .list(admin.0.org_id, &name)
                    .await?;
                let missing: Vec<String> = declared
                    .into_iter()
                    .filter(|d| !stored.iter().any(|s| &s.name == d))
                    .collect();
                if !missing.is_empty() {
                    return Err(ApiError::conflict(
                        "missing_secrets",
                        format!("missing secrets: {}", missing.join(", ")),
                    ));
                }
            }
            store
                .integrations()
                .upsert(admin.0.org_id, &name, &config, enabled)
                .await?;
        }
        None => {
            // v2 MCP plugin installed from the registry: config fields merge
            // shallowly over the stored row so partial updates keep mcp/auth.
            let Some(row) = existing else {
                return Err(ApiError::not_found(format!("unknown integration {name}")));
            };
            let mut config = row.config.clone();
            if let Some(patch) = body.get("config").and_then(|c| c.as_object()) {
                if let Some(obj) = config.as_object_mut() {
                    for (k, v) in patch {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
            validate_mcp_config(&config)?;
            let enabled = body["enabled"].as_bool().unwrap_or(row.enabled);
            if enabled {
                if config["mcp"]["url"].as_str().is_none() {
                    return Err(ApiError::bad_request(
                        "mcp plugin needs an mcp.url before enabling",
                    ));
                }
                let declared: Vec<String> = latest_integration_manifest(&store, admin.0.org_id, &name)
                    .await?
                    .and_then(|m| m.auth)
                    .map(|a| a.secret_names)
                    .unwrap_or_default();
                let stored = store
                    .integration_secrets()
                    .list(admin.0.org_id, &name)
                    .await?;
                let missing: Vec<String> = declared
                    .into_iter()
                    .filter(|d| !stored.iter().any(|s| &s.name == d))
                    .collect();
                if !missing.is_empty() {
                    return Err(ApiError::conflict(
                        "missing_secrets",
                        format!("missing secrets: {}", missing.join(", ")),
                    ));
                }
            }
            store
                .integrations()
                .upsert(admin.0.org_id, &name, &config, enabled)
                .await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

/// Upserts one integration secret (write-only; values never read back).
async fn set_integration_secret(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(name): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let secret_name = body["name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing name"))?;
    let value = body["value"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing value"))?;
    let store = state.store().await?;
    known_integration(&store, admin.0.org_id, &name).await?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    store
        .integration_secrets()
        .upsert(admin.0.org_id, &name, secret_name, value, &master)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Lists one integration's secret names + timestamps — never values.
async fn list_integration_secrets(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    known_integration(&store, admin.0.org_id, &name).await?;
    let secrets = store.integration_secrets().list(admin.0.org_id, &name).await?;
    Ok(Json(json!({ "secrets": secrets })))
}

/// Removes one secret. If the integration is enabled and its manifest
/// declares that secret, the row is auto-disabled (spec §9).
async fn delete_integration_secret(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((name, secret)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    known_integration(&store, admin.0.org_id, &name).await?;
    store
        .integration_secrets()
        .delete(admin.0.org_id, &name, &secret)
        .await?;
    let row = store
        .integrations()
        .list(admin.0.org_id)
        .await?
        .into_iter()
        .find(|r| r.name == name);
    if row.as_ref().is_some_and(|r| r.enabled) {
        // The row's manifest declares its secrets: an in-code manifest for a
        // built-in, the registry manifest for an MCP plugin.
        let declares = match crate::integrations::integration_by_name(&name) {
            Some(plugin) => plugin
                .manifest()
                .auth
                .map(|a| a.secret_names.contains(&secret))
                .unwrap_or(false),
            None => latest_integration_manifest(&store, admin.0.org_id, &name)
                .await?
                .and_then(|m| m.auth)
                .map(|a| a.secret_names.contains(&secret))
                .unwrap_or(false),
        };
        if declares {
            store
                .integrations()
                .upsert(admin.0.org_id, &name, &row.unwrap().config, false)
                .await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

/// A secrets-CRUD target must be a known integration: a configured row, or
/// a compiled-in kind (built-ins have no install step, so their secrets can
/// be staged before the row exists).
async fn known_integration(
    store: &crate::store::Store,
    org_id: Uuid,
    name: &str,
) -> Result<(), ApiError> {
    if crate::integrations::integration_by_name(name).is_some() {
        return Ok(());
    }
    integration_row(store, org_id, name).await.map(|_| ())
}

async fn integration_row(
    store: &crate::store::Store,
    org_id: Uuid,
    name: &str,
) -> Result<crate::store::integrations::IntegrationRow, ApiError> {
    store
        .integrations()
        .list(org_id)
        .await?
        .into_iter()
        .find(|r| r.name == name)
        .ok_or_else(|| ApiError::not_found(format!("unknown integration {name}")))
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
