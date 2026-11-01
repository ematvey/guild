// Usage/cost reports: per user, team or model, bucketed per day or hour, and
// today/month totals. Admins see the whole org; members only themselves.
// The ClickHouse reads live in store/usage.ts.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { queryParam, requireUser } from "./error.js";
import type { IdentityCtx, InfraContext } from "../route-contexts.js";
import { errorText, startOfDayUtc, startOfMonthUtc } from "../usage.js";
import { isUuid } from "../time.js";
import type { UserRow } from "../store/identity.js";
import {
  UsageReports,
  usageGroupNames,
  type UsageFilters,
  type UsageGroup,
  type UsageScope,
} from "../store/usage.js";

function parseGroup(groupBy: string | undefined): UsageGroup {
  if (groupBy === undefined || groupBy === "user") return "user";
  if (groupBy === "team" || groupBy === "model") return groupBy;
  throw ApiError.badRequest(`unknown group_by ${groupBy}`);
}

function parseDate(s: string, field: string): Date {
  const rfc = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (rfc) {
    const date = new Date(s);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(s)) return new Date(`${s}T00:00:00Z`);
  throw ApiError.badRequest(`${field} must be RFC 3339 or YYYY-MM-DD`);
}

function uuidFilter(req: FastifyRequest, name: string): string | undefined {
  const value = queryParam(req, name);
  if (value !== undefined && !isUuid(value)) throw ApiError.badRequest(`invalid ${name}: ${value}`);
  return value;
}

function timeFilters(req: FastifyRequest): UsageFilters {
  const from = queryParam(req, "from");
  const to = queryParam(req, "to");
  return {
    ...(from === undefined ? {} : { from: parseDate(from, "from") }),
    ...(to === undefined ? {} : { to: parseDate(to, "to") }),
  };
}

function scopeOf(user: UserRow): UsageScope {
  return { orgId: user.org_id, userId: user.role === "admin" ? null : user.id };
}

async function report<T>(what: string, read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    throw ApiError.internal(`${what} failed: ${errorText(error)}`);
  }
}

/** Raw uuids mean nothing in the UI: user groups show emails and team
 *  groups team names (unknown ids — e.g. deleted rows — keep the raw value
 *  rather than disappearing from the breakdown). */
async function nameGroups(
  infra: InfraContext,
  orgId: string,
  group: UsageGroup | null,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (group !== "user" && group !== "team") return rows;
  const names = await usageGroupNames(infra.pool, orgId, group);
  return rows.map((r) => {
    const id = r["group"];
    if (typeof id === "string" && id !== "none") {
      const name = names.get(id);
      if (name !== undefined) return { ...r, group: name };
    }
    return r;
  });
}

export function registerUsageRoutes(app: FastifyInstance, ctx: IdentityCtx, infra: InfraContext): void {
  const reports = new UsageReports(infra.usage.client);

  app.get("/api/v1/usage", async (req) => {
    const user = await requireUser(ctx, req);
    const group = parseGroup(queryParam(req, "group_by"));
    const teamId = uuidFilter(req, "team_id");
    const filters: UsageFilters = { ...timeFilters(req), ...(teamId === undefined ? {} : { teamId }) };
    let rows = await report("usage query", reports.breakdown(scopeOf(user), group, filters));
    rows = await nameGroups(infra, user.org_id, group, rows);
    // cost_usd is an f64 column; an integral value renders as an integer.
    rows = rows.map((r) => ({ ...r, cost_usd: Number(r["cost_usd"] ?? 0) }));
    return JSON.stringify({ rows });
  });

  app.get("/api/v1/usage/series", async (req) => {
    const user = await requireUser(ctx, req);
    const bucket = queryParam(req, "bucket") ?? "day";
    if (bucket !== "day" && bucket !== "hour") throw ApiError.badRequest(`unknown bucket ${bucket}`);
    const groupBy = queryParam(req, "group_by");
    const group = groupBy === undefined || groupBy === "none" ? null : parseGroup(groupBy);
    const chatId = uuidFilter(req, "chat_id");
    const filters: UsageFilters = { ...timeFilters(req), ...(chatId === undefined ? {} : { chatId }) };
    const raw = await report("usage series", reports.series(scopeOf(user), bucket, group, filters));
    // The bucket renders as RFC 3339 with an explicit +00:00 offset.
    const rows = raw.map((r) => ({
      bucket: `${String(r["bucket"]).replace(" ", "T")}+00:00`,
      group: r["group"] ?? "",
      tokens_in: r["tokens_in"],
      tokens_out: r["tokens_out"],
      cost_usd: Number(r["cost_usd"] ?? 0),
      requests: r["requests"],
    }));
    return JSON.stringify({ rows: await nameGroups(infra, user.org_id, group, rows) });
  });

  app.get("/api/v1/usage/summary", async (req) => {
    const user = await requireUser(ctx, req);
    const scope = scopeOf(user);
    const today = await report("usage query", reports.spendSince(scope, startOfDayUtc()));
    const month = await report("usage query", reports.spendSince(scope, startOfMonthUtc()));
    return JSON.stringify({
      today_cost_usd: today.cost,
      month_cost_usd: month.cost,
      today_tokens: today.tokens,
      month_tokens: month.tokens,
    });
  });
}
