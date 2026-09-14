//! Google Workspace integration (read-only): Gmail, Calendar, Drive and the
//! Admin Directory behind one service account. Config keys:
//! `api_base` (optional, Google API host root, default
//! `https://www.googleapis.com`) and `token_url` (optional, OAuth token
//! endpoint, default `https://oauth2.googleapis.com/token`). Secrets:
//! `service_account_json` (the full service-account JSON string) and
//! `admin_email` (the domain-wide delegation default subject). Auth: a
//! RS256 JWT is exchanged for an access token whose `sub` carries the
//! acting identity; tokens cache in-process until near expiry.

use super::{api_tool_spec, call_vendor_api, field, in_code_manifest, ApiAuth, Category, Integration, ToolOutcome};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use futures::future::BoxFuture;
use guild_core::registry::BundleManifest;
use protocol::api::ToolSpec;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const SCOPES: &str = "https://www.googleapis.com/auth/gmail.readonly \
                      https://www.googleapis.com/auth/calendar.readonly \
                      https://www.googleapis.com/auth/drive.readonly \
                      https://www.googleapis.com/auth/admin.directory.user.readonly";
const DEFAULT_API_BASE: &str = "https://www.googleapis.com";
const DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const JWT_TTL_SECS: u64 = 3600;
/// A cached access token refreshes this long before its own expiry.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);
const MAX_BODY_CHARS: usize = 8000;

pub struct GoogleWorkspace {
    /// Access tokens keyed by `token_url|client_email|subject` — one cache
    /// entry per acting identity, shared across calls in this process.
    tokens: Mutex<HashMap<String, CachedToken>>,
}

struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// The process-wide connector instance: `integration_by_name` hands out a
/// fresh Arc per lookup, and the token cache must outlive a single call —
/// the shared instance keeps the cache in-process.
static INSTANCE: LazyLock<Arc<GoogleWorkspace>> = LazyLock::new(|| {
    Arc::new(GoogleWorkspace {
        tokens: Mutex::new(HashMap::new()),
    })
});

pub fn instance() -> Arc<GoogleWorkspace> {
    INSTANCE.clone()
}

/// Acting identity for the `sub` claim: the call's `acting_as` value when
/// present, else the `admin_email` secret (the domain-wide delegation
/// default subject).
pub fn acting_identity(acting_as: Option<&str>, admin_email: &str) -> String {
    acting_as
        .map(str::to_string)
        .unwrap_or_else(|| admin_email.to_string())
}

fn api_base(config: &serde_json::Value) -> String {
    config["api_base"]
        .as_str()
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
}

fn token_url(config: &serde_json::Value) -> String {
    config["token_url"]
        .as_str()
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_TOKEN_URL.to_string())
}

fn secret(secrets: &[(String, String)], name: &str) -> Result<String, String> {
    secrets
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.clone())
        .ok_or(format!("secret {name} is not stored"))
}

/// (`client_email`, `private_key`) out of the full service-account JSON.
fn service_account(secrets: &[(String, String)]) -> Result<(String, String), String> {
    let raw = secret(secrets, "service_account_json")?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("service_account_json is not valid json: {e}"))?;
    let client_email = v["client_email"]
        .as_str()
        .ok_or("service_account_json missing client_email")?
        .to_string();
    let private_key = v["private_key"]
        .as_str()
        .ok_or("service_account_json missing private_key")?
        .to_string();
    Ok((client_email, private_key))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

/// A valid (possibly cached) OAuth access token for `sub`.
async fn access_token(
    connector: &GoogleWorkspace,
    config: &serde_json::Value,
    secrets: &[(String, String)],
    sub: &str,
) -> Result<String, String> {
    let (client_email, private_key) = service_account(secrets)?;
    let token_url = token_url(config);
    let cache_key = format!("{token_url}|{client_email}|{sub}");
    {
        let cache = connector.tokens.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            if cached.expires_at > Instant::now() + EXPIRY_MARGIN {
                return Ok(cached.token.clone());
            }
        }
    }
    let now = unix_now();
    let claims = JwtClaims {
        iss: &client_email,
        sub,
        scope: SCOPES,
        aud: &token_url,
        iat: now,
        exp: now + JWT_TTL_SECS,
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key.as_bytes())
        .map_err(|e| format!("service_account_json private_key unreadable: {e}"))?;
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    let assertion = jsonwebtoken::encode(&header, &claims, &key)
        .map_err(|e| format!("service account jwt signing failed: {e}"))?;
    let resp = reqwest::Client::new()
        .post(&token_url)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("google token endpoint unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "google token endpoint returned {}",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("google token endpoint returned bad json: {e}"))?;
    let token = body["access_token"]
        .as_str()
        .ok_or("google token response missing access_token")?
        .to_string();
    // Clamp: a nonsensical expires_in must not overflow Instant.
    let expires_in = body["expires_in"].as_u64().unwrap_or(JWT_TTL_SECS).min(86_400);
    // Two concurrent callers may both exchange a JWT — the token endpoint
    // tolerates that; the loser's entry overwrites harmlessly.
    connector.tokens.lock().await.insert(
        cache_key,
        CachedToken {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(expires_in),
        },
    );
    Ok(token)
}

