//! Artifact plumbing for the local engine (tool-artifacts spec): the
//! cloud-backed fetcher and the registry materialization hooks the machine
//! link's dispatched tools run with. Files materialize under the chat's
//! project workdir at `.guild/artifacts/<chat_id>/<filename>` and live
//! indefinitely (no eviction).

use crate::cloud::{CloudClient, CloudError};
use async_trait::async_trait;
use guild_core::tools::artifacts::{self, ArtifactFetcher, ArtifactIndex};
use protocol::api::ThreadEvent;
use std::sync::Arc;
use uuid::Uuid;

/// Fetch source backed by the cloud API client: artifact bytes from the
/// download endpoint, thread events from the chat log.
pub struct CloudArtifacts {
    pub cloud: CloudClient,
}

fn cloud_err(e: CloudError) -> String {
    e.to_string()
}

#[async_trait]
impl ArtifactFetcher for CloudArtifacts {
    async fn fetch(&self, artifact_id: Uuid) -> Result<Vec<u8>, String> {
        self.cloud
            .fetch_tool_artifact(artifact_id)
            .await
            .map_err(cloud_err)
    }

    async fn thread_events(&self, chat_id: Uuid) -> Result<Vec<ThreadEvent>, String> {
        self.cloud.thread_events(chat_id).await.map_err(cloud_err)
    }
}

/// Registry hooks for one engine: the process-shared path→id index plus
/// the cloud fetch source.
pub fn registry_hooks(
    cloud: CloudClient,
    index: Arc<ArtifactIndex>,
) -> Arc<artifacts::ArtifactHooks> {
    Arc::new(artifacts::ArtifactHooks {
        index,
        fetcher: Arc::new(CloudArtifacts { cloud }),
    })
}
