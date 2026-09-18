//! Google Workspace integration (read-only): Gmail, Calendar, Drive and the
//! Admin Directory behind one service account. Config keys:
//! `api_base` (optional, Google API host root, default
//! `https://www.googleapis.com`) and `token_url` (optional, OAuth token
//! endpoint, default `https://oauth2.googleapis.com/token`). Secrets:
//! `service_account_json` (the full service-account JSON string) and
//! `admin_email` (the domain-wide delegation default subject). Auth: a
//! RS256 JWT is exchanged for an access token whose `sub` carries the
//! acting identity; tokens cache in-process until near expiry.

use super::{
    api_tool_spec, call_vendor_api, field, in_code_manifest, ApiAuth, Category, Integration,
    ToolOutcome,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use futures::future::BoxFuture;
use guild_core::registry::BundleManifest;
use guild_core::tools::ToolArtifact;
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
/// Ceiling for the generic `api` tool's response text (tool artifacts
/// design): oversized results spill into artifacts, so the cap only bounds
/// storage, not history.
const API_MAX_CHARS: usize = 1024 * 1024;

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
        return Err(format!("google token endpoint returned {}", resp.status()));
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
    let expires_in = body["expires_in"]
        .as_u64()
        .unwrap_or(JWT_TTL_SECS)
        .min(86_400);
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
/// mapped email or an admin override) when present, else the default
/// subject: the `admin_email` setting; the legacy secret-named row of
/// pre-schema deployments is the fallback.
fn admin_email(config: &serde_json::Value, secrets: &[(String, String)]) -> Result<String, String> {
    if let Some(email) = config["admin_email"].as_str() {
        return Ok(email.to_string());
    }
    secret(secrets, "admin_email")
}

async fn access_token_for(
    connector: &GoogleWorkspace,
    config: &serde_json::Value,
    secrets: &[(String, String)],
    acting_as: Option<&str>,
) -> Result<String, String> {
    let admin_email = admin_email(config, secrets)?;
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
    args["max_results"]
        .as_u64()
        .unwrap_or(default)
        .clamp(1, cap)
}

/// Decodes a Gmail base64url body part to raw bytes.
fn decode_body_part_bytes(data: &str) -> Option<Vec<u8>> {
    let cleaned = data.trim_end_matches('=');
    B64_URL.decode(cleaned).ok()
}

/// Decodes a Gmail base64url body part to text.
fn decode_body_part(data: &str) -> Option<String> {
    decode_body_part_bytes(data).and_then(|bytes| String::from_utf8(bytes).ok())
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
        .find(|h| {
            h["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
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
            artifact: None,
            content: "No messages match the search.".to_string(),
            meta: None,
        });
    }
    let mut out = format!(
        "Gmail search \"{}\": {} result(s)\n",
        query,
        body["resultSizeEstimate"]
            .as_u64()
            .unwrap_or(messages.len() as u64)
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
        artifact: None,
        content: out,
        meta: None,
    })
}

/// Attachment parts of a message: (filename, mime, attachment id).
fn attachment_parts(payload: &serde_json::Value) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    collect_attachment_parts(payload, &mut out);
    out
}

fn collect_attachment_parts(
    payload: &serde_json::Value,
    out: &mut Vec<(String, String, String)>,
) {
    // Body parts of the message text carry an empty attachment id; a part
    // with a real id is an attachment (filename may sit on the part or in
    // its headers).
    if let Some(id) = payload["body"]["attachmentId"].as_str() {
        if !id.is_empty() {
            let filename = payload["filename"]
                .as_str()
                .or_else(|| header_value(payload, "filename"))
                .unwrap_or("(unnamed)")
                .to_string();
            let mime = payload["mimeType"]
                .as_str()
                .unwrap_or("application/octet-stream")
                .to_string();
            out.push((filename, mime, id.to_string()));
        }
    }
    for part in payload["parts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        collect_attachment_parts(part, out);
    }
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
    // Attachment parts are listed (not fetched) so the model can pull one
    // with gmail_get_attachment.
    let parts = attachment_parts(payload);
    if !parts.is_empty() {
        out.push_str("\nAttachments:\n");
        for (filename, mime, id) in &parts {
            out.push_str(&format!("- {filename} ({mime}; attachment id {id})\n"));
        }
    }
    Ok(ToolOutcome {
        artifact: None,
        content: out,
        meta: None,
    })
}

