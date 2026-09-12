//! Atlassian Cloud integration (Jira + Confluence). All credentials live in
//! secrets — config carries no keys: `site` (e.g. `https://org.atlassian.net`),
//! `email`, `token` (API token; every request authenticates as basic auth
//! `email:token`).
//!
//! Tools:
//! - `jira_search` (read) — JQL query via `POST /rest/api/3/search/jql`
//! - `jira_get_issue` (read) — `GET /rest/api/3/issue/{key}`
//! - `confluence_search` (read) — CQL query via `GET /wiki/rest/api/search`
//! - `confluence_get_page` (read) — `GET /wiki/rest/api/content/{id}` with the
//!   storage-format body, returned as plain text
//! - `confluence_create_page` (write) — `POST /wiki/rest/api/content`

use super::{in_code_manifest, Category, Integration, ToolOutcome};
use futures::future::BoxFuture;
use guild_core::registry::BundleManifest;
use protocol::api::ToolSpec;

const JIRA_FIELDS: &str = "summary,status,issuetype,assignee,created";
const MAX_BODY_SNIPPET: usize = 300;

/// The site/email/token triple every call needs, resolved from the secret
/// store (values never appear in errors, results, or logs).
struct Creds {
    site: String,
    email: String,
    token: String,
}

fn secret<'a>(secrets: &'a [(String, String)], name: &str) -> Option<&'a str> {
    secrets
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

fn creds(secrets: &[(String, String)]) -> Result<Creds, String> {
    let missing: Vec<&str> = ["site", "email", "token"]
        .into_iter()
        .filter(|n| secret(secrets, n).is_none())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "atlassian requires the site, email, and token secrets; missing: {}",
            missing.join(", ")
        ));
    }
    Ok(Creds {
        // The site secret may carry a trailing slash; the paths below do not.
        site: secret(secrets, "site")
            .unwrap()
            .trim_end_matches('/')
            .to_string(),
        email: secret(secrets, "email").unwrap().to_string(),
        token: secret(secrets, "token").unwrap().to_string(),
    })
}

