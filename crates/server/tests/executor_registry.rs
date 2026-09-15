//! Executor registry liveness semantics: the heartbeat upserts, so a
//! reconnecting app re-registers without a fresh stream connect, and a
//! stream drop never unregisters a heartbeating app — only staleness
//! (TTL expiry) does.

use guild_server::state::EXECUTOR_TTL_SECS;
use guild_server::test_support::test_state;

#[tokio::test]
async fn heartbeat_registers_unknown_machine() {
    let state = test_state();
    let user = uuid::Uuid::new_v4();
    let org = uuid::Uuid::new_v4();
    let mid = "m-upsert-1";
    // Before any registration the machine is unknown.
    assert!(!state.machine_connected(mid));
    // A heartbeat alone registers it (the old touch-only semantics no-op'd
    // here, which stranded tools behind a dead stream — see the
    // single-process spec).
    assert!(state.executor_touch(mid, user, org, "WORKSTATION"));
    assert!(state.machine_connected(mid));
    assert_eq!(state.machine_label(mid).as_deref(), Some("WORKSTATION"));
    // A nameless heartbeat keeps the known label.
    assert!(state.executor_touch(mid, user, org, ""));
    assert_eq!(state.machine_label(mid).as_deref(), Some("WORKSTATION"));
    // A named heartbeat updates the label.
    assert!(state.executor_touch(mid, user, org, "WORKSTATION2"));
    assert_eq!(state.machine_label(mid).as_deref(), Some("WORKSTATION2"));
}

#[tokio::test]
async fn stream_drop_keeps_the_entry_and_ttl_expires_it() {
    let state = test_state();
    let user = uuid::Uuid::new_v4();
    let org = uuid::Uuid::new_v4();
    let mid = "m-upsert-2";
    let guard = state.executor_acquire(mid, &test_user(user, org), "WORKSTATION");
    assert!(state.machine_connected(mid));
    // Stream body dropped: the guard is a no-op — the link stream flaps
    // behind proxies (Cloudflare kills/restarts SSE), and the desktop
    // heartbeats independently of the stream, so a flap must not take the
    // machine offline.
    drop(guard);
    assert!(state.machine_connected(mid));
    // Heartbeats keep it fresh.
    assert!(state.executor_touch(mid, user, org, "WORKSTATION"));
    assert!(state.machine_connected(mid));
    // Only staleness (the app actually stopped heartbeating) marks it
    // offline.
    state
        .executors
        .lock()
        .unwrap()
        .get_mut(mid)
        .unwrap()
        .last_seen
        .store(0, std::sync::atomic::Ordering::Relaxed);
    assert!(!state.machine_connected(mid));
    assert!(EXECUTOR_TTL_SECS > 0);
}

#[tokio::test]
async fn machines_of_user_tracks_ownership() {
    let state = test_state();
    let user = uuid::Uuid::new_v4();
    let org = uuid::Uuid::new_v4();
    let mid = "m-upsert-3";
    assert!(state.executor_touch(mid, user, org, "A"));
    assert_eq!(
        state.machines_of_user(user),
        vec![(mid.to_string(), "A".to_string())]
    );
}

fn test_user(user_id: uuid::Uuid, org_id: uuid::Uuid) -> guild_server::store::identity::UserRow {
    guild_server::store::identity::UserRow {
        id: user_id,
        org_id,
        email: "t@t".into(),
        role: "member".into(),
        identity_type: "managed".into(),
        display_name: None,
        avatar_url: None,
    }
}
