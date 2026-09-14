//! HubSpot CRM integration: contact, company, and deal search plus deal
//! updates through the CRM v3 API. Auth is a private-app access token sent
//! as `Authorization: Bearer`.

use super::{api_tool_spec, call_vendor_api, field, in_code_manifest, ApiAuth, Category, Integration, ToolOutcome};
use guild_core::registry::BundleManifest;
use futures::future::BoxFuture;
use protocol::api::ToolSpec;

/// HubSpot CRM connector. Config `{ "base_url": "…" }` overrides the API
/// origin (test seam); the default is `https://api.hubapi.com`. The token
/// is a stored secret.
pub struct Hubspot;

/// Search tool name → CRM object type.
const SEARCH_TOOLS: [(&str, &str); 3] = [
    ("search_contacts", "contacts"),
    ("search_companies", "companies"),
    ("search_deals", "deals"),
];

/// Properties requested per object type (the search API returns only what
/// the request names).
fn display_props(object: &str) -> &'static [&'static str] {
    match object {
        "contacts" => &["firstname", "lastname", "email"],
        "companies" => &["name", "domain"],
        _ => &["dealname", "amount"],
    }
}

fn secret<'a>(secrets: &'a [(String, String)], name: &str) -> Option<&'a str> {
    secrets
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, value)| value.as_str())
}

/// The API origin: the config `base_url` wins, the default is the public
/// CRM API host. Trailing slashes are stripped.
fn base_url(config: &serde_json::Value) -> String {
    config["base_url"]
        .as_str()
        .unwrap_or("https://api.hubapi.com")
        .trim_end_matches('/')
        .to_string()
}

/// One model-facing result line: ordinal, object id, then the display
/// properties that are present.
fn search_line(index: usize, object: &str, hit: &serde_json::Value) -> String {
    let id = hit["id"].as_str().unwrap_or("?");
    let props = &hit["properties"];
    let values: Vec<&str> = display_props(object)
        .iter()
        .filter_map(|p| props[*p].as_str())
        .collect();
    format!("{}. id={} {}", index + 1, id, values.join(" "))
}

impl Integration for Hubspot {
    fn name(&self) -> &'static str {
        "hubspot"
    }

    fn category(&self) -> Category {
        Category::Other
    }

    fn manifest(&self) -> BundleManifest {
        in_code_manifest(
            "hubspot",
            "1.0.0",
            "HubSpot CRM: search contacts, companies, and deals; update deals",
            &["token"],
            &[
                ("search_contacts", "read"),
                ("search_companies", "read"),
                ("search_deals", "read"),
                ("update_deal", "write"),
                ("api", "write"),
            ],
            &[guild_core::registry::FieldSpec {
                default: Some(serde_json::json!("https://api.hubapi.com")),
                help: Some("Override only for a HubSpot API proxy".into()),
                ..field("base_url", "string")
            }],
        )
    }

    fn tools(&self, _config: &serde_json::Value) -> anyhow::Result<Vec<ToolSpec>> {
        let search = |name: &'static str, noun: &str| ToolSpec {
            name: name.into(),
            description: format!(
                "Search HubSpot {noun} by free-text query (CRM v3 search)."
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "number",
                        "description": "1-100 results, default 10" }
                },
                "required": ["query"]
            }),
        };
        Ok(vec![
            search("search_contacts", "contacts"),
            search("search_companies", "companies"),
            search("search_deals", "deals"),
            ToolSpec {
                name: "update_deal".into(),
                description: "Update properties of one HubSpot deal by id.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string",
                            "description": "Deal id (internal numeric id)" },
                        "properties": { "type": "object",
                            "description": "Deal properties to set, e.g. {\"amount\": \"1000\"}" }
                    },
                    "required": ["id", "properties"]
                }),
            },
            api_tool_spec("HubSpot"),
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
            let token = secret(secrets, "token")
                .ok_or("hubspot requires the token secret")?
                .to_string();

            if tool == "update_deal" {
                return update_deal(&base_url(_config), &token, &args).await;
            }
            if tool == "api" {
                return call_vendor_api(
                    &base_url(_config),
                    &ApiAuth::Bearer(token),
                    &args,
                    12_000,
                    &[],
                )
                .await;
            }
            let Some((_, object)) = SEARCH_TOOLS.iter().find(|(name, _)| *name == tool) else {
                return Err(format!("hubspot integration has no tool {tool}"));
            };
            search(object, &base_url(_config), &token, &args).await
        })
    }
}

/// CRM v3 free-text search: POSTs `{query, limit, properties}` to
/// `/crm/v3/objects/{object}/search` and renders one line per hit.
async fn search(
    object: &str,
    base: &str,
    token: &str,
    args: &serde_json::Value,
) -> Result<ToolOutcome, String> {
    let query = args["query"]
        .as_str()
        .ok_or("search requires query")?
        .to_string();
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 100) as usize;
    let properties = display_props(object);
    let body = serde_json::json!({
        "query": query,
        "limit": limit,
        "properties": properties,
    });
    let resp = reqwest::Client::new()
        .post(format!("{base}/crm/v3/objects/{object}/search"))
        .bearer_auth(token)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("hubspot unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("hubspot returned {}", resp.status()));
    }
    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("hubspot returned bad json: {e}"))?;
    let hits = parsed["results"].as_array().cloned().unwrap_or_default();

    let mut content = String::new();
    let mut results = Vec::new();
    for (i, hit) in hits.iter().take(limit).enumerate() {
        content.push_str(&search_line(i, object, hit));
        content.push('\n');
        let label = search_line(i, object, hit);
        results.push(serde_json::json!({
            "id": hit["id"],
            "label": label,
        }));
    }
    if content.is_empty() {
        content = "No results.".to_string();
    }
    let meta = serde_json::json!({
        "card": "crm",
        "kind": "search",
        "object": object,
        "count": results.len(),
        "results": results,
    });
    Ok(ToolOutcome {
        content,
        meta: Some(meta),
    })
}

/// PATCHes one deal's properties and reports the updated deal id.
async fn update_deal(
    base: &str,
    token: &str,
    args: &serde_json::Value,
) -> Result<ToolOutcome, String> {
    let id = args["id"]
        .as_str()
        .ok_or("update_deal requires id")?
        .to_string();
    let props = args["properties"]
        .as_object()
        .filter(|p| !p.is_empty())
        .ok_or("update_deal requires a non-empty properties object")?;
    let body = serde_json::json!({ "properties": props });
    let resp = reqwest::Client::new()
        .patch(format!("{base}/crm/v3/objects/deals/{id}"))
        .bearer_auth(token)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("hubspot unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("hubspot returned {}", resp.status()));
    }
    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("hubspot returned bad json: {e}"))?;
    let updated_id = parsed["id"].as_str().unwrap_or(&id);
    let fields: Vec<String> = props.keys().cloned().collect();
    let meta = serde_json::json!({
        "card": "crm",
        "kind": "deal_update",
        "id": updated_id,
        "fields": fields,
    });
    Ok(ToolOutcome {
        content: format!("Deal {updated_id} updated ({}).", fields.join(", ")),
        meta: Some(meta),
    })
}
