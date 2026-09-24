//! Durable machine registry: adoption, reconnect, last_seen, and bind
//! checks against an isolated database.

#![cfg(feature = "test-support")]

use guild_server::store::machines::MachineRow;
use guild_server::store::Store;
use uuid::Uuid;

async fn org_user(db: &Store) -> (Uuid, Uuid) {
    let org = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
        .bind(org)
        .execute(db.pool())
        .await
        .unwrap();
    let email = format!("u-{}@machines.test", org.simple());
    let user = db
        .identity()
        .create_user(org, &email, "hunter226", "admin")
        .await
        .unwrap();
    (org, user.id)
}

async fn get_row(db: &Store, machine_id: &str) -> sqlx::Result<Option<MachineRow>> {
    sqlx::query_as("SELECT * FROM machines WHERE machine_id = $1")
        .bind(machine_id)
        .fetch_optional(db.pool())
        .await
}

#[tokio::test]
async fn no_fingerprint_match_inserts_a_fresh_row() {
    let db = Store::connect_test().await.unwrap();
    let (org, user) = org_user(&db).await;

    let outcome = db
        .machines()
        .upsert_connected(
            org,
            user,
            "m-new",
            Some("WORKSTATION"),
            None,
            Some(""),
            Some("11"),
            Some("0.4.0"),
            Some("127.0.0.1:5000"),
        )
        .await
        .unwrap();

    assert!(outcome.adopted_from.is_none());
    let row = outcome.row;
    assert_eq!(row.machine_id, "m-new");
    assert_eq!(row.org_id, org);
    assert_eq!(row.user_id, user);
    assert_eq!(row.label.as_deref(), Some("WORKSTATION"));
    // Empty strings are stored as NULL, never as ''.
    assert_eq!(row.hardware_fingerprint, None);
    assert_eq!(row.os, None);
    assert_eq!(row.os_version.as_deref(), Some("11"));
    assert_eq!(row.app_version.as_deref(), Some("0.4.0"));
    assert_eq!(row.last_ip.as_deref(), Some("127.0.0.1:5000"));
    assert!(row.re_paired_at.is_none());
    assert_eq!(row.first_connected_at, row.last_connected_at);

    let listed = db.machines().list_for_user(org, user).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].machine_id, "m-new");
}

