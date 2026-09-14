use guild_app_server::cloud::CloudClient;
use guild_app_server::registry_client;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "guild-regclient-{tag}-{}-{}",
        std::process::id(),
        AtomicU64::new(0).fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_skill(base: &Path, slug: &str) -> std::path::PathBuf {
    let dir = base.join(slug);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {slug}\ndescription: test skill {slug}\n---\nDo the thing."),
    )
    .unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publish_then_install_roundtrip() {
    let srv = guild_server::test_support::serve_full().await;
    let (token, user) = CloudClient::login(&srv.base_url, "a@b.c", "hunter226")
        .await
        .unwrap();
    let cloud = CloudClient {
        base_url: srv.base_url.clone(),
        token,
    };

    let source = scratch("src");
    let skill_dir = make_skill(&source, "deploy-check");
    let r = registry_client::publish(&cloud, "skill", &skill_dir, "1.0.0")
        .await
        .unwrap();
    assert_eq!(r.slug, "deploy-check");

    // not approved yet → member-style install rejected
    let project = scratch("proj");
    let err = registry_client::install_skill(&cloud, &project, "deploy-check", None).await;
    assert!(err.is_err(), "draft must not install");

    // admin approves via the review endpoint
    let app_state = srv.state.clone();
    let _ = app_state; // the admin path is covered by the server tests; approve directly:
    let store = srv.store();
    let stored = store
        .registry()
        .get_version(user.org_id, "skill", "deploy-check", "1.0.0")
        .await
        .unwrap();
    store
        .registry()
        .set_review(
            user.org_id,
            "skill",
            "deploy-check",
            "approved",
            Some("1.0.0"),
            stored.bundle_sha256.as_deref(),
        )
        .await
        .unwrap();

    let entry = registry_client::install_skill(&cloud, &project, "deploy-check", None)
        .await
        .unwrap();
    assert_eq!(entry.name, "deploy-check");
    assert_eq!(entry.description, "test skill deploy-check");
    let installed = std::fs::read_to_string(&entry.path).unwrap();
    assert!(installed.contains("Do the thing."));

    // skills discovery now finds it
    let found =
        guild_app_server::skills::discover(&project, &std::env::temp_dir().join("nonexistent-cfg"));
    assert!(found.iter().any(|e| e.name == "deploy-check"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_item_publishes_without_skill_md() {
    let srv = guild_server::test_support::serve_full().await;
    let (token, _user) = CloudClient::login(&srv.base_url, "a@b.c", "hunter226")
        .await
        .unwrap();
    let cloud = CloudClient {
        base_url: srv.base_url.clone(),
        token,
    };

    let source = scratch("mcpsrc");
    std::fs::create_dir_all(source.join("my-mcp")).unwrap();
    std::fs::write(source.join("my-mcp/config.json"), r#"{"command":["echo"]}"#).unwrap();
    let r = registry_client::publish(&cloud, "mcp", &source.join("my-mcp"), "0.1.0")
        .await
        .unwrap();
    assert_eq!(r.slug, "my-mcp");
}
