//! The auth-state transition table (auth_state.rs): login → identify →
//! sign-out → re-login → pair, plus the multi-workspace behaviors (two
//! live sessions, switch, per-workspace sign-out, restore with a dead
//! token). Every transition must apply the in-memory change, persist
//! `workspaces.json` (+ the token.json active-session mirror) and publish
//! the machine-link configs — `AuthState::transition` is the only
//! mutation path.

use guild_app_server::auth_state::{AuthChange, AuthState};
use guild_app_server::cloud::CloudClient;
use guild_app_server::machine_link::{new_registry, MachineLinkConfig};
use guild_app_server::session_store::{self, StoredSession, WorkspaceStore};
use serde_json::json;
use std::path::PathBuf;

/// Login + pair endpoints: both return a fresh token + user.
async fn fake_cloud() -> wiremock::MockServer {
    let server = wiremock::MockServer::start().await;
    let user = json!({
        "id": uuid::Uuid::now_v7(),
        "email": "a@b.c",
        "org_id": uuid::Uuid::now_v7(),
        "role": "member",
        "display_name": null,
        "avatar_url": null,
    });
    let login_body = json!({ "token": "login-token", "user": user.clone() });
    let pair_body = json!({ "token": "pair-token", "user": user });
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/v1/auth/login"))
        .respond_with(move |_: &wiremock::Request| {
            wiremock::ResponseTemplate::new(200).set_body_json(login_body.clone())
        })
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/v1/auth/pair"))
        .respond_with(move |_: &wiremock::Request| {
            wiremock::ResponseTemplate::new(200).set_body_json(pair_body.clone())
        })
        .mount(&server)
        .await;
    server
}

/// GET /api/v1/auth/me: `status` for any bearer.
async fn fake_me(status: u16) -> wiremock::MockServer {
    let server = wiremock::MockServer::start().await;
    let user = json!({
        "id": uuid::Uuid::now_v7(),
        "email": "a@b.c",
        "org_id": uuid::Uuid::now_v7(),
        "role": "member",
        "display_name": null,
        "avatar_url": null,
    });
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/api/v1/auth/me"))
        .respond_with(move |_: &wiremock::Request| {
            wiremock::ResponseTemplate::new(status).set_body_json(user.clone())
        })
        .mount(&server)
        .await;
    server
}

