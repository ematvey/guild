//! S3-compatible object storage (MinIO in compose; spec §4.4/§4.9).

use crate::config::Config;
use object_store::ObjectStoreExt as _;

pub struct ObjectStore {
    store: std::sync::Arc<dyn object_store::ObjectStore>,
}

impl ObjectStore {
    pub fn connect(cfg: &Config) -> anyhow::Result<Self> {
        let store = object_store::aws::AmazonS3Builder::new()
            .with_endpoint(&cfg.s3_url)
            .with_bucket_name(&cfg.s3_bucket)
            .with_access_key_id(&cfg.s3_access_key_id)
            .with_secret_access_key(&cfg.s3_secret_access_key)
            .with_allow_http(true)
            .build()?;
        Ok(Self {
            store: std::sync::Arc::new(store),
        })
    }

    pub async fn put(&self, key: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        self.store
            .put(
                &object_store::path::Path::from(key),
                object_store::PutPayload::from(bytes),
            )
            .await?;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        let result = self.store.get(&object_store::path::Path::from(key)).await?;
        Ok(result.bytes().await?.to_vec())
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.store
            .delete(&object_store::path::Path::from(key))
            .await?;
        Ok(())
    }
}

pub type SharedObjectStore = std::sync::Arc<ObjectStore>;
