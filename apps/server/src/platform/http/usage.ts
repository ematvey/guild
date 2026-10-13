// Usage/cost queries over ClickHouse: per user, team, model, day. Admins
// see the whole org; members only themselves. ClickHouse binds use
// URL params (`?` →
// `{param_N:Type}` URL params); the SELECT statements are ported verbatim.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { queryParam, requireUser } from "./error.js";
import type { IdentityCtx } from "../contexts.js";
import type { InfraContext } from "../contexts.js";
import { errorText, startOfDayUtc, startOfMonthUtc } from "../usage.js";
import { rustFloat, rustJsonText } from "../provider/sse.js";
import { isUuid } from "../time.js";

interface UsageQuery {
  from?: string;
  to?: string;
  group_by?: string;
  team_id?: string;
  bucket?: string;
  chat_id?: string;
}

function readQuery(req: FastifyRequest): UsageQuery {
  return {
    from: queryParam(req, "from"),
    to: queryParam(req, "to"),
    group_by: queryParam(req, "group_by"),
    team_id: queryParam(req, "team_id"),
    bucket: queryParam(req, "bucket"),
    chat_id: queryParam(req, "chat_id"),
  };
}

/** Grouping expression + label for the breakdown queries. */
function groupExpr(groupBy?: string): [string, string] {
  if (groupBy === undefined || groupBy === "user") return ["toString(user_id)", "user"];
  if (groupBy === "team") return ["coalesce(toString(team_id), 'none')", "team"];
  if (groupBy === "model") return ["model", "model"];
  throw ApiError.badRequest(`unknown group_by ${groupBy}`);
}

function parseDate(s: string, field: string): Date {
  const rfc = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (rfc) {
    const date = new Date(s);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) {
    return new Date(`${s}T00:00:00Z`);
  }
  throw ApiError.badRequest(`${field} must be RFC 3339 or YYYY-MM-DD`);
}

/** Raw uuids mean nothing in the UI: resolve user groups to emails and team
 *  groups to team names (unknown ids — e.g. deleted rows — keep the raw
 *  value rather than disappearing from the breakdown). */
async function resolveGroupNames(
  infra: InfraContext,
  orgId: string,
  kind: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (kind !== "user" && kind !== "team") return rows;
  let byId: Map<string, string>;
  if (kind === "user") {
    const res = await infra.pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE org_id = $1",
      [orgId],
    );
    byId = new Map(res.rows.map((u) => [u.id, u.email]));
  } else {
    const res = await infra.pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM teams WHERE org_id = $1",
      [orgId],
    );
    byId = new Map(res.rows.map((t) => [t.id, t.name]));
  }
  return rows.map((r) => {
    const group = r["group"];
    if (typeof group === "string" && group !== "none") {
      const name = byId.get(group);
      if (name !== undefined) r["group"] = name;
    }
    return r;
  });
}

