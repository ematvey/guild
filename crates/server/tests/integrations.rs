//! Integration plugin tests: superproxy web_fetch against a mock gateway,
//! searxng web_search meta shape (spec C.2/D).

use guild_server::integrations::{integration_by_name, integration_names, Category};
use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn superproxy_config(server: &MockServer, token: Option<&str>) -> serde_json::Value {
    let mut cfg = json!({ "base_url": server.uri() });
    if let Some(t) = token {
        cfg["token"] = json!(t);
    }
    cfg
}

#[tokio::test]
async fn superproxy_fetch_builds_content_and_meta() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/fetch"))
        .and(query_param("url", "https://example.com/a"))
        .and(query_param("format", "markdown"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "url": "https://example.com/a",
            "status": 200,
            "title": "Example Page",
            "description": "an example",
            "published": null,
            "wordCount": 2,
            "content": "hello body"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("superproxy").unwrap();
    assert_eq!(plugin.name(), "superproxy");
    assert_eq!(plugin.category(), Category::Fetch);

    let config = superproxy_config(&server, None);
    let out = plugin
        .execute(&config, "web_fetch", json!({ "url": "https://example.com/a" }), &[], None)
        .await
        .unwrap();
    assert_eq!(out.content, "# Example Page\n\nhello body");
    let meta = out.meta.expect("fetch meta present");
    assert_eq!(meta["card"], "web");
    assert_eq!(meta["kind"], "fetch");
    assert_eq!(meta["url"], "https://example.com/a");
    assert_eq!(meta["status_code"], 200);
    assert_eq!(meta["truncated"], false);
    assert_eq!(meta["title"], "Example Page");

    server.verify().await;
}

#[tokio::test]
async fn superproxy_sends_bearer_token_when_configured() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("authorization", "Bearer sekrit"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "url": "https://example.com/b", "status": 200,
            "content": "body"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("superproxy").unwrap();
    let config = superproxy_config(&server, Some("sekrit"));
    let out = plugin
        .execute(&config, "web_fetch", json!({ "url": "https://example.com/b" }), &[], None)
        .await
        .unwrap();
    // No title in response -> no title header, no meta.title.
    assert_eq!(out.content, "body");
    let meta = out.meta.unwrap();
    assert!(meta.get("title").is_none());

    server.verify().await;
}

#[tokio::test]
async fn superproxy_truncates_long_content() {
    let server = MockServer::start().await;
    let long_body = "x".repeat(50_000);
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "url": "https://example.com/long", "status": 200,
            "title": "Long", "content": long_body
        })))
        .mount(&server)
        .await;

    let plugin = integration_by_name("superproxy").unwrap();
    let config = superproxy_config(&server, None);
    let out = plugin
        .execute(
            &config,
            "web_fetch",
            json!({ "url": "https://example.com/long", "max_chars": 1000 }),
            &[], None)
        .await
        .unwrap();
    assert_eq!(out.content.len(), 1000 + "\n\n[truncated]".len());
    assert!(out.content.ends_with("[truncated]"));
    let meta = out.meta.unwrap();
    assert_eq!(meta["truncated"], true);
}

#[tokio::test]
async fn superproxy_errors_map_to_err() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&server)
        .await;

    let plugin = integration_by_name("superproxy").unwrap();
    let config = superproxy_config(&server, None);
    let err = plugin
        .execute(&config, "web_fetch", json!({ "url": "https://x.test/" }), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("502"));

    // Unknown tool name.
    let err = plugin
        .execute(&config, "web_search", json!({}), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("no tool web_search"));
}

#[tokio::test]
async fn searxng_search_builds_meta_with_sources() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search"))
        .and(query_param("q", "rust"))
        .and(query_param("format", "json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                { "title": "Rust home", "url": "https://rust-lang.org", "content": "a language" },
                { "title": "Docs", "url": "https://doc.rust-lang.org", "content": "the docs" },
                { "title": "T3", "url": "https://t.test", "content": "third" },
                { "title": "T4", "url": "https://4.test", "content": "fourth" },
                { "title": "T5", "url": "https://5.test", "content": "fifth" },
                { "title": "T6", "url": "https://6.test", "content": "sixth" },
                { "title": "T7", "url": "https://7.test", "content": "seventh" }
            ]
        })))
        .mount(&server)
        .await;

    let plugin = integration_by_name("searxng").unwrap();
    assert_eq!(plugin.category(), Category::Search);

    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(&config, "web_search", json!({ "query": "rust", "count": 5 }), &[], None)
        .await
        .unwrap();
    assert!(out.content.starts_with("1. Rust home"));
    let meta = out.meta.expect("search meta present");
    assert_eq!(meta["card"], "web");
    assert_eq!(meta["kind"], "search");
    // count=5 but 7 hits -> truncated.
    assert_eq!(meta["truncated"], true);
    let sources = meta["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 5);
    assert_eq!(sources[0]["url"], "https://rust-lang.org");
    assert_eq!(sources[0]["title"], "Rust home");
    assert_eq!(sources[0]["snippet"], "a language");
}

// ---------- firecrawl: scrape / search / map against a stub API ----------

fn firecrawl_bearer() -> Vec<(String, String)> {
    vec![("api_key".to_string(), "fc-key-1".to_string())]
}

