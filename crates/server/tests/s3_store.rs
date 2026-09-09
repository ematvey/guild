use guild_server::config::Config;
use guild_server::s3::ObjectStore;
use testcontainers_modules::minio::MinIO;
use testcontainers_modules::testcontainers::runners::AsyncRunner;

fn config_with(endpoint: &str) -> Config {
    let mut cfg = Config::test_config();
    cfg.s3_url = endpoint.to_string();
    cfg
}

async fn make_bucket(endpoint: &str, bucket: &str) {
    let creds =
        aws_sdk_s3::config::Credentials::new("minioadmin", "minioadmin", None, None, "test");
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
    let container = MinIO::default().start().await.expect("minio testcontainer");
    let port = container.get_host_port_ipv4(9000).await.unwrap();
    let endpoint = format!("http://127.0.0.1:{port}");
    make_bucket(&endpoint, "guild").await;
    let store = ObjectStore::connect(&config_with(&endpoint)).unwrap();

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
