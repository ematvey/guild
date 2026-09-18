//! The auth-state transition table (auth_state.rs): login → identify →
//! sign-out → re-login → pair. Every transition must apply the in-memory
//! change, persist token.json exactly once, and publish the machine-link
//! config exactly once — `AuthState::transition` is the only mutation path.

use guild_app_server::auth_state::{AuthChange, AuthState};
use guild_app_server::cloud::CloudClient;
use guild_app_server::session_store::{self, StoredSession};
use serde_json::json;
use tokio::sync::watch;

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

#[tokio::test]
async fn login_identify_signout_relogin_pair() {
    let server = fake_cloud().await;
    let base_url = server.uri();

    let store = std::env::temp_dir().join(format!(
        "guild-auth-state-{}-{}.json",
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    ));
    let (link_tx, mut link_rx) = watch::channel(None);
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
            &link_tx,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "login publishes");
    assert!(link_rx.borrow_and_update().is_none(), "no machine id yet");
    assert_eq!(state.email(), Some("a@b.c"));
    let stored = stored_at(&store);
    assert_eq!(stored.token, "login-token");
    assert_eq!(stored.base_url, base_url);
    assert_eq!(stored.email.as_deref(), Some("a@b.c"));
    assert!(stored.machine_id.is_none(), "fresh login has no machine id");

    // --- 2. identify: record the machine, persist it, publish the link ---
    state
        .transition(
            AuthChange::Identify {
                machine_id: "machine-1".into(),
            },
            Some(&store),
            &link_tx,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "identify publishes");
    let cfg = link_rx.borrow_and_update().clone().expect("link config");
    assert_eq!(cfg.machine_id, "machine-1");
    assert_eq!(cfg.base_url, base_url);
    assert_eq!(cfg.token, "login-token");
    assert!(!cfg.client_id.is_empty(), "client id generated on identify");
    let stored = stored_at(&store);
    assert_eq!(stored.machine_id.as_deref(), Some("machine-1"));
    assert!(stored.client_id.is_some());

    // --- 3. sign-out: memory + store cleared, link dropped ---
    state
        .transition(AuthChange::SignOut, Some(&store), &link_tx)
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "sign-out publishes");
    assert!(link_rx.borrow_and_update().is_none(), "sign-out drops the link");
    assert!(state.cloud().is_none() && state.email().is_none());
    assert!(state.machine_id().is_none() && state.client_id().is_none());
    assert!(
        session_store::load(&store).is_none(),
        "token.json removed on sign-out"
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
            &link_tx,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap());
    link_rx.borrow_and_update();
    let stored = stored_at(&store);
    assert_eq!(stored.token, "login-token");
    assert!(stored.machine_id.is_none(), "sign-out also forgot the machine");

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
            &link_tx,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap(), "pair publishes");
    link_rx.borrow_and_update();
    let stored = stored_at(&store);
    assert_eq!(stored.token, "pair-token", "pair persisted over the login");
    assert_eq!(state.cloud().unwrap().token, "pair-token");

    std::fs::remove_file(&store).unwrap();
}

/// An identify before any login parks the link and does NOT touch the
/// store — the identity stays in memory until login adopts it.
#[tokio::test]
async fn anonymous_identify_parks_the_link_and_skips_the_store() {
    let store = std::env::temp_dir().join(format!(
        "guild-auth-anon-{}-{}.json",
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    ));
    let (link_tx, mut link_rx) = watch::channel(None);
    let mut state = AuthState::default();

    state
        .transition(
            AuthChange::Identify {
                machine_id: "machine-early".into(),
            },
            Some(&store),
            &link_tx,
        )
        .unwrap();
    assert!(link_rx.has_changed().unwrap());
    assert!(link_rx.borrow_and_update().is_none(), "no session, no link");
    assert_eq!(state.machine_id(), Some("machine-early"));
    assert!(
        session_store::load(&store).is_none(),
        "anonymous identify must not create token.json"
    );
    assert!(!store.exists(), "the store file must not even be created");

    // login adopts the parked identity — and persists it in the same step.
    let server = fake_cloud().await;
    let (token, _user) = CloudClient::login(&server.uri(), "a@b.c", "pw").await.unwrap();
    state
        .transition(
            AuthChange::Login {
                base_url: server.uri(),
                token,
                email: "a@b.c".into(),
            },
            Some(&store),
            &link_tx,
        )
        .unwrap();
    let cfg = link_rx
        .borrow_and_update()
        .clone()
        .expect("login with a parked machine id publishes the link");
    assert_eq!(cfg.machine_id, "machine-early");
    let stored = stored_at(&store);
    assert_eq!(stored.machine_id.as_deref(), Some("machine-early"));

    std::fs::remove_file(&store).unwrap();
}

fn stored_at(path: &std::path::Path) -> StoredSession {
    session_store::load(path).expect("token.json exists")
}
