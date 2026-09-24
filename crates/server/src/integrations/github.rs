//! GitHub integration (REST v3). Config: no required keys; the optional
//! `api_url` overrides `https://api.github.com` (GitHub Enterprise Server).
//! Secret: `token` — sent as `Authorization: Bearer`; `User-Agent` is
//! mandatory on every GitHub API request.

use super::{
    api_tool_spec, call_vendor_api, field, in_code_manifest, path_segment, probe, ApiAuth,
    Category, Integration, ToolOutcome,
};
use base64::Engine;
use futures::future::BoxFuture;
use guild_core::registry::BundleManifest;
use protocol::api::ToolSpec;

const DEFAULT_API: &str = "https://api.github.com";
const USER_AGENT: &str = "guild-integration-github";

pub struct Github;

/// API root for one config: the `api_url` override when set, else github.com.
fn api_url(config: &serde_json::Value) -> String {
    config["api_url"]
        .as_str()
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_API.to_string())
}

/// The stored `token` secret; the connector requires it.
fn token(secrets: &[(String, String)]) -> Result<String, String> {
    secrets
        .iter()
        .find(|(name, _)| name == "token")
        .map(|(_, value)| value.clone())
        .ok_or_else(|| "github secret 'token' is not stored".to_string())
}

/// Maps an HTTP failure to the tool-error contract: auth errors, missing
/// resources, and validation rejections get specific wording; anything else
/// carries the status and a body excerpt.
fn map_error(status: u16, body: &str) -> String {
    let excerpt: String = body.chars().take(300).collect();
    match status {
        401 | 403 => format!("github auth failed ({status})"),
        404 => "github: not found".to_string(),
        422 => format!("github rejected the request: {excerpt}"),
        _ => format!("github returned {status}: {excerpt}"),
    }
}

/// Sends one authenticated GitHub API request and parses the JSON body.
async fn send(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let resp = req
        .send()
        .await
        .map_err(|e| format!("github unreachable: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("github returned an unreadable body: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(map_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("github returned bad json: {e}"))
}

/// Builds a request against `path` on `api` with the Bearer auth, the
/// mandatory User-Agent, and the GitHub JSON accept header.
/// The contents-API path for one file: owner/repo as encoded segments, and
/// the file path as `/`-separated encoded parts — a `..` segment is
/// rejected (it traverses to another repo path with the org credential).
fn github_file_path(owner: &str, repo: &str, path: &str) -> Result<String, String> {
    let parts: Vec<String> = path
        .split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| {
            if p == ".." {
                Err(format!("path segment {p:?} is not allowed"))
            } else {
                Ok(path_segment(p)?)
            }
        })
        .collect::<Result<_, _>>()?;
    Ok(format!(
        "/repos/{}/{}/contents/{}",
        path_segment(owner)?,
        path_segment(repo)?,
        parts.join("/")
    ))
}

fn request(api: &str, token: &str, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .get(format!("{api}{path}"))
        .bearer_auth(token)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(30))
}

/// Renders one search hit line for the model-facing text.
fn repo_line(i: usize, hit: &serde_json::Value) -> String {
    let full_name = hit["full_name"].as_str().unwrap_or("(unnamed)");
    let url = hit["html_url"].as_str().unwrap_or("");
    let language = hit["language"].as_str().unwrap_or("");
    let stars = hit["stargazers_count"].as_u64().unwrap_or(0);
    let description = hit["description"].as_str().unwrap_or("");
    format!(
        "{}. {} ({}, ★{}) {}\n   {}\n",
        i + 1,
        full_name,
        if language.is_empty() { "?" } else { language },
        stars,
        url,
        description
    )
}

