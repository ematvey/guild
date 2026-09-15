//! Atlassian connector tests: Jira and Confluence tools against a mock
//! Atlassian Cloud (wiremock) — happy paths with auth-header assertions,
//! error mapping, and secret handling (fake credentials only).

use guild_server::integrations::{integration_by_name, Category};
use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const EMAIL: &str = "bot@example.test";
const TOKEN: &str = "fake-token-123";

/// Site and email are plain settings; only the API token is a credential.
fn config(site: &str) -> serde_json::Value {
    json!({ "site": site, "email": EMAIL })
}

fn secrets() -> Vec<(String, String)> {
    vec![("token".to_string(), TOKEN.to_string())]
}

/// Basic auth value for email:token — every connector request must carry it.
fn basic_auth() -> String {
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{EMAIL}:{TOKEN}"))
    )
}

#[tokio::test]
async fn jira_search_posts_jql_with_basic_auth() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/rest/api/3/search/jql"))
        .and(header("authorization", basic_auth()))
        .and(wiremock::matchers::body_partial_json(json!({
            "jql": "project = PROJ ORDER BY updated DESC",
            "maxResults": 10
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "issues": [
                { "key": "PROJ-1", "fields": {
                    "summary": "Fix login", "status": { "name": "In Progress" },
                    "issuetype": { "name": "Bug" }, "assignee": { "displayName": "Alice" } } },
                { "key": "PROJ-2", "fields": {
                    "summary": "Add dark mode", "status": { "name": "To Do" },
                    "issuetype": { "name": "Story" }, "assignee": null } }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("atlassian").unwrap();
    assert_eq!(plugin.name(), "atlassian");
    assert_eq!(plugin.categories(), &[Category::Other]);

    let out = plugin
        .execute(
            &config(&server.uri()),
            "jira_search",
            json!({ "jql": "project = PROJ ORDER BY updated DESC" }),
            &secrets(),
            None,
        )
        .await
        .unwrap();
    assert!(out
        .content
        .contains("PROJ-1 — Fix login [In Progress] (Alice)"));
    assert!(out.content.contains("PROJ-2 — Add dark mode [To Do]"));
    let meta = out.meta.expect("search meta present");
    assert_eq!(meta["kind"], "jira_search");
    assert_eq!(meta["count"], 2);
    assert_eq!(meta["truncated"], false);

    server.verify().await;
}

#[tokio::test]
async fn jira_get_issue_renders_block_with_browse_url() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/3/issue/PROJ-1"))
        .and(header("authorization", basic_auth()))
        .and(query_param(
            "fields",
            "summary,status,issuetype,assignee,created",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "key": "PROJ-1",
            "fields": {
                "summary": "Fix login",
                "status": { "name": "In Progress" },
                "issuetype": { "name": "Bug" },
                "assignee": { "displayName": "Alice" },
                "created": "2026-09-01T10:00:00.000+0000"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("atlassian").unwrap();
    let out = plugin
        .execute(
            &config(&server.uri()),
            "jira_get_issue",
            json!({ "issue_key": "PROJ-1" }),
            &secrets(),
            None,
        )
        .await
        .unwrap();
    assert!(out.content.starts_with("PROJ-1 — Fix login"));
    assert!(out
        .content
        .contains("type: Bug | status: In Progress | assignee: Alice"));
    assert!(out
        .content
        .contains(&format!("{}/browse/PROJ-1", server.uri())));
    let meta = out.meta.unwrap();
    assert_eq!(meta["kind"], "jira_issue");
    assert_eq!(meta["key"], "PROJ-1");

    server.verify().await;
}

#[tokio::test]
async fn confluence_search_queries_cql() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/wiki/rest/api/search"))
        .and(header("authorization", basic_auth()))
        .and(query_param("cql", "space = PROJ AND type = page"))
        .and(query_param("limit", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                { "content": { "id": "101", "title": "Onboarding", "type": "page" },
                  "excerpt": "How to get started" },
                { "content": { "id": "102", "title": "Runbook", "type": "page" },
                  "excerpt": "" }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("atlassian").unwrap();
    let out = plugin
        .execute(
            &config(&server.uri()),
            "confluence_search",
            json!({ "cql": "space = PROJ AND type = page", "limit": 2 }),
            &secrets(),
            None,
        )
        .await
        .unwrap();
    assert!(out
        .content
        .contains("Onboarding (id 101): How to get started"));
    assert!(out.content.contains("Runbook (id 102)"));
    let meta = out.meta.unwrap();
    assert_eq!(meta["kind"], "confluence_search");
    assert_eq!(meta["count"], 2);

    server.verify().await;
}

#[tokio::test]
async fn confluence_get_page_strips_storage_markup() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/wiki/rest/api/content/101"))
        .and(header("authorization", basic_auth()))
        .and(query_param("expand", "body.storage"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "101",
            "title": "Onboarding",
            "type": "page",
            "body": { "storage": {
                "value": "<p>Welcome to <b>PROJ</b></p><p>Read the runbook.</p>",
                "representation": "storage" } },
            "_links": { "webui": "/spaces/PROJ/pages/101" }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("atlassian").unwrap();
    let out = plugin
        .execute(
            &config(&server.uri()),
            "confluence_get_page",
            json!({ "page_id": "101" }),
            &secrets(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        out.content,
        format!(
            "Onboarding\n\nWelcome to PROJ Read the runbook.\n\n{}/spaces/PROJ/pages/101",
            server.uri()
        )
    );
    let meta = out.meta.unwrap();
    assert_eq!(meta["kind"], "confluence_page");
    assert_eq!(meta["title"], "Onboarding");

    server.verify().await;
}

#[tokio::test]
async fn confluence_create_page_posts_storage_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/wiki/rest/api/content"))
        .and(header("authorization", basic_auth()))
        .and(wiremock::matchers::body_partial_json(json!({
            "type": "page",
            "title": "Meeting notes",
            "space": { "key": "PROJ" },
            "body": { "storage": { "value": "<p>hello</p>", "representation": "storage" } }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "777",
            "title": "Meeting notes",
            "type": "page",
            "_links": { "webui": "/spaces/PROJ/pages/777" }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("atlassian").unwrap();
    let out = plugin
        .execute(
            &config(&server.uri()),
            "confluence_create_page",
            json!({ "space_key": "PROJ", "title": "Meeting notes", "content": "<p>hello</p>" }),
            &secrets(),
            None,
        )
        .await
        .unwrap();
    assert!(out.content.contains("Created page 777 (Meeting notes)"));
    assert!(out
        .content
        .contains(&format!("{}/spaces/PROJ/pages/777", server.uri())));
    let meta = out.meta.unwrap();
    assert_eq!(meta["kind"], "confluence_page_created");
    assert_eq!(meta["id"], "777");

    server.verify().await;
}

#[tokio::test]
async fn atlassian_errors_map_to_err() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/rest/api/3/search/jql"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "errorMessages": ["Basic authentication with passwords is deprecated."]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let plugin = integration_by_name("atlassian").unwrap();

    // Auth failure: status plus the vendor message body.
    let err = plugin
        .execute(
            &config(&server.uri()),
            "jira_search",
            json!({ "jql": "project = PROJ" }),
            &secrets(),
            None,
        )
        .await
        .unwrap_err();
    assert!(err.contains("401"), "unexpected error: {err}");
    assert!(err.contains("deprecated"), "unexpected error: {err}");

    // Server failure on the Confluence side.
    let err = plugin
        .execute(
            &config(&server.uri()),
            "confluence_search",
            json!({ "cql": "space = PROJ" }),
            &secrets(),
            None,
        )
        .await
        .unwrap_err();
    assert!(err.contains("500"), "unexpected error: {err}");

    // Unknown tool name.
    let err = plugin
        .execute(
            &config(&server.uri()),
            "jira_create",
            json!({}),
            &secrets(),
            None,
        )
        .await
        .unwrap_err();
    assert!(err.contains("no tool jira_create"));
}

#[tokio::test]
async fn atlassian_requires_settings_and_token() {
    let plugin = integration_by_name("atlassian").unwrap();
    // Missing settings fail with the specific field.
    let err = plugin
        .execute(
            &json!({}),
            "jira_search",
            json!({ "jql": "project = PROJ" }),
            &secrets(),
            None,
        )
        .await
        .unwrap_err();
    assert!(
        err.contains("requires the site setting"),
        "unexpected: {err}"
    );

    // The manifest declares exactly one credential (the token); site and
    // email are required settings.
    let m = plugin.manifest();
    assert_eq!(
        m.auth.expect("auth manifest").secret_names,
        vec!["token".to_string()]
    );
    let fields = m.settings.expect("settings").fields;
    assert!(fields.iter().any(|f| f.name == "site" && f.required));
    assert!(fields.iter().any(|f| f.name == "email" && f.required));
    assert_eq!(
        m.tools.expect("tools").classes["confluence_create_page"],
        "write"
    );
}
