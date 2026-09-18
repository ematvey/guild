//! Artifact plumbing for the local engine (tool-artifacts spec): the
//! cloud-backed fetcher, the registry materialization hooks, and the
//! background prefetch paths. Files materialize under the chat's project
//! workdir at `.guild/artifacts/<chat_id>/<filename>` and live
//! indefinitely (no eviction).

use crate::cloud::{CloudClient, CloudError};
use async_trait::async_trait;
use guild_core::tools::artifacts::{
    self, ArtifactFetcher, ArtifactIndex, ArtifactPath,
};
use protocol::api::ThreadEvent;
use std::path::PathBuf;
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
        self.cloud
            .thread_events(chat_id)
            .await
            .map_err(cloud_err)
    }
}

/// Registry hooks for one engine: the process-shared path→id index plus
/// the cloud fetch source.
pub fn registry_hooks(cloud: CloudClient, index: Arc<ArtifactIndex>) -> Arc<artifacts::ArtifactHooks> {
    Arc::new(artifacts::ArtifactHooks {
        index,
        fetcher: Arc::new(CloudArtifacts { cloud }),
    })
}

/// Materializes one artifact and dtrace-logs the outcome (prefetch is
/// fire-and-forget: failures never surface to a turn).
async fn prefetch_one(
    workdir: &std::path::Path,
    artifact: &ArtifactPath,
    index: &ArtifactIndex,
    fetcher: &dyn ArtifactFetcher,
) {
    match artifacts::materialize(workdir, artifact, index, fetcher).await {
        Ok(p) => crate::dtrace::dtrace(&format!("artifact prefetched: {}", p.display())),
        Err(e) => crate::dtrace::dtrace(&format!(
            "artifact prefetch failed (chat {}): {e}",
            artifact.chat_id
        )),
    }
}

/// Spawns background materialization for artifacts named in a server tool
/// result's pointer text arriving on the live completion stream
/// (`ToolCompleted` content carries the relative `.guild/artifacts/…`
/// path). Ids resolve through the index, rebuilding it from the chat's
/// thread log when needed.
pub fn spawn_prefetch_on_content(
    cloud: CloudClient,
    index: Arc<ArtifactIndex>,
    workdir: PathBuf,
    content: &str,
) {
    let found = artifacts::scan_text(&workdir, content);
    if found.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let fetcher = CloudArtifacts { cloud };
        for artifact in found {
            prefetch_one(&workdir, &artifact, &index, &fetcher).await;
        }
    });
}

/// Spawns background work that rebuilds the path→id index from the chat's
/// thread log and materializes every artifact file missing on disk — run at
/// agent start so the model's first read of an older artifact is local.
pub fn spawn_thread_sync_prefetch(
    cloud: CloudClient,
    index: Arc<ArtifactIndex>,
    workdir: PathBuf,
    chat_id: Uuid,
) {
    tokio::spawn(async move {
        let fetcher = CloudArtifacts { cloud };
        let events = match fetcher.thread_events(chat_id).await {
            Ok(e) => e,
            Err(e) => {
                crate::dtrace::dtrace(&format!(
                    "artifact index sync failed (chat {chat_id}): {e}"
                ));
                return;
            }
        };
        for ev in &events {
            if let Some(artifact) = index.record_thread_event(chat_id, ev) {
                prefetch_one(&workdir, &artifact, &index, &fetcher).await;
            }
        }
    });
}