/// Access token for the call's acting identity: `acting_as` (the caller's
/// mapped email or an admin override) when present, else the `admin_email`
/// secret — the domain-wide delegation default subject.
async fn access_token_for(
    connector: &GoogleWorkspace,
    config: &serde_json::Value,
    secrets: &[(String, String)],
    acting_as: Option<&str>,
) -> Result<String, String> {
    let admin_email = secret(secrets, "admin_email")?;
    let sub = acting_identity(acting_as, &admin_email);
    access_token(connector, config, secrets, &sub).await
}

async fn get_json(url: &str, token: &str, api: &str) -> Result<serde_json::Value, String> {
    let resp = get_request(url, token)
        .send()
        .await
        .map_err(|e| format!("{api} unreachable: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("{api} returned unreadable body: {e}"))?;
    if !status.is_success() {
        // A short error body helps diagnosis; secrets never appear here.
        let detail: String = text.chars().take(300).collect();
        return Err(format!("{api} returned {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("{api} returned bad json: {e}"))
}

fn get_request(url: &str, token: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(20))
}

fn max_results(args: &serde_json::Value, default: u64, cap: u64) -> u64 {
    args["max_results"].as_u64().unwrap_or(default).clamp(1, cap)
}

/// Decodes a Gmail base64url body part to text.
fn decode_body_part(data: &str) -> Option<String> {
    let cleaned = data.trim_end_matches('=');
    let bytes = B64_URL.decode(cleaned).ok()?;
    String::from_utf8(bytes).ok()
}

/// Depth-first search of the MIME tree for a readable text body: text/plain
/// wins, text/html is a fallback (tags stripped), body text only — no
/// attachments.
fn extract_body(payload: &serde_json::Value) -> Option<String> {
    let mime = payload["mimeType"].as_str().unwrap_or("");
    if let Some(data) = payload["body"]["data"].as_str() {
        if mime == "text/plain" {
            return decode_body_part(data);
        }
        if mime == "text/html" {
            return decode_body_part(data).map(strip_html_tags);
        }
    }
    for part in payload["parts"].as_array()?.iter() {
        if let Some(body) = extract_body(part) {
            return Some(body);
        }
    }
    None
}

/// Replaces tag markup with a single space — a readable-text fallback for
/// html-only messages.
fn strip_html_tags(html: String) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn header_value<'a>(payload: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    payload["headers"]
        .as_array()?
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str())
}

fn truncate(text: String) -> String {
    if text.chars().count() <= MAX_BODY_CHARS {
        text
    } else {
        let cut: String = text.chars().take(MAX_BODY_CHARS).collect();
        format!("{cut}\n\n[truncated]")
    }
}

/// `name contains '<value>'` with the quote escaped for the Drive query
/// grammar.
fn drive_name_query(name: &str) -> String {
    format!("name contains '{}'", name.replace('\'', "\\'"))
}

async fn gmail_search(
    config: &serde_json::Value,
    args: &serde_json::Value,
    token: &str,
) -> Result<ToolOutcome, String> {
    let query = args["query"]
        .as_str()
        .ok_or("gmail_search requires query")?;
    let url = format!(
        "{}/gmail/v1/users/me/messages?q={}&maxResults={}",
        api_base(config),
        urlencoding_lite(query),
        max_results(args, 10, 25)
    );
    let body = get_json(&url, token, "gmail").await?;
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    if messages.is_empty() {
        return Ok(ToolOutcome {
            content: "No messages match the search.".to_string(),
            meta: None,
        });
    }
    let mut out = format!(
        "Gmail search \"{}\": {} result(s)\n",
        query,
        body["resultSizeEstimate"].as_u64().unwrap_or(messages.len() as u64)
    );
    for m in &messages {
        out.push_str(&format!(
            "- id {} (thread {})\n",
            m["id"].as_str().unwrap_or("?"),
            m["threadId"].as_str().unwrap_or("?")
        ));
    }
    if body["nextPageToken"].is_string() {
        out.push_str("(more results available — narrow the query)\n");
    }
    Ok(ToolOutcome {
        content: out,
        meta: None,
    })
}

async fn gmail_get_message(
    config: &serde_json::Value,
    args: &serde_json::Value,
    token: &str,
) -> Result<ToolOutcome, String> {
    let id = args["message_id"]
        .as_str()
        .ok_or("gmail_get_message requires message_id")?;
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}",
        api_base(config),
        urlencoding_lite(id)
    );
    let body = get_json(&url, token, "gmail").await?;
    let payload = &body["payload"];
    let mut out = String::new();
    for header in ["Subject", "From", "Date"] {
        if let Some(v) = header_value(payload, header) {
            out.push_str(&format!("{header}: {v}\n"));
        }
    }
    out.push('\n');
    match extract_body(payload) {
        Some(text) => out.push_str(&truncate(text)),
        None => out.push_str(&format!(
            "(no text body — snippet: {})",
            body["snippet"].as_str().unwrap_or("none")
        )),
    }
    Ok(ToolOutcome {
        content: out,
        meta: None,
    })
}

