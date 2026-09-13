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
    pub webhook_token: String,
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

impl<'a> RoutineStore<'a> {
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        org_id: Uuid,
        created_by: Uuid,
        slug: &str,
        name: &str,
        trigger_kind: &str,
        trigger_config: serde_json::Value,
        prompt: &str,
        model: &str,
        allowed_tools: serde_json::Value,
        webhook_token: &str,
        enabled: bool,
    ) -> Result<RoutineRow, ApiError> {
        let id = Uuid::now_v7();
        match sqlx::query_as::<_, RoutineRow>(
            "INSERT INTO routines (id, org_id, created_by, slug, name, trigger_kind, trigger_config, prompt, model, allowed_tools, webhook_token, enabled) \
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
        .bind(webhook_token)
        .bind(enabled)
        .fetch_one(self.pool)
        .await
        {
            Ok(r) => Ok(r),
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
                Err(ApiError::conflict("slug_taken", "a routine with this slug already exists"))
            }
            Err(e) => Err(ApiError::from(e)),
        }
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
    ) -> Result<RoutineRow, ApiError> {
        sqlx::query_as::<_, RoutineRow>(
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
        .bind(patch.trigger_config.clone())
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such routine"))
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
