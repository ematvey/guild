//! Durable accepted chat commands and their delivery outbox.
use crate::http::error::ApiError;
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct TurnCommand {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub chat_id: Uuid,
    pub request: Value,
    pub payload: Value,
    pub status: String,
    pub invocation_id: Option<String>,
}

pub struct TurnCommandStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl TurnCommandStore<'_> {
    pub async fn existing(
        &self,
        id: Uuid,
        org: Uuid,
        user: Uuid,
        chat: Uuid,
        request: &Value,
    ) -> Result<Option<TurnCommand>, ApiError> {
        let row: Option<TurnCommand> = sqlx::query_as("SELECT * FROM turn_commands WHERE id = $1")
            .bind(id)
            .fetch_optional(self.pool)
            .await?;
        if let Some(row) = &row {
            if row.org_id != org
                || row.user_id != user
                || row.chat_id != chat
                || &row.request != request
            {
                return Err(ApiError::conflict(
                    "command_id_conflict",
                    "message ID was already used for a different command",
                ));
            }
        }
        Ok(row)
    }

    /// The command and visible user echo either both commit or neither does.
    // Atomic acceptance keeps owner identity, immutable request and visible echo explicit.
    #[allow(clippy::too_many_arguments)]
    pub async fn accept(
        &self,
        id: Uuid,
        org: Uuid,
        user: Uuid,
        chat: Uuid,
        request: Value,
        mut payload: Value,
        event: &protocol::api::ThreadEvent,
    ) -> Result<TurnCommand, ApiError> {
        let mut tx = self.pool.begin().await?;
        let (project, machine, label): (Option<Uuid>, Option<String>, Option<String>) = sqlx::query_as("SELECT project_id,machine_id,machine_label FROM chats WHERE id = $1 AND org_id = $2 FOR UPDATE")
            .bind(chat).bind(org).fetch_one(&mut *tx).await?;
        if request.get("project_id").is_none_or(|id| id.is_null()) {
            payload["project_id"] = serde_json::json!(project);
            payload["machine_id"] = serde_json::json!(machine);
            payload["machine_label"] = serde_json::json!(label);
        }
        let inserted = sqlx::query("INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING")
            .bind(id).bind(org).bind(user).bind(chat).bind(&request).bind(&payload).execute(&mut *tx).await?.rows_affected() == 1;
        let row: TurnCommand = sqlx::query_as("SELECT * FROM turn_commands WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if row.org_id != org || row.user_id != user || row.chat_id != chat || row.request != request
        {
            return Err(ApiError::conflict(
                "command_id_conflict",
                "message ID was already used for a different command",
            ));
        }
        if inserted {
            if let Some(project) = request.get("project_id").and_then(Value::as_str) {
                let project: Uuid = project
                    .parse()
                    .map_err(|_| ApiError::bad_request("invalid project"))?;
                sqlx::query(
                    "UPDATE chats SET project_id=$2,machine_id=$3,machine_label=$4 WHERE id=$1",
                )
                .bind(chat)
                .bind(project)
                .bind(payload["machine_id"].as_str())
                .bind(payload["machine_label"].as_str())
                .execute(&mut *tx)
                .await?;
            }
            let value = serde_json::to_value(event).expect("event serializes");
            let result = sqlx::query("INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1,$2,'user_message',$3) ON CONFLICT (id) DO NOTHING")
                .bind(id).bind(chat).bind(value).execute(&mut *tx).await?;
            if result.rows_affected() != 1 {
                return Err(ApiError::conflict(
                    "command_id_conflict",
                    "message ID already identifies a thread event",
                ));
            }
            sqlx::query("SELECT pg_notify('guild_thread_committed', $1)")
                .bind(chat.to_string())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(row)
    }

    /// Only the oldest unfinished command of each chat may enter Restate.
    /// Archived chats never dispatch: archiving settles their waiting
    /// commands, and this guard closes the dispatch/archive race.
    pub async fn pending_heads(&self, chat: Option<Uuid>) -> Result<Vec<TurnCommand>, ApiError> {
        Ok(sqlx::query_as("SELECT c.* FROM turn_commands c WHERE c.status = 'pending' AND ($1::uuid IS NULL OR c.chat_id = $1) AND NOT EXISTS (SELECT 1 FROM turn_commands older WHERE older.chat_id = c.chat_id AND older.position < c.position AND older.finished_at IS NULL) AND NOT EXISTS (SELECT 1 FROM chats ch WHERE ch.id = c.chat_id AND ch.archived_at IS NOT NULL) ORDER BY c.position LIMIT 64")
            .bind(chat).fetch_all(self.pool).await?)
    }

    pub async fn submitted(&self, id: Uuid, invocation: &str) -> Result<(), ApiError> {
        sqlx::query("UPDATE turn_commands SET invocation_id = coalesce(invocation_id,$2), status = CASE WHEN status = 'pending' THEN 'submitted' ELSE status END WHERE id = $1")
            .bind(id).bind(invocation).execute(self.pool).await?;
        Ok(())
    }

    /// None means a legacy invocation. A duplicate invocation never executes
    /// a completed command, even after Restate's idempotency retention expires.
    /// An archived chat's command never begins: a delivery that raced the
    /// archive settles as cancelled without running.
    pub async fn begin(
        &self,
        id: Uuid,
        chat: Uuid,
        invocation: &str,
    ) -> Result<Option<bool>, ApiError> {
        let mut tx = self.pool.begin().await?;
        let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT status, invocation_id FROM turn_commands WHERE id = $1 AND chat_id = $2 FOR UPDATE")
            .bind(id).bind(chat).fetch_optional(&mut *tx).await?;
        let Some((status, owner)) = row else {
            return Ok(None);
        };
        let archived: Option<(bool,)> =
            sqlx::query_as("SELECT archived_at IS NOT NULL FROM chats WHERE id = $1")
                .bind(chat)
                .fetch_optional(&mut *tx)
                .await?;
        if archived.is_some_and(|(a,)| a) {
            return Ok(Some(false));
        }
        if status == "running" {
            return Ok(Some(owner.as_deref() == Some(invocation)));
        }
        if !matches!(status.as_str(), "pending" | "submitted") {
            return Ok(Some(false));
        }
        if owner.as_deref().is_some_and(|owner| owner != invocation) {
            return Ok(Some(false));
        }
        sqlx::query("UPDATE turn_commands SET status = 'running', invocation_id = $2, started_seq = coalesce(started_seq,nextval(pg_get_serial_sequence('thread_events','seq'))) WHERE id = $1")
            .bind(id).bind(invocation).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(true))
    }

    pub async fn finish(&self, id: Uuid, invocation: &str, failed: bool) -> Result<(), ApiError> {
        sqlx::query("UPDATE turn_commands SET status = $3, finished_at = coalesce(finished_at,now()) WHERE id = $1 AND invocation_id = $2 AND finished_at IS NULL")
            .bind(id).bind(invocation).bind(if failed {"failed"} else {"completed"}).execute(self.pool).await?;
        Ok(())
    }

    pub async fn finish_invocation(&self, invocation: &str) -> Result<(), ApiError> {
        sqlx::query("UPDATE turn_commands SET status = 'failed', finished_at = now() WHERE invocation_id = $1 AND finished_at IS NULL")
            .bind(invocation).execute(self.pool).await?;
        Ok(())
    }

    pub async fn cancel_waiting_head(&self, chat: Uuid) -> Result<(), ApiError> {
        sqlx::query("UPDATE turn_commands SET status = 'cancelled', finished_at = now() WHERE id = (SELECT id FROM turn_commands WHERE chat_id = $1 AND finished_at IS NULL ORDER BY position LIMIT 1) AND status IN ('pending','submitted')")
            .bind(chat).execute(self.pool).await?;
        Ok(())
    }
}
