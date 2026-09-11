//! Usage/cost queries over ClickHouse (spec §4.5): per user, team, model,
//! day. Admins see the whole org; members only themselves.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::{Query as Q, State};
use axum::{Json, Router};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/usage", axum::routing::get(usage))
        .route("/api/v1/usage/summary", axum::routing::get(summary))
        .route("/api/v1/usage/series", axum::routing::get(series))
}

#[derive(Deserialize)]
struct UsageQuery {
    from: Option<String>,
    to: Option<String>,
    group_by: Option<String>,
    team_id: Option<Uuid>,
}

fn clickhouse_uuid(u: Uuid) -> String {
    format!("toUUID('{u}')")
}

/// Grouping expression + label for the breakdown queries.
fn group_expr(group_by: Option<&str>) -> Result<(&'static str, &'static str), ApiError> {
    Ok(match group_by {
        None | Some("user") => ("toString(user_id)", "user"),
        Some("team") => ("coalesce(toString(team_id), 'none')", "team"),
        Some("model") => ("model", "model"),
        Some(other) => return Err(ApiError::bad_request(format!("unknown group_by {other}"))),
    })
}

/// Raw uuids mean nothing in the UI: resolve user groups to emails and team
/// groups to team names (unknown ids — e.g. deleted rows — keep the raw
/// value rather than disappearing from the breakdown).
async fn resolve_group_names(
    state: &AppState,
    org_id: Uuid,
    kind: &str,
    rows: Vec<UsageAggRow>,
) -> Result<Vec<UsageAggRow>, ApiError> {
    let by_id: HashMap<String, String> = match kind {
        "user" => state
            .store()
            .await?
            .identity()
            .list_users(org_id)
            .await?
            .into_iter()
            .map(|u| (u.id.to_string(), u.email))
            .collect(),
        "team" => state
            .store()
            .await?
            .teams()
            .list_teams(org_id)
            .await?
            .into_iter()
            .map(|t| (t.id.to_string(), t.name))
            .collect(),
        _ => return Ok(rows),
    };
    Ok(rows
        .into_iter()
        .map(|mut r| {
            if r.group != "none" {
                if let Some(name) = by_id.get(&r.group) {
                    r.group = name.clone();
                }
            }
            r
        })
        .collect())
}

fn parse_date(s: &str, field: &str) -> Result<DateTime<Utc>, ApiError> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(d.and_hms_opt(0, 0, 0).unwrap().and_utc());
    }
    Err(ApiError::bad_request(format!(
        "{field} must be RFC 3339 or YYYY-MM-DD"
    )))
}

#[derive(clickhouse::Row, serde::Deserialize, serde::Serialize, Debug)]
struct UsageAggRow {
    #[serde(rename = "group")]
    group: String,
    tokens_in: u64,
    tokens_out: u64,
    cost_usd: f64,
    requests: u64,
}

async fn usage(
    State(state): State<AppState>,
    user: AuthUser,
    Q(q): Q<UsageQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let group_by = group_expr(q.group_by.as_deref())?;
    let mut conditions = vec![format!("org_id = {}", clickhouse_uuid(user.0.org_id))];
    if user.0.role != "admin" {
        conditions.push(format!("user_id = {}", clickhouse_uuid(user.0.id)));
    }
    if let Some(team) = q.team_id {
        conditions.push(format!("team_id = {}", clickhouse_uuid(team)));
    }
    if let Some(from) = &q.from {
        let dt = parse_date(from, "from")?;
        conditions.push(format!("ts >= toDateTime({})", dt.timestamp()));
    }
    if let Some(to) = &q.to {
        let dt = parse_date(to, "to")?;
        conditions.push(format!("ts <= toDateTime({})", dt.timestamp()));
    }

    let sql = format!(
        "SELECT {group} AS \"group\", sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, \
         sum(cost_usd) AS cost_usd, count() AS requests \
         FROM usage_events WHERE {} GROUP BY \"group\" ORDER BY cost_usd DESC",
        conditions.join(" AND "),
        group = group_by.0,
    );

    let client = state.config.clickhouse_client();
    let rows: Vec<UsageAggRow> = match client.query(&sql).fetch_all().await {
        Ok(rows) => rows,
        Err(e) if e.to_string().contains("UNKNOWN_TABLE") => {
            return Ok(Json(json!({ "rows": [] })));
        }
        Err(e) => return Err(ApiError::internal(format!("usage query failed: {e}"))),
    };

    // Raw uuids mean nothing in the UI: resolve names (see helper above).
    let rows = resolve_group_names(&state, user.0.org_id, group_by.1, rows).await?;
    Ok(Json(json!({ "rows": rows })))
}

#[derive(Deserialize)]
struct SeriesQuery {
    from: Option<String>,
    to: Option<String>,
    /// Bucket size: hour (for 24h views) or day (default).
    bucket: Option<String>,
    group_by: Option<String>,
    /// Restrict to one chat's usage (chat-path events use session_id =
    /// chat id; the OpenAI-key path uses the key id, so this only ever
    /// matches chat-originated spend).
    chat_id: Option<Uuid>,
}

#[derive(clickhouse::Row, serde::Deserialize, serde::Serialize, Debug)]
struct SeriesRow {
    #[serde(rename = "bucket", with = "clickhouse::serde::chrono::datetime")]
    bucket: DateTime<Utc>,
    group: String,
    tokens_in: u64,
    tokens_out: u64,
    cost_usd: f64,
    requests: u64,
}

