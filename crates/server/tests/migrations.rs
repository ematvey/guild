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
    assert_eq!(names.len(), 48, "every migration recorded exactly once");
    // checksums recorded for all
    let unhashed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM schema_history WHERE content_hash IS NULL")
            .fetch_one(db.store.pool())
            .await
            .unwrap();
    assert_eq!(unhashed, 0);

    // Tampered checksum (edited migration file) must error on next boot.
    sqlx::query("UPDATE schema_history SET content_hash = 'deadbeef' WHERE name = '0001_identity'")
        .execute(db.store.pool())
        .await
        .unwrap();
    let err = Store::connect(&db.url)
        .await
        .err()
        .expect("drift must fail");
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
    assert_eq!(n, 48, "no double-application under concurrent boots");
}

/// Applies the embedded migration files in order with the same
/// statement-splitting rule the runner uses (comments stripped, `;` split).
/// Used by the wipe test to stage a pre-0048 database the template path
/// cannot produce (the template is always fully migrated).
async fn apply_migrations(
    admin: &sqlx::PgPool,
    db: &str,
    migrations: &[(&str, &str)],
) -> anyhow::Result<()> {
    let url = format!("{}/{}", std::env::var("GUILD_TEST_PG_URL")?, db);
    let pool = sqlx::PgPool::connect(&url).await?;
    for (_, sql) in migrations {
        let sql = sql
            .lines()
            .filter(|l| !l.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        for stmt in sql.split(';') {
            let stmt = stmt.trim();
            if stmt.is_empty() {
                continue;
            }
            sqlx::query(stmt).execute(&pool).await?;
        }
    }
    pool.close().await;
    Ok(())
}

/// The wipe migration (0048): chat-scoped data is gone, the fresh chats
/// table carries project_id (never project_dir), the wiped-but-live tables
/// come back empty and usable, and only the tool_dispatch:/approval: kv rows
/// are cleared.
#[tokio::test]
async fn wipe_migration_drops_thread_data_and_recreates_chats_on_projects() {
    let base = std::env::var("GUILD_TEST_PG_URL").expect("GUILD_TEST_PG_URL");
    let admin = sqlx::PgPool::connect(&format!("{base}/postgres")).await.unwrap();
    let db = format!("test_{}", uuid::Uuid::now_v7().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&admin)
        .await
        .unwrap();

    // Stage: everything up to and including 0046, then seed the old world.
    apply_migrations(&admin, &db, &guild_server::store::MIGRATIONS_UPTO_0046)
        .await
        .unwrap();
    let pool = sqlx::PgPool::connect(&format!("{base}/{db}")).await.unwrap();
    let org = uuid::Uuid::now_v7();
    let user = uuid::Uuid::now_v7();
    let chat = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'w')")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id, org_id, email, password_hash, role) VALUES ($1, $2, 'w@x.y', 'h', 'member')",
    )
    .bind(user)
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO chats (id, org_id, user_id, title, project_dir) VALUES ($1, $2, $3, 'old', 'C:\\old')")
        .bind(chat)
        .bind(org)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, 'user_message', '{}')")
        .bind(uuid::Uuid::now_v7())
        .bind(chat)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_reads (chat_id, user_id, last_read_event_id) VALUES ($1, $2, $3)")
        .bind(chat)
        .bind(user)
        .bind(uuid::Uuid::now_v7())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, org_id, chat_id, filename, content_type, size_bytes, object_key) \
         VALUES ($1, $2, $3, 'f.txt', 'text/plain', 1, 'k')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(org)
    .bind(chat)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_sessions (id, org_id, user_id, chat_id, workspace_name) VALUES ($1, $2, $3, $4, 'ws')",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(org)
    .bind(user)
    .bind(chat)
    .execute(&pool)
    .await
    .unwrap();
    for key in ["tool_dispatch:c1:d1", "approval:c1", "keep:me"] {
        sqlx::query("INSERT INTO server_kv (key, value) VALUES ($1, 'v')")
            .bind(key)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Apply 0047 + 0048 (the wipe) and assert the new world.
    apply_migrations(&admin, &db, &guild_server::store::MIGRATIONS_FROM_0047)
        .await
        .unwrap();

    let cols: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'chats' ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(cols.contains(&"project_id".to_string()));
    assert!(!cols.contains(&"project_dir".to_string()));

    for table in ["projects", "thread_events", "chat_reads", "attachments", "agent_sessions"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(exists, "{table} must exist after the wipe");
    }
    for table in ["chats", "thread_events", "chat_reads", "attachments", "agent_sessions"] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} must be empty after the wipe");
    }
    let kv: Vec<String> =
        sqlx::query_scalar("SELECT key FROM server_kv ORDER BY key").fetch_all(&pool).await.unwrap();
    assert_eq!(kv, vec!["keep:me".to_string()]);

    // The fresh tables are live: a new chat takes events and read markers.
    let fresh = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO chats (id, org_id, user_id, title, project_id) VALUES ($1, $2, $3, 'new', NULL)")
        .bind(fresh)
        .bind(org)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, 'user_message', '{}')")
        .bind(uuid::Uuid::now_v7())
        .bind(fresh)
        .execute(&pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM thread_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);

    pool.close().await;
    let _ = sqlx::query(&format!("DROP DATABASE {db} WITH (FORCE)"))
        .execute(&admin)
        .await;
}
