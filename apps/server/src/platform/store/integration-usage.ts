// Integration usage over a time window, read from the
// `integration.tool_called` audit events: every call through the chat loop
// or the script API records one, with its tool, caller, outcome, latency
// and (on failure) the error. Windowed analytics: the integrations page
// reads it when opened and on Refresh.

import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";

const KIND = "integration.tool_called";

/** Last-call state and call counts of every integration with calls in the
 *  window, for the installed list. */
export interface UsageSummaryRow {
  slug: string;
  calls: number;
  errors: number;
  last_call_at: string;
  last_ok: boolean;
  last_error: string | null;
}

export interface IntegrationUsage {
  days: number;
  totals: {
    calls: number;
    errors: number;
    people: number;
    p50_ms: number | null;
    p95_ms: number | null;
    last_call_at: string | null;
  };
  by_day: { day: string; calls: number; errors: number }[];
  by_tool: { tool: string; calls: number; errors: number; p95_ms: number | null }[];
  by_person: { user_id: string; name: string; calls: number; errors: number; last_call_at: string }[];
  recent_failures: { at: string; tool: string; error: string; name: string | null; via: string }[];
}

export function clampDays(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 90) : fallback;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));
const ts = (v: unknown): string => pgTimestampToRfc3339(String(v));

export async function usageSummary(pool: PlatformPool, orgId: string, days: number): Promise<UsageSummaryRow[]> {
  const res = await pool.query(
    `SELECT payload->>'slug' AS slug,
            count(*) AS calls,
            count(*) FILTER (WHERE payload->>'ok' = 'false') AS errors,
            ${utcText("max(created_at)")} AS last_call_at,
            (array_agg(payload->>'ok' ORDER BY created_at DESC))[1] AS last_ok,
            (array_agg(payload->>'error' ORDER BY created_at DESC))[1] AS last_error
       FROM events
      WHERE org_id = $1 AND kind = $2 AND created_at >= now() - make_interval(days => $3)
      GROUP BY 1`,
    [orgId, KIND, days],
  );
  return res.rows.map((r) => ({
    slug: String(r.slug),
    calls: num(r.calls),
    errors: num(r.errors),
    last_call_at: ts(r.last_call_at),
    last_ok: r.last_ok !== "false",
    last_error: r.last_ok === "false" ? ((r.last_error as string | null) ?? null) : null,
  }));
}

export async function integrationUsage(
  pool: PlatformPool,
  orgId: string,
  slug: string,
  days: number,
): Promise<IntegrationUsage> {
  const scope = `org_id = $1 AND kind = '${KIND}' AND payload->>'slug' = $2
                 AND created_at >= now() - make_interval(days => $3)`;
  const binds = [orgId, slug, days];
  const callerName = `COALESCE(NULLIF(u.display_name, ''), u.email)`;
  const callerJoin = `LEFT JOIN users u ON u.id::text = e.payload->>'caller' AND u.org_id = e.org_id`;
  const [totals, byDay, byTool, byPerson, failures] = await Promise.all([
    pool.query(
      `SELECT count(*) AS calls,
              count(*) FILTER (WHERE payload->>'ok' = 'false') AS errors,
              count(DISTINCT payload->>'caller') AS people,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'ms')::numeric) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'ms')::numeric) AS p95,
              ${utcText("max(created_at)")} AS last_call_at
         FROM events WHERE ${scope}`,
      binds,
    ),
    pool.query(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*) AS calls,
              count(*) FILTER (WHERE payload->>'ok' = 'false') AS errors
         FROM events WHERE ${scope}
        GROUP BY 1 ORDER BY 1`,
      binds,
    ),
    pool.query(
      `SELECT payload->>'tool' AS tool,
              count(*) AS calls,
              count(*) FILTER (WHERE payload->>'ok' = 'false') AS errors,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'ms')::numeric) AS p95
         FROM events WHERE ${scope}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
      binds,
    ),
    pool.query(
      `SELECT e.payload->>'caller' AS user_id, ${callerName} AS name,
              count(*) AS calls,
              count(*) FILTER (WHERE e.payload->>'ok' = 'false') AS errors,
              ${utcText("max(e.created_at)")} AS last_call_at
         FROM events e ${callerJoin}
        WHERE ${scope.replace(/(org_id|kind|payload|created_at)\b/g, "e.$1")}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50`,
      binds,
    ),
    pool.query(
      `SELECT ${utcText("e.created_at")} AS at, e.payload->>'tool' AS tool, e.payload->>'error' AS error,
              e.payload->>'via' AS via, ${callerName} AS name
         FROM events e ${callerJoin}
        WHERE ${scope.replace(/(org_id|kind|payload|created_at)\b/g, "e.$1")}
          AND e.payload->>'ok' = 'false'
        ORDER BY e.created_at DESC LIMIT 20`,
      binds,
    ),
  ]);
  const t = totals.rows[0] ?? {};
  return {
    days,
    totals: {
      calls: num(t.calls),
      errors: num(t.errors),
      people: num(t.people),
      p50_ms: numOrNull(t.p50),
      p95_ms: numOrNull(t.p95),
      last_call_at: t.last_call_at ? ts(t.last_call_at) : null,
    },
    by_day: byDay.rows.map((r) => ({ day: String(r.day), calls: num(r.calls), errors: num(r.errors) })),
    by_tool: byTool.rows.map((r) => ({
      tool: String(r.tool),
      calls: num(r.calls),
      errors: num(r.errors),
      p95_ms: numOrNull(r.p95),
    })),
    by_person: byPerson.rows.map((r) => ({
      user_id: String(r.user_id ?? ""),
      name: (r.name as string | null) ?? "Unknown caller",
      calls: num(r.calls),
      errors: num(r.errors),
      last_call_at: ts(r.last_call_at),
    })),
    recent_failures: failures.rows.map((r) => ({
      at: ts(r.at),
      tool: String(r.tool),
      error: (r.error as string | null) ?? "The call failed; no error was recorded.",
      name: (r.name as string | null) ?? null,
      via: String(r.via ?? "chat"),
    })),
  };
}
