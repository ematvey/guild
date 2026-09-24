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
    let err =
        registry_client::install_skill(&cloud, &project, "deploy-check", None, false, "").await;
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

    let entry =
        registry_client::install_skill(&cloud, &project, "deploy-check", None, false, "a@b.c")
            .await
            .unwrap();
    assert_eq!(entry.name, "deploy-check");
    assert_eq!(entry.description, "test skill deploy-check");
    let installed = std::fs::read_to_string(&entry.path).unwrap();
    assert!(installed.contains("Do the thing."));

    // install target is the shared .agents/skills dir + provenance sidecar
    let dest = project.join(".agents/skills/deploy-check");
    assert!(dest.join("SKILL.md").is_file());
    let prov = guild_app_server::registry_client::read_sidecar(&dest).unwrap();
    assert_eq!(prov.source, "registry");
    assert_eq!(prov.version, "1.0.0");
    assert_eq!(prov.review_status, "approved");
    assert!(prov.bundle_hash.starts_with("sha256:"));

    // the installed SKILL.md is on disk where discovery (client-side now)
    // would find it
    assert!(dest.join("SKILL.md").is_file());

    // uninstall removes the registry-installed dir
    registry_client::uninstall_skill(&project, "deploy-check", false).unwrap();
    assert!(!dest.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uninstall_refuses_dirs_guild_did_not_install() {
    let project = scratch("foreign");
    let dest = project.join(".agents/skills/hand-made");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(
        dest.join("SKILL.md"),
        "---\nname: hand-made\ndescription: authored outside guild\n---\nbody",
    )
    .unwrap();
    let err = registry_client::uninstall_skill(&project, "hand-made", false);
    assert!(err.is_err(), "no sidecar → refuse");
    assert!(dest.join("SKILL.md").is_file(), "dir must survive");

    // a local-source sidecar is refused too
    guild_app_server::registry_client::write_sidecar(
        &dest,
        &guild_app_server::registry_client::SkillProvenance {
            source: "local".into(),
            slug: "hand-made".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(registry_client::uninstall_skill(&project, "hand-made", false).is_err());
    assert!(dest.join("SKILL.md").is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publish_stamps_provenance_sidecar() {
    let srv = guild_server::test_support::serve_full().await;
    let (token, _user) = CloudClient::login(&srv.base_url, "a@b.c", "hunter226")
        .await
        .unwrap();
    let cloud = CloudClient {
        base_url: srv.base_url.clone(),
        token,
    };
    let source = scratch("pubsrc");
    let skill_dir = make_skill(&source, "my-authored");
    registry_client::publish(&cloud, "skill", &skill_dir, "0.2.0")
        .await
        .unwrap();
    let prov = guild_app_server::registry_client::read_sidecar(&skill_dir).unwrap();
    assert_eq!(prov.source, "registry");
    assert!(prov.published_by_me, "author marks their own publish");
    assert_eq!(prov.slug, "my-authored");
    assert_eq!(prov.version, "0.2.0");
    assert!(prov.bundle_hash.starts_with("sha256:"));
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

/// An upgrade over an existing install replaces the whole dir: files the
/// new bundle drops must not survive from the previous version, and a
/// failed extract must not leave a mixed tree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgrading_a_skill_drops_files_removed_by_the_new_version() {
    let srv = guild_server::test_support::serve_full().await;
    let (token, user) = CloudClient::login(&srv.base_url, "a@b.c", "hunter226")
        .await
        .unwrap();
    let cloud = CloudClient {
        base_url: srv.base_url.clone(),
        token,
    };
    let source = scratch("upsrc");
    let skill_dir = make_skill(&source, "upgradable");
    std::fs::write(skill_dir.join("old-helper.txt"), "v1 only").unwrap();
    registry_client::publish(&cloud, "skill", &skill_dir, "1.0.0")
        .await
        .unwrap();

    let project = scratch("upproj");
    let store = srv.store();
    let dest = project.join(".agents/skills/upgradable");

    // admin-approve-and-install helper
    async fn approve_and_install(
        store: &guild_server::store::Store,
        org: uuid::Uuid,
        cloud: &CloudClient,
        project: &Path,
        version: &str,
    ) {
        let stored = store
            .registry()
            .get_version(org, "skill", "upgradable", version)
            .await
            .unwrap();
        store
            .registry()
            .set_review(
                org,
                "skill",
                "upgradable",
                "approved",
                Some(version),
                stored.bundle_sha256.as_deref(),
            )
            .await
            .unwrap();
        registry_client::install_skill(
            cloud,
            project,
            "upgradable",
            Some(version.into()),
            false,
            "a@b.c",
        )
        .await
        .unwrap();
    }
    approve_and_install(&store, user.org_id, &cloud, &project, "1.0.0").await;
    assert!(dest.join("old-helper.txt").is_file());
    assert_eq!(
        guild_app_server::registry_client::read_sidecar(&dest)
            .unwrap()
            .version,
        "1.0.0"
    );

    // v1.1.0 drops old-helper.txt and adds new-helper.txt
    std::fs::remove_file(skill_dir.join("old-helper.txt")).unwrap();
    std::fs::write(skill_dir.join("new-helper.txt"), "v2").unwrap();
    registry_client::publish(&cloud, "skill", &skill_dir, "1.1.0")
        .await
        .unwrap();
    approve_and_install(&store, user.org_id, &cloud, &project, "1.1.0").await;

    assert!(
        !dest.join("old-helper.txt").exists(),
        "the previous version's file must not survive the upgrade"
    );
    assert!(dest.join("new-helper.txt").is_file());
    assert_eq!(
        guild_app_server::registry_client::read_sidecar(&dest)
            .unwrap()
            .version,
        "1.1.0"
    );
}
