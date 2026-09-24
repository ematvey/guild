//! GitLab integration (REST v4). Config: the optional `base_url` overrides
//! `https://gitlab.com/api/v4` (self-hosted instances). Secret: `token` —
//! sent as the `PRIVATE-TOKEN` header.

use super::{
    api_tool_spec, call_vendor_api, field, in_code_manifest, probe, ApiAuth, Category, Integration,
    ToolOutcome,
};
use futures::future::BoxFuture;
use guild_core::registry::BundleManifest;
use protocol::api::ToolSpec;

const DEFAULT_API: &str = "https://gitlab.com/api/v4";

pub struct Gitlab;

/// API root for one config: the `base_url` override when set, else gitlab.com's
/// v4 root. A value saved as a bare instance origin (the manifest's old
/// default, and the natural `https://gitlab.example.com` entry) gets
/// `/api/v4` appended — used as an API root every call would 404. A value
/// that already carries a path (a custom API root, or one ending in
/// `/api/v4`) is used as-is.
fn base_url(config: &serde_json::Value) -> String {
    match config["base_url"]
        .as_str()
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
    {
        Some(v) if !has_url_path(v) => format!("{v}/api/v4"),
        Some(v) => v.to_string(),
        None => DEFAULT_API.to_string(),
    }
}

/// True when the URL carries a path beyond the authority (`scheme://host/x`):
/// a bare origin cannot be a working API root.
fn has_url_path(u: &str) -> bool {
    match u.split_once("://") {
        Some((_, rest)) => rest.contains('/'),
        None => true,
    }
}

/// The stored `token` secret; the connector requires it.
fn token(secrets: &[(String, String)]) -> Result<String, String> {
    secrets
        .iter()
        .find(|(name, _)| name == "token")
        .map(|(_, value)| value.clone())
        .ok_or_else(|| "gitlab secret 'token' is not stored".to_string())
}

