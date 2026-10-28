// Activity API: traces (agent runs), spans (LLM and tool calls), sessions
// (chats) and the activity summary, all over ClickHouse. Admin scope is the
// session's org; member scope is the session's user id. No org id from the
// client is ever trusted. Payload bodies are admin-only.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { queryParam, requireUser } from "./error.js";
import { errorText } from "../usage.js";
import { isUuid } from "../time.js";
import type { IdentityCtx, InfraContext } from "../route-contexts.js";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** RFC 3339 or YYYY-MM-DD, same contract as the usage routes. */
function parseDate(s: string, field: string): Date {
  const rfc = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (rfc) {
    const date = new Date(s);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) return new Date(`${s}T00:00:00Z`);
  throw ApiError.badRequest(`${field} must be RFC 3339 or YYYY-MM-DD`);
}

function limitOf(req: FastifyRequest): number {
  const raw = queryParam(req, "limit");
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw ApiError.badRequest(`limit must be an integer in [1, ${MAX_LIMIT}]`);
  }
  return value;
}

function offsetOf(req: FastifyRequest): number {
  const raw = queryParam(req, "offset");
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw ApiError.badRequest("offset must be a nonnegative integer");
  return value;
}

function uuidFilter(req: FastifyRequest, name: string): string | undefined {
  const value = queryParam(req, name);
  if (value === undefined || value === "") return undefined;
  if (!isUuid(value)) throw ApiError.badRequest(`invalid ${name}: ${value}`);
  return value;
}

function windowOf(req: FastifyRequest): { from: Date; to: Date } {
  const from = queryParam(req, "from");
  const to = queryParam(req, "to");
  return {
    from: from === undefined ? new Date(Date.now() - 7 * 86_400_000) : parseDate(from, "from"),
    to: to === undefined ? new Date(Date.now() + 86_400_000) : parseDate(to, "to"),
  };
}

/** The llm_calls tables do not exist yet (ClickHouse never saw the DDL):
 *  the queries degrade to empty, exactly like the usage routes. */
function isUnknownTable(error: unknown): boolean {
  const err = error as { unknownTable?: boolean; body?: string };
  return err.unknownTable === true || (err.body ?? "").includes("UNKNOWN_TABLE");
}

function iso(value: unknown): unknown {
  return typeof value === "string" ? `${value.replace(" ", "T")}+00:00` : value;
}

