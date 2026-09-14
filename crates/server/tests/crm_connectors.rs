//! CRM lane connector tests: hubspot search/update and langfuse
//! traces/prompts against wiremock fixtures. All tokens are fake.

use guild_server::integrations::{integration_by_name, Category};
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FAKE_TOKEN: &str = "pat-fake-token";

fn hubspot_secrets() -> Vec<(String, String)> {
    vec![("token".to_string(), FAKE_TOKEN.to_string())]
}

fn langfuse_secrets(host: &str) -> Vec<(String, String)> {
    vec![
        ("host".to_string(), host.to_string()),
        ("public_key".to_string(), "pk".to_string()),
        ("secret_key".to_string(), "sk".to_string()),
    ]
}

// ---------- hubspot: search family ----------

#[tokio::test]
async fn hubspot_search_contacts_sends_bearer_and_renders_hits() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/crm/v3/objects/contacts/search"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .and(body_partial_json(json!({ "query": "jane", "limit": 10 })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                { "id": "101", "properties": {
                    "firstname": "Jane", "lastname": "Doe",
                    "email": "jane@example.com" } }
            ],
            "total": 1
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    assert_eq!(plugin.category(), Category::Other);
    let out = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "search_contacts",
            json!({ "query": "jane" }),
            &hubspot_secrets(), None)
        .await
        .unwrap();
    assert!(out.content.contains("101 Jane Doe jane@example.com"));
    let meta = out.meta.expect("search meta present");
    assert_eq!(meta["card"], "crm");
    assert_eq!(meta["kind"], "search");
    assert_eq!(meta["object"], "contacts");
    assert_eq!(meta["count"], 1);

    server.verify().await;
}

#[tokio::test]
async fn hubspot_search_companies_renders_hits() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/crm/v3/objects/companies/search"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                { "id": "202", "properties": { "name": "Acme", "domain": "acme.com" } }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let out = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "search_companies",
            json!({ "query": "acme", "limit": 5 }),
            &hubspot_secrets(), None)
        .await
        .unwrap();
    assert!(out.content.contains("202 Acme acme.com"));
    assert_eq!(out.meta.unwrap()["object"], "companies");

    server.verify().await;
}

#[tokio::test]
async fn hubspot_search_deals_renders_hits() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/crm/v3/objects/deals/search"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                { "id": "303", "properties": { "dealname": "Big deal", "amount": "1000" } }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let out = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "search_deals",
            json!({ "query": "deal" }),
            &hubspot_secrets(), None)
        .await
        .unwrap();
    assert!(out.content.contains("303 Big deal 1000"));
    assert_eq!(out.meta.unwrap()["object"], "deals");

    server.verify().await;
}

#[tokio::test]
async fn hubspot_search_errors_map_to_err() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let err = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "search_contacts",
            json!({ "query": "x" }),
            &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("hubspot returned 401"));

    // Unknown tool name.
    let err = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "create_ticket",
            json!({}), &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("no tool create_ticket"));

    // Missing token secret.
    let err = plugin
        .execute(&json!({}), "search_contacts", json!({ "query": "x" }), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("token"));
}

// ---------- hubspot: update_deal (write) ----------

