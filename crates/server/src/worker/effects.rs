//! Persistent claims cover the crash window before a side-effect result is journaled.

use crate::store::Store;
use serde::{de::DeserializeOwned, Serialize};

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
    store
        .kv()
        .put(&format!("{key}:result"), &serde_json::to_string(result)?)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(())
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;

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
