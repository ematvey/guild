use guild_server::config::Config;
use guild_server::s3::ObjectStore;
use uuid::Uuid;

/// Object storage tests run against the neutral host rustfs (:9950, see
/// docs/deploy-nuances.md) — no testcontainer. Each test gets its own bucket
/// so runs never collide on the shared server. Override with GUILD_TEST_S3_URL
/// / GUILD_TEST_S3_ACCESS_KEY_ID / GUILD_TEST_S3_SECRET_ACCESS_KEY.
fn test_s3_env() -> (String, String, String) {
    (
        std::env::var("GUILD_TEST_S3_URL").unwrap_or_else(|_| "http://127.0.0.1:9950".into()),
        std::env::var("GUILD_TEST_S3_ACCESS_KEY_ID").unwrap_or_else(|_| "rustfsadmin".into()),
        std::env::var("GUILD_TEST_S3_SECRET_ACCESS_KEY").unwrap_or_else(|_| "rustfsadmin".into()),
    )
}

fn config_with(endpoint: &str, bucket: &str, ak: &str, sk: &str) -> Config {
    let mut cfg = Config::test_config();
    cfg.s3_url = endpoint.to_string();
    cfg.s3_bucket = bucket.to_string();
    cfg.s3_access_key_id = ak.to_string();
    cfg.s3_secret_access_key = sk.to_string();
    cfg
}

async fn make_bucket(endpoint: &str, bucket: &str, ak: &str, sk: &str) {
    let creds = aws_sdk_s3::config::Credentials::new(ak, sk, None, None, "test");
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .credentials_provider(creds)
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .build();
    let client = aws_sdk_s3::Client::from_conf(conf);
    client.create_bucket().bucket(bucket).send().await.unwrap();
}

#[tokio::test]
async fn put_get_delete_roundtrip() {
    let (endpoint, ak, sk) = test_s3_env();
    let bucket = format!("t{}", Uuid::now_v7().simple());
    make_bucket(&endpoint, &bucket, &ak, &sk).await;
    let store = ObjectStore::connect(&config_with(&endpoint, &bucket, &ak, &sk)).unwrap();

    let key = "test/roundtrip.bin";
    store.put(key, b"hello bundle".to_vec()).await.unwrap();
    let got = store.get(key).await.unwrap();
    assert_eq!(got, b"hello bundle");

    // overwrite works (republish semantics)
    store.put(key, b"v2".to_vec()).await.unwrap();
    assert_eq!(store.get(key).await.unwrap(), b"v2");

    store.delete(key).await.unwrap();
    assert!(store.get(key).await.is_err());
}