/// Sends one authenticated request and returns the parsed JSON body. Errors
/// carry the status and a short body snippet (Atlassian error messages name
/// the bad JQL/CQL — useful for the model), never credential values.
async fn send_json(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let resp = req
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("atlassian unreachable: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("atlassian body unreadable: {e}"))?;
    if !status.is_success() {
        let snippet: String = body.chars().take(MAX_BODY_SNIPPET).collect();
        return Err(format!("atlassian returned {status}: {snippet}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("atlassian returned bad json: {e}"))
}

/// One line of a search result: `KEY — summary [Status] (Assignee)`.
fn jira_line(issue: &serde_json::Value) -> String {
    let key = issue["key"].as_str().unwrap_or("?");
    let fields = &issue["fields"];
    let summary = fields["summary"].as_str().unwrap_or("");
    let status = fields["status"]["name"].as_str().unwrap_or("");
    let assignee = fields["assignee"]["displayName"].as_str().unwrap_or("");
    let mut line = format!("{key} — {summary}");
    if !status.is_empty() {
        line.push_str(&format!(" [{status}]"));
    }
    if !assignee.is_empty() {
        line.push_str(&format!(" ({assignee})"));
    }
    line
}

/// Flattens one Jira issue into a readable block with a browse URL.
fn jira_issue_block(creds: &Creds, issue: &serde_json::Value) -> String {
    let key = issue["key"].as_str().unwrap_or("?");
    let fields = &issue["fields"];
    let status = fields["status"]["name"].as_str().unwrap_or("");
    let itype = fields["issuetype"]["name"].as_str().unwrap_or("");
    let assignee = fields["assignee"]["displayName"].as_str().unwrap_or("");
    let created = fields["created"].as_str().unwrap_or("");
    let mut block = format!("{} — {}", key, fields["summary"].as_str().unwrap_or(""));
    let mut facts: Vec<String> = Vec::new();
    if !itype.is_empty() {
        facts.push(format!("type: {itype}"));
    }
    if !status.is_empty() {
        facts.push(format!("status: {status}"));
    }
    if !assignee.is_empty() {
        facts.push(format!("assignee: {assignee}"));
    }
    if !created.is_empty() {
        facts.push(format!("created: {created}"));
    }
    if !facts.is_empty() {
        block.push_str(&format!("\n{}\n", facts.join(" | ")));
    }
    block.push_str(&format!("{}/browse/{key}", creds.site));
    block
}

/// Strips storage-format XHTML tags and collapses whitespace to plain text.
fn storage_to_text(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    for c in value.chars() {
        match c {
            '<' => {
                // Tag boundaries separate words — keep one space per tag.
                if !text.ends_with(' ') && !text.is_empty() {
                    text.push(' ');
                }
                in_tag = true;
            }
            '>' => in_tag = false,
            c if !in_tag => text.push(c),
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `ATLASSIAN_TENANT` — no config: the site is a secret, nothing else to set.
pub struct Atlassian;

impl Integration for Atlassian {
    fn name(&self) -> &'static str {
        "atlassian"
    }

    fn category(&self) -> Category {
        Category::Other
    }

    fn manifest(&self) -> BundleManifest {
        in_code_manifest(
            "atlassian",
            "1.0.0",
            "Jira and Confluence Cloud: search and read issues and pages, create pages",
            &["site", "email", "token"],
            &[
                ("jira_search", "read"),
                ("jira_get_issue", "read"),
                ("confluence_search", "read"),
                ("confluence_get_page", "read"),
                ("confluence_create_page", "write"),
            ],
        )
    }

    fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
        Ok(vec![
            ToolSpec {
                name: "jira_search".into(),
                description: "Search Jira issues with a JQL query (returns key, summary, \
                              status, type, assignee)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "jql": { "type": "string",
                            "description": "JQL query, e.g. \"project = PROJ ORDER BY updated DESC\"" },
                        "max_results": { "type": "number",
                            "description": "1-50, default 10" }
                    },
                    "required": ["jql"]
                }),
            },
            ToolSpec {
                name: "jira_get_issue".into(),
                description: "Fetch one Jira issue by key (summary, status, type, assignee, \
                              created, browse URL)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "issue_key": { "type": "string", "description": "Issue key, e.g. PROJ-1" }
                    },
                    "required": ["issue_key"]
                }),
            },
            ToolSpec {
                name: "confluence_search".into(),
                description: "Search Confluence with a CQL query (returns page titles, \
                              excerpts, ids)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "cql": { "type": "string",
                            "description": "CQL query, e.g. \"space = PROJ AND type = page\"" },
                        "limit": { "type": "number", "description": "1-50, default 10" }
                    },
                    "required": ["cql"]
                }),
            },
            ToolSpec {
                name: "confluence_get_page".into(),
                description: "Fetch one Confluence page by id — title plus storage body as \
                              plain text."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "page_id": { "type": "string", "description": "Numeric page id" }
                    },
                    "required": ["page_id"]
                }),
            },
            ToolSpec {
                name: "confluence_create_page".into(),
                description: "Create a Confluence page in a space (title + content in \
                              storage XHTML format)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "space_key": { "type": "string", "description": "Space key, e.g. PROJ" },
                        "title": { "type": "string" },
                        "content": { "type": "string",
                            "description": "Page body in Confluence storage XHTML format, \
                                           e.g. \"<p>hello</p>\"" }
                    },
                    "required": ["space_key", "title", "content"]
                }),
            },
        ])
    }

    fn execute<'a>(
        &'a self,
        _config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
        secrets: &'a [(String, String)],
        _acting_as: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
        Box::pin(async move {
            let creds = creds(secrets)?;
            let client = reqwest::Client::new();
            match tool {
                "jira_search" => {
                    let jql = args["jql"].as_str().ok_or("jira_search requires jql")?;
                    let max_results = args["max_results"].as_u64().unwrap_or(10).clamp(1, 50);
                    let body = serde_json::json!({
                        "jql": jql,
                        "maxResults": max_results,
                        "fields": ["summary", "status", "issuetype", "assignee"],
                    });
                    let resp = send_json(
                        client
                            .post(format!("{}/rest/api/3/search/jql", creds.site))
                            .basic_auth(&creds.email, Some(&creds.token))
                            .json(&body),
                    )
                    .await?;
                    let issues = resp["issues"].as_array().cloned().unwrap_or_default();
                    let truncated = issues.len() as u64 > max_results;
                    let mut content = issues
                        .iter()
                        .take(max_results as usize)
                        .map(jira_line)
                        .collect::<Vec<_>>()
                        .join("\n");
                    if content.is_empty() {
                        content = "No issues match the query.".to_string();
                    }
                    Ok(ToolOutcome {
                        content,
                        meta: Some(serde_json::json!({
                            "kind": "jira_search",
                            "count": issues.len().min(max_results as usize),
                            "truncated": truncated,
                        })),
                    })
                }
                "jira_get_issue" => {
                    let key = args["issue_key"]
                        .as_str()
                        .ok_or("jira_get_issue requires issue_key")?;
                    let issue = send_json(
                        client
                            .get(format!("{}/rest/api/3/issue/{key}", creds.site))
                            .basic_auth(&creds.email, Some(&creds.token))
                            .query(&[("fields", JIRA_FIELDS)]),
                    )
                    .await?;
                    let block = jira_issue_block(&creds, &issue);
                    Ok(ToolOutcome {
                        content: block,
                        meta: Some(serde_json::json!({
                            "kind": "jira_issue",
                            "key": issue["key"],
                            "url": format!("{}/browse/{}", creds.site,
                                issue["key"].as_str().unwrap_or(key)),
                        })),
                    })
                }
                "confluence_search" => {
                    let cql = args["cql"].as_str().ok_or("confluence_search requires cql")?;
                    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50);
                    let resp = send_json(
                        client
                            .get(format!("{}/wiki/rest/api/search", creds.site))
                            .basic_auth(&creds.email, Some(&creds.token))
                            .query(&[("cql", cql), ("limit", &limit.to_string())]),
                    )
                    .await?;
                    let results = resp["results"].as_array().cloned().unwrap_or_default();
                    let truncated = results.len() as u64 > limit;
                    let mut content = results
                        .iter()
                        .take(limit as usize)
                        .map(|r| {
                            let title = r["content"]["title"].as_str().unwrap_or("(untitled)");
                            let id = r["content"]["id"].as_str().unwrap_or("?");
                            let excerpt = r["excerpt"].as_str().unwrap_or("");
                            if excerpt.is_empty() {
                                format!("{title} (id {id})")
                            } else {
                                format!("{title} (id {id}): {excerpt}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if content.is_empty() {
                        content = "No results match the query.".to_string();
                    }
                    Ok(ToolOutcome {
                        content,
                        meta: Some(serde_json::json!({
                            "kind": "confluence_search",
                            "count": results.len().min(limit as usize),
                            "truncated": truncated,
                        })),
                    })
                }
                "confluence_get_page" => {
                    let page_id = args["page_id"]
                        .as_str()
                        .ok_or("confluence_get_page requires page_id")?;
                    let page = send_json(
                        client
                            .get(format!("{}/wiki/rest/api/content/{page_id}", creds.site))
                            .basic_auth(&creds.email, Some(&creds.token))
                            .query(&[("expand", "body.storage")]),
                    )
                    .await?;
                    let title = page["title"].as_str().unwrap_or("");
                    let storage = page["body"]["storage"]["value"].as_str().unwrap_or("");
                    let webui = page["_links"]["webui"].as_str().unwrap_or("");
                    let mut content = title.to_string();
                    let text = storage_to_text(storage);
                    if !text.is_empty() {
                        content.push_str("\n\n");
                        content.push_str(&text);
                    }
                    if !webui.is_empty() {
                        content.push_str(&format!("\n\n{}{}", creds.site, webui));
                    }
                    Ok(ToolOutcome {
                        content,
                        meta: Some(serde_json::json!({
                            "kind": "confluence_page",
                            "id": page["id"],
                            "title": title,
                        })),
                    })
                }
                "confluence_create_page" => {
                    let space_key = args["space_key"]
                        .as_str()
                        .ok_or("confluence_create_page requires space_key")?;
                    let title = args["title"]
                        .as_str()
                        .ok_or("confluence_create_page requires title")?;
                    let value = args["content"]
                        .as_str()
                        .ok_or("confluence_create_page requires content")?;
                    let body = serde_json::json!({
                        "type": "page",
                        "title": title,
                        "space": { "key": space_key },
                        "body": { "storage": { "value": value, "representation": "storage" } },
                    });
                    let page = send_json(
                        client
                            .post(format!("{}/wiki/rest/api/content", creds.site))
                            .basic_auth(&creds.email, Some(&creds.token))
                            .json(&body),
                    )
                    .await?;
                    let id = page["id"].as_str().unwrap_or("");
                    let webui = page["_links"]["webui"].as_str().unwrap_or("");
                    let url = if webui.is_empty() {
                        None
                    } else {
                        Some(format!("{}{}", creds.site, webui))
                    };
                    let mut content = format!("Created page {} ({})", id, title);
                    if let Some(u) = &url {
                        content.push_str(&format!("\n{u}"));
                    }
                    let mut meta = serde_json::json!({
                        "kind": "confluence_page_created",
                        "id": id,
                        "title": page["title"].as_str().unwrap_or(title),
                    });
                    if let Some(u) = url {
                        meta["url"] = serde_json::Value::String(u);
                    }
                    Ok(ToolOutcome {
                        content,
                        meta: Some(meta),
                    })
                }
                other => Err(format!("atlassian integration has no tool {other}")),
            }
        })
    }
}
