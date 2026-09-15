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
            axum::routing::put(set_config)
                .get(get_config)
                .delete(remove_config),
        )
        .route("/api/v1/auth/oidc/status", axum::routing::get(status))
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
    // Blank secret = keep the stored one (the edit form's contract).
    let client_secret = body["client_secret"].as_str();
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
        Some(r) => {
            // Length-only bullet preview so the edit form's secret field can
            // show a mask of the real stored length (never any content).
            let master = state.config.master_key()?;
            let secret_masked = state
                .store()
                .await?
                .oidc()
                .decrypt_secret(&r, &master)
                .ok()
                .map(|s| crate::crypto::mask_secret_len(s.chars().count()));
            json!({"configured": true, "issuer": r.issuer, "client_id": r.client_id, "secret_masked": secret_masked})
        }
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

/// The IdP `redirect_uri` and the post-login app redirect both come from the
/// configured API base URL — raw `Host`/`X-Forwarded-Proto` headers are
/// attacker-controlled on the direct-HTTP deployment and must not shape
/// security-relevant URLs.
fn server_origin(state: &AppState) -> String {
    state.config.api_url.trim_end_matches('/').to_string()
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
    let app_origin = server_origin(&state);
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
    let email_verified = userinfo["email_verified"].as_bool().unwrap_or(false);
    let display_name = userinfo["name"].as_str().map(str::to_string);
    let avatar_url = userinfo["picture"].as_str().map(str::to_string);

    // Provision on first login with the IdP profile, refresh it when the
    // claims change, then hand out a session.
    let identity = store.identity();
    let user = resolve_oidc_user(
        &identity,
        org,
        &email,
        email_verified,
        display_name.as_deref(),
        avatar_url.as_deref(),
    )
    .await?;
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

/// Resolves an OIDC login to a local user. The IdP-verified email is the
/// only match key: unverified email claims are rejected, and a managed
/// (password) account with the same address is never auto-matched — linking
/// it to OIDC requires an explicit admin flow, otherwise anyone whose IdP
/// asserts an arbitrary email could take over that account.
async fn resolve_oidc_user(
    identity: &crate::store::identity::IdentityStore<'_>,
    org: Uuid,
    email: &str,
    email_verified: bool,
    display_name: Option<&str>,
    avatar_url: Option<&str>,
) -> Result<crate::store::identity::UserRow, ApiError> {
    if !email_verified {
        return Err(ApiError::unauthorized("idp did not verify the email claim"));
    }
    match identity.find_by_email(org, email).await? {
        Some(u) if u.identity_type == "oidc" => {
            if u.display_name.as_deref() != display_name || u.avatar_url.as_deref() != avatar_url {
                identity
                    .update_oidc_profile(u.id, display_name, avatar_url)
                    .await?;
            }
            Ok(u)
        }
        Some(_) => Err(ApiError::conflict(
            "email_taken",
            "this email belongs to a password account; oidc linking is a separate admin flow",
        )),
        None => {
            identity
                .create_oidc_user(org, email, display_name, avatar_url)
                .await
        }
    }
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::resolve_oidc_user;
    use crate::store::Store;

    /// An unverified or verified email claim against an existing managed
    /// (password) user must never resolve to that user — no match, no
    /// session, no auto-provisioned account either.
    #[tokio::test]
    async fn unverified_or_managed_email_does_not_yield_a_session() {
        let db = Store::connect_test().await.unwrap();
        let store = &db.store;
        let identity = store.identity();
        let org = uuid::Uuid::now_v7();
        sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
            .bind(org)
            .execute(db.store.pool())
            .await
            .unwrap();
        let managed = identity
            .create_user(org, "local@example.org", "hunter226", "member")
            .await
            .unwrap();

        // Unverified claim naming the local user's email: rejected.
        let err = resolve_oidc_user(&identity, org, "local@example.org", false, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::UNAUTHORIZED);

        // Verified claim naming the local user's email: still rejected —
        // managed accounts are not auto-matched by email.
        let err = resolve_oidc_user(&identity, org, "local@example.org", true, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::CONFLICT);

        // No session may exist for the managed user.
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
            .bind(managed.id)
            .fetch_one(db.store.pool())
            .await
            .unwrap();
        assert_eq!(sessions, 0);

        // A distinct verified email provisions an oidc user, and a repeat
        // login resolves to the same account with the profile refreshed.
        let provisioned = resolve_oidc_user(
            &identity,
            org,
            "sso@example.org",
            true,
            Some("SSO User"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(provisioned.identity_type, "oidc");
        let again = resolve_oidc_user(
            &identity,
            org,
            "sso@example.org",
            true,
            Some("SSO User"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(again.id, provisioned.id);
    }
}