/// Fetches one Gmail attachment as raw bytes via the tool-artifact channel:
/// filename/mime come from the message part carrying the attachment id
/// (args can override the filename); the base64url body decodes to bytes
/// that the worker spills into a downloadable artifact.
async fn gmail_get_attachment(
    config: &serde_json::Value,
    args: &serde_json::Value,
    token: &str,
) -> Result<ToolOutcome, String> {
    let message_id = args["message_id"]
        .as_str()
        .ok_or("gmail_get_attachment requires message_id")?;
    let attachment_id = args["attachment_id"]
        .as_str()
        .ok_or("gmail_get_attachment requires attachment_id")?;
    // The attachment endpoint returns only size + base64url data; the part
    // metadata (filename, mime) comes from the message itself.
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}",
        api_base(config),
        urlencoding_lite(message_id)
    );
    let message = get_json(&url, token, "gmail").await?;
    let (part_filename, part_mime) = attachment_parts(&message["payload"])
        .into_iter()
        .find(|(_, _, id)| id == attachment_id)
        .map(|(f, m, _)| (Some(f), Some(m)))
        .unwrap_or((None, None));
    let filename = args["filename"]
        .as_str()
        .map(str::to_string)
        .or(part_filename)
        .unwrap_or_else(|| format!("gmail_{attachment_id}.bin"));
    let content_type = part_mime.unwrap_or_else(|| "application/octet-stream".to_string());
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}/attachments/{}",
        api_base(config),
        urlencoding_lite(message_id),
        urlencoding_lite(attachment_id)
    );
    let body = get_json(&url, token, "gmail").await?;
    let data = body["data"]
        .as_str()
        .ok_or("gmail attachment response missing data")?;
    let bytes =
        decode_body_part_bytes(data).ok_or("gmail attachment data is not valid base64url")?;
    Ok(ToolOutcome {
        content: format!(
            "attachment {filename} ({} bytes, {content_type})",
            bytes.len()
        ),
        meta: None,
        artifact: Some(ToolArtifact {
            filename,
            content_type,
            bytes,
        }),
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
            artifact: None,
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
        artifact: None,
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
            artifact: None,
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
        artifact: None,
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
    let admin = admin_email(config, secrets).unwrap_or_default();
    let default_domain = admin.rsplit('@').next().unwrap_or_default();
    let domain = args["domain"].as_str().unwrap_or(default_domain);
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
            artifact: None,
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
        artifact: None,
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

    fn categories(&self) -> &'static [Category] {
        &[Category::Other]
    }

    fn manifest(&self) -> BundleManifest {
        let mut manifest = in_code_manifest(
            "google_workspace",
            "1.0.0",
            "Read-only Google Workspace tools: Gmail, Calendar, Drive, Admin Directory",
            &[],
            &[
                ("gmail_search", "read"),
                ("gmail_get_message", "read"),
                ("gmail_get_attachment", "read"),
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
                guild_core::registry::FieldSpec {
                    required: true,
                    help: Some("workspace admin the service account acts as by default".into()),
                    placeholder: Some("admin@yourorg.com".into()),
                    ..field("admin_email", "string")
                },
                guild_core::registry::FieldSpec {
                    required: true,
                    ..field("service_account_json", "secret")
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
                kind: Default::default(),
            },
            ToolSpec {
                name: "gmail_get_message".into(),
                description: "Fetch one Gmail message: headers, text body, and the list of \
                              attachment parts (filename, mime, attachment id)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "message_id": { "type": "string" }
                    },
                    "required": ["message_id"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "gmail_get_attachment".into(),
                description: "Fetch one Gmail attachment as a downloadable file artifact. \
                              Get the attachment id from gmail_get_message's attachment list."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "message_id": { "type": "string" },
                        "attachment_id": { "type": "string" },
                        "filename": { "type": "string", "description": "Override the materialized filename (optional)" }
                    },
                    "required": ["message_id", "attachment_id"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "calendar_list_events".into(),
                description: "List upcoming events on the primary Google Calendar.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "time_min": { "type": "string", "description": "RFC3339 lower bound (optional)" },
                        "time_max": { "type": "string", "description": "RFC3339 upper bound (optional)" },
                        "max_results": { "type": "number", "description": "1-50, default 10" }
                    }
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "drive_search".into(),
                description: "Search Google Drive files by name substring.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Filename substring to match" },
                        "max_results": { "type": "number", "description": "1-50, default 10" }
                    },
                    "required": ["name"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "directory_users".into(),
                description:
                    "List Google Workspace directory users (defaults to the admin's domain).".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "domain": { "type": "string", "description": "Domain to list (optional)" },
                        "max_results": { "type": "number", "description": "1-50, default 20" }
                    }
                }),
                kind: Default::default(),
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
                return call_vendor_api(base, &ApiAuth::Bearer(token), &args, API_MAX_CHARS, &[])
                    .await;
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
                "gmail_get_attachment" => {
                    let token = access_token_for(self, config, secrets, acting_as).await?;
                    gmail_get_attachment(config, &args, &token).await
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

    /// The token exchange IS the test: it signs the service-account JWT and
    /// impersonates the admin — every credential in the chain is exercised.
    fn test_connection<'a>(
        &'a self,
        config: &'a serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let admin_email = admin_email(config, secrets)?;
            access_token(self, config, secrets, &admin_email)
                .await
                .map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_body_part_bytes_handles_binary_base64url() {
        // JPEG magic bytes, url-safe alphabet, no padding.
        assert_eq!(
            decode_body_part_bytes("_9j_4A").unwrap(),
            vec![0xFF, 0xD8, 0xFF, 0xE0]
        );
        // Text payload survives both variants.
        assert_eq!(
            decode_body_part_bytes("SGVsbG8sIHdvcmxkIQ").unwrap(),
            b"Hello, world!".to_vec()
        );
        assert_eq!(
            decode_body_part("SGVsbG8sIHdvcmxkIQ").as_deref(),
            Some("Hello, world!")
        );
        // Non-UTF8 data stays bytes-only: the string variant rejects it.
        assert!(decode_body_part("_9j_4A").is_none());
        assert!(decode_body_part_bytes("!!!").is_none());
    }

    #[test]
    fn attachment_parts_walk_the_mime_tree() {
        let message = serde_json::json!({
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {
                        "mimeType": "text/plain",
                        "body": { "data": "aGk", "attachmentId": "" }
                    },
                    {
                        "filename": "report.xlsx",
                        "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "body": { "attachmentId": "ANG4a" }
                    },
                    {
                        "mimeType": "multipart/alternative",
                        "parts": [
                            {
                                "filename": "sheet2.csv",
                                "mimeType": "text/csv",
                                "body": { "attachmentId": "ANG7b" }
                            }
                        ]
                    }
                ]
            }
        });
        let parts = attachment_parts(&message["payload"]);
        assert_eq!(
            parts,
            vec![
                (
                    "report.xlsx".to_string(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
                    "ANG4a".to_string()
                ),
                (
                    "sheet2.csv".to_string(),
                    "text/csv".to_string(),
                    "ANG7b".to_string()
                ),
            ]
        );
    }
}