fn tmp_store(tag: &str) -> PathBuf {
    // Unique DIRECTORY (not filename): workspaces.json is a sibling of the
    // token path, so a unique name in a shared dir would collide.
    let dir = std::env::temp_dir().join(format!(
        "guild-auth-state-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("token.json")
}

fn workspace_store(token_path: &std::path::Path) -> WorkspaceStore {
    session_store::load_store(token_path)
}

fn mirrored(token_path: &std::path::Path) -> Option<StoredSession> {
    session_store::load(token_path)
}

#[tokio::test]
async fn login_identify_signout_relogin_pair() {
    let server = fake_cloud().await;
    let base_url = server.uri();

    let store = tmp_store("table");
    let (links, _) = new_registry();
    let mut link_rx = links.subscribe_or_create(&base_url);
    let mut state = AuthState::default();

    // --- 1. login: persist the session, publish (None — no machine yet) ---
    let (token, user) = CloudClient::login(&base_url, "a@b.c", "pw").await.unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: base_url.clone(),
                token: token.clone(),
                email: user.email.clone(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "login publishes");
    assert!(link_rx.borrow_and_update().is_none(), "no machine id yet");
    assert_eq!(state.email(), Some("a@b.c"));
    let ws = workspace_store(&store);
    assert_eq!(ws.active.as_deref(), Some(base_url.as_str()));
    assert_eq!(ws.workspaces.len(), 1);
    assert_eq!(ws.workspaces[0].token, "login-token");
    assert_eq!(ws.workspaces[0].email.as_deref(), Some("a@b.c"));
    // token.json mirrors the active session.
    assert_eq!(mirrored(&store).unwrap().token, "login-token");
    assert!(
        ws.workspaces[0].machine_id.is_none(),
        "fresh login has no machine id"
    );

    // --- 2. identify: record the machine, persist it, publish the link ---
    state
        .transition(
            AuthChange::Identify {
                machine_id: "machine-1".into(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "identify publishes");
    let cfg: MachineLinkConfig = link_rx.borrow_and_update().clone().expect("link config");
    assert_eq!(cfg.machine_id, "machine-1");
    assert_eq!(cfg.base_url, base_url);
    assert_eq!(cfg.token, "login-token");
    assert!(!cfg.client_id.is_empty(), "client id generated on identify");
    assert_eq!(
        workspace_store(&store).workspaces[0].machine_id.as_deref(),
        Some("machine-1")
    );
    assert_eq!(
        mirrored(&store).unwrap().machine_id.as_deref(),
        Some("machine-1")
    );

    // --- 3. sign-out: workspace dropped, store cleared, link torn down ---
    state
        .transition(AuthChange::SignOut, Some(&store), &links)
        .unwrap();
    assert!(
        links.subscribe(&base_url).is_none(),
        "sign-out removes the link channel"
    );
    assert!(state.cloud().is_none() && state.email().is_none());
    assert!(state.machine_id().is_none() && state.client_id().is_none());
    assert!(
        session_store::load(&store).is_none(),
        "token.json removed on sign-out"
    );
    assert!(
        workspace_store(&store).workspaces.is_empty(),
        "workspaces.json emptied on sign-out"
    );

    // --- 4. re-login: the same transition works from the empty state ---
    let (token, user) = CloudClient::login(&base_url, "a@b.c", "pw").await.unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: base_url.clone(),
                token: token.clone(),
                email: user.email.clone(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    // Fresh receiver: the sign-out removed the old channel.
    let mut link_rx = links.subscribe_or_create(&base_url);
    assert!(
        link_rx.borrow_and_update().is_none(),
        "parked until identify"
    );
    assert_eq!(mirrored(&store).unwrap().token, "login-token");
    assert!(
        workspace_store(&store).workspaces[0].machine_id.is_none(),
        "sign-out also forgot the machine"
    );

    // --- 5. pair: a redeemed session overwrites the login ---
    let code = format!("g1|{base_url}|deadbeef");
    let (pair_base, token, user) = CloudClient::pair(&code).await.unwrap();
    assert_eq!(pair_base, base_url);
    state
        .transition(
            AuthChange::Login {
                base_url,
                token: token.clone(),
                email: user.email.clone(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "pair publishes");
    // The machine identity was reset by the sign-out and not re-reported:
    // the pair parks the link (None) until the next identify.
    assert!(link_rx.borrow_and_update().is_none());
    assert_eq!(
        mirrored(&store).unwrap().token,
        "pair-token",
        "pair persisted over the login"
    );
    assert_eq!(state.cloud().unwrap().token, "pair-token");

    std::fs::remove_file(&store).unwrap();
    let _ = std::fs::remove_file(session_store::workspaces_path(&store));
}

/// An identify before any login parks the link and does NOT touch the
/// store — the identity stays in memory until login adopts it.
#[tokio::test]
async fn anonymous_identify_parks_the_link_and_skips_the_store() {
    let store = tmp_store("anon");
    let (links, _) = new_registry();
    let mut link_rx = links.subscribe_or_create("http://later");
    let mut state = AuthState::default();

    state
        .transition(
            AuthChange::Identify {
                machine_id: "machine-early".into(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    // No link config can exist: no workspace, no channel traffic — the
    // identify parked nothing because there is nothing to park.
    assert!(link_rx.borrow_and_update().is_none(), "no session, no link");
    assert_eq!(state.machine_id(), Some("machine-early"));
    assert!(
        session_store::load(&store).is_none(),
        "anonymous identify must not create token.json"
    );
    assert!(
        !store.exists() && !session_store::workspaces_path(&store).exists(),
        "neither store file may be created"
    );

    // login adopts the parked identity — and persists it in the same step.
    let server = fake_cloud().await;
    let (token, _user) = CloudClient::login(&server.uri(), "a@b.c", "pw")
        .await
        .unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: server.uri(),
                token,
                email: "a@b.c".into(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    let mut link_rx = links.subscribe_or_create(server.uri().as_str());
    let cfg = link_rx
        .borrow_and_update()
        .clone()
        .expect("login with a parked machine id publishes the link");
    assert_eq!(cfg.machine_id, "machine-early");
    assert_eq!(
        mirrored(&store).unwrap().machine_id.as_deref(),
        Some("machine-early")
    );

    std::fs::remove_file(&store).unwrap();
    let _ = std::fs::remove_file(session_store::workspaces_path(&store));
}

/// Two live sessions coexist: each keeps its own link, the active pointer
/// and token.json mirror follow login/switch, and signing one out leaves
/// the other live.
#[tokio::test]
async fn two_workspaces_stay_independent() {
    let a = fake_cloud().await;
    let b = fake_cloud().await;
    let store = tmp_store("two");
    let (links, _) = new_registry();
    let mut link_a = links.subscribe_or_create(a.uri().as_str());
    let mut link_b = links.subscribe_or_create(b.uri().as_str());
    let mut state = AuthState::default();

    // Login A, identify (A's link comes up).
    let (token, user) = CloudClient::login(a.uri().as_str(), "a@b.c", "pw")
        .await
        .unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: a.uri(),
                token,
                email: user.email,
            },
            Some(&store),
            &links,
        )
        .unwrap();
    state
        .transition(
            AuthChange::Identify {
                machine_id: "machine-1".into(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    link_a.borrow_and_update();
    assert!(link_a.borrow().is_some(), "A's link is up");

    // Login B: adopt-or-replace + activate. A's link keeps its config;
    // B's link comes up (machine identity is per-install).
    let (token, user) = CloudClient::login(b.uri().as_str(), "a@b.c", "pw")
        .await
        .unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: b.uri(),
                token,
                email: user.email,
            },
            Some(&store),
            &links,
        )
        .unwrap();
    link_b.borrow_and_update();
    assert!(link_b.borrow().is_some(), "B's link came up on login");
    assert!(link_a.borrow().is_some(), "A's link stayed up");
    assert_eq!(state.active_base(), Some(b.uri().as_str()));
    let ws = workspace_store(&store);
    assert_eq!(ws.workspaces.len(), 2);
    assert_eq!(ws.active.as_deref(), Some(b.uri().as_str()));
    assert_eq!(
        mirrored(&store).unwrap().base_url,
        b.uri(),
        "token.json mirrors the ACTIVE session"
    );

    // Switch back to A: the active pointer and the mirror move; links and
    // their configs do not change.
    let a_before = link_a.borrow().clone();
    let b_before = link_b.borrow().clone();
    state
        .transition(
            AuthChange::Switch {
                base_url: a.uri().into(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    assert_eq!(state.active_base(), Some(a.uri().as_str()));
    assert_eq!(mirrored(&store).unwrap().base_url, a.uri());
    assert_eq!(link_a.borrow().clone(), a_before, "switch changes no link");
    assert_eq!(link_b.borrow().clone(), b_before, "switch changes no link");

    // Sign out A (the active one): B becomes active, its link untouched.
    state
        .transition(AuthChange::SignOut, Some(&store), &links)
        .unwrap();
    assert!(link_a.borrow().is_none(), "A's link was torn down");
    assert!(link_b.borrow().is_some(), "B's link survived A's sign-out");
    assert_eq!(state.active_base(), Some(b.uri().as_str()));
    assert_eq!(mirrored(&store).unwrap().base_url, b.uri());
    let ws = workspace_store(&store);
    assert_eq!(ws.workspaces.len(), 1);

    // Re-adding A via login adopts-or-replaces cleanly.
    let (token, user) = CloudClient::login(a.uri().as_str(), "a@b.c", "pw")
        .await
        .unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: a.uri(),
                token,
                email: user.email,
            },
            Some(&store),
            &links,
        )
        .unwrap();
    // Per-workspace sign-out of B (non-active).
    state
        .transition(
            AuthChange::SignOutWorkspace {
                base_url: b.uri().into(),
            },
            Some(&store),
            &links,
        )
        .unwrap();
    assert!(link_b.borrow().is_none(), "B's link torn down");
    assert_eq!(state.active_base(), Some(a.uri().as_str()));

    std::fs::remove_file(&store).unwrap();
    let _ = std::fs::remove_file(session_store::workspaces_path(&store));
}

/// Switch validation: an unknown base_url and a tokenless entry both fail,
/// leaving the active pointer untouched.
#[tokio::test]
async fn switch_rejects_unknown_and_tokenless_entries() {
    let server = fake_cloud().await;
    let store = tmp_store("switch-bad");
    let (links, _) = new_registry();
    let mut state = AuthState::default();
    let (token, user) = CloudClient::login(server.uri().as_str(), "a@b.c", "pw")
        .await
        .unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: server.uri(),
                token,
                email: user.email,
            },
            Some(&store),
            &links,
        )
        .unwrap();

    let unknown = state.transition(
        AuthChange::Switch {
            base_url: "http://nowhere".into(),
        },
        Some(&store),
        &links,
    );
    assert!(unknown.is_err(), "unknown base_url rejected");

    // A tokenless entry (a dead token left the row) cannot be activated:
    // restore a store whose only row's token was already cleared.
    let tokenless_path = tmp_store("switch-tokenless");
    session_store::save_store(
        &session_store::workspaces_path(&tokenless_path),
        &WorkspaceStore {
            active: None,
            workspaces: vec![StoredSession {
                base_url: "http://dead".into(),
                token: String::new(),
                email: Some("a@b.c".into()),
                machine_id: None,
                client_id: None,
                machine_name: None,
                org_name: None,
                org_logo_url: None,
            }],
        },
    )
    .unwrap();
    let mut state = AuthState::restored_at(&tokenless_path).await.unwrap();
    let tokenless = state.transition(
        AuthChange::Switch {
            base_url: "http://dead".into(),
        },
        None,
        &links,
    );
    assert!(tokenless.is_err(), "tokenless entry rejected");
    let _ = std::fs::remove_file(&tokenless_path);
    let _ = std::fs::remove_file(session_store::workspaces_path(&tokenless_path));

    std::fs::remove_file(&store).unwrap();
    let _ = std::fs::remove_file(session_store::workspaces_path(&store));
}

/// Restore validates every entry: a live token keeps its workspace and the
/// active pointer (falling back to the live entry when the stored pointer
/// died); an unauthorized token keeps its row with the token cleared — the
/// switcher's "sign in again" case.
#[tokio::test]
async fn restore_keeps_a_dead_token_row_and_falls_back_to_the_live_one() {
    let live = fake_me(200).await;
    let dead = fake_me(401).await;
    let token_path = tmp_store("restore");
    let ws_path = session_store::workspaces_path(&token_path);
    let store = WorkspaceStore {
        active: Some(dead.uri()),
        workspaces: vec![
            StoredSession {
                base_url: dead.uri(),
                token: "dead-token".into(),
                email: Some("a@b.c".into()),
                machine_id: Some("m-1".into()),
                client_id: Some("c-1".into()),
                machine_name: Some("box".into()),
                org_name: None,
                org_logo_url: None,
            },
            StoredSession {
                base_url: live.uri(),
                token: "live-token".into(),
                email: Some("a@b.c".into()),
                machine_id: Some("m-1".into()),
                client_id: Some("c-1".into()),
                machine_name: Some("box".into()),
                org_name: Some("Live Workspace".into()),
                org_logo_url: Some("/api/v1/orgs/x/logo".into()),
            },
        ],
    };
    session_store::save_store(&ws_path, &store).unwrap();

    let state = AuthState::restored_at(&token_path).await.unwrap();
    let (active, rows) = state.workspaces();
    assert_eq!(rows.len(), 2, "the dead row stays listed");
    let dead_row = rows.iter().find(|r| r.base_url == dead.uri()).unwrap();
    assert!(!dead_row.has_token, "dead token cleared");
    assert_eq!(dead_row.email.as_deref(), Some("a@b.c"));
    let live_row = rows.iter().find(|r| r.base_url == live.uri()).unwrap();
    assert!(live_row.has_token);
    // The stored pointer (dead) falls back to the live entry.
    assert_eq!(active.as_deref(), Some(live.uri().as_str()));
    assert_eq!(
        state.machine_id(),
        Some("m-1"),
        "machine identity restored from the rows"
    );
    // The pruned store was written back; the mirror shows the live session.
    assert_eq!(mirrored(&token_path).unwrap().base_url, live.uri());
    let pruned = workspace_store(&token_path);
    assert_eq!(pruned.active.as_deref(), Some(live.uri().as_str()));
    assert!(pruned
        .workspaces
        .iter()
        .find(|r| r.base_url == dead.uri())
        .unwrap()
        .token
        .is_empty());

    std::fs::remove_file(&token_path).unwrap();
    let _ = std::fs::remove_file(&ws_path);
}

/// Login refreshes the workspace's identity (name + logo) into the state
/// and the store — the switcher shows it without touching the network.
#[tokio::test]
async fn login_refreshes_org_identity_into_the_store() {
    let server = fake_cloud().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/api/v1/org"))
        .respond_with(move |_: &wiremock::Request| {
            wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "name": "Acme Rockets",
                "logo_url": "/api/v1/orgs/x/logo",
            }))
        })
        .mount(&server)
        .await;

    let store = tmp_store("org-identity");
    let (links, _) = new_registry();
    let mut state = AuthState::default();
    let (token, user) = CloudClient::login(&server.uri(), "a@b.c", "pw")
        .await
        .unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: server.uri(),
                token,
                email: user.email,
            },
            Some(&store),
            &links,
        )
        .unwrap();
    state
        .refresh_org_identity(server.uri().as_str(), Some(&store))
        .await;

    let (_, rows) = state.workspaces();
    assert_eq!(rows[0].name.as_deref(), Some("Acme Rockets"));
    assert_eq!(rows[0].logo_url.as_deref(), Some("/api/v1/orgs/x/logo"));
    // Persisted: a fresh restore shows the identity without re-fetching.
    let row = &session_store::load_store(&store).workspaces[0];
    assert_eq!(row.org_name.as_deref(), Some("Acme Rockets"));
    assert_eq!(row.org_logo_url.as_deref(), Some("/api/v1/orgs/x/logo"));
}
