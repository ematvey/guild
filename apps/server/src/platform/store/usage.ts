// Usage reports over ClickHouse's usage_events: the per-group breakdown,
// the bucketed series, and spend since a point in time, each scoped to an
// org or to one member of it. A request id may be recorded more than once
// (a retried insert): every read goes through the one de-duplicating
// subquery, which keeps the newest row per (org_id, request_id).

import type { ClickhouseClient } from "../clickhouse.js";
import type { PlatformPool } from "../db.js";

type Bind = string | number;

/** usage_events with one row per (org_id, request_id), filtered by `where`
 *  (its binds come first in the statement). */
export function dedupedUsageEvents(where: string): string {
  return `(SELECT * FROM usage_events WHERE ${where} ORDER BY ts DESC LIMIT 1 BY org_id, request_id)`;
}

/** Whose usage a report covers: the whole org, or one member of it. */
export interface UsageScope {
  orgId: string;
  /** null = the whole org. */
  userId: string | null;
}

export type UsageGroup = "user" | "team" | "model";

/** Grouping expressions are a code whitelist; values are bound. */
const GROUP_EXPR: Record<UsageGroup, string> = {
  user: "toString(user_id)",
  team: "coalesce(toString(team_id), 'none')",
  model: "model",
};

const BUCKET_EXPR = { day: "toStartOfDay(ts)", hour: "toStartOfHour(ts)" } as const;
export type UsageBucket = keyof typeof BUCKET_EXPR;

export interface UsageFilters {
  teamId?: string;
  /** Matches the session_id column (a chat's usage). */
  chatId?: string;
  from?: Date;
  to?: Date;
}

/** The table does not exist yet (no usage recorded): reports read empty. */
function emptyWhenNoTable(error: unknown): Record<string, unknown>[] {
  const err = error as { unknownTable?: boolean; body?: string };
  if (err.unknownTable === true || (err.body ?? "").includes("UNKNOWN_TABLE")) return [];
  throw error;
}

function scoped(scope: UsageScope, filters: UsageFilters = {}): { where: string; binds: Bind[] } {
  let where = "org_id = toUUID(?)";
  const binds: Bind[] = [scope.orgId];
  if (scope.userId !== null) {
    where += " AND user_id = toUUID(?)";
    binds.push(scope.userId);
  }
  if (filters.teamId !== undefined) {
    where += " AND team_id = toUUID(?)";
    binds.push(filters.teamId);
  }
  if (filters.chatId !== undefined) {
    where += " AND session_id = toUUID(?)";
    binds.push(filters.chatId);
  }
  if (filters.from !== undefined) {
    where += " AND ts >= toDateTime(?)";
    binds.push(Math.floor(filters.from.getTime() / 1000));
  }
  if (filters.to !== undefined) {
    where += " AND ts <= toDateTime(?)";
    binds.push(Math.floor(filters.to.getTime() / 1000));
  }
  return { where, binds };
}

export class UsageReports {
  constructor(private readonly client: ClickhouseClient) {}

  /** Token, cost and request totals per group. */
  async breakdown(scope: UsageScope, group: UsageGroup, filters: UsageFilters): Promise<Record<string, unknown>[]> {
    const expr = GROUP_EXPR[group];
    const { where, binds } = scoped(scope, filters);
    // GROUP BY names the raw expression: `group` is a reserved word, and
    // ClickHouse rejects non-aggregate columns otherwise.
    return this.client
      .query(
        `SELECT ${expr} AS "group", sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, ` +
          `sum(cost_usd) AS cost_usd, count() AS requests FROM ${dedupedUsageEvents(where)} GROUP BY ${expr}`,
        binds,
      )
      .catch(emptyWhenNoTable);
  }

  /** Totals per time bucket, optionally split per group. */
  async series(
    scope: UsageScope,
    bucket: UsageBucket,
    group: UsageGroup | null,
    filters: UsageFilters,
  ): Promise<Record<string, unknown>[]> {
    const bucketExpr = BUCKET_EXPR[bucket];
    const groupExpr = group === null ? "''" : GROUP_EXPR[group];
    const { where, binds } = scoped(scope, filters);
    return this.client
      .query(
        `SELECT ${bucketExpr} AS bucket, ${groupExpr} AS "group", sum(tokens_in) AS tokens_in, ` +
          `sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd, count() AS requests ` +
          `FROM ${dedupedUsageEvents(where)} GROUP BY ${bucketExpr}${group === null ? "" : `, ${groupExpr}`}`,
        binds,
      )
      .catch(emptyWhenNoTable);
  }

  /** Cost and tokens (in + out) since `since`. */
  async spendSince(scope: UsageScope, since: Date): Promise<{ cost: number; tokens: number }> {
    const { where, binds } = scoped(scope, { from: since });
    const rows = await this.client
      .query(
        `SELECT coalesce(sum(cost_usd), 0) AS cost_usd, coalesce(sum(tokens_in + tokens_out), 0) AS tokens ` +
          `FROM ${dedupedUsageEvents(where)}`,
        binds,
      )
      .catch(emptyWhenNoTable);
    const row = rows[0] ?? {};
    const num = (key: string): number => {
      const value = row[key];
      if (typeof value === "number") return value;
      if (typeof value === "string") return Number(value) || 0;
      return 0;
    };
    return { cost: num("cost_usd"), tokens: num("tokens") };
  }
}

/** Display names for user or team group ids: user emails, team names. */
export async function usageGroupNames(
  pool: PlatformPool,
  orgId: string,
  group: "user" | "team",
): Promise<Map<string, string>> {
  if (group === "user") {
    const res = await pool.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE org_id = $1", [
      orgId,
    ]);
    return new Map(res.rows.map((u) => [u.id, u.email]));
  }
  const res = await pool.query<{ id: string; name: string }>("SELECT id, name FROM teams WHERE org_id = $1", [orgId]);
  return new Map(res.rows.map((t) => [t.id, t.name]));
}
