use guild_server::store::integration_secrets::ResolveError;
use guild_server::store::Store;
use uuid::Uuid;

#[tokio::test]
async fn secrets_upsert_list_resolve_delete() {
    let db = Store::connect_test().await.unwrap();
    let org = Uuid::now_v7();
    // same key the test harness config uses (hex "00"*32)
    let master: [u8; 32] = [0u8; 32];

    db.integration_secrets()
        .upsert(org, "hubspot", "api_key", "sk-live-123", &master)
        .await
        .unwrap();

    // list exposes names + timestamps only, never values
    let rows = db.integration_secrets().list(org, "hubspot").await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "api_key");

    // resolve returns decrypted pairs
    let resolved = db
        .integration_secrets()
        .resolve(org, "hubspot", &["api_key".to_string()], &master)
        .await
        .unwrap();
    assert_eq!(resolved, vec![("api_key".to_string(), "sk-live-123".to_string())]);

    // resolve with an unstored declared name errors with the missing names
    let err = db
        .integration_secrets()
        .resolve(org, "hubspot", &["api_key".to_string(), "missing".to_string()], &master)
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
    let rows = db.integration_secrets().list(org, "hubspot").await.unwrap();
    assert!(rows.is_empty());
}

/// Deleting an integration must not leave its secrets behind: re-adding the
/// same slug later must start with no credentials.
#[tokio::test]
async fn integration_delete_removes_secrets() {
    let db = Store::connect_test().await.unwrap();
    let org = Uuid::now_v7();
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
    assert!(
        db.integration_secrets()
            .list(org, "hubspot")
            .await
            .unwrap()
            .is_empty()
    );

    // Re-add with the same slug: no old credentials revived.
    let id2 = db
        .integrations()
        .upsert(org, "hubspot", &serde_json::json!({}), true)
        .await
        .unwrap();
    assert_ne!(id, id2);
    assert!(
        db.integration_secrets()
            .list(org, "hubspot")
            .await
            .unwrap()
            .is_empty()
    );
}