/// Percent-encodes a project reference (numeric id or `group/project` path) —
/// the slash inside the path must ride encoded inside one path segment.
fn project_ref(project: &str) -> String {
    project
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Maps an HTTP failure to the tool-error contract: auth errors, missing
/// resources, and validation rejections get specific wording; anything else
/// carries the status and a body excerpt.
fn map_error(status: u16, body: &str) -> String {
    let excerpt: String = body.chars().take(300).collect();
    match status {
        401 => "gitlab auth failed (401)".to_string(),
        404 => "gitlab: not found (project or resource)".to_string(),
        400 => format!("gitlab rejected the request: {excerpt}"),
        _ => format!("gitlab returned {status}: {excerpt}"),
    }
}

/// Sends one authenticated GitLab API request and parses the JSON body.
async fn send(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let resp = req
        .send()
        .await
        .map_err(|e| format!("gitlab unreachable: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("gitlab returned an unreadable body: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(map_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("gitlab returned bad json: {e}"))
}

/// Builds a GET request against `path` on `base` with the PRIVATE-TOKEN auth.
fn request(base: &str, token: &str, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .get(format!("{base}{path}"))
        .header("PRIVATE-TOKEN", token)
        .timeout(std::time::Duration::from_secs(30))
}

impl Integration for Gitlab {
    fn name(&self) -> &'static str {
        "gitlab"
    }

    fn categories(&self) -> &'static [Category] {
        &[Category::Other]
    }

    fn manifest(&self) -> BundleManifest {
        in_code_manifest(
            "gitlab",
            "1.0.0",
            "GitLab projects, issues, and merge requests",
            &[],
            &[
                ("list_projects", "read"),
                ("list_issues", "read"),
                ("list_mrs", "read"),
                ("create_issue", "write"),
                ("api", "write"),
            ],
            &[
                guild_core::registry::FieldSpec {
                    default: Some(serde_json::json!("https://gitlab.com/api/v4")),
                    help: Some("Override for self-hosted GitLab (API root)".into()),
                    ..field("base_url", "string")
                },
                guild_core::registry::FieldSpec {
                    required: true,
                    ..field("token", "secret")
                },
            ],
        )
    }

    fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
        Ok(vec![
            ToolSpec {
                name: "list_projects".into(),
                description: "List GitLab projects visible to the token (id, path, url).".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "search": { "type": "string", "description": "Optional name filter" },
                        "per_page": { "type": "number", "description": "1-50, default 20" }
                    },
                    "required": []
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "list_issues".into(),
                description: "List issues of one project (numeric id or group/project path)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "project": { "type": "string" },
                        "state": { "type": "string", "enum": ["opened", "closed", "all"],
                            "description": "default opened" },
                        "per_page": { "type": "number", "description": "1-50, default 20" }
                    },
                    "required": ["project"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "list_mrs".into(),
                description: "List merge requests of one project.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "project": { "type": "string" },
                        "state": { "type": "string", "enum": ["opened", "closed", "merged", "all"],
                            "description": "default opened" },
                        "per_page": { "type": "number", "description": "1-50, default 20" }
                    },
                    "required": ["project"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "create_issue".into(),
                description: "Open a new issue in one project.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "project": { "type": "string" },
                        "title": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "required": ["project", "title"]
                }),
                kind: Default::default(),
            },
            api_tool_spec("GitLab"),
        ])
    }

    fn execute<'a>(
        &'a self,
        config: &'a serde_json::Value,
        tool: &'a str,
        args: serde_json::Value,
        secrets: &'a [(String, String)],
        _acting_as: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ToolOutcome, String>> {
        Box::pin(async move {
            let tok = token(secrets)?;
            let base = base_url(config);
            if tool == "api" {
                return call_vendor_api(&base, &ApiAuth::PrivateToken(tok), &args, 12_000, &[])
                    .await;
            }
            match tool {
                "list_projects" => {
                    let search = args["search"].as_str().unwrap_or("");
                    let per_page = args["per_page"].as_u64().unwrap_or(20).clamp(1, 50);
                    let per_page = per_page.to_string();
                    let mut req = request(&base, &tok, "/projects").query(&[
                        ("membership", "true"),
                        ("order_by", "last_activity_at"),
                        ("per_page", per_page.as_str()),
                    ]);
                    if !search.is_empty() {
                        req = req.query(&[("search", search)]);
                    }
                    let body = send(req).await?;
                    let mut content = String::new();
                    for (i, project) in body
                        .as_array()
                        .map(|a| a.as_slice())
                        .unwrap_or(&[])
                        .iter()
                        .enumerate()
                    {
                        let name = project["name"].as_str().unwrap_or("(unnamed)");
                        let path = project["path_with_namespace"].as_str().unwrap_or("");
                        let url = project["web_url"].as_str().unwrap_or("");
                        let description = project["description"].as_str().unwrap_or("");
                        content.push_str(&format!(
                            "{}. {} ({}) {}\n   {}\n",
                            i + 1,
                            name,
                            path,
                            url,
                            description
                        ));
                    }
                    if content.is_empty() {
                        content = "No projects.".to_string();
                    }
                    Ok(ToolOutcome {
                        artifact: None,
                        content,
                        meta: None,
                    })
                }
                "list_issues" => {
                    let project = args["project"]
                        .as_str()
                        .ok_or("list_issues requires project")?;
                    let state = args["state"].as_str().unwrap_or("opened");
                    let per_page = args["per_page"].as_u64().unwrap_or(20).clamp(1, 50);
                    let per_page = per_page.to_string();
                    let body = send(
                        request(
                            &base,
                            &tok,
                            &format!("/projects/{}/issues", project_ref(project)),
                        )
                        .query(&[("state", state), ("per_page", per_page.as_str())]),
                    )
                    .await?;
                    let mut content = String::new();
                    for issue in body.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                        let iid = issue["iid"].as_u64().unwrap_or(0);
                        let title = issue["title"].as_str().unwrap_or("");
                        let state = issue["state"].as_str().unwrap_or("?");
                        let author = issue["author"]["username"].as_str().unwrap_or("?");
                        content.push_str(&format!("!{iid} [{state}] {title} (@{author})\n"));
                    }
                    if content.is_empty() {
                        content = "No issues.".to_string();
                    }
                    Ok(ToolOutcome {
                        artifact: None,
                        content,
                        meta: None,
                    })
                }
                "list_mrs" => {
                    let project = args["project"]
                        .as_str()
                        .ok_or("list_mrs requires project")?;
                    let state = args["state"].as_str().unwrap_or("opened");
                    let per_page = args["per_page"].as_u64().unwrap_or(20).clamp(1, 50);
                    let per_page = per_page.to_string();
                    let body = send(
                        request(
                            &base,
                            &tok,
                            &format!("/projects/{}/merge_requests", project_ref(project)),
                        )
                        .query(&[("state", state), ("per_page", per_page.as_str())]),
                    )
                    .await?;
                    let mut content = String::new();
                    for mr in body.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                        let iid = mr["iid"].as_u64().unwrap_or(0);
                        let title = mr["title"].as_str().unwrap_or("");
                        let state = mr["state"].as_str().unwrap_or("?");
                        let source = mr["source_branch"].as_str().unwrap_or("?");
                        let target = mr["target_branch"].as_str().unwrap_or("?");
                        let author = mr["author"]["username"].as_str().unwrap_or("?");
                        content.push_str(&format!(
                            "!{iid} [{state}] {title} ({source}→{target}, @{author})\n"
                        ));
                    }
                    if content.is_empty() {
                        content = "No merge requests.".to_string();
                    }
                    Ok(ToolOutcome {
                        artifact: None,
                        content,
                        meta: None,
                    })
                }
                "create_issue" => {
                    let project = args["project"]
                        .as_str()
                        .ok_or("create_issue requires project")?;
                    let title = args["title"]
                        .as_str()
                        .ok_or("create_issue requires title")?;
                    let mut payload = serde_json::json!({ "title": title });
                    if let Some(d) = args["description"].as_str() {
                        payload["description"] = serde_json::Value::String(d.to_string());
                    }
                    let body = send(
                        reqwest::Client::new()
                            .post(format!("{base}/projects/{}/issues", project_ref(project)))
                            .header("PRIVATE-TOKEN", &tok)
                            .timeout(std::time::Duration::from_secs(30))
                            .json(&payload),
                    )
                    .await?;
                    let iid = body["iid"].as_u64().unwrap_or(0);
                    let url = body["web_url"].as_str().unwrap_or("");
                    Ok(ToolOutcome {
                        artifact: None,
                        content: format!("Created issue !{iid}: {url}"),
                        meta: Some(serde_json::json!({ "iid": iid, "url": url })),
                    })
                }
                other => Err(format!("gitlab integration has no tool {other}")),
            }
        })
    }

    /// The authenticated user: cheapest credential check GitLab offers.
    fn test_connection<'a>(
        &'a self,
        config: &'a serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let token = token(secrets)?;
            probe(
                request(base_url(config).as_str(), token.as_str(), "/user"),
                "gitlab",
            )
            .await
        })
    }
}
