//! Migration runner: idempotent, advisory-locked, checksummed (store/mod.rs).

use guild_server::store::Store;
use guild_server::store::TestDb;

#[tokio::test]
async fn migrations_apply_once_and_detect_drift() {
    let db: TestDb = Store::connect_test().await.unwrap();

    // A second connect on the same database must no-op, not double-apply.
    Store::connect(&db.url).await.unwrap();
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM schema_history ORDER BY name")
        .fetch_all(db.store.pool())
        .await
        .unwrap();
    assert_eq!(names.len(), 39, "every migration recorded exactly once");
    // checksums recorded for all
    let unhashed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_history WHERE content_hash IS NULL")
        .fetch_one(db.store.pool())
        .await
        .unwrap();
    assert_eq!(unhashed, 0);

    // Tampered checksum (edited migration file) must error on next boot.
    sqlx::query("UPDATE schema_history SET content_hash = 'deadbeef' WHERE name = '0001_identity'")
        .execute(db.store.pool())
        .await
        .unwrap();
    let err = Store::connect(&db.url).await.err().expect("drift must fail");
    assert!(err.to_string().contains("drifted"), "{err}");
}

#[tokio::test]
async fn concurrent_boots_do_not_double_apply() {
    let db: TestDb = Store::connect_test().await.unwrap();
    // Two connects racing on the same fresh database.
    let url = db.url.clone();
    let (a, b) = tokio::join!(Store::connect(&url), Store::connect(&url));
    a.unwrap();
    b.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_history")
        .fetch_one(db.store.pool())
        .await
        .unwrap();
    assert_eq!(n, 39, "no double-application under concurrent boots");
}
