//! Langfuse observability integration: traces and prompts through the
//! public API (`/api/public/...`), authenticated with basic auth over the
//! public/secret key pair.

use super::{
    api_tool_spec, call_vendor_api, field, in_code_manifest, path_segment, probe, ApiAuth,
    Category, Integration, ToolOutcome,
};
use futures::future::BoxFuture;
use guild_core::registry::BundleManifest;
use protocol::api::ToolSpec;

/// Langfuse connector. Config `{ "base_url": "…" }` overrides the stored
/// `host` secret (test seam); the keys are stored secrets.
pub struct Langfuse;

fn secret<'a>(secrets: &'a [(String, String)], name: &str) -> Option<&'a str> {
    secrets
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, value)| value.as_str())
}

/// The API base URL: the config `base_url` wins, the `host` secret is the
/// default. Trailing slashes are stripped either way.
fn base_url(config: &serde_json::Value, secrets: &[(String, String)]) -> Result<String, String> {
    // The config base_url wins; the legacy `host` secret of pre-schema
    // deployments is the fallback; else the public cloud.
    if let Some(url) = config["base_url"].as_str() {
        return Ok(url.trim_end_matches('/').to_string());
    }
    if let Some(host) = secret(secrets, "host") {
        return Ok(host.trim_end_matches('/').to_string());
    }
    Ok("https://cloud.langfuse.com".to_string())
}

/// Performs one GET against the public API with basic auth and maps
/// non-2xx / malformed responses to errors.
async fn get(
    base: &str,
    path_and_query: &str,
    public_key: &str,
    secret_key: &str,
) -> Result<serde_json::Value, String> {
    let resp = reqwest::Client::new()
        .get(format!("{base}{path_and_query}"))
        .basic_auth(public_key, Some(secret_key))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("langfuse unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("langfuse returned {}", resp.status()));
    }
    resp.json()
        .await
        .map_err(|e| format!("langfuse returned bad json: {e}"))
}

impl Integration for Langfuse {
    fn name(&self) -> &'static str {
        "langfuse"
    }

    fn categories(&self) -> &'static [Category] {
        &[Category::Other]
    }

    fn manifest(&self) -> BundleManifest {
        in_code_manifest(
            "langfuse",
            "1.0.0",
            "Langfuse LLM observability: list and inspect traces, list prompts",
            &[],
            &[
                ("list_traces", "read"),
                ("get_trace", "read"),
                ("get_prompt", "read"),
                ("api", "write"),
            ],
            &[
                guild_core::registry::FieldSpec {
                    default: Some(serde_json::json!("https://cloud.langfuse.com")),
                    help: Some("Override for self-hosted Langfuse".into()),
                    ..field("base_url", "string")
                },
                guild_core::registry::FieldSpec {
                    required: true,
                    ..field("public_key", "secret")
                },
                guild_core::registry::FieldSpec {
                    required: true,
                    ..field("secret_key", "secret")
                },
            ],
        )
    }

    fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
        Ok(vec![
            ToolSpec {
                name: "list_traces".into(),
                description: "List recent Langfuse traces (id, name, timestamp).".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "limit": { "type": "number",
                            "description": "1-50 traces, default 10" }
                    }
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "get_trace".into(),
                description: "Fetch one Langfuse trace with its full body by id.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "trace_id": { "type": "string" }
                    },
                    "required": ["trace_id"]
                }),
                kind: Default::default(),
            },
            ToolSpec {
                name: "get_prompt".into(),
                description: "Fetch one Langfuse prompt by name (latest or a specific version)."
                    .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Prompt name" },
                        "version": { "type": "number", "description": "Specific version (default: latest)" }
                    },
                    "required": ["name"]
                }),
                kind: Default::default(),
            },
            api_tool_spec("Langfuse"),
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
            let public_key = secret(secrets, "public_key")
                .ok_or("langfuse requires the public_key secret")?
                .to_string();
            let secret_key = secret(secrets, "secret_key")
                .ok_or("langfuse requires the secret_key secret")?
                .to_string();
            let base = base_url(config, secrets)?;
            match tool {
                "list_traces" => list_traces(&base, &public_key, &secret_key, &args).await,
                "get_trace" => get_trace(&base, &public_key, &secret_key, &args).await,
                "get_prompt" => get_prompt(&base, &public_key, &secret_key, &args).await,
                "api" => {
                    call_vendor_api(
                        &base,
                        &ApiAuth::Basic(public_key.to_string(), secret_key.to_string()),
                        &args,
                        12_000,
                        &[],
                    )
                    .await
                }
                other => Err(format!("langfuse integration has no tool {other}")),
            }
        })
    }

    /// Lists projects: the cheapest authenticated Langfuse call.
    fn test_connection<'a>(
        &'a self,
        config: &'a serde_json::Value,
        secrets: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let base = base_url(config, secrets)?;
            let public_key =
                secret(secrets, "public_key").ok_or("langfuse requires the public_key secret")?;
            let secret_key =
                secret(secrets, "secret_key").ok_or("langfuse requires the secret_key secret")?;
            probe(
                reqwest::Client::new()
                    .get(format!("{base}/api/public/projects"))
                    .basic_auth(public_key, Some(secret_key)),
                "langfuse",
            )
            .await
        })
    }
}