function number(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function renderSpan(row: Record<string, unknown>): Record<string, unknown> {
  return {
    span_id: row["span_id"],
    trace_id: row["trace_id"],
    run_id: row["run_id"] ?? null,
    parent_span_id: row["parent_span_id"] ?? null,
    name: row["name"] ?? "",
    span_type: row["span_type"] ?? "llm",
    status: row["status"] ?? "ok",
    start_time: iso(row["start_time"]),
    end_time: iso(row["end_time"]),
    duration_ms: number(row["duration_ms"]),
    model: row["model"] ?? "",
    provider: row["provider"] ?? "",
    tokens_in: number(row["tokens_in"]),
    tokens_out: number(row["tokens_out"]),
    reasoning_tokens: number(row["reasoning_tokens"]),
    cost_usd: number(row["cost_usd"]),
    error: row["error"] ?? "",
    input: row["input"] ?? "",
    output: row["output"] ?? "",
    request_id: row["request_id"] ?? null,
    caller: row["caller"] ?? "",
    session_id: row["session_id"] ?? null,
    chat_id: row["chat_id"] ?? null,
    attributes: parseAttributes(row["attributes"]),
  };
}

function parseAttributes(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function renderTrace(row: Record<string, unknown>): Record<string, unknown> {
  const started = typeof row["started_at"] === "string" ? new Date(`${row["started_at"].replace(" ", "T")}Z`) : null;
  const finished = typeof row["finished_at"] === "string" ? new Date(`${row["finished_at"].replace(" ", "T")}Z`) : null;
  const duration =
    started === null ? 0 : Math.max(0, (finished?.getTime() ?? Date.now()) - started.getTime());
  return {
    trace_id: row["trace_id"],
    org_id: row["org_id"],
    user_id: row["user_id"] ?? null,
    agent_id: row["agent_id"] ?? null,
    agent_name: row["agent_name"] ?? "",
    session_id: row["session_id"] ?? null,
    thread_id: row["thread_id"] ?? null,
    parent_trace_id: row["parent_trace_id"] ?? null,
    routine_id: row["routine_id"] ?? null,
    trigger: row["trigger"] ?? "",
    status: row["status"] ?? "",
    name: row["name"] ?? "",
    summary: row["summary"] ?? "",
    error: row["error"] ?? "",
    started_at: iso(row["started_at"]),
    finished_at: iso(row["finished_at"]),
    duration_ms: duration,
    span_count: number(row["span_count"]),
    call_count: number(row["call_count"]),
    tool_count: number(row["tool_count"]),
    error_count: number(row["error_count"]),
    tokens_in: number(row["tokens_in"]),
    tokens_out: number(row["tokens_out"]),
    reasoning_tokens: number(row["reasoning_tokens"]),
    cost_usd: number(row["cost_usd"]),
    longest_ms: number(row["longest_ms"]),
  };
}

function renderSession(row: Record<string, unknown>): Record<string, unknown> {
  const started = typeof row["started_at"] === "string" ? new Date(`${row["started_at"].replace(" ", "T")}Z`) : null;
  const ended = typeof row["ended_at"] === "string" ? new Date(`${row["ended_at"].replace(" ", "T")}Z`) : null;
  return {
    session_id: row["session_id"],
    traces: number(row["traces"]),
    calls: number(row["calls"]),
    tool_calls: number(row["tool_calls"]),
    tokens_in: number(row["tokens_in"]),
    tokens_out: number(row["tokens_out"]),
    cost_usd: number(row["cost_usd"]),
    errors: number(row["errors"]),
    started_at: iso(row["started_at"]),
    ended_at: iso(row["ended_at"]),
    duration_ms:
      started === null ? 0 : Math.max(0, (ended?.getTime() ?? started.getTime()) - started.getTime()),
  };
}

export function registerActivityRoutes(app: FastifyInstance, ctx: IdentityCtx, infra: InfraContext): void {
  /** Admins see the org; members see their own traces and calls. */
  const viewer = async (req: FastifyRequest) => requireUser(ctx, req);

  const scopedUserId = (user: { role: string; id: string }): string | undefined =>
    user.role === "admin" ? undefined : user.id;

  app.get("/api/v1/activity/traces", async (req) => {
    const user = await viewer(req);
    const window = windowOf(req);
    const agent = uuidFilter(req, "agent");
    const parent = uuidFilter(req, "parent");
    const session = uuidFilter(req, "session");
    const status = queryParam(req, "status");
    const trigger = queryParam(req, "trigger");
    const q = queryParam(req, "q");
    let rows: Record<string, unknown>[];
    let total: number;
    try {
      const res = await infra.trace.traces({
        orgId: user.org_id,
        userId: scopedUserId(user),
        from: window.from,
        to: window.to,
        ...(agent === undefined ? {} : { agentId: agent }),
        ...(parent === undefined ? {} : { parentTraceId: parent }),
        ...(session === undefined ? {} : { sessionId: session }),
        ...(status === undefined || status === "" ? {} : { status }),
        ...(trigger === undefined || trigger === "" ? {} : { trigger }),
        ...(q === undefined || q === "" ? {} : { query: q }),
        limit: limitOf(req),
        offset: offsetOf(req),
      });
      rows = res.rows;
      total = res.total;
    } catch (error) {
      if (isUnknownTable(error)) {
        rows = [];
        total = 0;
      } else {
        throw ApiError.internal(`activity query failed: ${errorText(error)}`);
      }
    }
    return JSON.stringify({ traces: rows.map(renderTrace), total });
  });

  app.get("/api/v1/activity/traces/:id", async (req) => {
    const user = await requireUser(ctx, req);
    const id = (req.params as Record<string, string>)["id"] ?? "";
    if (!isUuid(id)) throw ApiError.badRequest(`invalid trace id: ${id}`);
    let result: Awaited<ReturnType<typeof infra.trace.trace>>;
    try {
      result = await infra.trace.trace(user.org_id, id);
    } catch (error) {
      if (isUnknownTable(error)) result = { trace: null, spans: [], children: [] };
      else throw ApiError.internal(`trace query failed: ${errorText(error)}`);
    }
    if (result.trace === null) throw ApiError.notFound("no such trace");
    const owner = result.trace["user_id"];
    if (user.role !== "admin" && owner !== user.id) throw ApiError.notFound("no such trace");
    return JSON.stringify({
      trace: renderTrace(result.trace),
      spans: result.spans.map(renderSpan),
      children: result.children.map(renderTrace),
    });
  });

  app.get("/api/v1/activity/spans", async (req) => {
    const user = await viewer(req);
    const window = windowOf(req);
    const spanType = queryParam(req, "type");
    if (spanType !== undefined && spanType !== "" && spanType !== "llm" && spanType !== "tool") {
      throw ApiError.badRequest(`unknown span type ${spanType}`);
    }
    const traceId = uuidFilter(req, "trace");
    const sessionId = uuidFilter(req, "session");
    const caller = queryParam(req, "caller");
    if (caller !== undefined && caller !== "" && caller !== "model" && caller !== "judge") {
      throw ApiError.badRequest(`unknown caller ${caller}`);
    }
    const status = queryParam(req, "status");
    let rows: Record<string, unknown>[];
    let total: number;
    try {
      const res = await infra.trace.spans({
        orgId: user.org_id,
        userId: scopedUserId(user),
        from: window.from,
        to: window.to,
        ...(spanType === undefined || spanType === "" ? {} : { spanType }),
        ...(traceId === undefined ? {} : { traceId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(caller === undefined || caller === "" ? {} : { caller }),
        ...(status === undefined || status === "" ? {} : { status }),
        ...(queryParam(req, "model") === undefined ? {} : { model: queryParam(req, "model")! }),
        ...(queryParam(req, "q") === undefined || queryParam(req, "q") === ""
          ? {}
          : { query: queryParam(req, "q")! }),
        limit: limitOf(req),
        offset: offsetOf(req),
      });
      rows = res.rows;
      total = res.total;
    } catch (error) {
      if (isUnknownTable(error)) {
        rows = [];
        total = 0;
      } else {
        throw ApiError.internal(`span query failed: ${errorText(error)}`);
      }
    }
    return JSON.stringify({ spans: rows.map(renderSpan), total });
  });

  app.get("/api/v1/activity/sessions", async (req) => {
    const user = await viewer(req);
    const window = windowOf(req);
    let rows: Record<string, unknown>[];
    let total: number;
    try {
      const res = await infra.trace.sessions({
        orgId: user.org_id,
        userId: scopedUserId(user),
        from: window.from,
        to: window.to,
        limit: limitOf(req),
        offset: offsetOf(req),
      });
      rows = res.rows;
      total = res.total;
    } catch (error) {
      if (isUnknownTable(error)) {
        rows = [];
        total = 0;
      } else {
        throw ApiError.internal(`session query failed: ${errorText(error)}`);
      }
    }
    return JSON.stringify({ sessions: rows.map(renderSession), total });
  });

  app.get("/api/v1/activity/summary", async (req) => {
    const user = await viewer(req);
    const window = windowOf(req);
    let result: Record<string, unknown>;
    try {
      result = await infra.trace.summary({
        orgId: user.org_id,
        userId: scopedUserId(user),
        from: window.from,
        to: window.to,
      });
    } catch (error) {
      if (isUnknownTable(error)) result = { totals: {}, by_day: [] };
      else throw ApiError.internal(`activity summary failed: ${errorText(error)}`);
    }
    const totals = (result["totals"] ?? {}) as Record<string, unknown>;
    const byDay = Array.isArray(result["by_day"]) ? (result["by_day"] as Record<string, unknown>[]) : [];
    return JSON.stringify({
      totals: {
        traces: number(totals["traces"]),
        failed_traces: number(totals["failed_traces"]),
        calls: number(totals["calls"]),
        tool_calls: number(totals["tool_calls"]),
        errors: number(totals["errors"]),
        tokens_in: number(totals["tokens_in"]),
        tokens_out: number(totals["tokens_out"]),
        reasoning_tokens: number(totals["reasoning_tokens"]),
        cost_usd: number(totals["cost_usd"]),
        p50_ms: number(totals["p50_ms"]),
        p95_ms: number(totals["p95_ms"]),
      },
      by_day: byDay.map((row) => ({
        day: iso(row["day"]),
        calls: number(row["calls"]),
        tokens_in: number(row["tokens_in"]),
        tokens_out: number(row["tokens_out"]),
        cost_usd: number(row["cost_usd"]),
        p95_ms: number(row["p95_ms"]),
      })),
    });
  });

  app.get("/api/v1/activity/spans/:id/payloads", async (req) => {
    const user = await requireUser(ctx, req);
    if (user.role !== "admin") throw ApiError.forbidden();
    const id = (req.params as Record<string, string>)["id"] ?? "";
    if (!isUuid(id)) throw ApiError.badRequest(`invalid span id: ${id}`);
    let rows: Record<string, unknown>[];
    try {
      rows = await infra.trace.payloads(user.org_id, id);
    } catch (error) {
      if (isUnknownTable(error)) rows = [];
      else throw ApiError.internal(`payload query failed: ${errorText(error)}`);
    }
    return JSON.stringify({ payloads: rows.map((row) => ({ kind: row["kind"], body: row["body"] })) });
  });
}