export function registerUsageRoutes(app: FastifyInstance, ctx: IdentityCtx, infra: InfraContext): void {
  app.get("/api/v1/usage", async (req) => {
    const user = await requireUser(ctx, req);
    const q = readQuery(req);
    const [groupExprText, kind] = groupExpr(q.group_by);
    // Value positions are bound parameters — identifiers (group expression)
    // stay a code whitelist. Order of binds must match the appended `?`s.
    let sql =
      `SELECT ${groupExprText} AS "group", sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, ` +
      "sum(cost_usd) AS cost_usd, count() AS requests " +
      "FROM (SELECT * FROM usage_events WHERE org_id = toUUID(?) ORDER BY ts DESC LIMIT 1 BY org_id, request_id) WHERE 1=1";
    const memberScoped = user.role !== "admin";
    const binds: (string | number)[] = [user.org_id];
    if (memberScoped) {
      sql += " AND user_id = toUUID(?)";
      binds.push(user.id);
    }
    if (q.team_id !== undefined) {
      if (!isUuid(q.team_id)) throw ApiError.badRequest(`invalid team_id: ${q.team_id}`);
      sql += " AND team_id = toUUID(?)";
      binds.push(q.team_id);
    }
    if (q.from !== undefined) {
      parseDate(q.from, "from");
      sql += " AND ts >= toDateTime(?)";
      binds.push(Math.floor(parseDate(q.from, "from").getTime() / 1000));
    }
    if (q.to !== undefined) {
      parseDate(q.to, "to");
      sql += " AND ts <= toDateTime(?)";
      binds.push(Math.floor(parseDate(q.to, "to").getTime() / 1000));
    }
    // Group by the raw expression (not the alias — `group` is a reserved
    // word); ClickHouse >= 26.x rejects non-aggregate columns otherwise.
    sql += ` GROUP BY ${groupExprText}`;

    let rows: Record<string, unknown>[];
    try {
      rows = await infra.usage.client.query(sql, binds);
    } catch (error) {
      const err = error as { unknownTable?: boolean; body?: string };
      if (err.unknownTable || (err.body ?? "").includes("UNKNOWN_TABLE")) {
        rows = [];
      } else {
        throw ApiError.internal(`usage query failed: ${errorText(error)}`);
      }
    }
    rows = await resolveGroupNames(infra, user.org_id, kind, rows);
    // cost_usd is an f64 column: serde renders integral floats with a
    // ".0" tail.
    rows = rows.map((r) => ({ ...r, cost_usd: rustFloat(Number(r["cost_usd"] ?? 0)) }));
    return rustJsonText({ rows });
  });

  app.get("/api/v1/usage/series", async (req) => {
    const user = await requireUser(ctx, req);
    const q = readQuery(req);
    let bucketExpr: string;
    if (q.bucket === undefined || q.bucket === "day") bucketExpr = "toStartOfDay(ts)";
    else if (q.bucket === "hour") bucketExpr = "toStartOfHour(ts)";
    else throw ApiError.badRequest(`unknown bucket ${q.bucket}`);
    let [groupExprText, kind] =
      q.group_by === undefined || q.group_by === "none" ? (["''", "none"] as [string, string]) : groupExpr(q.group_by);
    if (kind === "none") groupExprText = "''";

    // Bound parameters, as in `usage` above.
    let sql =
      `SELECT ${bucketExpr} AS bucket, ${groupExprText} AS "group", sum(tokens_in) AS tokens_in, ` +
      "sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd, count() AS requests " +
      "FROM (SELECT * FROM usage_events WHERE org_id = toUUID(?) ORDER BY ts DESC LIMIT 1 BY org_id, request_id) WHERE 1=1";
    const memberScoped = user.role !== "admin";
    const binds: (string | number)[] = [user.org_id];
    if (memberScoped) {
      sql += " AND user_id = toUUID(?)";
      binds.push(user.id);
    }
    if (q.chat_id !== undefined) {
      if (!isUuid(q.chat_id)) throw ApiError.badRequest(`invalid chat_id: ${q.chat_id}`);
      sql += " AND session_id = toUUID(?)";
      binds.push(q.chat_id);
    }
    if (q.from !== undefined) {
      parseDate(q.from, "from");
      sql += " AND ts >= toDateTime(?)";
      binds.push(Math.floor(parseDate(q.from, "from").getTime() / 1000));
    }
    if (q.to !== undefined) {
      parseDate(q.to, "to");
      sql += " AND ts <= toDateTime(?)";
      binds.push(Math.floor(parseDate(q.to, "to").getTime() / 1000));
    }
    // Group by the bucket and (when grouping) the raw group expression —
    // not the aliases (`group` is a reserved word); ClickHouse >= 26.x
    // rejects non-aggregate columns without an explicit GROUP BY.
    sql += ` GROUP BY ${bucketExpr}`;
    if (groupExprText !== "''") sql += `, ${groupExprText}`;

    let rows: Record<string, unknown>[];
    try {
      rows = await infra.usage.client.query(sql, binds);
    } catch (error) {
      const err = error as { unknownTable?: boolean; body?: string };
      if (err.unknownTable || (err.body ?? "").includes("UNKNOWN_TABLE")) {
        rows = [];
      } else {
        throw ApiError.internal(`usage series failed: ${errorText(error)}`);
      }
    }

    // Serialize bucket as ISO for the client (+00:00, chrono to_rfc3339).
    rows = rows.map((r) => ({
      bucket: `${String(r["bucket"]).replace(" ", "T")}+00:00`,
      group: r["group"] ?? "",
      tokens_in: r["tokens_in"],
      tokens_out: r["tokens_out"],
      cost_usd: rustFloat(Number(r["cost_usd"] ?? 0)),
      requests: r["requests"],
    }));
    rows = await resolveGroupNames(infra, user.org_id, kind, rows);
    return rustJsonText({ rows });
  });

  app.get("/api/v1/usage/summary", async (req) => {
    const user = await requireUser(ctx, req);
    const memberScoped = user.role !== "admin";
    let scope = "org_id = toUUID(?)";
    if (memberScoped) scope += " AND user_id = toUUID(?)";
    const startOfDay = startOfDayUtc();
    const startOfMonth = startOfMonthUtc();

    const binds = (tsBound: number): (string | number)[] =>
      memberScoped ? [user.org_id, user.id, tsBound] : [user.org_id, tsBound];
    const sumSql = (tsBound: number) =>
      infra.usage.client
        .query(
          `SELECT coalesce(sum(cost_usd), 0) AS cost_usd, coalesce(sum(tokens_in + tokens_out), 0) AS tokens FROM (SELECT * FROM usage_events WHERE ${scope} ORDER BY ts DESC LIMIT 1 BY org_id, request_id) WHERE ts >= toDateTime(?)`,
          binds(tsBound),
        )
        .catch((error: unknown) => {
          const err = error as { unknownTable?: boolean; body?: string };
          if (err.unknownTable || (err.body ?? "").includes("UNKNOWN_TABLE")) return [];
          throw ApiError.internal(`usage query failed: ${errorText(error)}`);
        });
    const totals = (rows: Record<string, unknown>[]): { cost: number; tokens: number } => {
      const row = rows[0] ?? {};
      const num = (key: string): number => {
        const value = row[key];
        if (typeof value === "number") return value;
        if (typeof value === "string") return Number(value) || 0;
        return 0;
      };
      return { cost: num("cost_usd"), tokens: num("tokens") };
    };
    const today = totals(await sumSql(Math.floor(startOfDay.getTime() / 1000)));
    const month = totals(await sumSql(Math.floor(startOfMonth.getTime() / 1000)));
    return rustJsonText({
      today_cost_usd: rustFloat(today.cost),
      month_cost_usd: rustFloat(month.cost),
      today_tokens: today.tokens,
      month_tokens: month.tokens,
    });
  });
}
