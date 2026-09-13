//! Executor registry liveness semantics: the heartbeat upserts, so a
//! reconnecting app re-registers without a fresh stream connect, and a
//! stream drop does not permanently unregister a heartbeating app.

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
async fn stream_drop_unregisters_but_heartbeat_reregisters() {
    let state = test_state();
    let user = uuid::Uuid::new_v4();
    let org = uuid::Uuid::new_v4();
    let mid = "m-upsert-2";
    let guard = state.executor_acquire(mid, &test_user(user, org), "WORKSTATION");
    assert!(state.machine_connected(mid));
    // Stream body dropped: the guard unregisters immediately...
    drop(guard);
    assert!(!state.machine_connected(mid));
    // ...but the next heartbeat (the app process is still running) restores
    // the entry — tools are dispatched to the machine again.
    assert!(state.executor_touch(mid, user, org, "WORKSTATION"));
    assert!(state.machine_connected(mid));
    assert!(EXECUTOR_TTL_SECS > 0);
}

#[tokio::test]
async fn machines_of_user_tracks_ownership() {
    let state = test_state();
    let user = uuid::Uuid::new_v4();
    let org = uuid::Uuid::new_v4();
    let mid = "m-upsert-3";
    assert!(state.executor_touch(mid, user, org, "A"));
    assert_eq!(state.machines_of_user(user), vec![(mid.to_string(), "A".to_string())]);
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