async fn calendar_list_events(
    config: &serde_json::Value,
    args: &serde_json::Value,
    token: &str,
) -> Result<ToolOutcome, String> {
    let mut url = format!(
        "{}/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults={}",
        api_base(config),
        max_results(args, 10, 50)
    );
    if let Some(t) = args["time_min"].as_str() {
        url.push_str(&format!("&timeMin={}", urlencoding_lite(t)));
    }
    if let Some(t) = args["time_max"].as_str() {
        url.push_str(&format!("&timeMax={}", urlencoding_lite(t)));
    }
    let body = get_json(&url, token, "calendar").await?;
    let items = body["items"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return Ok(ToolOutcome {
            content: "No events in the requested window.".to_string(),
            meta: None,
        });
    }
    let mut out = format!("Calendar events: {}\n", items.len());
    for e in &items {
        let start = e["start"]["dateTime"]
            .as_str()
            .or(e["start"]["date"].as_str())
            .unwrap_or("(no start)");
        out.push_str(&format!(
            "- {} {}\n",
            start,
            e["summary"].as_str().unwrap_or("(untitled)")
        ));
    }
    Ok(ToolOutcome {
        content: out,
        meta: None,
    })
}

async fn drive_search(
    config: &serde_json::Value,
    args: &serde_json::Value,
    token: &str,
) -> Result<ToolOutcome, String> {
    let name = args["name"].as_str().ok_or("drive_search requires name")?;
    let url = format!(
        "{}/drive/v3/files?q={}&fields=files(id,name,mimeType)&pageSize={}",
        api_base(config),
        urlencoding_lite(&drive_name_query(name)),
        max_results(args, 10, 50)
    );
    let body = get_json(&url, token, "drive").await?;
    let files = body["files"].as_array().cloned().unwrap_or_default();
    if files.is_empty() {
        return Ok(ToolOutcome {
            content: format!("No Drive files matching \"{}\".", name),
            meta: None,
        });
    }
    let mut out = format!("Drive files matching \"{}\": {}\n", name, files.len());
    for f in &files {
        out.push_str(&format!(
            "- {} — {} (id {})\n",
            f["name"].as_str().unwrap_or("(untitled)"),
            f["mimeType"].as_str().unwrap_or("unknown"),
            f["id"].as_str().unwrap_or("?")
        ));
    }
    Ok(ToolOutcome {
        content: out,
        meta: None,
    })
}

async fn directory_users(
    config: &serde_json::Value,
    args: &serde_json::Value,
    secrets: &[(String, String)],
    token: &str,
) -> Result<ToolOutcome, String> {
    // Default domain: the admin_email's own domain (domain-wide delegation
    // is scoped to the service account's workspace).
    let admin = secret(secrets, "admin_email").unwrap_or_default();
    let default_domain = admin.rsplit('@').next().unwrap_or_default();
    let domain = args["domain"]
        .as_str()
        .unwrap_or(default_domain);
    let url = if domain.is_empty() {
        format!(
            "{}/admin/directory/v1/users?customer=my_customer&maxResults={}",
            api_base(config),
            max_results(args, 20, 50)
        )
    } else {
        format!(
            "{}/admin/directory/v1/users?domain={}&maxResults={}",
            api_base(config),
            urlencoding_lite(domain),
            max_results(args, 20, 50)
        )
    };
    let body = get_json(&url, token, "directory").await?;
    let users = body["users"].as_array().cloned().unwrap_or_default();
    if users.is_empty() {
        return Ok(ToolOutcome {
            content: format!("No directory users in domain \"{}\".", domain),
            meta: None,
        });
    }
    let mut out = format!("Directory users (domain {}): {}\n", domain, users.len());
    for u in &users {
        out.push_str(&format!(
            "- {} — {}\n",
            u["primaryEmail"].as_str().unwrap_or("(no email)"),
            u["name"]["fullName"].as_str().unwrap_or("(no name)")
        ));
    }
    Ok(ToolOutcome {
        content: out,
        meta: None,
    })
}

