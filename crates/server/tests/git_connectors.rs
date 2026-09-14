//! GitHub + GitLab connector tests: one happy path with an auth-header
//! assertion and an error-mapping case per tool family, against wiremock
//! fixtures with fake tokens.

use base64::Engine as _;
use guild_server::integrations::{integration_by_name, Category};
use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FAKE_GITHUB_TOKEN: &str = "gh-fake-token";
const FAKE_GITLAB_TOKEN: &str = "gl-fake-token";

// ---------- github ----------

#[tokio::test]
async fn github_search_repositories_happy_path_with_auth() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search/repositories"))
        .and(query_param("q", "rust web"))
        .and(query_param("per_page", "10"))
        .and(header("authorization", format!("Bearer {FAKE_GITHUB_TOKEN}")))
        .and(header("user-agent", "guild-integration-github"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 1,
            "items": [ {
                "full_name": "owner/repo",
                "html_url": "https://github.com/owner/repo",
                "description": "a repo",
                "language": "Rust",
                "stargazers_count": 42
            } ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("github").unwrap();
    assert_eq!(plugin.category(), Category::Other);
    let config = json!({ "api_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "search_repositories",
            json!({ "query": "rust web" }),
            &[("token".into(), FAKE_GITHUB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("1. owner/repo (Rust, ★42)"));
    assert_eq!(out.meta.unwrap()["total_count"], 1);
    server.verify().await;
}

#[tokio::test]
async fn github_list_issues_filters_out_pull_requests() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/octo/repo/issues"))
        .and(query_param("state", "open"))
        .and(header("authorization", format!("Bearer {FAKE_GITHUB_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "number": 7, "title": "bug", "state": "open",
              "user": { "login": "octo" } },
            { "number": 8, "title": "pr", "state": "open",
              "user": { "login": "octo" }, "pull_request": { "url": "x" } }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("github").unwrap();
    let config = json!({ "api_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "list_issues",
            json!({ "owner": "octo", "repo": "repo" }),
            &[("token".into(), FAKE_GITHUB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("#7 [open] bug (@octo)"));
    assert!(!out.content.contains("#8"));
    server.verify().await;
}

#[tokio::test]
async fn github_list_pulls_renders_branches() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/octo/repo/pulls"))
        .and(query_param("state", "open"))
        .and(header("authorization", format!("Bearer {FAKE_GITHUB_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "number": 12, "title": "fix thing", "state": "open",
              "user": { "login": "octo" },
              "head": { "ref": "fix-branch" }, "base": { "ref": "main" } }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("github").unwrap();
    let config = json!({ "api_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "list_pulls",
            json!({ "owner": "octo", "repo": "repo" }),
            &[("token".into(), FAKE_GITHUB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("#12 [open] fix thing (fix-branch→main, @octo)"));
    server.verify().await;
}

#[tokio::test]
async fn github_get_file_decodes_base64_content() {
    let server = MockServer::start().await;
    // base64("hello guild\n")
    let encoded = base64::engine::general_purpose::STANDARD.encode("hello guild\n");
    Mock::given(method("GET"))
        .and(path("/repos/octo/repo/contents/src/main.rs"))
        .and(query_param("ref", "main"))
        .and(header("authorization", format!("Bearer {FAKE_GITHUB_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "name": "main.rs",
            "path": "src/main.rs",
            "encoding": "base64",
            "content": encoded
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("github").unwrap();
    let config = json!({ "api_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "get_file",
            json!({ "owner": "octo", "repo": "repo", "path": "src/main.rs", "ref": "main" }),
            &[("token".into(), FAKE_GITHUB_TOKEN.into())], None)
        .await
        .unwrap();
    assert_eq!(out.content, "hello guild\n");
    assert_eq!(out.meta.unwrap()["file"], "src/main.rs");
    server.verify().await;
}

#[tokio::test]
async fn github_create_issue_posts_payload_and_reports_url() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/repos/octo/repo/issues"))
        .and(header("authorization", format!("Bearer {FAKE_GITHUB_TOKEN}")))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "number": 99,
            "html_url": "https://github.com/octo/repo/issues/99"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("github").unwrap();
    let config = json!({ "api_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "create_issue",
            json!({ "owner": "octo", "repo": "repo", "title": "new bug", "body": "details" }),
            &[("token".into(), FAKE_GITHUB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("#99"));
    assert_eq!(out.meta.unwrap()["url"], "https://github.com/octo/repo/issues/99");
    server.verify().await;
}

#[tokio::test]
async fn github_maps_errors_per_family() {
    let server = MockServer::start().await;
    let plugin = integration_by_name("github").unwrap();
    let config = json!({ "api_url": server.uri() });
    let secrets = vec![("token".to_string(), FAKE_GITHUB_TOKEN.to_string())];

    // search family: 403 → auth error.
    Mock::given(method("GET"))
        .and(path("/search/repositories"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let err = plugin
        .execute(
            &config,
            "search_repositories",
            json!({ "query": "x" }),
            &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("auth failed (403)"), "{err}");

    // issues family: 422 → validation rejection with the body excerpt.
    Mock::given(method("POST"))
        .and(path("/repos/octo/repo/issues"))
        .respond_with(
            ResponseTemplate::new(422)
                .set_body_json(json!({ "message": "Validation Failed" })),
        )
        .mount(&server)
        .await;
    let err = plugin
        .execute(
            &config,
            "create_issue",
            json!({ "owner": "octo", "repo": "repo", "title": "" }),
            &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("rejected the request"), "{err}");
    assert!(err.contains("Validation Failed"), "{err}");

    // file family: 404 → not found.
    Mock::given(method("GET"))
        .and(path("/repos/octo/repo/contents/nope.txt"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let err = plugin
        .execute(
            &config,
            "get_file",
            json!({ "owner": "octo", "repo": "repo", "path": "nope.txt" }),
            &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "{err}");

    // pulls family: 500 → generic status mapping.
    Mock::given(method("GET"))
        .and(path("/repos/octo/repo/pulls"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let err = plugin
        .execute(
            &config,
            "list_pulls",
            json!({ "owner": "octo", "repo": "repo" }),
            &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("github returned 500"), "{err}");

    // Missing secret never reaches the network.
    let err = plugin
        .execute(&config, "search_repositories", json!({ "query": "x" }), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("'token' is not stored"), "{err}");
}

// ---------- gitlab ----------

#[tokio::test]
async fn gitlab_list_projects_happy_path_with_private_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/projects"))
        .and(query_param("membership", "true"))
        .and(query_param("search", "api"))
        .and(header("private-token", FAKE_GITLAB_TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "id": 42, "name": "backend", "path_with_namespace": "acme/backend",
              "web_url": "https://gitlab.com/acme/backend", "description": "the backend" }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("gitlab").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "list_projects",
            json!({ "search": "api" }),
            &[("token".into(), FAKE_GITLAB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("1. backend (acme/backend)"));
    assert!(out.content.contains("https://gitlab.com/acme/backend"));
    server.verify().await;
}

#[tokio::test]
async fn gitlab_list_issues_encodes_project_path() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fbackend/issues"))
        .and(query_param("state", "opened"))
        .and(header("private-token", FAKE_GITLAB_TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "iid": 5, "title": "crash on start", "state": "opened",
              "web_url": "https://gitlab.com/acme/backend/-/issues/5",
              "author": { "username": "dev" } }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("gitlab").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "list_issues",
            json!({ "project": "acme/backend" }),
            &[("token".into(), FAKE_GITLAB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("!5 [opened] crash on start (@dev)"));
    server.verify().await;
}

#[tokio::test]
async fn gitlab_list_mrs_renders_branches() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/projects/42/merge_requests"))
        .and(query_param("state", "opened"))
        .and(header("private-token", FAKE_GITLAB_TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "iid": 9, "title": "add endpoint", "state": "opened",
              "source_branch": "feat/api", "target_branch": "main",
              "author": { "username": "dev" } }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("gitlab").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "list_mrs",
            json!({ "project": "42" }),
            &[("token".into(), FAKE_GITLAB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("!9 [opened] add endpoint (feat/api→main, @dev)"));
    server.verify().await;
}

#[tokio::test]
async fn gitlab_create_issue_posts_payload_and_reports_url() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/projects/42/issues"))
        .and(header("private-token", FAKE_GITLAB_TOKEN))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "iid": 11,
            "web_url": "https://gitlab.com/acme/backend/-/issues/11"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("gitlab").unwrap();
    let config = json!({ "base_url": server.uri() });
    let out = plugin
        .execute(
            &config,
            "create_issue",
            json!({ "project": "42", "title": "new bug", "description": "details" }),
            &[("token".into(), FAKE_GITLAB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("!11"));
    assert_eq!(
        out.meta.unwrap()["url"],
        "https://gitlab.com/acme/backend/-/issues/11"
    );
    server.verify().await;
}

#[tokio::test]
async fn gitlab_maps_errors_per_family() {
    let server = MockServer::start().await;
    let plugin = integration_by_name("gitlab").unwrap();
    let config = json!({ "base_url": server.uri() });
    let secrets = vec![("token".to_string(), FAKE_GITLAB_TOKEN.to_string())];

    // projects family: 401 → auth error.
    Mock::given(method("GET"))
        .and(path("/projects"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;
    let err = plugin
        .execute(&config, "list_projects", json!({}), &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("auth failed"), "{err}");

    // issues family: 400 → validation rejection.
    Mock::given(method("POST"))
        .and(path("/projects/42/issues"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_json(json!({ "message": { "title": ["can't be blank"] } })),
        )
        .mount(&server)
        .await;
    let err = plugin
        .execute(
            &config,
            "create_issue",
            json!({ "project": "42", "title": "" }),
            &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("rejected the request"), "{err}");

    // mr family: 404 → not found (unknown project).
    Mock::given(method("GET"))
        .and(path("/projects/999/merge_requests"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let err = plugin
        .execute(
            &config,
            "list_mrs",
            json!({ "project": "999" }),
            &secrets, None)
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "{err}");

    // Missing secret never reaches the network.
    let err = plugin
        .execute(&config, "list_projects", json!({}), &[], None)
        .await
        .unwrap_err();
    assert!(err.contains("'token' is not stored"), "{err}");
}

// ---------- manifests ----------

#[test]
fn github_and_gitlab_manifests_declare_the_token_secret_and_classes() {
    let gh = integration_by_name("github").unwrap();
    let m = gh.manifest();
    assert_eq!(m.kind, "integration");
    assert_eq!(m.slug, "github");
    assert_eq!(m.auth.unwrap().secret_names, vec!["token".to_string()]);
    let classes = m.tools.unwrap().classes;
    assert_eq!(classes["create_issue"], "write");
    assert_eq!(classes["search_repositories"], "read");
    assert_eq!(classes["get_file"], "read");

    let gl = integration_by_name("gitlab").unwrap();
    let m = gl.manifest();
    assert_eq!(m.slug, "gitlab");
    assert_eq!(m.auth.unwrap().secret_names, vec!["token".to_string()]);
    let classes = m.tools.unwrap().classes;
    assert_eq!(classes["create_issue"], "write");
    assert_eq!(classes["list_mrs"], "read");
}

#[tokio::test]
async fn github_api_passthrough_sends_agent_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo"))
        .and(header("authorization", format!("Bearer {FAKE_GITHUB_TOKEN}")))
        .and(header("user-agent", "guild-integration-github"))
        .and(header("accept", "application/vnd.github+json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"full_name": "owner/repo"})))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("github").unwrap();
    let config = json!({ "api_url": server.uri() });
    let out = plugin
        .execute(&config, "api", json!({"path": "/repos/owner/repo"}), &[("token".into(), FAKE_GITHUB_TOKEN.into())], None)
        .await
        .unwrap();
    assert!(out.content.contains("owner/repo"));
}

/// The connection test must respect the base_url convention (the default
/// already carries /api/v4) — a self-hosted base with the suffix, like
/// `https://gitlab.example.dev/api/v4`, must probe `{base}/user`, not
/// double the prefix.
#[tokio::test]
async fn gitlab_test_connection_tolerates_api_v4_base_suffix() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .and(header("PRIVATE-TOKEN", FAKE_GITLAB_TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "username": "acme" })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("gitlab").unwrap();
    let config = json!({ "base_url": format!("{}/api/v4", server.uri()) });
    plugin
        .test_connection(&config, &[("token".into(), FAKE_GITLAB_TOKEN.into())])
        .await
        .unwrap();
    server.verify().await;
}
