//! Pruning of expired sessions and dead pairing tokens.

use guild_server::store::{Store, TestDb};

#[tokio::test]
async fn expired_sessions_and_dead_pairing_tokens_are_pruned() {
    let db: TestDb = Store::connect_test().await.unwrap();
    let store = &db.store;
        let admin_id = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let admin = store.identity().find_by_email_any("a@b.c").await.unwrap().unwrap();

    // live + expired sessions
    let (_sid, token) = store.identity().create_session(admin_id).await.unwrap();
    sqlx::query("INSERT INTO sessions (token, user_id, expires_at) VALUES ('dead', $1, now() - interval '1 hour')")
        .bind(admin_id)
        .execute(store.pool())
        .await
        .unwrap();

    // live + dead pairing tokens
    let _t1 = store.pairing().create(admin.org_id, admin_id, 30).await.unwrap();
    sqlx::query("INSERT INTO pairing_tokens (id, org_id, user_id, secret_hash, expires_at, used_at) VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $1, 'dead-hash', now() - interval '1 hour', NULL)")
        .bind(admin_id)
        .execute(store.pool())
        .await
        .unwrap();

    let pruned_sessions = store.identity().prune_expired_sessions().await.unwrap();
    assert_eq!(pruned_sessions, 1, "only the expired session is removed");
    let pruned_tokens = store.pairing().prune_dead_tokens().await.unwrap();
    assert_eq!(pruned_tokens, 1, "only the dead pairing token is removed");

    // survivors stay valid
    assert!(store.identity().validate_session(&token).await.is_ok());
    let alive: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_tokens WHERE user_id = $1")
        .bind(admin_id)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(alive, 1);

    // second run is a no-op
    assert_eq!(store.identity().prune_expired_sessions().await.unwrap(), 0);
    assert_eq!(store.pairing().prune_dead_tokens().await.unwrap(), 0);
}
