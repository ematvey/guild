//! Persistent claims cover the crash window before a side-effect result is journaled.

use crate::store::Store;
use serde::{de::DeserializeOwned, Serialize};

/// Claim namespaces (key prefixes in server_kv). Each invocation writes its
/// own keys, so they are pruned once the invocation can no longer replay.
pub(crate) const CLAIM_PREFIXES: &[&str] = &[
    "plugin_effect:",
    "routine_effect:",
    "tool_dispatch:",
    "server_effect:",
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
/// retention bound — but ONLY when the owning invocation is durably
/// terminal. Called from the hourly maintenance loop.
///
/// The guarantee: a claim exists to stop a replayed invocation from
/// re-executing a side effect whose result was never journaled. Age alone
/// proves nothing — an invocation that crashed mid-effect and whose worker
/// version was unavailable for months can still resume and replay. So a
/// candidate claim is pruned only when its owning invocation id (recorded
/// in the key and looked up in `turn_commands` / `routine_runs`) has
/// reached a terminal status (`completed`/`failed`/`cancelled` for turn
/// commands, `succeeded`/`failed` for routine runs). `tool_dispatch:` keys
/// are keyed by chat/dispatch: a ChatRunner invocation can replay a
/// dispatch only while one of the chat's turn commands is unfinished (or
/// the chat is generating), so an idle chat's aged dispatch claims are
/// retired. Claims with no discoverable owner are kept permanently as
/// tombstones: repeated-action safety beats storage.
pub(crate) async fn prune(store: &Store) -> anyhow::Result<u64> {
    let mut query = String::from(
        "SELECT key FROM server_kv WHERE updated_at < now() - make_interval(days => $1) AND (",
    );
    for i in 0..CLAIM_PREFIXES.len() {
        if i > 0 {
            query.push_str(" OR ");
        }
        // ESCAPE keeps `_`/`%` in a prefix literal instead of wildcard
        // semantics (`plugin_effect:` must not match `pluginXeffect:…`).
        query.push_str(&format!("key LIKE ${} || '%' ESCAPE '\\'", i + 2));
    }
    query.push(')');
    let mut bound = sqlx::query_as::<_, (String,)>(&query).bind(CLAIM_RETENTION_DAYS);
    for prefix in CLAIM_PREFIXES {
        let escaped = prefix
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        bound = bound.bind(escaped.to_string());
    }
    let candidates = bound.fetch_all(store.pool()).await?;

    let mut pruned: u64 = 0;
    for (key,) in candidates {
        let terminal: bool = match owner(&key) {
            None => continue, // tombstone: no owner is discoverable
            Some(ClaimOwner::Invocation(invocation)) => {
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM turn_commands WHERE invocation_id = $1 \
                 AND status IN ('completed','failed','cancelled')) \
                 OR EXISTS(SELECT 1 FROM routine_runs WHERE invocation_id = $1 \
                 AND status IN ('succeeded','failed'))",
                )
                .bind(&invocation)
                .fetch_one(store.pool())
                .await?
            }
            Some(ClaimOwner::Chat(chat)) => {
                sqlx::query_scalar(
                    "SELECT NOT EXISTS(SELECT 1 FROM turn_commands WHERE chat_id = $1 \
                 AND finished_at IS NULL) \
                 AND NOT EXISTS(SELECT 1 FROM chats WHERE id = $1 AND generating)",
                )
                .bind(chat)
                .fetch_one(store.pool())
                .await?
            }
        };
        if !terminal {
            continue; // the invocation may still replay — keep the claim
        }
        pruned += sqlx::query("DELETE FROM server_kv WHERE key = $1 OR key = $1 || ':result'")
            .bind(&key)
            .execute(store.pool())
            .await?
            .rows_affected();
    }
    Ok(pruned)
}

/// What decides whether a claim can still be replayed.
#[derive(Debug, PartialEq)]
enum ClaimOwner {
    /// The invocation that wrote it (`server_effect:<invocation>:<call>`,
    /// `plugin_effect:<invocation>`, `routine_effect:<invocation>:…`).
    Invocation(String),
    /// The chat whose runner dispatched it (`tool_dispatch:<chat>:<dispatch>`).
    Chat(uuid::Uuid),
}