/// Percent-encodes the reserved characters Google's query strings must not
/// carry raw (query values ride inside one query parameter).
fn urlencoding_lite(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl Integration for GoogleWorkspace {
    fn name(&self) -> &'static str {
        "google_workspace"
    }

    fn category(&self) -> Category {
        Category::Other
    }

    fn manifest(&self) -> BundleManifest {
        let mut manifest = in_code_manifest(
            "google_workspace",
            "1.0.0",
            "Read-only Google Workspace tools: Gmail, Calendar, Drive, Admin Directory",
            &["service_account_json", "admin_email"],
            &[
                ("gmail_search", "read"),
                ("gmail_get_message", "read"),
                ("calendar_list_events", "read"),
                ("drive_search", "read"),
                ("directory_users", "read"),
                ("api", "write"),
            ],
            &[
                guild_core::registry::FieldSpec {
                    default: Some(serde_json::json!("https://www.googleapis.com")),
                    help: Some("Override only for a Google API proxy".into()),
                    ..field("api_base", "string")
                },
                guild_core::registry::FieldSpec {
                    default: Some(serde_json::json!("https://oauth2.googleapis.com/token")),
                    help: Some("Override only for a Google API proxy".into()),
                    ..field("token_url", "string")
                },
            ],
        );
        if let Some(auth) = manifest.auth.as_mut() {
            // Org-wide service account; the per-call acting identity rides
            // the token `sub` claim (identity_key "email").
            auth.kind = "org_secret_impersonated".to_string();
            auth.identity_key = "email".to_string();
        }
        manifest
    }

    fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
        Ok(vec![
            ToolSpec {
                name: "gmail_search".into(),
                description: "Search Gmail and return matching message ids (Gmail query syntax)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Gmail search query, e.g. 'from:alice has:attachment'" },
                        "max_results": { "type": "number", "description": "1-25, default 10" }
                    },
                    "required": ["query"]
                }),
            },
            ToolSpec {
                name: "gmail_get_message".into(),
                description: "Fetch one Gmail message and return its headers and text body."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "message_id": { "type": "string" }
                    },
                    "required": ["message_id"]
                }),
            },
            ToolSpec {
                name: "calendar_list_events".into(),
                description: "List upcoming events on the primary Google Calendar."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "time_min": { "type": "string", "description": "RFC3339 lower bound (optional)" },
                        "time_max": { "type": "string", "description": "RFC3339 upper bound (optional)" },
                        "max_results": { "type": "number", "description": "1-50, default 10" }
                    }
                }),
            },
            ToolSpec {
                name: "drive_search".into(),
                description: "Search Google Drive files by name substring."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Filename substring to match" },
                        "max_results": { "type": "number", "description": "1-50, default 10" }
                    },
                    "required": ["name"]
                }),
            },
            ToolSpec {
                name: "directory_users".into(),
                description: "List Google Workspace directory users (defaults to the admin's domain)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "domain": { "type": "string", "description": "Domain to list (optional)" },
                        "max_results": { "type": "number", "description": "1-50, default 20" }
                    }
                }),
            },
            api_tool_spec("Google API"),
        ])
    }

    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
        secrets: &'a [(String, String)],
        acting_as: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
        Box::pin(async move {
            // Dispatch first: an unknown tool fails without touching the
            // network. Per-call identity (spec §5): acting_as is the DWD
            // `sub`; the default subject is admin_email.
            if tool == "api" {
                let token = access_token_for(self, config, secrets, acting_as).await?;
                let base = config["api_base"]
                    .as_str()
                    .unwrap_or(DEFAULT_API_BASE)
                    .trim_end_matches('/');
                return call_vendor_api(base, &ApiAuth::Bearer(token), &args, 12_000, &[]).await;
            }
            match tool {
                "gmail_search" => {
                    let token = access_token_for(self, config, secrets, acting_as).await?;
                    gmail_search(config, &args, &token).await
                }
                "gmail_get_message" => {
                    let token = access_token_for(self, config, secrets, acting_as).await?;
                    gmail_get_message(config, &args, &token).await
                }
                "calendar_list_events" => {
                    let token = access_token_for(self, config, secrets, acting_as).await?;
                    calendar_list_events(config, &args, &token).await
                }
                "drive_search" => {
                    let token = access_token_for(self, config, secrets, acting_as).await?;
                    drive_search(config, &args, &token).await
                }
                "directory_users" => {
                    let token = access_token_for(self, config, secrets, acting_as).await?;
                    directory_users(config, &args, secrets, &token).await
                }
                other => Err(format!("google_workspace integration has no tool {other}")),
            }
        })
    }
}
