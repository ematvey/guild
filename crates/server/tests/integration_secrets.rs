use guild_server::store::integration_secrets::ResolveError;
use guild_server::store::Store;
use uuid::Uuid;

#[tokio::test]
async fn secrets_upsert_list_resolve_delete() {
    let db = Store::connect_test().await.unwrap();
    let org = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
        .bind(org)
        .execute(db.store.pool())
        .await
        .unwrap();
    // same key the test harness config uses (hex "00"*32)
    let master: [u8; 32] = [0u8; 32];

    db.integration_secrets()
        .upsert(org, "hubspot", "api_key", "sk-live-123", &master)
        .await
        .unwrap();

    // list exposes names, timestamps and masked previews, never values
    let rows = db
        .integration_secrets()
        .list(org, "hubspot", &master)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "api_key");
    assert_eq!(rows[0].masked, "••••-123");

    // resolve returns decrypted pairs
    let resolved = db
        .integration_secrets()
        .resolve(org, "hubspot", &["api_key".to_string()], &master)
        .await
        .unwrap();
    assert_eq!(
        resolved,
        vec![("api_key".to_string(), "sk-live-123".to_string())]
    );

    // resolve with an unstored declared name errors with the missing names
    let err = db
        .integration_secrets()
        .resolve(
            org,
            "hubspot",
            &["api_key".to_string(), "missing".to_string()],
            &master,
        )
        .await
        .unwrap_err();
    match err {
        ResolveError::MissingSecrets(names) => assert_eq!(names, vec!["missing".to_string()]),
        other => panic!("expected MissingSecrets, got {other:?}"),
    }

    // upsert replaces the value
    db.integration_secrets()
        .upsert(org, "hubspot", "api_key", "sk-live-456", &master)
        .await
        .unwrap();
    let resolved = db
        .integration_secrets()
        .resolve(org, "hubspot", &["api_key".to_string()], &master)
        .await
        .unwrap();
    assert_eq!(resolved[0].1, "sk-live-456");

    // delete removes the secret
    db.integration_secrets()
        .delete(org, "hubspot", "api_key")
        .await
        .unwrap();
    let rows = db
        .integration_secrets()
        .list(org, "hubspot", &master)
        .await
        .unwrap();
    assert!(rows.is_empty());
}

/// Deleting an integration must not leave its secrets behind: re-adding the
/// same slug later must start with no credentials.
#[tokio::test]
async fn integration_delete_removes_secrets() {
    let db = Store::connect_test().await.unwrap();
    let org = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
        .bind(org)
        .execute(db.store.pool())
        .await
        .unwrap();
    let master: [u8; 32] = [0u8; 32];

    let id = db
        .integrations()
        .upsert(org, "hubspot", &serde_json::json!({}), true)
        .await
        .unwrap();
    db.integration_secrets()
        .upsert(org, "hubspot", "api_key", "sk-live-123", &master)
        .await
        .unwrap();

    db.integrations().delete(org, id).await.unwrap();
    assert!(db.integrations().list(org).await.unwrap().is_empty());
    assert!(db
        .integration_secrets()
        .list(org, "hubspot", &master)
        .await
        .unwrap()
        .is_empty());

    // Re-add with the same slug: no old credentials revived.
    let id2 = db
        .integrations()
        .upsert(org, "hubspot", &serde_json::json!({}), true)
        .await
        .unwrap();
    assert_ne!(id, id2);
    assert!(db
        .integration_secrets()
        .list(org, "hubspot", &master)
        .await
        .unwrap()
        .is_empty());
}

/// Rows written before the masked column existed carry masked = ''; the
/// first listing backfills the preview from the stored value.
#[tokio::test]
async fn list_backfills_missing_masked_preview() {
    let db = Store::connect_test().await.unwrap();
    let org = Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
        .bind(org)
        .execute(db.store.pool())
        .await
        .unwrap();
    let master: [u8; 32] = [0u8; 32];

    db.integration_secrets()
        .upsert(org, "hubspot", "api_key", "sk-live-abcd1234", &master)
        .await
        .unwrap();
    sqlx::query("UPDATE integration_secrets SET masked = ''")
        .execute(db.store.pool())
        .await
        .unwrap();

    let rows = db
        .integration_secrets()
        .list(org, "hubspot", &master)
        .await
        .unwrap();
    assert_eq!(rows[0].masked, "••••1234");
}
