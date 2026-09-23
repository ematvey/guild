//! Routine records: user-created automations (trigger + agent config) and
//! their run history (spec §4.6).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct RoutineRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub created_by: Option<Uuid>,
    pub slug: String,
    pub name: String,
    pub trigger_kind: String,
    pub trigger_config: serde_json::Value,
    pub prompt: String,
    pub model: String,
    pub allowed_tools: serde_json::Value,
    /// sha256 of the webhook bearer token — the plaintext is shown once at
    /// creation and never stored. Not serialized: list/get responses must
    /// not leak the hash (ApiKeyRow omits key_hash the same way).
    #[serde(skip_serializing)]
    pub webhook_token_hash: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct RunRow {
    pub id: Uuid,
    pub routine_id: Uuid,
    pub trigger: String,
    pub status: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

pub struct RoutineStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

/// Webhook tokens are hashed at rest, like api keys and pairing codes.
fn webhook_token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl<'a> RoutineStore<'a> {
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        org_id: Uuid,
        created_by: Uuid,
        slug: &str,
        name: &str,
        trigger_kind: &str,
        mut trigger_config: serde_json::Value,
        prompt: &str,
        model: &str,
        allowed_tools: serde_json::Value,
        webhook_token: &str,
        enabled: bool,
    ) -> Result<RoutineRow, ApiError> {
        if trigger_kind == "interval" {
            let object = trigger_config
                .as_object_mut()
                .ok_or_else(|| ApiError::bad_request("trigger_config must be an object"))?;
            object.insert(
                "schedule_generation".into(),
                serde_json::json!(Uuid::now_v7()),
            );
        }
        let id = Uuid::now_v7();
        let mut tx = self.pool.begin().await?;
        let routine = match sqlx::query_as::<_, RoutineRow>(
            "INSERT INTO routines (id, org_id, created_by, slug, name, trigger_kind, trigger_config, prompt, model, allowed_tools, webhook_token_hash, enabled) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             RETURNING *",
        )
        .bind(id)
        .bind(org_id)
        .bind(created_by)
        .bind(slug)
        .bind(name)
        .bind(trigger_kind)
        .bind(trigger_config)
        .bind(prompt)
        .bind(model)
        .bind(allowed_tools)
        .bind(webhook_token_hash(webhook_token))
        .bind(enabled)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(r) => Ok(r),
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
                Err(ApiError::conflict("slug_taken", "a routine with this slug already exists"))
            }
            Err(e) => Err(ApiError::from(e)),
        }?;
        if routine.enabled && routine.trigger_kind == "interval" {
            enqueue_schedule(&mut tx, &routine).await?;
        }
        tx.commit().await?;
        Ok(routine)
    }

    pub async fn get(&self, org_id: Uuid, id: Uuid) -> Result<RoutineRow, ApiError> {
        sqlx::query_as("SELECT * FROM routines WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .fetch_optional(self.pool)
            .await?
            .ok_or_else(|| ApiError::not_found("no such routine"))
    }

    pub async fn get_by_slug(&self, org_id: Uuid, slug: &str) -> Result<RoutineRow, ApiError> {
        sqlx::query_as("SELECT * FROM routines WHERE org_id = $1 AND slug = $2")
            .bind(org_id)
            .bind(slug)
            .fetch_optional(self.pool)
            .await?
            .ok_or_else(|| ApiError::not_found("no such routine"))
    }

    pub async fn get_for_internal(&self, id: Uuid) -> Result<RoutineRow, ApiError> {
        sqlx::query_as("SELECT * FROM routines WHERE id = $1")
            .bind(id)
            .fetch_optional(self.pool)
            .await?
            .ok_or_else(|| ApiError::not_found("no such routine"))
    }

    pub async fn list(&self, org_id: Uuid) -> Result<Vec<RoutineRow>, ApiError> {
        sqlx::query_as("SELECT * FROM routines WHERE org_id = $1 ORDER BY created_at DESC")
            .bind(org_id)
            .fetch_all(self.pool)
            .await
            .map_err(Into::into)
    }

    pub async fn update(
        &self,
        org_id: Uuid,
        id: Uuid,
        patch: &UpdatePatch,
        is_admin: bool,
    ) -> Result<(RoutineRow, bool), ApiError> {
        let mut tx = self.pool.begin().await?;
        let current: RoutineRow =
            sqlx::query_as("SELECT * FROM routines WHERE org_id = $1 AND id = $2 FOR UPDATE")
                .bind(org_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| ApiError::not_found("no such routine"))?;
        if !is_admin
            && (patch.enabled == Some(true)
                || current.enabled
                    && (patch.prompt.is_some()
                        || patch.model.is_some()
                        || patch.trigger_config.is_some()))
        {
            return Err(ApiError::forbidden());
        }
        if current.trigger_kind == "interval" {
            let config = patch
                .trigger_config
                .as_ref()
                .unwrap_or(&current.trigger_config);
            if config["interval_secs"].as_u64().is_none_or(|n| n < 5) {
                return Err(ApiError::bad_request(
                    "interval trigger needs trigger_config.interval_secs >= 5",
                ));
            }
        }
        let mut config = patch
            .trigger_config
            .clone()
            .unwrap_or_else(|| current.trigger_config.clone());
        let enabled = patch.enabled.unwrap_or(current.enabled);
        let new_schedule = current.trigger_kind == "interval"
            && enabled
            && (!current.enabled || patch.trigger_config.is_some());
        if current.trigger_kind == "interval" {
            let generation = if new_schedule || current.enabled != enabled {
                serde_json::json!(Uuid::now_v7())
            } else {
                current.trigger_config["schedule_generation"].clone()
            };
            config
                .as_object_mut()
                .ok_or_else(|| ApiError::bad_request("trigger_config must be an object"))?
                .insert("schedule_generation".into(), generation);
        }
        let updated = sqlx::query_as::<_, RoutineRow>(
            "UPDATE routines SET \
               prompt = coalesce($3, prompt), \
               model = coalesce($4, model), \
               enabled = coalesce($5, enabled), \
               trigger_config = coalesce($6, trigger_config) \
             WHERE org_id = $1 AND id = $2 \
             RETURNING *",
        )
        .bind(org_id)
        .bind(id)
        .bind(patch.prompt.clone())
        .bind(patch.model.clone())
        .bind(patch.enabled)
        .bind(config)
        .fetch_one(&mut *tx)
        .await?;
        if current.trigger_kind == "interval" {
            sqlx::query("UPDATE routine_schedule_starts SET status='retired' WHERE routine_id=$1 AND (NOT $2 OR generation::text != $3)")
                .bind(id).bind(enabled).bind(updated.trigger_config["schedule_generation"].as_str().unwrap_or(""))
                .execute(&mut *tx).await?;
            if new_schedule {
                enqueue_schedule(&mut tx, &updated).await?;
            }
        }
        tx.commit().await?;
        Ok((updated, new_schedule))
    }

    pub async fn delete(&self, org_id: Uuid, id: Uuid) -> Result<(), ApiError> {
        let n = sqlx::query("DELETE FROM routines WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(self.pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(ApiError::not_found("no such routine"));
        }
        Ok(())
    }

    pub async fn start_run(
        &self,
        routine_id: Uuid,
        trigger: &str,
    ) -> Result<(Uuid, DateTime<Utc>), ApiError> {
        let id = Uuid::now_v7();
        let started_at: DateTime<Utc> = sqlx::query_scalar(
            "INSERT INTO routine_runs (id, routine_id, trigger) VALUES ($1, $2, $3) RETURNING started_at",
        )
        .bind(id)
        .bind(routine_id)
        .bind(trigger)
        .fetch_one(self.pool)
        .await?;
        Ok((id, started_at))
    }

    pub async fn finish_run(
        &self,
        run_id: Uuid,
        status: &str,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), ApiError> {
        let res = sqlx::query(
            "UPDATE routine_runs SET status = $2, summary = $3, error = $4, finished_at = now() WHERE id = $1",
        )
        .bind(run_id)
        .bind(status)
        .bind(summary)
        .bind(error)
        .execute(self.pool)
        .await?;
        if res.rows_affected() == 0 {
            // A vanished run row means the record was removed mid-run; the
            // run's outcome must not disappear without a trace.
            tracing::warn!(run = %run_id, "finish_run matched no rows");
        }
        Ok(())
    }

    pub async fn list_runs(&self, org_id: Uuid, routine_id: Uuid) -> Result<Vec<RunRow>, ApiError> {
        sqlx::query_as(
            "SELECT r.* FROM routine_runs r JOIN routines t ON t.id = r.routine_id \
             WHERE t.org_id = $1 AND r.routine_id = $2 ORDER BY r.started_at DESC LIMIT 100",
        )
        .bind(org_id)
        .bind(routine_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }
}

pub struct UpdatePatch {
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub enabled: Option<bool>,
    pub trigger_config: Option<serde_json::Value>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ScheduleStart {
    pub generation: Uuid,
    pub routine_id: Uuid,
}

async fn enqueue_schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    routine: &RoutineRow,
) -> Result<(), ApiError> {
    let generation: Uuid = routine.trigger_config["schedule_generation"]
        .as_str()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| ApiError::internal("invalid schedule generation"))?;
    sqlx::query("INSERT INTO routine_schedule_starts (generation,routine_id) VALUES ($1,$2) ON CONFLICT DO NOTHING")
        .bind(generation).bind(routine.id).execute(&mut **tx).await?;
    Ok(())
}