#[tokio::test]
async fn fingerprint_match_adopts_the_row_and_rekeys_the_id() {
    let db = Store::connect_test().await.unwrap();
    let (org, user) = org_user(&db).await;

    db.machines()
        .upsert_connected(
            org,
            user,
            "old-id",
            Some("OLD"),
            Some("FP-1"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let project = db
        .projects()
        .create(org, user, "bound", "/workspace", "old-id")
        .await
        .unwrap();
    let chat = db
        .chats()
        .create_chat_with_machine(org, user, None, Some(project.id), Some("old-id"), None)
        .await
        .unwrap();
    let original_first = get_row(&db, "old-id")
        .await
        .unwrap()
        .unwrap()
        .first_connected_at;

    let outcome = db
        .machines()
        .upsert_connected(
            org,
            user,
            "new-id",
            Some("NEW"),
            Some("FP-1"),
            Some("Windows"),
            None,
            Some("0.4.0"),
            None,
        )
        .await
        .unwrap();

    assert_eq!(outcome.adopted_from.as_deref(), Some("old-id"));
    let row = get_row(&db, "new-id").await.unwrap().expect("re-keyed row");
    assert!(get_row(&db, "old-id").await.unwrap().is_none());
    assert_eq!(row.org_id, org);
    assert_eq!(row.user_id, user);
    // Metadata refresh does not erase what the earlier pairing reported.
    assert_eq!(row.hardware_fingerprint.as_deref(), Some("FP-1"));
    assert_eq!(row.os.as_deref(), Some("Windows"));
    assert!(row.re_paired_at.is_some(), "re-pair must be stamped");
    assert_eq!(row.first_connected_at, original_first);

    let bound: String = sqlx::query_scalar("SELECT machine_id FROM projects WHERE id = $1")
        .bind(project.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(bound, "new-id");
    let bound: String = sqlx::query_scalar("SELECT machine_id FROM chats WHERE id = $1")
        .bind(chat.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(bound, "new-id");
    assert!(db.machines().bindable("new-id", user, org).await.unwrap());
    assert!(!db.machines().bindable("old-id", user, org).await.unwrap());
    let other = db
        .identity()
        .create_user(org, "other@machines.test", "hunter226", "member")
        .await
        .unwrap();
    db.machines()
        .upsert_connected(org, other.id, "old-id", None, None, None, None, None, None)
        .await
        .unwrap();
    assert!(db
        .chats()
        .readable_by_executor(org, chat.id, &other)
        .await
        .is_err());
}

#[tokio::test]
async fn reconnect_of_a_known_machine_never_rekeys() {
    let db = Store::connect_test().await.unwrap();
    let (org, user) = org_user(&db).await;

    db.machines()
        .upsert_connected(
            org,
            user,
            "m1",
            Some("A"),
            Some("FP-2"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let first = get_row(&db, "m1").await.unwrap().unwrap();
    let outcome = db
        .machines()
        .upsert_connected(
            org,
            user,
            "m1",
            Some("B"),
            None,
            Some("Linux"),
            None,
            None,
            Some("10.0.0.9:7000"),
        )
        .await
        .unwrap();

    assert!(outcome.adopted_from.is_none());
    let row = get_row(&db, "m1").await.unwrap().unwrap();
    assert_eq!(row.first_connected_at, first.first_connected_at);
    assert!(row.re_paired_at.is_none());
    assert_eq!(row.label.as_deref(), Some("B"));
    assert_eq!(row.os.as_deref(), Some("Linux"));
    assert_eq!(
        row.hardware_fingerprint.as_deref(),
        Some("FP-2"),
        "reconnect without fingerprint must keep the stored one"
    );
    assert_eq!(row.last_ip.as_deref(), Some("10.0.0.9:7000"));
}

#[tokio::test]
async fn fingerprint_adoption_is_scoped_to_one_org() {
    let db = Store::connect_test().await.unwrap();
    let (org_a, user_a) = org_user(&db).await;
    let (org_b, user_b) = org_user(&db).await;

    db.machines()
        .upsert_connected(
            org_a,
            user_a,
            "a-desk",
            None,
            Some("FP-3"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

    // A different org pairing with the same fingerprint gets its own row.
    let outcome = db
        .machines()
        .upsert_connected(
            org_b,
            user_b,
            "b-desk",
            None,
            Some("FP-3"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert!(outcome.adopted_from.is_none());
    assert!(get_row(&db, "a-desk").await.unwrap().is_some());
    assert!(get_row(&db, "b-desk").await.unwrap().is_some());
}

#[tokio::test]
async fn cross_org_machine_id_claim_is_left_untouched() {
    let db = Store::connect_test().await.unwrap();
    let (org_a, user_a) = org_user(&db).await;
    let (org_b, user_b) = org_user(&db).await;

    db.machines()
        .upsert_connected(
            org_a,
            user_a,
            "shared-id",
            Some("A"),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let outcome = db
        .machines()
        .upsert_connected(
            org_b,
            user_b,
            "shared-id",
            Some("B"),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

    // The foreign org's row is untouched and org B gets no registration
    // (client-issued ids are untrustworthy across orgs).
    assert_eq!(outcome.row.org_id, org_a);
    assert_eq!(outcome.adopted_from, None);
    let row = get_row(&db, "shared-id").await.unwrap().unwrap();
    assert_eq!(row.org_id, org_a);
    assert_eq!(row.label.as_deref(), Some("A"));
    let listed = db.machines().list_for_user(org_b, user_b).await.unwrap();
    assert!(listed.is_empty());
}

#[tokio::test]
async fn last_seen_refreshes_the_timestamp() {
    let db = Store::connect_test().await.unwrap();
    let (org, user) = org_user(&db).await;

    db.machines()
        .upsert_connected(org, user, "m1", None, None, None, None, None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE machines SET last_seen_at = now() - interval '1 hour'")
        .execute(db.pool())
        .await
        .unwrap();
    let before = get_row(&db, "m1").await.unwrap().unwrap().last_seen_at;

    db.machines().last_seen("m1").await.unwrap();

    let after = get_row(&db, "m1").await.unwrap().unwrap().last_seen_at;
    assert!(after > before);
}

#[tokio::test]
async fn offline_known_machine_is_bindable_and_foreign_is_not() {
    let ts = guild_server::test_support::test_state_with_db().await;
    let (org, user) = org_user(&ts.db).await;
    let other_user = ts
        .db
        .identity()
        .create_user(
            org,
            &format!("o-{}@machines.test", org.simple()),
            "hunter226",
            "member",
        )
        .await
        .unwrap();

    ts.db
        .machines()
        .upsert_connected(org, user, "desk-1", None, None, None, None, None, None)
        .await
        .unwrap();

    // DB-known machine binds even with no live socket (hub stays empty).
    assert!(ts.state.machine_bindable("desk-1", user, org).await);
    // Org-wide binding still holds for a member of the same org.
    assert!(
        ts.state
            .machine_bindable("desk-1", other_user.id, org)
            .await
    );
    // Unknown machine or foreign user/org cannot bind.
    assert!(!ts.state.machine_bindable("ghost", user, org).await);
    assert!(
        !ts.state
            .machine_bindable("desk-1", Uuid::now_v7(), Uuid::now_v7())
            .await
    );
}

#[tokio::test]
async fn cross_user_reconnect_of_a_known_machine_id_is_refused() {
    let db = Store::connect_test().await.unwrap();
    let (org, user_a) = org_user(&db).await;
    let email = format!("b-{}@machines.test", org.simple());
    let user_b = db
        .identity()
        .create_user(org, &email, "hunter226", "member")
        .await
        .unwrap()
        .id;

    db.machines()
        .upsert_connected(org, user_a, "desk", Some("A"), None, None, None, None, None)
        .await
        .unwrap();

    // Same org, different user: the row's owner may reconnect, nobody else.
    let err = db
        .machines()
        .upsert_connected(org, user_b, "desk", Some("B"), None, None, None, None, None)
        .await
        .map(|outcome| outcome.adopted_from)
        .expect_err("cross-user reconnect must be refused");
    assert_eq!(err.status, axum::http::StatusCode::FORBIDDEN);

    let row = get_row(&db, "desk").await.unwrap().unwrap();
    assert_eq!(row.user_id, user_a, "row ownership unchanged");
    assert_eq!(row.label.as_deref(), Some("A"), "metadata untouched");

    // The owner reconnecting is still fine.
    let outcome = db
        .machines()
        .upsert_connected(
            org,
            user_a,
            "desk",
            Some("A2"),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert!(outcome.adopted_from.is_none());
    assert_eq!(outcome.row.label.as_deref(), Some("A2"));
}

#[tokio::test]
async fn cross_user_fingerprint_is_never_adopted() {
    let db = Store::connect_test().await.unwrap();
    let (org, user_a) = org_user(&db).await;
    let email = format!("b-{}@machines.test", org.simple());
    let user_b = db
        .identity()
        .create_user(org, &email, "hunter226", "member")
        .await
        .unwrap()
        .id;

    db.machines()
        .upsert_connected(
            org,
            user_a,
            "a-desk",
            None,
            Some("FP-X"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

    // user_b presenting user_a's fingerprint (registry metadata any member
    // can read) gets a fresh row, never the re-key of user_a's machine.
    let outcome = db
        .machines()
        .upsert_connected(
            org,
            user_b,
            "b-rogue",
            None,
            Some("FP-X"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert!(outcome.adopted_from.is_none(), "no adoption across users");
    assert_eq!(outcome.row.user_id, user_b);
    let a_row = get_row(&db, "a-desk").await.unwrap().unwrap();
    assert_eq!(a_row.user_id, user_a, "user_a's row untouched");
    assert_eq!(a_row.machine_id, "a-desk", "no re-key happened");
}
