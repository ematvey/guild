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
            axum::routing::get(list_integrations).post(create_integration),
        )
        .route(
            "/api/v1/admin/integrations/{id}/secrets",
            axum::routing::get(list_integration_secrets),
        )
        .route(
            "/api/v1/admin/integrations/{id}/tools",
            axum::routing::get(list_integration_tools),
        )
        .route(
            "/api/v1/admin/integrations/{id}/tools/{tool}",
            axum::routing::put(set_integration_tool),
        )
        .route(
            "/api/v1/admin/integrations/{id}",
            axum::routing::put(update_integration).delete(delete_integration),
        )
        .route(
            "/api/v1/admin/assistant-prompt",
            axum::routing::get(get_assistant_prompt).put(set_assistant_prompt),
        )
        .route(
            "/api/v1/admin/approval-policy-prompt",
            axum::routing::get(get_approval_policy_prompt).put(set_approval_policy_prompt),
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
        return Err(ApiError::bad_request("prompt exceeds 10,000 characters"));
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

// Org KV key holding the admin-configured "Approve for me" policy prompt.
use crate::worker::restate::{APPROVAL_POLICY_PROMPT_KEY, DEFAULT_APPROVAL_POLICY_PROMPT};

/// Returns the org's "Approve for me" auto-approval policy prompt; `null` =
/// using the built-in default (also returned under `default` so clients can
/// display the effective text without duplicating it).
async fn get_approval_policy_prompt(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let prompt = store
        .org_kv()
        .get(admin.0.org_id, APPROVAL_POLICY_PROMPT_KEY)
        .await?;
    Ok(Json(json!({
        "prompt": prompt,
        "default": DEFAULT_APPROVAL_POLICY_PROMPT,
    })))
}

/// Sets the org's "Approve for me" auto-approval policy prompt. An empty
/// string resets to the built-in default.
async fn set_approval_policy_prompt(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Some(prompt) = body.get("prompt").and_then(|p| p.as_str()) else {
        return Err(ApiError::bad_request("missing \"prompt\" string"));
    };
    if prompt.chars().count() > ASSISTANT_PROMPT_MAX {
        return Err(ApiError::bad_request("prompt exceeds 10,000 characters"));
    }
    let store = state.store().await?;
    if prompt.is_empty() {
        store
            .org_kv()
            .delete(admin.0.org_id, APPROVAL_POLICY_PROMPT_KEY)
            .await?;
    } else {
        store
            .org_kv()
            .put(admin.0.org_id, APPROVAL_POLICY_PROMPT_KEY, prompt)
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
    let mut row_values = Vec::with_capacity(rows.len());
    for row in &rows {
        let categories = configured_row_categories(&store, admin.0.org_id, row).await?;
        let secret_names = declared_secret_names(&store, row).await?;
        let settings = effective_settings(&store, row).await?;
        row_values.push(json!({
            "id": row.id,
            "org_id": row.org_id,
            "name": row.name,
            "config": row.config,
            "enabled": row.enabled,
            "categories": categories,
            "secret_names": secret_names,
            "settings": settings,
        }));
    }
    let mut available: Vec<serde_json::Value> = crate::integrations::integration_names()
        .iter()
        // A compiled-in kind with an existing row is configured — it leaves
        // the available list (an installed registry bundle of the same slug
        // shadows it, see upsert_integration).
        .filter(|n| !rows.iter().any(|r| r.name == **n))
        .map(|n| {
            let plugin = crate::integrations::integration_by_name(n);
            let categories = plugin
                .as_ref()
                .map(|p| crate::integrations::category_strings(p.categories()))
                .unwrap_or_else(|| vec!["other".to_string()]);
            let manifest = plugin.map(|p| p.manifest());
            let secret_names = manifest
                .as_ref()
                .and_then(|m| m.auth.as_ref())
                .map(|a| a.secret_names.clone())
                .unwrap_or_default();
            let settings = manifest
                .and_then(|m| m.settings)
                .map(|s| serde_json::to_value(s).unwrap_or_default())
                .unwrap_or(serde_json::Value::Null);
            json!({ "name": n, "categories": categories, "secret_names": secret_names, "settings": settings })
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
        if let Some(manifest) =
            latest_integration_manifest(&store, admin.0.org_id, &item.slug).await?
        {
            if manifest.mcp.is_some() {
                available.push(json!({
                    "name": item.slug,
                    "categories": ["mcp"],
                    "secret_names": manifest.auth.as_ref().map(|a| a.secret_names.clone()).unwrap_or_default(),
                    "settings": manifest.settings.clone().map(|s| serde_json::to_value(s).unwrap_or_default()).unwrap_or(serde_json::Value::Null),
                }));
            }
        }
    }
    Ok(Json(
        json!({ "integrations": row_values, "available": available }),
    ))
}

/// Categories of a configured integration row, as the UI lists them: a
/// compiled-in kind reports its own categories (display order); a registry
/// v2 bundle with an MCP manifest (or a row already carrying mcp.url) is an
/// MCP plugin and shadows the compiled-in kind of the same slug; anything
/// else is "other".
async fn configured_row_categories(
    store: &crate::store::Store,
    org_id: Uuid,
    row: &crate::store::integrations::IntegrationRow,
) -> Result<Vec<String>, ApiError> {
    let mcp_claimed = latest_integration_manifest(store, org_id, &row.name)
        .await?
        .map(|m| m.mcp.is_some())
        .unwrap_or(false)
        || row.config["mcp"]["url"].as_str().is_some();
    if mcp_claimed {
        return Ok(vec!["mcp".to_string()]);
    }
    Ok(crate::integrations::integration_by_name(&row.name)
        .map(|p| crate::integrations::category_strings(p.categories()))
        .unwrap_or_else(|| vec!["other".to_string()]))
}

/// Secret names an integration's credentials must use, with the same
/// precedence as `save_integration`'s enable gate: a registry v2 bundle's
/// manifest applies only when it claims the slug (an MCP manifest, or the
/// row already resolved to mcp.url); a published bundle that claims nothing
/// leaves the compiled-in connector's manifest in charge.
async fn declared_secret_names(
    store: &crate::store::Store,
    row: &crate::store::integrations::IntegrationRow,
) -> Result<Vec<String>, ApiError> {
    let manifest = latest_integration_manifest(store, row.org_id, &row.name).await?;
    let v2_claimed = manifest.as_ref().map(|m| m.mcp.is_some()).unwrap_or(false)
        || row.config["mcp"]["url"].as_str().is_some();
    if v2_claimed {
        let manifest = manifest.unwrap_or_default();
        if let Some(settings) = manifest.settings {
            let derived = settings.secret_names();
            if !derived.is_empty() {
                return Ok(derived);
            }
        }
        return Ok(manifest.auth.map(|a| a.secret_names).unwrap_or_default());
    }
    Ok(crate::integrations::integration_by_name(&row.name)
        .and_then(|p| p.manifest().auth)
        .map(|a| a.secret_names)
        .unwrap_or_default())
}

/// Typed settings schema for one integration's config fields (the admin UI
/// renders its form from this), with the same precedence as
/// `save_integration`: a registry v2 bundle's manifest applies only when it
/// claims the slug; otherwise the compiled-in connector's manifest.
async fn effective_settings(
    store: &crate::store::Store,
    row: &crate::store::integrations::IntegrationRow,
) -> Result<serde_json::Value, ApiError> {
    let manifest = latest_integration_manifest(store, row.org_id, &row.name).await?;
    let v2_claimed = manifest.as_ref().map(|m| m.mcp.is_some()).unwrap_or(false)
        || row.config["mcp"]["url"].as_str().is_some();
    if v2_claimed {
        return match manifest.and_then(|m| m.settings) {
            Some(s) => serde_json::to_value(s)
                .map_err(|e| ApiError::internal(format!("settings schema serialize failed: {e}"))),
            None => Ok(serde_json::Value::Null),
        };
    }
    let settings =
        crate::integrations::integration_by_name(&row.name).and_then(|p| p.manifest().settings);
    Ok(match settings {
        Some(s) => serde_json::to_value(s)
            .map_err(|e| ApiError::internal(format!("settings schema serialize failed: {e}")))?,
        None => serde_json::Value::Null,
    })
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

/// Creates a configuration row for a not-yet-configured connector: a
/// compiled-in kind or an installed registry v2 MCP plugin. The new row's
/// stable id is the object's address from here on.
async fn create_integration(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body["name"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing name"))?
        .to_string();
    let store = state.store().await?;
    let rows = store.integrations().list(admin.0.org_id).await?;
    if rows.iter().any(|r| r.name == name) {
        return Err(ApiError::conflict(
            "already_configured",
            format!("integration {name} already has a configuration"),
        ));
    }
    // Known connectors only: a compiled-in kind, or an installed registry v2
    // bundle whose manifest declares an MCP server.
    let known = crate::integrations::integration_by_name(&name).is_some()
        || latest_integration_manifest(&store, admin.0.org_id, &name)
            .await?
            .and_then(|m| m.mcp)
            .is_some();
    if !known {
        return Err(ApiError::not_found(format!("unknown integration {name}")));
    }
    save_integration(&state, &store, admin.0.org_id, &name, None, &body).await?;
    let row = integration_row(&store, admin.0.org_id, &name).await?;
    Ok(Json(json!({
        "id": row.id,
        "org_id": row.org_id,
        "name": row.name,
        "config": row.config,
        "enabled": row.enabled,
    })))
}

/// Removes an integration's configuration by id (the connector can be
/// re-added later as a fresh row with a fresh id).
async fn delete_integration(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    store.integrations().delete(admin.0.org_id, id).await?;
    Ok(Json(json!({})))
}

/// Updates one integration by id: config, enabled flag and newly entered
/// credential values, validated and connection-tested before anything is
/// persisted. The connector slug comes from the row.
async fn update_integration(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let row = store
        .integrations()
        .get(admin.0.org_id, id)
        .await?
        .ok_or_else(|| ApiError::not_found("unknown integration"))?;
    save_integration(&state, &store, admin.0.org_id, &row.name, Some(&row), &body).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Shared save path for create and update: applies the registry-shadowing
/// rules, validates required fields, merges newly entered credential
/// values in memory, runs the connector's connection test against the
/// would-be state, and persists (config, secrets, enabled) only on
/// success — a broken connection is never stored.
async fn save_integration(
    state: &crate::state::AppState,
    store: &crate::store::Store,
    org_id: Uuid,
    name: &str,
    existing: Option<&crate::store::integrations::IntegrationRow>,
    body: &serde_json::Value,
) -> Result<(), ApiError> {
    let master = state.config.master_key().map_err(ApiError::from)?;
    // A create-stub (POST with just a name) registers the row disabled and
    // empty: the completeness check and connection test below apply to
    // every real save of settings or credentials.
    let is_stub_create = existing.is_none()
        && body.get("config").is_none()
        && body.get("enabled").is_none()
        && body.get("secrets").is_none();
    if is_stub_create {
        store
            .integrations()
            .upsert(org_id, name, &json!({}), false)
            .await?;
        return Ok(());
    }
    let registry_manifest = latest_integration_manifest(store, org_id, name).await?;
    let v2_claimed = registry_manifest
        .as_ref()
        .map(|m| m.mcp.is_some())
        .unwrap_or(false)
        || existing
            .map(|r| r.config["mcp"]["url"].as_str().is_some())
            .unwrap_or(false);
    // Newly entered credential values: only non-empty strings are writes;
    // an untouched field stays as stored (standard CRUD update).
    let submitted: Vec<(String, String)> = body["secrets"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.as_str().map(|s| !s.is_empty()).unwrap_or(false))
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    if v2_claimed {
        // v2 MCP plugin installed from the registry: config fields merge
        // shallowly over the stored row (an empty object on create) so
        // partial updates keep mcp/auth. The tools curation map never comes
        // from a settings save — the PUT tools endpoint is its only writer.
        let mut config = existing
            .map(|r| r.config.clone())
            .unwrap_or_else(|| json!({}));
        if let Some(patch) = body.get("config").and_then(|c| c.as_object()) {
            if let Some(obj) = config.as_object_mut() {
                for (k, v) in patch {
                    if k == "tools" {
                        continue;
                    }
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        validate_mcp_config(&config)?;
        let enabled = body["enabled"]
            .as_bool()
            .unwrap_or_else(|| existing.map(|r| r.enabled).unwrap_or(false));
        let declared = registry_manifest
            .as_ref()
            .and_then(|m| m.settings.as_ref())
            .map(|s| s.secret_names())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                registry_manifest
                    .as_ref()
                    .and_then(|m| m.auth.as_ref())
                    .map(|a| a.secret_names.clone())
                    .unwrap_or_default()
            });
        if enabled {
            if config["mcp"]["url"].as_str().is_none() {
                return Err(ApiError::bad_request(
                    "mcp plugin needs an mcp.url before enabling",
                ));
            }
        }
        // Resolve stored secrets, overlay the submitted values in memory,
        // and test the connection before anything is written. A save that
        // neither enables nor writes credentials touches neither.
        if !declared.is_empty() || !submitted.is_empty() {
            let mut secrets = store
                .integration_secrets()
                .resolve(
                    org_id,
                    name,
                    &store.integration_secrets().names(org_id, name).await?,
                    &master,
                )
                .await
                .map_err(|e| match e {
                    crate::store::integration_secrets::ResolveError::Api(api) => api,
                    crate::store::integration_secrets::ResolveError::MissingSecrets(names) => {
                        ApiError::conflict(
                            "missing_secrets",
                            format!("missing secrets: {}", names.join(", ")),
                        )
                    }
                })?;
            for (k, v) in &submitted {
                secrets.retain(|(n, _)| n != k);
                secrets.push((k.clone(), v.clone()));
            }
            if enabled {
                let missing: Vec<String> = declared
                    .iter()
                    .filter(|d| !secrets.iter().any(|(n, _)| n == *d))
                    .cloned()
                    .collect();
                if !missing.is_empty() {
                    return Err(ApiError::conflict(
                        "missing_secrets",
                        format!("missing secrets: {}", missing.join(", ")),
                    ));
                }
                let url = config["mcp"]["url"].as_str().unwrap_or_default();
                mcp_test_connection(state, org_id, url, &secrets).await?;
            }
        }
        for (k, v) in &submitted {
            store
                .integration_secrets()
                .upsert(org_id, name, k, v, &master)
                .await?;
        }
        store
            .integrations()
            .upsert(org_id, name, &config, enabled)
            .await?;
        return Ok(());
    }
    let Some(plugin) = crate::integrations::integration_by_name(&name) else {
        return Err(ApiError::not_found(format!("unknown integration {name}")));
    };
    let mut config = body
        .get("config")
        .cloned()
        .unwrap_or_else(|| existing.map(|r| r.config.clone()).unwrap_or(json!({})));
    // Per-tool curation (adapters spec §6) is admin state with a single
    // writer — the PUT tools endpoint. A settings save never changes it:
    // the client-sent tools map (a stale snapshot by definition) is dropped
    // and the stored selection rides through.
    if let Some(obj) = config.as_object_mut() {
        obj.remove("tools");
        if let Some(stored) = existing.and_then(|r| r.config.get("tools")) {
            obj.insert("tools".to_string(), stored.clone());
        }
    }
    // Validate via the plugin's own config check before saving.
    if let Err(e) = plugin.tools(&config) {
        return Err(ApiError::bad_request(format!(
            "invalid integration config: {e}"
        )));
    }
    let manifest = plugin.manifest();
    let schema_fields = manifest.settings.map(|s| s.fields).unwrap_or_default();
    let enabled = body["enabled"]
        .as_bool()
        .unwrap_or_else(|| existing.map(|r| r.enabled).unwrap_or(false));
    // Required settings must be filled (a missing optional falls back to
    // the manifest default or stays absent). Credential fields are skipped
    // here — they are enforced by the missing-secrets gate below, which
    // reports the proper conflict code.
    for f in &schema_fields {
        if !f.required || f.kind == "secret" {
            continue;
        }
        let present = match f.kind.as_str() {
            "boolean" => config[f.name.as_str()].is_boolean(),
            _ => config[f.name.as_str()]
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or(false),
        };
        if !present {
            let label = f.label.clone().unwrap_or_else(|| f.name.clone());
            return Err(ApiError::bad_request(format!("field {label} is required")));
        }
    }
    // Merge stored + submitted credentials in memory and test before
    // anything is written.
    let declared = schema_fields
        .iter()
        .filter(|f| f.kind == "secret")
        .map(|f| f.name.clone())
        .collect::<Vec<_>>();
    let mut secrets = store
        .integration_secrets()
        .resolve(
            org_id,
            name,
            &store.integration_secrets().names(org_id, name).await?,
            &master,
        )
        .await
        .map_err(|e| match e {
            crate::store::integration_secrets::ResolveError::Api(api) => api,
            crate::store::integration_secrets::ResolveError::MissingSecrets(names) => {
                ApiError::conflict(
                    "missing_secrets",
                    format!("missing secrets: {}", names.join(", ")),
                )
            }
        })?;
    for (k, v) in &submitted {
        secrets.retain(|(n, _)| n != k);
        secrets.push((k.clone(), v.clone()));
    }
    if enabled {
        let missing: Vec<String> = declared
            .iter()
            .filter(|d| !secrets.iter().any(|(n, _)| n == *d))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(ApiError::conflict(
                "missing_secrets",
                format!("missing secrets: {}", missing.join(", ")),
            ));
        }
    }
    plugin
        .test_connection(&config, &secrets)
        .await
        .map_err(ApiError::bad_request)?;
    for (k, v) in &submitted {
        store
            .integration_secrets()
            .upsert(org_id, name, k, v, &master)
            .await?;
    }
    store
        .integrations()
        .upsert(org_id, name, &config, enabled)
        .await?;
    Ok(())
}

/// Connection test for an MCP plugin: a full pool connect plus tools/list
/// handshake with the would-be secret headers.
async fn mcp_test_connection(
    state: &crate::state::AppState,
    org_id: Uuid,
    url: &str,
    secrets: &[(String, String)],
) -> Result<(), ApiError> {
    let headers =
        crate::integrations::envelope_headers(&Uuid::now_v7(), &org_id, None, None, secrets);
    let key = crate::worker::mcp_pool::PoolKey {
        slug: "save-test".to_string(),
        url: url.to_string(),
        acting_as: None,
        secrets_fingerprint: crate::worker::mcp_pool::secrets_fingerprint(secrets),
    };
    let peer = state
        .mcp_pool
        .get_or_connect(&key, url, headers)
        .await
        .map_err(|e| ApiError::bad_request(format!("MCP server unreachable: {e:#}")))?;
    peer.list_tools(None)
        .await
        .map_err(|e| ApiError::bad_request(format!("MCP tools/list failed: {e}")))?;
    Ok(())
}

/// Lists one integration's secret names, timestamps and masked previews —
/// never values.
async fn list_integration_secrets(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let row = store
        .integrations()
        .get(admin.0.org_id, id)
        .await?
        .ok_or_else(|| ApiError::not_found("unknown integration"))?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    let secrets = store
        .integration_secrets()
        .list(admin.0.org_id, &row.name, &master)
        .await?;
    Ok(Json(json!({ "secrets": secrets })))
}

/// Removes one secret. If the integration is enabled and its manifest
/// declares that secret, the row is auto-disabled (spec §9).
async fn delete_integration_secret(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((id, secret)): Path<(Uuid, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let row = store
        .integrations()
        .get(admin.0.org_id, id)
        .await?
        .ok_or_else(|| ApiError::not_found("unknown integration"))?;
    store
        .integration_secrets()
        .delete(admin.0.org_id, &row.name, &secret)
        .await?;
    if row.enabled {
        // The row's manifest declares its secrets: the registry manifest
        // when a v2 bundle claims the slug (it shadows a same-named
        // built-in, see save_integration), the in-code manifest otherwise.
        let registry_manifest =
            latest_integration_manifest(&store, admin.0.org_id, &row.name).await?;
        let v2_claimed = registry_manifest
            .as_ref()
            .map(|m| m.mcp.is_some())
            .unwrap_or(false)
            || row.config["mcp"]["url"].as_str().is_some();
        let declares = if v2_claimed {
            registry_manifest
                .and_then(|m| m.auth)
                .map(|a| a.secret_names.contains(&secret))
                .unwrap_or(false)
        } else {
            crate::integrations::integration_by_name(&row.name)
                .and_then(|p| p.manifest().auth)
                .map(|a| a.secret_names.contains(&secret))
                .unwrap_or(false)
        };
        if declares {
            store
                .integrations()
                .update(admin.0.org_id, row.id, &row.config, false)
                .await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- per-tool admin curation (adapters spec §5/§6) ----------

/// One declared/served tool with its stored per-tool curation, as the admin
/// Tools table renders it.
fn curated_tool_json(
    raw_name: &str,
    slug: &str,
    class: &str,
    description: &str,
    mcp: bool,
    row_config: &serde_json::Value,
) -> serde_json::Value {
    let curate = crate::integrations::tool_curate(row_config, mcp, raw_name);
    json!({
        "name": raw_name,
        "tool": crate::integrations::namespaced_tool(slug, raw_name),
        "class": class,
        "description": description,
        "enabled": curate.enabled,
        "approval": if curate.always_ask { "always_ask" } else { "default" },
    })
}

/// `GET /api/v1/admin/integrations/{id}/tools` — the full, unfiltered tool
/// list of one integration row with each tool's stored per-tool config.
/// Built-in (adapter-bound) rows read their compiled-in declarations; MCP
/// rows connect live and merge the discovered tools with the stored config.
/// A disabled row reports `resolved: false` without connecting; a broken
/// plugin reports the resolution error — never a silent empty list.
async fn list_integration_tools(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store().await?;
    let row = store
        .integrations()
        .get(admin.0.org_id, id)
        .await?
        .ok_or_else(|| ApiError::not_found("unknown integration"))?;
    let mcp = row.config["mcp"]["url"].as_str().is_some();
    if !mcp {
        let Some(plugin) = crate::integrations::integration_by_name(&row.name) else {
            return Err(ApiError::not_found(format!(
                "unknown integration kind {}",
                row.name
            )));
        };
        let manifest = plugin.manifest();
        let specs = plugin
            .tools(&row.config)
            .map_err(|e| ApiError::bad_request(format!("invalid integration config: {e}")))?;
        let tools: Vec<serde_json::Value> = specs
            .iter()
            .map(|spec| {
                curated_tool_json(
                    &spec.name,
                    &row.name,
                    guild_core::registry::tool_class(&manifest, &spec.name),
                    &spec.description,
                    false,
                    &row.config,
                )
            })
            .collect();
        return Ok(Json(json!({ "resolved": true, "kind": "builtin", "tools": tools })));
    }
    // MCP-bound: live discovery merged with the stored config. A disabled
    // row is not resolved (it serves nothing); a reachable one lists every
    // tool it currently serves, each with the stored curation (absent =
    // disabled, so remote drift lands visible-but-off).
    if !row.enabled {
        return Ok(Json(
            json!({ "resolved": false, "kind": "mcp", "reason": "integration disabled", "tools": [] }),
        ));
    }
    let url = row.config["mcp"]["url"].as_str().unwrap_or_default();
    let manifest = crate::integrations::registry_manifest(&store, admin.0.org_id, &row.name)
        .await
        .map_err(|e| ApiError::bad_request(format!("no registry manifest: {e}")))?;
    let master = state.config.master_key().map_err(ApiError::from)?;
    let secret_names = manifest
        .auth
        .as_ref()
        .map(|a| a.secret_names.clone())
        .unwrap_or_default();
    let secrets = store
        .integration_secrets()
        .resolve(admin.0.org_id, &row.name, &secret_names, &master)
        .await
        .map_err(|e| ApiError::conflict("missing_secrets", format!("{e}")))?;
    let headers = crate::integrations::envelope_headers(
        &Uuid::now_v7(),
        &admin.0.org_id,
        None,
        None,
        &secrets,
    );
    let key = crate::worker::mcp_pool::PoolKey {
        slug: row.name.clone(),
        url: url.to_string(),
        acting_as: None,
        secrets_fingerprint: crate::worker::mcp_pool::secrets_fingerprint(&secrets),
    };
    let peer = state
        .mcp_pool
        .get_or_connect(&key, url, headers)
        .await
        .map_err(|e| ApiError::bad_request(format!("MCP server unreachable: {e:#}")))?;
    let listed = peer
        .list_tools(None)
        .await
        .map_err(|e| ApiError::bad_request(format!("MCP tools/list failed: {e}")))?;
    let tools: Vec<serde_json::Value> = listed
        .tools
        .iter()
        .map(|t| {
            curated_tool_json(
                &t.name,
                &row.name,
                guild_core::registry::tool_class(&manifest, &t.name),
                t.description.as_ref().map(|d| d.as_ref()).unwrap_or(""),
                true,
                &row.config,
            )
        })
        .collect();
    Ok(Json(json!({ "resolved": true, "kind": "mcp", "tools": tools })))
}

/// `PUT /api/v1/admin/integrations/{id}/tools/{tool}` — sets one tool's
/// per-tool curation (`enabled`, `approval`). Idempotent: the stored config
/// is the source of truth, so selections survive bundle republishes and
/// settings saves.
async fn set_integration_tool(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((id, tool)): Path<(Uuid, String)>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // The name becomes a JSON object key and a URL path segment: URL-safe
    // charset only, dashes and dots included (MCP tool names use them).
    if tool.is_empty()
        || !tool
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(ApiError::bad_request("invalid tool name"));
    }
    let enabled = body["enabled"]
        .as_bool()
        .ok_or_else(|| ApiError::bad_request("enabled must be a boolean"))?;
    let approval = body["approval"].as_str().unwrap_or("default");
    if approval != "default" && approval != crate::integrations::TOOL_APPROVAL_ALWAYS_ASK {
        return Err(ApiError::bad_request(
            "approval must be default or always_ask",
        ));
    }
    let store = state.store().await?;
    let (mcp, response) = {
        // Read-modify-write under a row lock in one transaction: two
        // concurrent PUTs (or a racing settings save) must never drop each
        // other's curation entry. Entries for not-currently-declared tools
        // are allowed — they are how a preset survives a bundle republish.
        let mut tx = store.pool().begin().await?;
        let (config, row_enabled, name): (serde_json::Value, bool, String) = sqlx::query_as(
            "SELECT config, enabled, name FROM integrations WHERE org_id = $1 AND id = $2 FOR UPDATE",
        )
        .bind(admin.0.org_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("unknown integration"))?;
        let mcp = config["mcp"]["url"].as_str().is_some();
        let mut new_config = config.clone();
        new_config["tools"][&tool] = json!({ "enabled": enabled, "approval": approval });
        sqlx::query(
            "UPDATE integrations SET config = $2, updated_at = now() WHERE org_id = $1 AND id = $3",
        )
        .bind(admin.0.org_id)
        .bind(&new_config)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        // Durable, org-queryable audit of the governance change.
        store
            .events()
            .emit(
                admin.0.org_id,
                "integration.tool_curated",
                json!({
                    "integration": name,
                    "tool": tool,
                    "enabled": enabled,
                    "approval": approval,
                    "by": admin.0.id,
                }),
            )
            .await?;
        tracing::info!(
            org = %admin.0.org_id,
            integration = %name,
            tool = %tool,
            enabled,
            approval,
            "per-tool curation updated"
        );
        let curate = crate::integrations::tool_curate(&new_config, mcp, &tool);
        let response = json!({
            "name": tool,
            "enabled": curate.enabled,
            "approval": if curate.always_ask { "always_ask" } else { "default" },
        });
        (mcp, response)
    };
    let _ = mcp; // kind kept for symmetry with the GET path
    Ok(Json(response))
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
    ensure_min_password_len(password)?;
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

/// Minimum accepted password length for admin-managed accounts.
fn ensure_min_password_len(password: &str) -> Result<(), ApiError> {
    if password.chars().count() < 8 {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters",
        ));
    }
    Ok(())
}

async fn delete_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if user_id == admin.0.id {
        return Err(ApiError::bad_request("cannot delete yourself"));
    }
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
    if let Some(p) = password {
        ensure_min_password_len(p)?;
    }
    if role.is_none() && password.is_none() {
        return Err(ApiError::bad_request("nothing to update"));
    }
    let store = state.store().await?;
    // An admin must not demote themselves, and the org's last admin must
    // not lose the admin role — otherwise no one can administer the org.
    let target = store.identity().get_user(user_id).await?;
    if target.role == "admin" && role == Some("member") {
        if target.id == admin.0.id {
            return Err(ApiError::bad_request("cannot demote yourself"));
        }
        let admins = store.identity().list_users(admin.0.org_id).await?;
        if admins.iter().filter(|u| u.role == "admin").count() <= 1 {
            return Err(ApiError::conflict(
                "last_admin",
                "cannot demote the last admin",
            ));
        }
    }
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