#[tokio::test]
async fn hubspot_update_deal_patches_properties() {
    let server = MockServer::start().await;
    Mock::given(method("PATCH"))
        .and(path("/crm/v3/objects/deals/555"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .and(body_partial_json(json!({ "properties": { "amount": "999" } })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "555", "properties": { "amount": "999" }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let out = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "update_deal",
            json!({ "id": "555", "properties": { "amount": "999" } }),
            &hubspot_secrets(), None)
        .await
        .unwrap();
    assert!(out.content.contains("555"));
    assert!(out.content.contains("amount"));
    let meta = out.meta.expect("update meta present");
    assert_eq!(meta["kind"], "deal_update");
    assert_eq!(meta["id"], "555");

    server.verify().await;
}

#[tokio::test]
async fn hubspot_update_deal_errors_map_to_err() {
    let server = MockServer::start().await;
    Mock::given(method("PATCH"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let err = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "update_deal",
            json!({ "id": "404", "properties": { "amount": "1" } }),
            &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("hubspot returned 404"));

    // Missing required args.
    let err = plugin
        .execute(
            &json!({ "base_url": server.uri() }),
            "update_deal",
            json!({}), &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("requires id"));
}

// ---------- langfuse ----------

#[tokio::test]
async fn langfuse_list_traces_sends_basic_auth_and_config_base_url_wins() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/public/traces"))
        .and(query_param("limit", "10"))
        // pk:sk in basic auth.
        .and(header("authorization", "Basic cGs6c2s="))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [
                { "id": "tr-1", "name": "chat", "timestamp": "2026-09-12T00:00:00Z" }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("langfuse").unwrap();
    assert_eq!(plugin.category(), Category::Other);
    // The host secret points nowhere real; the config base_url override
    // routes the call to the mock.
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "list_traces",
            json!({}),
            &langfuse_secrets("https://cloud.langfuse.com"), None)
        .await
        .unwrap();
    assert!(out.content.contains("tr-1 chat"));
    let meta = out.meta.expect("traces meta present");
    assert_eq!(meta["kind"], "traces");
    assert_eq!(meta["count"], 1);

    server.verify().await;
}

#[tokio::test]
async fn langfuse_get_trace_fetches_full_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/public/traces/tr-9"))
        .and(header("authorization", "Basic cGs6c2s="))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "tr-9", "name": "agent-run",
            "timestamp": "2026-09-12T01:00:00Z",
            "observations": [ { "id": "obs-1" } ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("langfuse").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "get_trace",
            json!({ "trace_id": "tr-9" }),
            &langfuse_secrets("https://cloud.langfuse.com"), None)
        .await
        .unwrap();
    assert!(out.content.contains("tr-9"));
    assert!(out.content.contains("obs-1"));
    assert_eq!(out.meta.unwrap()["id"], "tr-9");

    server.verify().await;
}

#[tokio::test]
async fn langfuse_get_prompt_renders_one_prompt() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/public/prompts/support"))
        .and(header("authorization", "Basic cGs6c2s="))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "name": "support", "version": 3, "type": "chat"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("langfuse").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(&config, "get_prompt", json!({"name": "support"}), &langfuse_secrets("https://x.test"), None)
        .await
        .unwrap();
    assert!(out.content.contains("support"));
    assert!(out.content.contains("v3"));
    let meta = out.meta.unwrap();
    assert_eq!(meta["kind"], "prompt");
    assert_eq!(meta["name"], "support");
    assert_eq!(meta["version"], 3);

    server.verify().await;
}

#[tokio::test]
async fn langfuse_errors_map_to_err() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let plugin = integration_by_name("langfuse").unwrap();
    let config = json!({ "base_url": server.uri() });
    let err = plugin
        .execute(&config, "list_traces", json!({}), &langfuse_secrets("https://x.test"), None)
        .await
        .unwrap_err();
    assert!(err.contains("langfuse returned 500"));

    // Unknown tool name.
    let err = plugin
        .execute(&config, "delete_prompt", json!({}), &langfuse_secrets("https://x.test"), None)
        .await
        .unwrap_err();
    assert!(err.contains("no tool delete_prompt"));

    // Missing secrets — no config override to hide it either.
    let err = plugin
        .execute(&json!({}), "list_traces", json!({}), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("public_key"));
}

// ---------- manifests ----------

#[test]
fn crm_manifests_declare_expected_secrets_and_classes() {
    let hubspot = integration_by_name("hubspot").unwrap().manifest();
    assert_eq!(
        hubspot.auth.expect("auth").secret_names,
        vec!["token".to_string()]
    );
    assert_eq!(
        hubspot.tools.expect("tools").classes["update_deal"],
        "write"
    );

    let langfuse = integration_by_name("langfuse").unwrap().manifest();
    // The host URL is a plain setting (default: the public cloud); only
    // the key pair is credential material.
    assert_eq!(
        langfuse.auth.expect("auth").secret_names,
        vec!["public_key".to_string(), "secret_key".to_string()]
    );
    let fields = langfuse.settings.expect("settings").fields;
    assert!(fields.iter().any(|f| f.name == "base_url"
        && !f.required
        && f.default == Some(serde_json::json!("https://cloud.langfuse.com"))));
    let classes = langfuse.tools.expect("tools").classes;
    assert!(classes.values().all(|c| c == "read" || c == "write"));
}

#[tokio::test]
async fn hubspot_api_passes_through_path_query_body_and_auth() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/crm/v3/objects/deals"))
        .and(query_param("limit", "2"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results": []})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/crm/v3/objects/deals/batch/create"))
        .and(body_partial_json(json!({"inputs": []})))
        .respond_with(ResponseTemplate::new(201).set_body_string("{}"))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "api",
            json!({"path": "/crm/v3/objects/deals", "query": {"limit": "2"}}),
            &hubspot_secrets(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(out.meta.unwrap()["status"], 200);
    let out = plugin
        .execute(
            &config,
            "api",
            json!({"method": "POST", "path": "/crm/v3/objects/deals/batch/create", "body": {"inputs": []}}),
            &hubspot_secrets(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(out.meta.unwrap()["status"], 201);
}

#[tokio::test]
async fn hubspot_api_maps_errors_and_rejects_bad_paths() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/nope"))
        .respond_with(ResponseTemplate::new(404).set_body_string("missing"))
        .mount(&server)
        .await;

    let plugin = integration_by_name("hubspot").unwrap();
    let config = json!({ "base_url": server.uri() });
    let err = plugin
        .execute(&config, "api", json!({"path": "/nope"}), &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("404"));
    let err = plugin
        .execute(&config, "api", json!({"path": "nope"}), &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("must start with /"));
    let err = plugin
        .execute(&config, "api", json!({"path": "/x", "method": "TRACE"}), &hubspot_secrets(), None)
        .await
        .unwrap_err();
    assert!(err.contains("not allowed"));
}