/// GET `/api/public/traces?limit=n` and render one line per trace.
async fn list_traces(
    base: &str,
    public_key: &str,
    secret_key: &str,
    args: &serde_json::Value,
) -> Result<ToolOutcome, String> {
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
    let body = get(
        base,
        &format!("/api/public/traces?limit={limit}"),
        public_key,
        secret_key,
    )
    .await?;
    let traces = body["data"].as_array().cloned().unwrap_or_default();

    let mut content = String::new();
    for (i, trace) in traces.iter().take(limit).enumerate() {
        let id = trace["id"].as_str().unwrap_or("?");
        let name = trace["name"].as_str().unwrap_or("(unnamed)");
        let timestamp = trace["timestamp"].as_str().unwrap_or("");
        content.push_str(&format!("{}. {id} {name} {timestamp}\n", i + 1));
    }
    if content.is_empty() {
        content = "No traces.".to_string();
    }
    let meta = serde_json::json!({
        "card": "langfuse",
        "kind": "traces",
        "count": traces.len().min(limit),
    });
    Ok(ToolOutcome {
        artifact: None,
        content,
        meta: Some(meta),
    })
}

/// GET `/api/public/traces/{id}` and return the full trace body.
async fn get_trace(
    base: &str,
    public_key: &str,
    secret_key: &str,
    args: &serde_json::Value,
) -> Result<ToolOutcome, String> {
    let trace_id = args["trace_id"]
        .as_str()
        .ok_or("get_trace requires trace_id")?;
    let trace = get(
        base,
        &format!("/api/public/traces/{}", path_segment(trace_id)),
        public_key,
        secret_key,
    )
    .await?;
    let content = serde_json::to_string_pretty(&trace)
        .map_err(|e| format!("langfuse trace unserializable: {e}"))?;
    let meta = serde_json::json!({
        "card": "langfuse",
        "kind": "trace",
        "id": trace["id"],
    });
    Ok(ToolOutcome {
        artifact: None,
        content,
        meta: Some(meta),
    })
}

/// GET `/api/public/prompts` and render one line per prompt.
/// Langfuse has no "list all prompts" endpoint — /api/public/prompts always
/// requires a `name`.
async fn get_prompt(
    base: &str,
    public_key: &str,
    secret_key: &str,
    args: &serde_json::Value,
) -> Result<ToolOutcome, String> {
    let name = args["name"]
        .as_str()
        .ok_or("get_prompt requires name")?
        .to_string();
    let version = args["version"].as_u64();
    // The prompt name is a path segment (folder names carry `/`): encoded,
    // so it cannot escape the segment or carry `?`/`#` into the request.
    let path = match version {
        Some(v) => format!("/api/public/prompts/{}?version={v}", path_segment(&name)),
        None => format!("/api/public/prompts/{}", path_segment(&name)),
    };
    let body = get(base, &path, public_key, secret_key).await?;
    let prompt_name = body["name"].as_str().unwrap_or(&name);
    let version = body["version"].as_u64().unwrap_or(0);
    let kind = body["type"].as_str().unwrap_or("text");
    let content = format!(
        "{prompt_name} v{version} ({kind})\n\n{}",
        serde_json::to_string_pretty(&body["prompt"]).unwrap_or_default()
    );
    let meta = serde_json::json!({
        "card": "langfuse",
        "kind": "prompt",
        "name": prompt_name,
        "version": version,
    });
    Ok(ToolOutcome {
        artifact: None,
        content,
        meta: Some(meta),
    })
}
