//! Slack connector: conversation and user reads plus message posts through
//! the Slack Web API (`{base_url}/api/...`, `Authorization: Bearer`), and a
//! plain-text post through an incoming webhook URL. Secrets: `bot_token`
//! (Web API calls), `webhook_url` (incoming webhook). Config: none required;
//! an optional `base_url` overrides the `https://slack.com` default (tests
//! and self-hosted proxies). Every tool class comes from the in-code
//! manifest; secret values ride into `execute` per call and never reach
//! logs or results.

use crate::integrations::{in_code_manifest, Category, Integration, ToolOutcome};
use guild_core::registry::BundleManifest;
use futures::future::BoxFuture;
use protocol::api::ToolSpec;

const SLACK_API: &str = "https://slack.com/api";

/// The Web API base: the admin-configured `base_url` when present, else the
/// real Slack API.
fn base_url(config: &serde_json::Value) -> Result<String, String> {
    match config["base_url"].as_str() {
        Some(url) => Ok(url.trim_end_matches('/').to_string()),
        None => Ok(SLACK_API.to_string()),
    }
}

/// Slack messaging integration. Tool surface: `conversations_list` (read),
/// `conversations_history` (read), `users_list` (read), `post_message`
/// (write, Web API `chat.postMessage`), `post_webhook` (write, incoming
/// webhook).
pub struct Slack;

/// The resolved secret value for `name`, or an error naming the missing
/// secret (the caller sees which credential is absent, never a value).
fn secret<'a>(secrets: &'a [(String, String)], name: &str) -> Result<&'a str, String> {
    secrets
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
        .ok_or_else(|| format!("slack integration requires secret {name}"))
}

/// Cursor pagination argument (optional, forwarded verbatim).
fn cursor(args: &serde_json::Value) -> Option<String> {
    args["cursor"].as_str().map(str::to_string)
}

/// Limit argument, clamped to Slack's max page size of 200.
fn limit(args: &serde_json::Value) -> u32 {
    args["limit"].as_u64().unwrap_or(200).clamp(1, 200) as u32
}

/// Sends one Web API GET and maps Slack's envelope: non-2xx is an HTTP
/// error, `"ok": false` carries Slack's own error string.
async fn api_get(
    base: &str,
    bot_token: &str,
    endpoint: &str,
    query: &[(&str, String)],
) -> Result<serde_json::Value, String> {
    let resp = reqwest::Client::new()
        .get(format!("{base}/{endpoint}"))
        .bearer_auth(bot_token)
        .query(query)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("slack unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("slack returned {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("slack returned bad json: {e}"))?;
    if body["ok"] != true {
        return Err(format!(
            "slack api error: {}",
            body["error"].as_str().unwrap_or("unknown")
        ));
    }
    Ok(body)
}

/// Composes the model-facing text as pretty-printed JSON of the useful
/// fields only.
fn json_text(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
}

/// Builds one tool spec with a JSON-schema parameter object.
fn spec(name: &str, description: &str, properties: serde_json::Value) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters: serde_json::json!({ "type": "object", "properties": properties }),
    }
}

