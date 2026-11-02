use guild_app_server::cloud::CloudClient;
use guild_app_server::registry_client;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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

/// Hand-rolled mock of the registry REST surface the client speaks: skill
/// bundles uploaded by publish are stored and served back on the bundle
/// endpoint, and the item listing carries the review gate. Approval flow on
/// the server side is owned and tested there.
#[derive(Default)]
struct RegistryState {
    bundles: HashMap<(String, String), Vec<u8>>,
    slug: String,
    latest_version: String,
    review_status: String,
}

async fn spawn_mock_registry(state: Arc<Mutex<RegistryState>>) -> wiremock::MockServer {
    let server = wiremock::MockServer::start().await;
    // publish: POST /api/v1/registry/{kind}?slug=&version= (gzip body)
    let st = state.clone();
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path_regex(
            "/api/v1/registry/(skill|mcp)",
        ))
        .respond_with(move |req: &wiremock::Request| {
            let mut query: HashMap<String, String> = req
                .url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            let slug = query.remove("slug").unwrap_or_default();
            let version = query.remove("version").unwrap_or_default();
            let mut s = st.lock().unwrap();
            s.bundles
                .insert((slug.clone(), version.clone()), req.body.clone());
            s.slug = slug.clone();
            s.latest_version = version.clone();
            wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"slug": slug, "version": version}))
        })
        .mount(&server)
        .await;
    // item listing: the install gate (review_status + latest_version)
    let st = state.clone();
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/api/v1/registry/skill"))
        .respond_with(move |_: &wiremock::Request| {
            let s = st.lock().unwrap();
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "slug": s.slug,
                    "review_status": s.review_status,
                    "latest_version": s.latest_version,
                }]
            }))
        })
        .mount(&server)
        .await;
    // bundle download: GET /api/v1/registry/skill/{slug}/{version}/bundle
    let st = state;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path_regex(
            "/api/v1/registry/skill/[^/]+/[^/]+/bundle",
        ))
        .respond_with(move |req: &wiremock::Request| {
            let segments: Vec<&str> = req.url.path().split('/').collect();
            let slug = segments[segments.len() - 3].to_string();
            let version = segments[segments.len() - 2].to_string();
            match st.lock().unwrap().bundles.get(&(slug, version)) {
                Some(bytes) => wiremock::ResponseTemplate::new(200)
                    .set_body_bytes(bytes.clone())
                    .insert_header("content-type", "application/gzip"),
                None => wiremock::ResponseTemplate::new(404),
            }
        })
        .mount(&server)
        .await;
    server
}

fn mock_cloud(base_url: &str) -> CloudClient {
    CloudClient {
        base_url: base_url.to_string(),
        token: "t".into(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publish_then_install_roundtrip() {
    let state = Arc::new(Mutex::new(RegistryState::default()));
    let server = spawn_mock_registry(state.clone()).await;
    let cloud = mock_cloud(&server.uri());

    let source = scratch("src");
    let skill_dir = make_skill(&source, "deploy-check");
    let r = registry_client::publish(&cloud, "skill", &skill_dir, "1.0.0")
        .await
        .unwrap();
    assert_eq!(r.slug, "deploy-check");

    // not approved yet → member-style install rejected
    let project = scratch("proj");
    let err =
        registry_client::install_skill(&cloud, Some(&project), "deploy-check", None, false, "")
            .await;
    assert!(err.is_err(), "draft must not install");

    // approve (the server-side review flow is owned and tested there)
    state.lock().unwrap().review_status = "approved".into();

    let entry = registry_client::install_skill(
        &cloud,
        Some(&project),
        "deploy-check",
        None,
        false,
        "a@b.c",
    )
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
    registry_client::uninstall_skill(Some(&project), "deploy-check", false).unwrap();
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
    let err = registry_client::uninstall_skill(Some(&project), "hand-made", false);
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
    assert!(registry_client::uninstall_skill(Some(&project), "hand-made", false).is_err());
    assert!(dest.join("SKILL.md").is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publish_stamps_provenance_sidecar() {
    let state = Arc::new(Mutex::new(RegistryState::default()));
    let server = spawn_mock_registry(state).await;
    let cloud = mock_cloud(&server.uri());
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
    let state = Arc::new(Mutex::new(RegistryState::default()));
    let server = spawn_mock_registry(state).await;
    let cloud = mock_cloud(&server.uri());

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
    let state = Arc::new(Mutex::new(RegistryState::default()));
    let server = spawn_mock_registry(state.clone()).await;
    let cloud = mock_cloud(&server.uri());
    let source = scratch("upsrc");
    let skill_dir = make_skill(&source, "upgradable");
    std::fs::write(skill_dir.join("old-helper.txt"), "v1 only").unwrap();
    registry_client::publish(&cloud, "skill", &skill_dir, "1.0.0")
        .await
        .unwrap();

    let project = scratch("upproj");
    let dest = project.join(".agents/skills/upgradable");

    // approve once; both installs are pinned versions
    state.lock().unwrap().review_status = "approved".into();
    registry_client::install_skill(
        &cloud,
        Some(&project),
        "upgradable",
        Some("1.0.0"),
        false,
        "a@b.c",
    )
    .await
    .unwrap();
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
    registry_client::install_skill(
        &cloud,
        Some(&project),
        "upgradable",
        Some("1.1.0"),
        false,
        "a@b.c",
    )
    .await
    .unwrap();

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

/// A failed upgrade extract leaves no staging dir behind (scanners would
/// index it as a skill) and keeps the previous install intact.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_upgrade_extract_leaves_no_staging_dir() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path(
            "/api/v1/registry/skill/broken/2.0.0/bundle",
        ))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(b"not a bundle".to_vec()))
        .mount(&server)
        .await;
    let cloud = CloudClient {
        base_url: server.uri(),
        token: "t".into(),
    };
    let project = scratch("brokenup");
    let skills = project.join(".agents/skills");
    let dest = make_skill(&skills, "broken");
    let err =
        registry_client::install_skill(&cloud, Some(&project), "broken", Some("2.0.0"), false, "")
            .await;
    assert!(err.is_err());
    assert!(
        dest.join("SKILL.md").is_file(),
        "the previous install survives"
    );
    let leftovers: Vec<_> = std::fs::read_dir(&skills)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "staging leaked: {leftovers:?}");
}
