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
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/usage", axum::routing::get(usage))
        .route("/api/v1/usage/summary", axum::routing::get(summary))
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
    let group_by = match q.group_by.as_deref() {
        None | Some("user") => ("toString(user_id)", "user"),
        Some("team") => ("coalesce(toString(team_id), 'none')", "team"),
        Some("model") => ("model", "model"),
        Some(other) => return Err(ApiError::bad_request(format!("unknown group_by {other}"))),
    };
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
    Ok(Json(json!({ "rows": rows })))
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
