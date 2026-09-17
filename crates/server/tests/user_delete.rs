//! Admin delete_user: must succeed for a user with owned rows (sessions,
//! chats, routines) and keep the org's last admin safe.

use guild_server::store::{Store, TestDb};
use uuid::Uuid;

#[tokio::test]
async fn delete_user_cascades_owned_rows() {
    let db: TestDb = Store::connect_test().await.unwrap();
    let store = &db.store;
    let _ = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let admin = store
        .identity()
        .find_by_email_any("a@b.c")
        .await
        .unwrap()
        .unwrap();
    let member = store
        .identity()
        .create_user(admin.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();

    let (_sid, _token) = store.identity().create_session(member.id).await.unwrap();
    let chat = store
        .chats()
        .create_chat(admin.org_id, member.id, Some("owned"), None)
        .await
        .unwrap();

    // last admin refuses
    let err = store
        .identity()
        .delete_user(admin.org_id, admin.id)
        .await
        .unwrap_err();
    assert_eq!(err.code, "last_admin");

    // member with sessions + chats deletes cleanly
    store
        .identity()
        .delete_user(admin.org_id, member.id)
        .await
        .unwrap();

    let chats: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chats WHERE id = $1")
        .bind(chat.id)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(chats, 0, "owned chat must be gone");
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
        .bind(member.id)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 0, "owned sessions must be gone");

    // a second admin can be deleted; routines attributed to them survive
    // with created_by nulled
    let admin2 = store
        .identity()
        .create_user(admin.org_id, "a2@b.c", "hunter226", "admin")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO routines (id, org_id, created_by, slug, name, trigger_kind, prompt, model, webhook_token_hash) \
         VALUES ($1, $2, $3, 'r1', 'R1', 'interval', '{}', 'm', 'tok')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(admin.org_id)
    .bind(admin2.id)
    .execute(store.pool())
    .await
    .unwrap();
    store
        .identity()
        .delete_user(admin.org_id, admin2.id)
        .await
        .unwrap();
    let created_by: Option<Uuid> =
        sqlx::query_scalar("SELECT created_by FROM routines WHERE org_id = $1 AND slug = 'r1'")
            .bind(admin.org_id)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(created_by, None, "routine survives with created_by nulled");
}