impl Integration for Slack {
    fn name(&self) -> &'static str {
        "slack"
    }

    fn category(&self) -> Category {
        Category::Other
    }

    fn manifest(&self) -> BundleManifest {
        in_code_manifest(
            "slack",
            "1.0.0",
            "Slack: list channels and users, read channel history, post messages",
            &["bot_token", "webhook_url"],
            &[
                ("conversations_list", "read"),
                ("conversations_history", "read"),
                ("users_list", "read"),
                ("post_message", "write"),
                ("post_webhook", "write"),
            ],
        )
    }

    fn tools(&self, config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
        // `base_url` is optional; when present it must be a string.
        if config.get("base_url").is_some() && config["base_url"].as_str().is_none() {
            anyhow::bail!("slack config base_url must be a string");
        }
        Ok(vec![
            spec(
                "conversations_list",
                "List Slack channels (public and private the bot can see).",
                serde_json::json!({
                    "limit": { "type": "number", "description": "1-200, default 200" },
                    "cursor": { "type": "string", "description": "Pagination cursor from a previous page" }
                }),
            ),
            spec(
                "conversations_history",
                "Read the message history of one channel by ID.",
                serde_json::json!({
                    "channel": { "type": "string", "description": "Channel ID, e.g. C0123456789" },
                    "limit": { "type": "number", "description": "1-200 messages, default 200" },
                    "cursor": { "type": "string", "description": "Pagination cursor from a previous page" }
                }),
            ),
            spec(
                "users_list",
                "List Slack users in the workspace.",
                serde_json::json!({
                    "limit": { "type": "number", "description": "1-200, default 200" },
                    "cursor": { "type": "string", "description": "Pagination cursor from a previous page" }
                }),
            ),
            spec(
                "post_message",
                "Post a message to a Slack channel through chat.postMessage.",
                serde_json::json!({
                    "channel": { "type": "string", "description": "Channel ID or name, e.g. C0123456789 or #general" },
                    "text": { "type": "string", "description": "Message text (plain text or Slack mrkdwn)" }
                }),
            ),
            spec(
                "post_webhook",
                "Post a message through the workspace's incoming webhook.",
                serde_json::json!({
                    "text": { "type": "string", "description": "Message text" }
                }),
            ),
        ])
    }

    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
        Box::pin(async move {
            let base = base_url(config)?;
            match tool {
                "conversations_list" => {
                    let token = secret(secrets, "bot_token")?;
                    let mut query = vec![
                        ("limit", limit(&args).to_string()),
                        (
                            "types",
                            "public_channel,private_channel".to_string(),
                        ),
                    ];
                    if let Some(c) = cursor(&args) {
                        query.push(("cursor", c));
                    }
                    let body = api_get(&base, token, "conversations.list", &query).await?;
                    let channels: Vec<serde_json::Value> = body["channels"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|c| {
                                    serde_json::json!({
                                        "id": c["id"],
                                        "name": c["name"],
                                        "is_private": c["is_private"],
                                        "topic": c["topic"]["value"],
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let meta = serde_json::json!({
                        "response_metadata": body["response_metadata"]["next_cursor"],
                    });
                    Ok(ToolOutcome {
                        content: json_text(&serde_json::json!({ "channels": channels })),
                        meta: Some(meta),
                    })
                }
                "conversations_history" => {
                    let token = secret(secrets, "bot_token")?;
                    let channel = args["channel"]
                        .as_str()
                        .ok_or("conversations_history requires channel")?
                        .to_string();
                    let mut query = vec![
                        ("channel", channel),
                        ("limit", limit(&args).to_string()),
                    ];
                    if let Some(c) = cursor(&args) {
                        query.push(("cursor", c));
                    }
                    let body = api_get(&base, token, "conversations.history", &query).await?;
                    let messages: Vec<serde_json::Value> = body["messages"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|m| {
                                    serde_json::json!({
                                        "ts": m["ts"],
                                        "user": m["user"],
                                        "text": m["text"],
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let meta = serde_json::json!({
                        "has_more": body["has_more"],
                        "response_metadata": body["response_metadata"]["next_cursor"],
                    });
                    Ok(ToolOutcome {
                        content: json_text(&serde_json::json!({ "messages": messages })),
                        meta: Some(meta),
                    })
                }
                "users_list" => {
                    let token = secret(secrets, "bot_token")?;
                    let mut query = vec![("limit", limit(&args).to_string())];
                    if let Some(c) = cursor(&args) {
                        query.push(("cursor", c));
                    }
                    let body = api_get(&base, token, "users.list", &query).await?;
                    let users: Vec<serde_json::Value> = body["members"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|u| {
                                    serde_json::json!({
                                        "id": u["id"],
                                        "name": u["name"],
                                        "real_name": u["real_name"],
                                        "is_bot": u["is_bot"],
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let meta = serde_json::json!({
                        "response_metadata": body["response_metadata"]["next_cursor"],
                    });
                    Ok(ToolOutcome {
                        content: json_text(&serde_json::json!({ "users": users })),
                        meta: Some(meta),
                    })
                }
                "post_message" => {
                    let token = secret(secrets, "bot_token")?;
                    let channel = args["channel"]
                        .as_str()
                        .ok_or("post_message requires channel")?;
                    let text = args["text"].as_str().ok_or("post_message requires text")?;
                    let resp = reqwest::Client::new()
                        .post(format!("{base}/chat.postMessage"))
                        .bearer_auth(token)
                        .json(&serde_json::json!({ "channel": channel, "text": text }))
                        .timeout(std::time::Duration::from_secs(30))
                        .send()
                        .await
                        .map_err(|e| format!("slack unreachable: {e}"))?;
                    if !resp.status().is_success() {
                        return Err(format!("slack returned {}", resp.status()));
                    }
                    let body: serde_json::Value = resp
                        .json()
                        .await
                        .map_err(|e| format!("slack returned bad json: {e}"))?;
                    if body["ok"] != true {
                        return Err(format!(
                            "slack api error: {}",
                            body["error"].as_str().unwrap_or("unknown")
                        ));
                    }
                    Ok(ToolOutcome {
                        content: json_text(&serde_json::json!({
                            "channel": body["channel"],
                            "ts": body["ts"],
                        })),
                        meta: None,
                    })
                }
                "post_webhook" => {
                    let webhook_url = secret(secrets, "webhook_url")?;
                    let text = args["text"].as_str().ok_or("post_webhook requires text")?;
                    // Incoming webhooks are unauthenticated POST endpoints:
                    // the URL itself carries the credential, so no auth header.
                    let resp = reqwest::Client::new()
                        .post(webhook_url)
                        .json(&serde_json::json!({ "text": text }))
                        .timeout(std::time::Duration::from_secs(30))
                        .send()
                        .await
                        .map_err(|e| format!("slack webhook unreachable: {e}"))?;
                    if !resp.status().is_success() {
                        return Err(format!("slack webhook returned {}", resp.status()));
                    }
                    let body = resp.text().await.unwrap_or_default();
                    if body.trim() != "ok" {
                        return Err(format!("slack webhook error: {body}"));
                    }
                    Ok(ToolOutcome {
                        content: "ok".to_string(),
                        meta: None,
                    })
                }
                other => Err(format!("slack integration has no tool {other}")),
            }
        })
    }
}
