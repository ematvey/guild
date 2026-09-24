//! Persistent claims cover the crash window before a side-effect result is journaled.

use crate::store::Store;
use serde::{de::DeserializeOwned, Serialize};

/// Claim namespaces (key prefixes in server_kv). Each invocation writes its
/// own keys, so they are pruned once the invocation can no longer replay.
pub(crate) const CLAIM_PREFIXES: &[&str] = &[
    "plugin_effect:",
    "routine_effect:",
    "tool_dispatch:",
];

/// Claims outlive every replay window (Restate's own journal/idempotency
/// retention is shorter); the hourly loop retires anything older.
pub(crate) const CLAIM_RETENTION_DAYS: i32 = 30;

/// A stored result larger than this is not persisted: the stored claim then
/// resolves to `Unknown` on replay ("outcome unknown"), which is the honest
/// report for a result that cannot be represented in the claim store.
pub(crate) const MAX_RESULT_BYTES: usize = 256 * 1024;

pub(crate) enum Claim<T> {
    Execute,
    Completed(T),
    Unknown,
}

pub(crate) async fn claim<T: DeserializeOwned>(
    store: &Store,
    key: &str,
) -> anyhow::Result<Claim<T>> {
    if store
        .kv()
        .claim(key, "started")
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?
    {
        return Ok(Claim::Execute);
    }
    Ok(
        match store
            .kv()
            .get(&format!("{key}:result"))
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?
        {
            Some(value) => match serde_json::from_str(&value) {
                Ok(result) => Claim::Completed(result),
                Err(_) => Claim::Unknown,
            },
            None => Claim::Unknown,
        },
    )
}

pub(crate) async fn complete<T: Serialize>(
    store: &Store,
    key: &str,
    result: &T,
) -> anyhow::Result<()> {
    let value = serde_json::to_string(result)?;
    if value.len() > MAX_RESULT_BYTES {
        tracing::warn!(
            key,
            bytes = value.len(),
            "effect result over claim bound; replay reports unknown outcome"
        );
        return Ok(());
    }
    store
        .kv()
        .put(&format!("{key}:result"), &value)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(())
}

/// Retires claim entries (and their stored results) older than the
/// retention bound. Called from the hourly maintenance loop.
pub(crate) async fn prune(store: &Store) -> anyhow::Result<u64> {
    store
        .kv()
        .prune_older_than(CLAIM_PREFIXES, CLAIM_RETENTION_DAYS)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_effect_claims_are_pruned_and_other_kv_survives() {
        let fixture = crate::test_support::test_state_with_db().await;
        let store = fixture.store();
        claim::<String>(&store, "plugin_effect:inv-1")
            .await
            .unwrap();
        complete(&store, "plugin_effect:inv-1", &"result")
            .await
            .unwrap();
        claim::<String>(&store, "routine_effect:inv-2:0:0")
            .await
            .unwrap();
        // Client tool dispatches claim the same store, one row per tool call
        // (1:1 with chat history); they retire on the same bound.
        store
            .kv()
            .put("tool_dispatch:chat-1:dispatch-1", "conn")
            .await
            .unwrap();
        store
            .kv()
            .put("release_signing_seed", "keep")
            .await
            .unwrap();
        sqlx::query("UPDATE server_kv SET updated_at = now() - make_interval(days => $1)")
            .bind(CLAIM_RETENTION_DAYS + 1)
            .execute(store.pool())
            .await
            .unwrap();
        let pruned = prune(&store).await.unwrap();
        assert_eq!(pruned, 4);
        assert!(store
            .kv()
            .get("tool_dispatch:chat-1:dispatch-1")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .kv()
            .get("plugin_effect:inv-1:result")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .kv()
            .get("routine_effect:inv-2:0:0")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .kv()
                .get("release_signing_seed")
                .await
                .unwrap()
                .as_deref(),
            Some("keep")
        );
        // A pruned claim is free again: a fresh claim executes.
        assert!(matches!(
            claim::<String>(&store, "plugin_effect:inv-1")
                .await
                .unwrap(),
            Claim::Execute
        ));
    }

    #[tokio::test]
    async fn concurrent_and_crashed_execution_never_gets_a_second_claim() {
        let fixture = crate::test_support::test_state_with_db().await;
        let store = fixture.store();
        let (a, b) = tokio::join!(
            claim::<String>(&store, "effect:one"),
            claim::<String>(&store, "effect:one")
        );
        assert!(matches!(
            (&a, &b),
            (Ok(Claim::Execute), Ok(Claim::Unknown)) | (Ok(Claim::Unknown), Ok(Claim::Execute))
        ));
        // No result was persisted: a new process must expose ambiguity, not repeat the action.
        let reopened = fixture.store();
        assert!(matches!(
            claim::<String>(&reopened, "effect:one").await.unwrap(),
            Claim::Unknown
        ));
        complete(&store, "effect:one", &"original result")
            .await
            .unwrap();
        assert!(
            matches!(claim::<String>(&reopened, "effect:one").await.unwrap(), Claim::Completed(result) if result == "original result")
        );
        assert!(matches!(
            claim::<String>(&store, "effect:two").await.unwrap(),
            Claim::Execute
        ));
    }
}
