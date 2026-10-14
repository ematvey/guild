// LLM observability queries over ClickHouse llm_calls: admin (org-wide)
// and member (own-calls) endpoints. Payload bodies are admin-only and
// fetched per row. No org id from the client is ever trusted — the admin
// scope is the session's org, the member scope is the session's user id.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { queryParam, requireUser } from "./error.js";
import { rustFloat, rustJsonText } from "../provider/sse.js";
import { errorText } from "../usage.js";
import { isUuid } from "../time.js";
import type { IdentityCtx, InfraContext } from "../contexts.js";

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

interface CallsQuery {
  from?: string;
  to?: string;
  caller?: string;
  model?: string;
  chat_id?: string;
  request_id?: string;
  limit?: string;
  offset?: string;
}

function readCallsQuery(req: FastifyRequest): CallsQuery {
  return {
    from: queryParam(req, "from"),
    to: queryParam(req, "to"),
    caller: queryParam(req, "caller"),
    model: queryParam(req, "model"),
    chat_id: queryParam(req, "chat_id"),
    request_id: queryParam(req, "request_id"),
    limit: queryParam(req, "limit"),
    offset: queryParam(req, "offset"),
  };
}

/** Renders ClickHouse rows into the wire shape: timestamps as RFC 3339
 *  (+00:00), costs with serde's integral-float ".0" tail. */
/** The llm_calls tables do not exist yet (ClickHouse never saw the DDL):
 *  the queries degrade to empty, exactly like the usage routes. */
function isUnknownTable(error: unknown): boolean {
  const err = error as { unknownTable?: boolean; body?: string };
  return err.unknownTable === true || (err.body ?? "").includes("UNKNOWN_TABLE");
}

function renderCallRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...r,
    ts: typeof r["ts"] === "string" ? `${r["ts"].replace(" ", "T")}+00:00` : r["ts"],
    cost_usd: rustFloat(Number(r["cost_usd"] ?? 0)),
    conversation_id: r["conversation_id"] === null ? null : Number(r["conversation_id"] ?? 0) || null,
    turn: r["turn"] === null ? null : Number(r["turn"] ?? 0),
    verdict: r["verdict"] === null ? null : Boolean(r["verdict"]),
    stream: Boolean(r["stream"]),
    tokens_in: Number(r["tokens_in"] ?? 0),
    tokens_out: Number(r["tokens_out"] ?? 0),
    reasoning_tokens: Number(r["reasoning_tokens"] ?? 0),
    duration_ms: Number(r["duration_ms"] ?? 0),
    prompt_chars: Number(r["prompt_chars"] ?? 0),
    completion_chars: Number(r["completion_chars"] ?? 0),
  }));
}

export function registerObservabilityRoutes(app: FastifyInstance, ctx: IdentityCtx, infra: InfraContext): void {
  /** The admin scope: the session user must hold the admin role (the org
   *  id always comes from the session, never the client). */
  const adminOf = async (req: FastifyRequest) => {
    const user = await requireUser(ctx, req);
    if (user.role !== "admin") throw ApiError.forbidden();
    return user;
  };
  /** One handler body for both scopes: `memberScoped` pins every query to
   *  the caller's user id (members see their own calls; admins the org). */
  const scopedCalls = async (req: FastifyRequest, memberScoped: boolean) => {
    const user = await (memberScoped ? requireUser(ctx, req) : adminOf(req));
    const q = readCallsQuery(req);
    if (q.caller !== undefined && q.caller !== "model" && q.caller !== "judge") {
      throw ApiError.badRequest(`unknown caller ${q.caller}`);
    }
    if (q.chat_id !== undefined && !isUuid(q.chat_id)) throw ApiError.badRequest(`invalid chat_id: ${q.chat_id}`);
    if (q.request_id !== undefined && !isUuid(q.request_id)) throw ApiError.badRequest(`invalid request_id: ${q.request_id}`);
    const limitRaw = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
      throw ApiError.badRequest(`limit must be an integer in [1, ${MAX_LIMIT}]`);
    }
    const offsetRaw = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(offsetRaw) || offsetRaw < 0) throw ApiError.badRequest("offset must be a nonnegative integer");
    let rows: Record<string, unknown>[];
    let total: number;
    try {
      const res = await infra.trace.calls({
        orgId: user.org_id,
        userId: memberScoped ? user.id : undefined,
        from: q.from === undefined ? undefined : parseDate(q.from, "from"),
        to: q.to === undefined ? undefined : parseDate(q.to, "to"),
        caller: q.caller,
        model: q.model,
        chatId: q.chat_id,
        requestId: q.request_id,
        limit: limitRaw,
        offset: offsetRaw,
      });
      rows = res.rows;
      total = res.total;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Unknown tables (ClickHouse never saw the DDL): degrade to empty,
      // exactly like the usage routes.
      if (isUnknownTable(error)) {
        rows = [];
        total = 0;
      } else {
        throw ApiError.internal(`observability query failed: ${errorText(error)}`);
      }
    }
    return rustJsonText({ calls: renderCallRows(rows), total });
  };

  const scopedSummary = async (req: FastifyRequest, memberScoped: boolean) => {
    const user = await (memberScoped ? requireUser(ctx, req) : adminOf(req));
    const q = readCallsQuery(req);
    let rows: Record<string, unknown>[];
    try {
      rows = await infra.trace.summary(
        user.org_id,
        memberScoped ? user.id : undefined,
        q.from === undefined ? new Date(0) : parseDate(q.from, "from"),
        q.to === undefined ? new Date(Date.now() + 86_400_000) : parseDate(q.to, "to"),
      );
    } catch (error) {
      if (isUnknownTable(error)) rows = [];
      else throw ApiError.internal(`observability summary failed: ${errorText(error)}`);
    }
    return rustJsonText({
      rows: rows.map((r) => ({
        day: typeof r["day"] === "string" ? `${r["day"].replace(" ", "T")}+00:00` : r["day"],
        caller: r["caller"],
        calls: Number(r["calls"] ?? 0),
        tokens_in: Number(r["tokens_in"] ?? 0),
        tokens_out: Number(r["tokens_out"] ?? 0),
        reasoning_tokens: Number(r["reasoning_tokens"] ?? 0),
        cost_usd: rustFloat(Number(r["cost_usd"] ?? 0)),
        p50_ms: Number(r["p50_ms"] ?? 0),
        p95_ms: Number(r["p95_ms"] ?? 0),
      })),
    });
  };

  app.get("/api/v1/admin/observability/calls", async (req) => scopedCalls(req, false));
  app.get("/api/v1/admin/observability/summary", async (req) => scopedSummary(req, false));
  app.get("/api/v1/observability/calls", async (req) => scopedCalls(req, true));
  app.get("/api/v1/observability/summary", async (req) => scopedSummary(req, true));

  // Payload bodies: admin only, fetched per row.
  app.get("/api/v1/admin/observability/calls/:request_id/payloads", async (req) => {
    const user = await requireUser(ctx, req);
    if (user.role !== "admin") throw ApiError.forbidden();
    const requestId = (req.params as Record<string, string>)["request_id"] ?? "";
    if (!isUuid(requestId)) throw ApiError.badRequest(`invalid request_id: ${requestId}`);
    let rows: Record<string, unknown>[];
    try {
      rows = await infra.trace.payloads(user.org_id, requestId);
    } catch (error) {
      if (isUnknownTable(error)) rows = [];
      else throw ApiError.internal(`payload query failed: ${errorText(error)}`);
    }
    return rustJsonText({
      payloads: rows.map((r) => ({ kind: r["kind"], body: r["body"] })),
    });
  });
}
