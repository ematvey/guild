//! OIDC SSO configuration + login flow (spec §4.1): generic OIDC against the
//! org's IdP, provisioning `identity_type='oidc'` users on first login.

use crate::http::error::ApiError;
use crate::http::gateway::AdminUser;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect, Response};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/admin/oidc",
            axum::routing::put(set_config).get(get_config).delete(remove_config),
        )
        .route(
            "/api/v1/auth/oidc/status",
            axum::routing::get(status),
        )
        .route("/api/v1/auth/oidc/login", axum::routing::get(login))
        .route("/api/v1/auth/oidc/callback", axum::routing::get(callback))
}

// ---------- admin config ----------
// ---------- admin config ----------

async fn set_config(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let issuer = body["issuer"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing issuer"))?;
    let client_id = body["client_id"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing client_id"))?;
    let client_secret = body["client_secret"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("missing client_secret"))?;
    let master = state.config.master_key()?;
    state
        .store()
        .await?
        .oidc()
        .upsert(admin.0.org_id, issuer, client_id, client_secret, &master)
        .await?;
    Ok(Json(json!({})))
}

async fn get_config(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let row = state.store().await?.oidc().get(admin.0.org_id).await?;
    Ok(Json(match row {
        Some(r) => json!({"configured": true, "issuer": r.issuer, "client_id": r.client_id}),
        None => json!({"configured": false}),
    }))
}

async fn remove_config(
    State(state): State<AppState>,
    admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    state.store().await?.oidc().delete(admin.0.org_id).await?;
    Ok(Json(json!({})))
}

/// Public: tells the sign-in page whether SSO is available and where to
/// start it. Guild is effectively single-org, so the org is resolved here.
async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let Some(org) = store.oidc().first_org_id().await? else {
        return Ok(Json(json!({"configured": false})));
    };
    let configured = store.oidc().get(org).await?.is_some();
    Ok(Json(json!({"configured": configured, "org_id": org})))
}

// ---------- login flow ----------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct OidcState {
    org: Uuid,
    /// Origin the login was started from; the callback redirects the browser
    /// back here with the session token in the URL fragment.
    app: String,
    exp: i64,
}

fn sign_state(state: &AppState, org: Uuid, app: String) -> Result<String, ApiError> {
    let claims = OidcState {
        org,
        app,
        exp: chrono::Utc::now().timestamp() + 600,
    };
    let key = jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes());
    jsonwebtoken::encode(&jsonwebtoken::Header::default(), &claims, &key)
        .map_err(|e| ApiError::internal(format!("state sign failed: {e}")))
}

fn verify_state(state: &AppState, token: &str) -> Result<OidcState, ApiError> {
    let key = jsonwebtoken::DecodingKey::from_secret(state.config.jwt_secret.as_bytes());
    let data = jsonwebtoken::decode::<OidcState>(token, &key, &jsonwebtoken::Validation::default())
        .map_err(|_| ApiError::unauthorized("bad state"))?;
    Ok(data.claims)
}

/// The browser-facing base URL (scheme + host) of this request: the IdP
/// redirect_uri and the post-login app redirect both come from it, so they
/// match whatever origin the user actually reached the server on.
fn request_origin(headers: &axum::http::HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    format!("{scheme}://{host}")
}

#[derive(Deserialize, Debug)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    userinfo_endpoint: Option<String>,
}

async fn fetch_discovery(issuer: &str) -> Result<Discovery, ApiError> {
    let url = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    reqwest::get(&url)
        .await
        .map_err(|e| ApiError::internal(format!("oidc discovery failed: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::internal(format!("oidc discovery failed: {e}")))?
        .json::<Discovery>()
        .await
        .map_err(|e| ApiError::internal(format!("oidc discovery parse failed: {e}")))
}

/// Starts the OIDC login: 302 to the IdP's authorization endpoint.
async fn login(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let org: Uuid = q
        .get("org_id")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing org_id"))?;
    let store = state.store().await?;
    let Some(row) = store.oidc().get(org).await? else {
        return Err(ApiError::not_found("no oidc config for org"));
    };
    let discovery = fetch_discovery(&row.issuer).await?;
    let app_origin = request_origin(&headers);
    let redirect_uri = format!("{app_origin}/api/v1/auth/oidc/callback");
    let auth_url = reqwest::Url::parse_with_params(
        &discovery.authorization_endpoint,
        &[
            ("response_type", "code"),
            ("client_id", row.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", "openid email profile"),
            ("state", sign_state(&state, org, app_origin)?.as_str()),
        ],
    )
    .map_err(|e| ApiError::internal(format!("auth url build failed: {e}")))?;
    Ok(Redirect::to(auth_url.as_str()).into_response())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

async fn callback(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let code = q
        .get("code")
        .ok_or_else(|| ApiError::bad_request("missing code"))?;
    let state_param = q
        .get("state")
        .ok_or_else(|| ApiError::bad_request("missing state"))?;
    let oidc_state = verify_state(&state, state_param)?;
    let org = oidc_state.org;

    let store = state.store().await?;
    let master = state.config.master_key()?;
    let row = store
        .oidc()
        .get(org)
        .await?
        .ok_or_else(|| ApiError::not_found("no oidc config for org"))?;
    let client_secret = store.oidc().decrypt_secret(&row, &master)?;
    let discovery = fetch_discovery(&row.issuer).await?;
    let redirect_uri = format!("{}/api/v1/auth/oidc/callback", oidc_state.app);

    let token_resp = reqwest::Client::new()
        .post(&discovery.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", row.client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ])
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("oidc token exchange failed: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::unauthorized(format!("oidc token exchange failed: {e}")))?
        .json::<TokenResponse>()
        .await
        .map_err(|e| ApiError::internal(format!("oidc token parse failed: {e}")))?;

    let userinfo_endpoint = discovery
        .userinfo_endpoint
        .ok_or_else(|| ApiError::internal("idp has no userinfo endpoint"))?;
    let userinfo = reqwest::Client::new()
        .get(&userinfo_endpoint)
        .bearer_auth(&token_resp.access_token)
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("oidc userinfo failed: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::unauthorized(format!("oidc userinfo failed: {e}")))?
        .json::<Value>()
        .await
        .map_err(|e| ApiError::internal(format!("oidc userinfo parse failed: {e}")))?;

    let email = userinfo["email"]
        .as_str()
        .ok_or_else(|| ApiError::unauthorized("idp returned no email claim"))?
        .to_string();
    let display_name = userinfo["name"].as_str().map(str::to_string);
    let avatar_url = userinfo["picture"].as_str().map(str::to_string);

    // Provision on first login with the IdP profile, refresh it when the
    // claims change, then hand out a session.
    let identity = store.identity();
    let user = match identity.find_by_email(org, &email).await? {
        Some(u) if u.display_name != display_name || u.avatar_url != avatar_url => {
            identity
                .update_oidc_profile(u.id, display_name.as_deref(), avatar_url.as_deref())
                .await?;
            u
        }
        Some(u) => u,
        None => {
            identity
                .create_oidc_user(org, &email, display_name.as_deref(), avatar_url.as_deref())
                .await?
        }
    };
    let (_sid, token) = identity.create_session(user.id).await?;

    // Back to the web app; the token rides in the URL fragment so it never
    // reaches the server again, and the app picks it up on load.
    let target = format!(
        "{}/#oidc_token={}&email={}",
        oidc_state.app.trim_end_matches('/'),
        urlencode(&token),
        urlencode(&email)
    );
    Ok(Redirect::to(&target).into_response())
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