/// Time-bucketed usage for charts: one row per (bucket, group). Buckets with
/// no traffic are absent — the client fills the gaps so lines stay continuous.
async fn series(
    State(state): State<AppState>,
    user: AuthUser,
    Q(q): Q<SeriesQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let bucket_expr = match q.bucket.as_deref() {
        None | Some("day") => "toStartOfDay(ts)",
        Some("hour") => "toStartOfHour(ts)",
        Some(other) => return Err(ApiError::bad_request(format!("unknown bucket {other}"))),
    };
    let group_by = match q.group_by.as_deref() {
        None | Some("none") => ("''", "none"),
        other => group_expr(other)?,
    };

    let mut conditions = vec![format!("org_id = {}", clickhouse_uuid(user.0.org_id))];
    if user.0.role != "admin" {
        conditions.push(format!("user_id = {}", clickhouse_uuid(user.0.id)));
    }
    if let Some(chat) = q.chat_id {
        conditions.push(format!("session_id = {}", clickhouse_uuid(chat)));
    }
    if let Some(from) = &q.from {
        let dt = parse_date(from, "from")?;
        conditions.push(format!("ts >= toDateTime({})", dt.timestamp()));
    }
    if let Some(to) = &q.to {
        let dt = parse_date(to, "to")?;
        conditions.push(format!("ts <= toDateTime({})", dt.timestamp()));
    }

    let sql = format!(
        "SELECT {bucket} AS bucket, {group} AS \"group\", sum(tokens_in) AS tokens_in, \
         sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd, count() AS requests \
         FROM usage_events WHERE {} GROUP BY bucket, \"group\" ORDER BY bucket, cost_usd DESC",
        conditions.join(" AND "),
        bucket = bucket_expr,
        group = group_by.0,
    );

    let client = state.config.clickhouse_client();
    let rows: Vec<SeriesRow> = match client.query(&sql).fetch_all().await {
        Ok(rows) => rows,
        Err(e) if e.to_string().contains("UNKNOWN_TABLE") => {
            return Ok(Json(json!({ "rows": [] })));
        }
        Err(e) => return Err(ApiError::internal(format!("usage series failed: {e}"))),
    };

    // Serialize bucket as ISO for the client.
    let rows: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "bucket": r.bucket.to_rfc3339(),
                "group": r.group,
                "tokens_in": r.tokens_in,
                "tokens_out": r.tokens_out,
                "cost_usd": r.cost_usd,
                "requests": r.requests,
            })
        })
        .collect();
    let rows = resolve_group_names_serde(&state, user.0.org_id, group_by.1, rows).await?;
    Ok(Json(json!({ "rows": rows })))
}

/// Name resolution over the serde-shaped series rows (same mapping as
/// `resolve_group_names`, which works on typed ClickHouse rows).
async fn resolve_group_names_serde(
    state: &AppState,
    org_id: Uuid,
    kind: &str,
    rows: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, ApiError> {
    if kind == "none" {
        return Ok(rows);
    }
    let by_id: HashMap<String, String> = if kind == "user" {
        state
            .store()
            .await?
            .identity()
            .list_users(org_id)
            .await?
            .into_iter()
            .map(|u| (u.id.to_string(), u.email))
            .collect()
    } else {
        state
            .store()
            .await?
            .teams()
            .list_teams(org_id)
            .await?
            .into_iter()
            .map(|t| (t.id.to_string(), t.name))
            .collect()
    };
    Ok(rows
        .into_iter()
        .map(|mut r| {
            if let Some(group) = r["group"].as_str() {
                if group != "none" {
                    if let Some(name) = by_id.get(group) {
                        r["group"] = json!(name);
                    }
                }
            }
            r
        })
        .collect())
}

async fn summary(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut scope = format!("org_id = {}", clickhouse_uuid(user.0.org_id));
    if user.0.role != "admin" {
        scope.push_str(&format!(" AND user_id = {}", clickhouse_uuid(user.0.id)));
    }
    let now = Utc::now();
    let start_of_day = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let start_of_month = now
        .date_naive()
        .with_day(1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();

    let client = state.config.clickhouse_client();
    let missing_table = |e: &str| e.contains("UNKNOWN_TABLE");
    let today: f64 = match client
        .query(&format!(
            "SELECT coalesce(sum(cost_usd), 0) FROM usage_events WHERE {scope} AND ts >= toDateTime({})",
            start_of_day.timestamp()
        ))
        .fetch_one()
        .await
    {
        Ok(v) => v,
        Err(e) if missing_table(&e.to_string()) => 0.0,
        Err(e) => return Err(ApiError::internal(format!("usage query failed: {e}"))),
    };
    let month: f64 = match client
        .query(&format!(
            "SELECT coalesce(sum(cost_usd), 0) FROM usage_events WHERE {scope} AND ts >= toDateTime({})",
            start_of_month.timestamp()
        ))
        .fetch_one()
        .await
    {
        Ok(v) => v,
        Err(e) if missing_table(&e.to_string()) => 0.0,
        Err(e) => return Err(ApiError::internal(format!("usage query failed: {e}"))),
    };
    Ok(Json(
        json!({ "today_cost_usd": today, "month_cost_usd": month }),
    ))
}