impl Integration for Github {
    fn name(&self) -> &'static str {
        "github"
    }

    fn categories(&self) -> &'static [Category] {
        &[Category::Other]
    }

    fn manifest(&self) -> BundleManifest {
        in_code_manifest(
            "github",
            "1.0.0",
            "GitHub repositories, issues, pull requests, and files",
            &[],
            &[
                ("search_repositories", "read"),
                ("list_issues", "read"),
                ("list_pulls", "read"),
                ("get_file", "read"),
                ("create_issue", "write"),
                ("api", "write"),
            ],
            &[
                guild_core::registry::FieldSpec {
                    default: Some(serde_json::json!("https://api.github.com")),
                    help: Some("Override for GitHub Enterprise Server".into()),
                    ..field("api_url", "string")
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
                name: "search_repositories".into(),
                description: "Search GitHub repositories (name, url, language, stars).".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "per_page": { "type": "number", "description": "1-50, default 10" }
                    },
                    "required": ["query"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "list_issues".into(),
                description: "List issues of one repository (pull requests are excluded).".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "owner": { "type": "string" },
                        "repo": { "type": "string" },
                        "state": { "type": "string", "enum": ["open", "closed", "all"],
                            "description": "default open" },
                        "per_page": { "type": "number", "description": "1-50, default 20" }
                    },
                    "required": ["owner", "repo"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "list_pulls".into(),
                description: "List pull requests of one repository.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "owner": { "type": "string" },
                        "repo": { "type": "string" },
                        "state": { "type": "string", "enum": ["open", "closed", "all"],
                            "description": "default open" },
                        "per_page": { "type": "number", "description": "1-50, default 20" }
                    },
                    "required": ["owner", "repo"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "get_file".into(),
                description: "Fetch one file's text content from a repository.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "owner": { "type": "string" },
                        "repo": { "type": "string" },
                        "path": { "type": "string", "description": "File path inside the repo" },
                        "ref": { "type": "string", "description": "Branch, tag, or sha (default branch)" }
                    },
                    "required": ["owner", "repo", "path"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "create_issue".into(),
                description: "Open a new issue in one repository.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "owner": { "type": "string" },
                        "repo": { "type": "string" },
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "labels": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["owner", "repo", "title"]
                }),
                kind: Default::default(),
            },
            api_tool_spec("GitHub"),
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
            let api = api_url(config);
            if tool == "api" {
                return call_vendor_api(
                    &api,
                    &ApiAuth::Bearer(tok),
                    &args,
                    12_000,
                    &[
                        ("User-Agent", USER_AGENT),
                        ("Accept", "application/vnd.github+json"),
                    ],
                )
                .await;
            }
            match tool {
                "search_repositories" => {
                    let query = args["query"]
                        .as_str()
                        .ok_or("search_repositories requires query")?;
                    let per_page = args["per_page"].as_u64().unwrap_or(10).clamp(1, 50);
                    let per_page = per_page.to_string();
                    let body = send(
                        request(&api, &tok, "/search/repositories")
                            .query(&[("q", query), ("per_page", per_page.as_str())]),
                    )
                    .await?;
                    let hits = body["items"]
                        .as_array()
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    let mut content = String::new();
                    for (i, hit) in hits.iter().enumerate() {
                        content.push_str(&repo_line(i, hit));
                    }
                    if content.is_empty() {
                        content = "No repositories matched.".to_string();
                    }
                    let meta = serde_json::json!({
                        "kind": "github",
                        "search": "repositories",
                        "total_count": body["total_count"].as_u64().unwrap_or(hits.len() as u64),
                    });
                    Ok(ToolOutcome {
                        artifact: None,
                        content,
                        meta: Some(meta),
                    })
                }
                "list_issues" => {
                    let owner = args["owner"].as_str().ok_or("list_issues requires owner")?;
                    let repo = args["repo"].as_str().ok_or("list_issues requires repo")?;
                    let state = args["state"].as_str().unwrap_or("open");
                    let per_page = args["per_page"].as_u64().unwrap_or(20).clamp(1, 50);
                    let per_page = per_page.to_string();
                    let body = send(
                        request(
                            &api,
                            &tok,
                            &format!(
                                "/repos/{}/{}/issues",
                                path_segment(owner)?,
                                path_segment(repo)?
                            ),
                        )
                        .query(&[("state", state), ("per_page", per_page.as_str())]),
                    )
                    .await?;
                    let mut content = String::new();
                    for issue in body.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                        // GitHub returns pull requests here too — skip them.
                        if issue["pull_request"].is_object() {
                            continue;
                        }
                        let number = issue["number"].as_u64().unwrap_or(0);
                        let title = issue["title"].as_str().unwrap_or("");
                        let state = issue["state"].as_str().unwrap_or("?");
                        let author = issue["user"]["login"].as_str().unwrap_or("?");
                        content.push_str(&format!("#{number} [{state}] {title} (@{author})\n"));
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
                "list_pulls" => {
                    let owner = args["owner"].as_str().ok_or("list_pulls requires owner")?;
                    let repo = args["repo"].as_str().ok_or("list_pulls requires repo")?;
                    let state = args["state"].as_str().unwrap_or("open");
                    let per_page = args["per_page"].as_u64().unwrap_or(20).clamp(1, 50);
                    let per_page = per_page.to_string();
                    let body = send(
                        request(
                            &api,
                            &tok,
                            &format!(
                                "/repos/{}/{}/pulls",
                                path_segment(owner)?,
                                path_segment(repo)?
                            ),
                        )
                        .query(&[("state", state), ("per_page", per_page.as_str())]),
                    )
                    .await?;
                    let mut content = String::new();
                    for pr in body.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                        let number = pr["number"].as_u64().unwrap_or(0);
                        let title = pr["title"].as_str().unwrap_or("");
                        let state = pr["state"].as_str().unwrap_or("?");
                        let head = pr["head"]["ref"].as_str().unwrap_or("?");
                        let base = pr["base"]["ref"].as_str().unwrap_or("?");
                        let author = pr["user"]["login"].as_str().unwrap_or("?");
                        content.push_str(&format!(
                            "#{number} [{state}] {title} ({head}→{base}, @{author})\n"
                        ));
                    }
                    if content.is_empty() {
                        content = "No pull requests.".to_string();
                    }
                    Ok(ToolOutcome {
                        artifact: None,
                        content,
                        meta: None,
                    })
                }
                "get_file" => {
                    let owner = args["owner"].as_str().ok_or("get_file requires owner")?;
                    let repo = args["repo"].as_str().ok_or("get_file requires repo")?;
                    let path = args["path"].as_str().ok_or("get_file requires path")?;
                    let entry = send(
                        request(&api, &tok, &github_file_path(owner, repo, path)?.as_str())
                            .query(&[("ref", args["ref"].as_str().unwrap_or(""))]),
                    )
                    .await?;
                    // GitHub nulls `content` for files above the contents-API
                    // size cap; `encoding` is base64 for regular files.
                    let encoded = entry["content"].as_str();
                    let text = match (entry["encoding"].as_str(), encoded) {
                        (Some("base64"), Some(c)) => {
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(c.replace('\n', ""))
                                .map_err(|e| format!("github file undecodable: {e}"))?;
                            String::from_utf8(bytes)
                                .map_err(|_| "github file is not utf-8 text".to_string())?
                        }
                        (Some("none"), Some(c)) => c.to_string(),
                        _ => return Err("github file too large for the contents API".to_string()),
                    };
                    let meta = serde_json::json!({
                        "kind": "github",
                        "file": entry["path"].as_str().unwrap_or(path),
                    });
                    Ok(ToolOutcome {
                        artifact: None,
                        content: text,
                        meta: Some(meta),
                    })
                }
                "create_issue" => {
                    let owner = args["owner"]
                        .as_str()
                        .ok_or("create_issue requires owner")?;
                    let repo = args["repo"].as_str().ok_or("create_issue requires repo")?;
                    let title = args["title"]
                        .as_str()
                        .ok_or("create_issue requires title")?;
                    let mut payload = serde_json::json!({ "title": title });
                    if let Some(b) = args["body"].as_str() {
                        payload["body"] = serde_json::Value::String(b.to_string());
                    }
                    if let Some(labels) = args["labels"].as_array() {
                        payload["labels"] = serde_json::Value::Array(labels.clone());
                    }
                    let resp = reqwest::Client::new()
                        .post(format!(
                            "{api}/repos/{}/{}/issues",
                            path_segment(owner)?,
                            path_segment(repo)?
                        ))
                        .bearer_auth(&tok)
                        .header("User-Agent", USER_AGENT)
                        .header("Accept", "application/vnd.github+json")
                        .timeout(std::time::Duration::from_secs(30))
                        .json(&payload)
                        .send()
                        .await
                        .map_err(|e| format!("github unreachable: {e}"))?;
                    let status = resp.status().as_u16();
                    let text = resp
                        .text()
                        .await
                        .map_err(|e| format!("github returned an unreadable body: {e}"))?;
                    if !(200..300).contains(&status) {
                        return Err(map_error(status, &text));
                    }
                    let body: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|e| format!("github returned bad json: {e}"))?;
                    let number = body["number"].as_u64().unwrap_or(0);
                    let url = body["html_url"].as_str().unwrap_or("");
                    Ok(ToolOutcome {
                        artifact: None,
                        content: format!("Created issue #{number}: {url}"),
                        meta: Some(serde_json::json!({ "number": number, "url": url })),
                    })
                }
                other => Err(format!("github integration has no tool {other}")),
            }
        })
    }

    /// The authenticated user: cheapest credential check GitHub offers.
    fn test_connection<'a>(
        &'a self,
        config: &'a serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let token = token(secrets)?;
            probe(
                request(api_url(config).as_str(), token.as_str(), "/user"),
                "github",
            )
            .await
        })
    }
}