fn owner(key: &str) -> Option<ClaimOwner> {
    if let Some(rest) = key.strip_prefix("tool_dispatch:") {
        return rest
            .split(':')
            .next()
            .and_then(|chat| chat.parse().ok())
            .map(ClaimOwner::Chat);
    }
    for prefix in CLAIM_PREFIXES {
        if let Some(rest) = key.strip_prefix(prefix) {
            let segment = rest.split(':').next().unwrap_or_default();
            if segment.is_empty() {
                return None;
            }
            return Some(ClaimOwner::Invocation(segment.to_string()));
        }
    }
    None
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn aged_claims_prune_only_when_the_owning_invocation_is_durable_terminal() {
        let fixture = crate::test_support::test_state_with_db().await;
        let store = fixture.store();
        let admin = store
            .identity()
            .ensure_bootstrap_admin("prune@example.test", "hunter226")
            .await
            .unwrap();
        let user_row = store.identity().get_user(admin).await.unwrap();
        let org = user_row.org_id;
        let user = user_row.id;
        let chat = store
            .chats()
            .create_chat(org, user, Some("t"), None)
            .await
            .unwrap()
            .id;
        let routine = store
            .routines()
            .create(
                org,
                user,
                "prune-digest",
                "Digest",
                "webhook",
                serde_json::json!({}),
                "p",
                "m",
                serde_json::json!([]),
                "hook",
                true,
            )
            .await
            .unwrap();
        let routine_id = routine.id;
        // inv-1 owns a routine run that FINISHED (succeeded) — prunable.
        let (run_done, _) = store
            .routines()
            .start_run(routine_id, "webhook", "inv-1")
            .await
            .unwrap();
        store
            .routines()
            .finish_run(run_done, "succeeded", Some("done"), None)
            .await
            .unwrap();
        // inv-2 owns a turn command that FINISHED (completed) — prunable.
        sqlx::query(
            "INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) \
             VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(Uuid::now_v7())
        .bind(org)
        .bind(user)
        .bind(chat)
        .bind(serde_json::json!({}))
        .bind(serde_json::json!({}))
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query("UPDATE turn_commands SET invocation_id = 'inv-2', status = 'completed', finished_at = now() WHERE chat_id = $1")
            .bind(chat)
            .execute(store.pool())
            .await
            .unwrap();
        // inv-3 owns a routine run still RUNNING — never pruned, however old.
        let (_run_live, _) = store
            .routines()
            .start_run(routine_id, "webhook", "inv-3")
            .await
            .unwrap();

        claim::<String>(&store, "plugin_effect:inv-1")
            .await
            .unwrap();
        complete(&store, "plugin_effect:inv-1", &"result")
            .await
            .unwrap();
        claim::<String>(&store, "routine_effect:inv-2:0:0")
            .await
            .unwrap();
        claim::<String>(&store, "server_effect:inv-3:call-1")
            .await
            .unwrap();
        complete(&store, "server_effect:inv-3:call-1", &"done")
            .await
            .unwrap();
        // No discoverable owner: tombstone, never pruned.
        store
            .kv()
            .put("tool_dispatch:chat-1:dispatch-1", "conn")
            .await
            .unwrap();
        // Dispatch claims of an idle chat (every command finished) retire;
        // a chat with an unfinished command keeps its dispatch claims.
        let busy = store
            .chats()
            .create_chat(org, user, Some("busy"), None)
            .await
            .unwrap()
            .id;
        sqlx::query(
            "INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) \
             VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(Uuid::now_v7())
        .bind(org)
        .bind(user)
        .bind(busy)
        .bind(serde_json::json!({}))
        .bind(serde_json::json!({}))
        .execute(store.pool())
        .await
        .unwrap();
        let idle_key = format!("tool_dispatch:{chat}:dispatch-1");
        let busy_key = format!("tool_dispatch:{busy}:dispatch-1");
        store.kv().put(&idle_key, "conn").await.unwrap();
        store.kv().put(&busy_key, "conn").await.unwrap();
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
        assert_eq!(
            pruned, 4,
            "the two finished-invocation pairs and the idle chat's dispatch claim"
        );
        assert!(store.kv().get(&idle_key).await.unwrap().is_none());
        assert!(store.kv().get(&busy_key).await.unwrap().is_some());
        // The still-running invocation's claim survives regardless of age:
        // its replay window never closed.
        assert!(store
            .kv()
            .get("server_effect:inv-3:call-1")
            .await
            .unwrap()
            .is_some());
        assert!(store
            .kv()
            .get("server_effect:inv-3:call-1:result")
            .await
            .unwrap()
            .is_some());
        // Tombstone: a claim without an owning invocation is kept forever.
        assert!(store
            .kv()
            .get("tool_dispatch:chat-1:dispatch-1")
            .await
            .unwrap()
            .is_some());
        // The terminal invocations' claims went.
        assert!(store
            .kv()
            .get("plugin_effect:inv-1")
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