#[tokio::test]
async fn firecrawl_scrape_builds_content_and_fetch_meta() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/scrape"))
        .and(header("authorization", "Bearer fc-key-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "data": {
                "markdown": "Example Domain\n==============",
                "metadata": {
                    "title": "Example Domain",
                    "sourceURL": "https://example.com",
                    "statusCode": 200
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("firecrawl").unwrap();
    assert_eq!(plugin.name(), "firecrawl");
    assert_eq!(plugin.category(), Category::Fetch);

    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "scrape",
            json!({ "url": "https://example.com" }),
            &firecrawl_bearer(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(out.content, "Example Domain\n==============");
    let meta = out.meta.expect("fetch meta present");
    assert_eq!(meta["card"], "web");
    assert_eq!(meta["kind"], "fetch");
    assert_eq!(meta["url"], "https://example.com");
    assert_eq!(meta["status_code"], 200);
    assert_eq!(meta["truncated"], false);
    assert_eq!(meta["title"], "Example Domain");

    server.verify().await;
}

#[tokio::test]
async fn firecrawl_omits_bearer_when_no_key_stored() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/map"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true, "links": ["https://a.test", "https://b.test"]
        })))
        .mount(&server)
        .await;

    let plugin = integration_by_name("firecrawl").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(&config, "map", json!({ "url": "https://a.test" }), &[], None)
        .await
        .unwrap();
    assert_eq!(out.content, "https://a.test\nhttps://b.test\n");
    assert!(out.meta.is_none());

    // No key stored -> no Authorization header rides at all.
    let requests = server.received_requests().await.expect("requests recorded");
    let map_req = requests
        .iter()
        .find(|r| r.url.path() == "/v1/map")
        .expect("map request recorded");
    assert!(!map_req.headers.contains_key("authorization"));

    server.verify().await;
}

#[tokio::test]
async fn firecrawl_search_builds_search_meta_and_honors_scrape_flag() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .and(header("authorization", "Bearer fc-key-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "data": [
                { "url": "https://rust-lang.org", "title": "Rust home",
                  "description": "a language", "markdown": "page body" },
                { "url": "https://doc.rust-lang.org", "title": "Docs",
                  "description": "the docs", "markdown": "doc body" }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("firecrawl").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "search",
            json!({ "query": "rust", "limit": 1, "scrape": true }),
            &firecrawl_bearer(),
            None,
        )
        .await
        .unwrap();
    // limit=1 but 2 hits -> truncated.
    assert!(out.content.starts_with("1. Rust home"));
    assert!(out.content.contains("page body"));
    let meta = out.meta.expect("search meta present");
    assert_eq!(meta["card"], "web");
    assert_eq!(meta["kind"], "search");
    assert_eq!(meta["truncated"], true);
    let sources = meta["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["url"], "https://rust-lang.org");
    assert_eq!(sources[0]["snippet"], "a language");

    server.verify().await;
}

#[tokio::test]
async fn firecrawl_errors_map_to_err() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(502).set_body_json(
            json!({ "success": false, "error": "upstream dead" }),
        ))
        .mount(&server)
        .await;

    let plugin = integration_by_name("firecrawl").unwrap();
    let config = json!({ "base_url": server.uri() });
    let err = plugin
        .execute(&config, "scrape", json!({ "url": "https://x.test/" }), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("502"));

    // Unknown tool name.
    let err = plugin
        .execute(&config, "crawl", json!({}), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("no tool crawl"));
}

#[tokio::test]
async fn firecrawl_test_connection_accepts_api_marker_and_rejects_imposter() {
    let plugin = integration_by_name("firecrawl").unwrap();

    let ok = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "message": "Firecrawl API" })),
        )
        .mount(&ok)
        .await;
    plugin
        .test_connection(&json!({ "base_url": ok.uri() }), &[])
        .await
        .unwrap();

    let imposter = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&imposter)
        .await;
    let err = plugin
        .test_connection(&json!({ "base_url": imposter.uri() }), &[])
        .await
        .unwrap_err();
    assert!(err.contains("unexpected response"));
}

#[test]
fn firecrawl_tools_declare_three_tools_and_optional_key_secret() {
    let plugin = integration_by_name("firecrawl").unwrap();
    let tools = plugin.tools(&json!({})).unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["scrape", "search", "map"]);

    // api_key rides as a declared secret; base_url falls back to the
    // docker-reachable default, so the empty config stays valid.
    let m = plugin.manifest();
    assert_eq!(
        m.auth.expect("auth").secret_names,
        vec!["api_key".to_string()]
    );
}

// ---------- unified interface: manifest + secrets (milestone 10, C1) ----------

#[test]
fn built_in_manifests_carry_slug_version_and_classes() {
    for name in integration_names() {
        let plugin = integration_by_name(name).unwrap_or_else(|| panic!("{name} resolves"));
        let m = plugin.manifest();
        assert_eq!(m.kind, "integration");
        assert_eq!(m.slug, *name);
        assert_eq!(plugin.name(), *name as &str);
        // In-code manifests carry no mcp field and no registry bundle.
        assert!(m.mcp.is_none(), "{name} manifest has an mcp field");
        let classes = m.tools.expect("classes").classes;
        assert!(!classes.is_empty(), "{name} declares tool classes");
    }
}

#[test]
fn superproxy_declares_no_required_secrets_for_backwards_compat() {
    // The gateway token stays optional (config fallback), so the enable
    // gate must not require a stored secret.
    let m = integration_by_name("superproxy").unwrap().manifest();
    assert_eq!(m.auth.expect("auth").secret_names, Vec::<String>::new());
}

#[tokio::test]
async fn superproxy_prefers_stored_secret_over_config_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("authorization", "Bearer store-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "url": "https://example.com/c", "status": 200, "content": "body"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("superproxy").unwrap();
    let config = superproxy_config(&server, Some("config-token"));
    let secrets = vec![("token".to_string(), "store-token".to_string())];
    let out = plugin
        .execute(&config, "web_fetch", json!({ "url": "https://example.com/c" }), &secrets, None)
        .await
        .unwrap();
    assert_eq!(out.content, "body");
    server.verify().await;
}
