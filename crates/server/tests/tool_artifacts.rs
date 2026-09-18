//! Tool-artifact store and endpoints (tool artifacts design): row CRUD with
//! org scoping, create-or-reuse idempotence, the spill primitive against the
//! real object-storage fixture, and the download/list endpoint round-trip.

#![cfg(feature = "test-support")]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::store::{Store, TestDb};
use guild_server::test_support::{full_state, insert_org_with_chat};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn artifact_uuid_is_deterministic_per_call() {
    let chat = Uuid::now_v7();
    let a = guild_server::store::tool_artifacts::artifact_uuid(chat, "call-1");
    let b = guild_server::store::tool_artifacts::artifact_uuid(chat, "call-1");
    let c = guild_server::store::tool_artifacts::artifact_uuid(chat, "call-2");
    let d = guild_server::store::tool_artifacts::artifact_uuid(Uuid::now_v7(), "call-1");
    assert_eq!(a, b, "same chat+call derives the same id (replay safety)");
    assert_ne!(a, c);
    assert_ne!(a, d);
}

/// One fresh (org, chat) on an isolated test database.
async fn org_chat(db: &TestDb) -> (Uuid, Uuid) {
    let org = Uuid::now_v7();
    let user = Uuid::now_v7();
    let chat = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 't')")
        .bind(org)
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) \
         VALUES ($1, $2, $3, 'x', 'member', 'managed')",
    )
    .bind(user)
    .bind(org)
    .bind(format!("{user}@test.local"))
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, 't')")
        .bind(chat)
        .bind(org)
        .bind(user)
        .execute(db.pool())
        .await
        .unwrap();
    (org, chat)
}

#[tokio::test]
async fn store_create_get_and_org_scoping() {
    let db: TestDb = Store::connect_test().await.unwrap();
    let (org, chat) = org_chat(&db).await;
    let (other_org, other_chat) = org_chat(&db).await;

    let id = Uuid::now_v7();
    let key = guild_server::store::tool_artifacts::object_key(org, id, "report.txt");
    let row = db
        .tool_artifacts()
        .create(
            id,
            org,
            chat,
            "report.txt",
            "text/plain",
            42,
            &key,
            "api",
            "call-1",
        )
        .await
        .unwrap();
    assert_eq!(row.filename, "report.txt");
    assert_eq!(row.tool_name, "api");
    assert_eq!(row.call_id, "call-1");

    // Own org resolves; a foreign org sees nothing.
    let got = db.tool_artifacts().get(org, id).await.unwrap();
    assert_eq!(got.id, id);
    assert!(db.tool_artifacts().get(other_org, id).await.is_err());

    let listed = db.tool_artifacts().list_for_chat(org, chat).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(db
        .tool_artifacts()
        .list_for_chat(other_org, chat)
        .await
        .unwrap()
        .is_empty());
    let _ = other_chat;
}

#[tokio::test]
async fn store_create_reuses_existing_row() {
    let db: TestDb = Store::connect_test().await.unwrap();
    let (org, chat) = org_chat(&db).await;
    let id = guild_server::store::tool_artifacts::artifact_uuid(chat, "call-9");
    let key = guild_server::store::tool_artifacts::object_key(org, id, "f.txt");
    let first = db
        .tool_artifacts()
        .create(
            id,
            org,
            chat,
            "f.txt",
            "text/plain",
            1,
            &key,
            "api",
            "call-9",
        )
        .await
        .unwrap();
    // A replay of the same tool call resolves to the same row, not a dup.
    let second = db
        .tool_artifacts()
        .create(
            id,
            org,
            chat,
            "f.txt",
            "text/plain",
            1,
            &key,
            "api",
            "call-9",
        )
        .await
        .unwrap();
    assert_eq!(first.id, second.id);
    let listed = db.tool_artifacts().list_for_chat(org, chat).await.unwrap();
    assert_eq!(listed.len(), 1);
}

#[tokio::test]
async fn spill_artifact_is_idempotent_and_prefixes_collisions() {
    let fs = full_state().await;
    let org = fs.org_id;
    let chat = fs.chat_id;

    let bytes = b"payload".to_vec();
    let first = guild_server::worker::spill::spill_artifact(
        &fs.state,
        org,
        chat,
        "call-1",
        "api",
        "result.txt",
        "text/plain; charset=utf-8",
        &bytes,
    )
    .await
    .unwrap();
    let replay = guild_server::worker::spill::spill_artifact(
        &fs.state,
        org,
        chat,
        "call-1",
        "api",
        "result.txt",
        "text/plain; charset=utf-8",
        &bytes,
    )
    .await
    .unwrap();
    assert_eq!(first.artifact_id, replay.artifact_id);
    assert_eq!(first.filename, "result.txt");
    assert_eq!(first.path, format!(".guild/artifacts/{chat}/result.txt"));
    // No duplicate row despite two spill attempts.
    assert_eq!(
        fs.db
            .tool_artifacts()
            .list_for_chat(org, chat)
            .await
            .unwrap()
            .len(),
        1
    );

    // A different call with the same filename gets an id-prefix.
    let second = guild_server::worker::spill::spill_artifact(
        &fs.state,
        org,
        chat,
        "call-2",
        "api",
        "result.txt",
        "text/plain; charset=utf-8",
        &bytes,
    )
    .await
    .unwrap();
    assert_ne!(second.artifact_id, first.artifact_id);
    assert_ne!(second.filename, "result.txt");
    assert!(second.filename.ends_with("_result.txt"));
    assert_eq!(
        fs.db
            .tool_artifacts()
            .list_for_chat(org, chat)
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn endpoints_download_and_list_round_trip() {
    let fs = full_state().await;
    let org = fs.org_id;
    let chat = fs.chat_id;
    let bytes = b"artifact-bytes".to_vec();
    let id = Uuid::now_v7();
    let key = guild_server::store::tool_artifacts::object_key(org, id, "out.bin");
    fs.state
        .objects()
        .await
        .unwrap()
        .put(&key, bytes.clone())
        .await
        .unwrap();
    fs.db
        .tool_artifacts()
        .create(
            id,
            org,
            chat,
            "out.bin",
            "application/octet-stream",
            14,
            &key,
            "api",
            "call-7",
        )
        .await
        .unwrap();

    let app = axum::Router::new()
        .merge(guild_server::http::tool_artifacts::routes())
        .with_state(fs.state.clone());

    // Download: bytes + headers.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/tool_artifacts/{id}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "application/octet-stream");
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], &bytes[..]);

    // List for the chat: the row is there.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{chat}/tool_artifacts"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let rows = body.as_array().expect("array of rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["filename"], "out.bin");
    assert_eq!(rows[0]["id"], id.to_string());
    assert_eq!(rows[0]["tool_name"], "api");

    // A foreign org's artifact 404s (org-scoped read).
    let other_chat = insert_org_with_chat(&fs.db).await;
    let other_org: Uuid = sqlx::query_scalar("SELECT org_id FROM chats WHERE id = $1")
        .bind(other_chat)
        .fetch_one(fs.db.pool())
        .await
        .unwrap();
    let foreign_id = Uuid::now_v7();
    let foreign_key =
        guild_server::store::tool_artifacts::object_key(other_org, foreign_id, "foreign.bin");
    fs.db
        .tool_artifacts()
        .create(
            foreign_id,
            other_org,
            other_chat,
            "foreign.bin",
            "text/plain",
            1,
            &foreign_key,
            "api",
            "call-x",
        )
        .await
        .unwrap();
    let res = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/tool_artifacts/{foreign_id}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}
