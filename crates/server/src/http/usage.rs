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
    // Value positions are bound parameters — identifiers (group expression)
    // stay a code whitelist. Order of binds must match the appended `?`s.
    let mut sql = format!(
        "SELECT {group} AS \"group\", sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, \
         sum(cost_usd) AS cost_usd, count() AS requests \
         FROM (SELECT * FROM usage_events WHERE org_id = toUUID(?) ORDER BY ts DESC LIMIT 1 BY org_id, request_id) WHERE 1=1",
        group = group_by.0,
    );
    let member_scoped = user.0.role != "admin";
    if member_scoped {
        sql.push_str(" AND user_id = toUUID(?)");
    }
    if q.team_id.is_some() {
        sql.push_str(" AND team_id = toUUID(?)");
    }
    if let Some(from) = &q.from {
        parse_date(from, "from")?;
        sql.push_str(" AND ts >= toDateTime(?)");
    }
    if let Some(to) = &q.to {
        parse_date(to, "to")?;
        sql.push_str(" AND ts <= toDateTime(?)");
    }
    // Group by the raw expression (not the alias — `group` is a reserved
    // word); ClickHouse >= 26.x rejects non-aggregate columns otherwise.
    sql.push_str(" GROUP BY ");
    sql.push_str(group_by.0);

    let client = state.config.clickhouse_client();
    let mut query = client.query(&sql).bind(user.0.org_id.simple().to_string());
    if member_scoped {
        query = query.bind(user.0.id.simple().to_string());
    }
    if let Some(team) = q.team_id {
        query = query.bind(team.simple().to_string());
    }
    if let Some(from) = &q.from {
        query = query.bind(parse_date(from, "from")?.timestamp());
    }
    if let Some(to) = &q.to {
        query = query.bind(parse_date(to, "to")?.timestamp());
    }
    let rows: Vec<UsageAggRow> = match query.fetch_all().await {
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

    // Bound parameters, as in `usage` above.
    let mut sql = format!(
        "SELECT {bucket} AS bucket, {group} AS \"group\", sum(tokens_in) AS tokens_in, \
         sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd, count() AS requests \
         FROM (SELECT * FROM usage_events WHERE org_id = toUUID(?) ORDER BY ts DESC LIMIT 1 BY org_id, request_id) WHERE 1=1",
        bucket = bucket_expr,
        group = group_by.0,
    );
    let member_scoped = user.0.role != "admin";
    if member_scoped {
        sql.push_str(" AND user_id = toUUID(?)");
    }
    if q.chat_id.is_some() {
        sql.push_str(" AND session_id = toUUID(?)");
    }
    if let Some(from) = &q.from {
        parse_date(from, "from")?;
        sql.push_str(" AND ts >= toDateTime(?)");
    }
    if let Some(to) = &q.to {
        parse_date(to, "to")?;
        sql.push_str(" AND ts <= toDateTime(?)");
    }
    // Group by the bucket and (when grouping) the raw group expression —
    // not the aliases (`group` is a reserved word); ClickHouse >= 26.x
    // rejects non-aggregate columns without an explicit GROUP BY.
    sql.push_str(" GROUP BY ");
    sql.push_str(bucket_expr);
    if group_by.0 != "''" {
        sql.push_str(", ");
        sql.push_str(group_by.0);
    }

    let client = state.config.clickhouse_client();
    let mut query = client.query(&sql).bind(user.0.org_id.simple().to_string());
    if member_scoped {
        query = query.bind(user.0.id.simple().to_string());
    }
    if let Some(chat) = q.chat_id {
        query = query.bind(chat.simple().to_string());
    }
    if let Some(from) = &q.from {
        query = query.bind(parse_date(from, "from")?.timestamp());
    }
    if let Some(to) = &q.to {
        query = query.bind(parse_date(to, "to")?.timestamp());
    }
    let rows: Vec<SeriesRow> = match query.fetch_all().await {
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
    let member_scoped = user.0.role != "admin";
    let mut scope = String::from("org_id = toUUID(?)");
    if member_scoped {
        scope.push_str(" AND user_id = toUUID(?)");
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

    #[derive(clickhouse::Row, serde::Deserialize)]
    struct SummaryRow {
        cost_usd: f64,
        tokens: u64,
    }

    let client = state.config.clickhouse_client();
    let missing_table = |e: &str| e.contains("UNKNOWN_TABLE");
    let totals = |scope: &str, since: i64, what: &str| {
        let mut q = client
            .query(&format!(
                "SELECT coalesce(sum(cost_usd), 0) AS cost_usd, coalesce(sum(tokens_in + tokens_out), 0) AS tokens \
                 FROM (SELECT * FROM usage_events WHERE {scope} ORDER BY ts DESC LIMIT 1 BY org_id, request_id) WHERE ts >= toDateTime(?)"
            ))
            .bind(user.0.org_id.simple().to_string());
        if member_scoped {
            q = q.bind(user.0.id.simple().to_string());
        }
        let what = what.to_string();
        async move {
            match q.bind(since).fetch_one::<SummaryRow>().await {
                Ok(v) => Ok(v),
                Err(e) if missing_table(&e.to_string()) => {
                    Ok(SummaryRow { cost_usd: 0.0, tokens: 0 })
                }
                Err(e) => Err(ApiError::internal(format!("{what} query failed: {e}"))),
            }
        }
    };
    let today = totals(&scope, start_of_day.timestamp(), "usage").await?;
    let month = totals(&scope, start_of_month.timestamp(), "usage").await?;
    Ok(Json(json!({
        "today_cost_usd": today.cost_usd,
        "month_cost_usd": month.cost_usd,
        "today_tokens": today.tokens,
        "month_tokens": month.tokens,
    })))
}