impl RoutineStore<'_> {
    pub async fn pending_schedules(
        &self,
        routine: Option<Uuid>,
    ) -> Result<Vec<ScheduleStart>, ApiError> {
        Ok(sqlx::query_as("SELECT generation,routine_id FROM routine_schedule_starts WHERE status='pending' AND ($1::uuid IS NULL OR routine_id=$1) ORDER BY created_at LIMIT 64")
            .bind(routine).fetch_all(self.pool).await?)
    }

    pub async fn schedule_dispatched(
        &self,
        generation: Uuid,
        invocation: &str,
    ) -> Result<(), ApiError> {
        // A late acknowledgement must not resurrect a retired or started schedule.
        sqlx::query("UPDATE routine_schedule_starts SET status='dispatched',invocation_id=coalesce(invocation_id,$2) WHERE generation=$1 AND status='pending'")
            .bind(generation).bind(invocation).execute(self.pool).await?;
        Ok(())
    }

    /// Permanent singleton claim supplements the ingress idempotency window.
    /// The same invocation may replay its claim after an ambiguous DB response.
    pub async fn claim_schedule(
        &self,
        routine: Uuid,
        generation: Uuid,
        invocation: &str,
    ) -> Result<bool, ApiError> {
        let mut tx = self.pool.begin().await?;
        let current: Option<RoutineRow> =
            sqlx::query_as("SELECT * FROM routines WHERE id=$1 FOR UPDATE")
                .bind(routine)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(current) = current else {
            return Ok(false);
        };
        let row: Option<(String,Option<String>)> = sqlx::query_as("SELECT status,invocation_id FROM routine_schedule_starts WHERE generation=$1 AND routine_id=$2 FOR UPDATE")
            .bind(generation).bind(routine).fetch_optional(&mut *tx).await?;
        let Some((status, owner)) = row else {
            return Ok(false);
        };
        if !current.enabled
            || current.trigger_kind != "interval"
            || current.trigger_config["schedule_generation"].as_str()
                != Some(generation.to_string().as_str())
        {
            sqlx::query("UPDATE routine_schedule_starts SET status='retired' WHERE generation=$1")
                .bind(generation)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(false);
        }
        if status == "retired" || owner.as_deref().is_some_and(|owner| owner != invocation) {
            return Ok(false);
        }
        sqlx::query("UPDATE routine_schedule_starts SET status='started',invocation_id=$2 WHERE generation=$1")
            .bind(generation).bind(invocation).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
}
