// LLM trace sink — ClickHouse. Every LLM call (gateway model calls, the
// approval judge) lands in llm_calls with caller/cause/duration/verdict
// metadata; request/response bodies land in llm_payloads only when payload
// tracing is enabled (GUILD_TRACE_PAYLOADS=1). Same degradation rules as the
// usage sink: an unreachable ClickHouse never breaks a model call or the
// approval gate — failures are logged and dropped. The tables are TS-owned
// (idempotent DDL on first use); llm_calls.request_id joins
// usage_events.request_id.

import { clickhouseDateTime, ClickhouseClient } from "./clickhouse.js";
import { errorText } from "./usage.js";

export interface LlmTraceCall {
  ts: Date;
  request_id: string;
  org_id: string;
  user_id: string;
  session_id: string;
  /** Caller-supplied chat context (the in-app lanes; null elsewhere). */
  chat_id: string | null;
  conversation_id: number | null;
  turn: number | null;
  /** 'model' (gateway) or 'judge' (self-reported by the approval gate). */
  caller: string;
  /** Why the call happened: 'turn-step', 'approval-gate:<tool>:<call_id>'… */
  cause: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens: number;
  cost_usd: number;
  duration_ms: number;
  finish_reason: string;
  stream: boolean;
  error: string;
  /** Judge rows only; null for model calls. */
  verdict: boolean | null;
  verdict_reason: string;
  prompt_chars: number;
  completion_chars: number;
}

export interface LlmCallsFilter {
  orgId: string;
  /** Member scoping: when set, only this user's calls. */
  userId?: string;
  from?: Date;
  to?: Date;
  caller?: string;
  model?: string;
  chatId?: string;
  /** One exact call (the row-detail deep link). */
  requestId?: string;
  limit: number;
  offset: number;
}

const CALLS_COLUMNS =
  "ts, request_id, org_id, user_id, team_id, session_id, chat_id, conversation_id, turn, " +
  "caller, cause, model, provider, tokens_in, tokens_out, reasoning_tokens, cost_usd, " +
  "duration_ms, finish_reason, stream, error, verdict, verdict_reason, prompt_chars, completion_chars";

export class LlmTraceSink {
  private ready: Promise<void> | null = null;

  constructor(
    readonly client: ClickhouseClient,
    /** Request/response payload capture (opt-in via GUILD_TRACE_PAYLOADS=1). */
    private readonly tracePayloads: boolean,
  ) {}

  /** Idempotent DDL for the two TS-owned tables; runs once per sink. */
  ensureOnce(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.client
        .execute(
          "CREATE TABLE IF NOT EXISTS llm_calls (" +
            "ts DateTime, request_id UUID, org_id UUID, user_id UUID, team_id Nullable(UUID), " +
            "session_id UUID, chat_id Nullable(UUID), conversation_id Nullable(Int64), turn Nullable(Int32), " +
            "caller LowCardinality(String), cause LowCardinality(String) DEFAULT '', " +
            "model String, provider String, tokens_in UInt32, tokens_out UInt32, " +
            "reasoning_tokens UInt32 DEFAULT 0, cost_usd Float64 DEFAULT 0, duration_ms UInt32, " +
            "finish_reason LowCardinality(String) DEFAULT '', stream Bool DEFAULT true, " +
            "error String DEFAULT '', verdict Nullable(Bool), verdict_reason String DEFAULT '', " +
            "prompt_chars UInt32 DEFAULT 0, completion_chars UInt32 DEFAULT 0" +
            ") ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (org_id, ts) " +
            "TTL toDateTime(ts) + INTERVAL 90 DAY",
        )
        .then(() =>
          this.client.execute(
            "CREATE TABLE IF NOT EXISTS llm_payloads (" +
              "ts DateTime, request_id UUID, org_id UUID, " +
              "kind LowCardinality(String), body String CODEC(ZSTD(3))" +
              ") ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (request_id, kind) " +
              "TTL toDateTime(ts) + INTERVAL 14 DAY",
          ),
        )
        .catch((error: unknown) => {
          // Reset so a later call retries the DDL (ClickHouse may have been
          // down at first use).
          this.ready = null;
          throw error;
        });
    }
    return this.ready;
  }

  /** Records one call row; every failure is logged and dropped. */
  async record(call: LlmTraceCall): Promise<void> {
    try {
      await this.ensureOnce();
      await this.client.insert("llm_calls", [
        {
          ts: clickhouseDateTime(call.ts),
          request_id: call.request_id,
          org_id: call.org_id,
          user_id: call.user_id,
          team_id: null,
          session_id: call.session_id,
          chat_id: call.chat_id,
          conversation_id: call.conversation_id,
          turn: call.turn,
          caller: call.caller,
          cause: call.cause,
          model: call.model,
          provider: call.provider,
          tokens_in: call.tokens_in,
          tokens_out: call.tokens_out,
          reasoning_tokens: call.reasoning_tokens,
          cost_usd: call.cost_usd,
          duration_ms: call.duration_ms,
          finish_reason: call.finish_reason,
          stream: call.stream,
          error: call.error.slice(0, 2000),
          verdict: call.verdict,
          verdict_reason: call.verdict_reason.slice(0, 2000),
          prompt_chars: call.prompt_chars,
          completion_chars: call.completion_chars,
        },
      ]);
    } catch (error) {
      console.warn(`llm trace row dropped: ${errorText(error)}`);
    }
  }

  /** Records one payload row; a no-op (not an error) when payload tracing
   *  is disabled. Failures are logged and dropped. */
  async recordPayload(requestId: string, orgId: string, kind: "request" | "response", body: string): Promise<void> {
    if (!this.tracePayloads) return;
    try {
      await this.ensureOnce();
      await this.client.insert("llm_payloads", [
        {
          ts: clickhouseDateTime(new Date()),
          request_id: requestId,
          org_id: orgId,
          kind,
          body: body.slice(0, 2_000_000),
        },
      ]);
    } catch (error) {
      console.warn(`llm trace payload dropped: ${errorText(error)}`);
    }
  }

  /** Filtered call rows (newest first) + the total matching count. The
   *  payloads live in llm_payloads and are fetched per row. */
  async calls(filter: LlmCallsFilter): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const where: string[] = ["org_id = toUUID(?)"];
    const binds: (string | number)[] = [filter.orgId];
    if (filter.userId !== undefined) {
      where.push("user_id = toUUID(?)");
      binds.push(filter.userId);
    }
    if (filter.from !== undefined) {
      where.push("ts >= toDateTime(?)");
      binds.push(Math.floor(filter.from.getTime() / 1000));
    }
    if (filter.to !== undefined) {
      where.push("ts <= toDateTime(?)");
      binds.push(Math.floor(filter.to.getTime() / 1000));
    }
    if (filter.caller !== undefined) {
      where.push("caller = ?");
      binds.push(filter.caller);
    }
    if (filter.model !== undefined) {
      where.push("model = ?");
      binds.push(filter.model);
    }
    if (filter.chatId !== undefined) {
      where.push("chat_id = toUUID(?)");
      binds.push(filter.chatId);
    }
    if (filter.requestId !== undefined) {
      where.push("request_id = toUUID(?)");
      binds.push(filter.requestId);
    }
    const predicate = where.join(" AND ");
    await this.ensureOnce();
    const totalRes = await this.client.query(`SELECT count() AS total FROM llm_calls WHERE ${predicate}`, binds);
    const rows = await this.client.query(
      `SELECT ${CALLS_COLUMNS} FROM llm_calls WHERE ${predicate} ORDER BY ts DESC, request_id DESC LIMIT ? OFFSET ?`,
      [...binds, filter.limit, filter.offset],
    );
    return { rows, total: countOf(totalRes) };
  }

  /** Per-day × caller aggregates for a window (cost falls back to the
   *  metered usage_events row when the trace row carries none — judge rows
   *  do not know the route prices). */
  async summary(orgId: string, userId: string | undefined, from: Date, to: Date): Promise<Record<string, unknown>[]> {
    await this.ensureOnce();
    let scope = "org_id = toUUID(?)";
    const binds: (string | number)[] = [orgId];
    if (userId !== undefined) {
      scope += " AND user_id = toUUID(?)";
      binds.push(userId);
    }
    return this.client.query(
      `SELECT toStartOfDay(ts) AS day, caller, count() AS calls, ` +
        "sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(reasoning_tokens) AS reasoning_tokens, " +
        `sum(coalesce(ue.cost_usd, lc.cost_usd)) AS cost_usd, ` +
        "quantile(0.5)(duration_ms) AS p50_ms, quantile(0.95)(duration_ms) AS p95_ms " +
        `FROM (SELECT * FROM llm_calls WHERE ${scope} AND ts >= toDateTime(?) AND ts <= toDateTime(?)) AS lc ` +
        "LEFT JOIN (SELECT request_id, any(cost_usd) AS cost_usd FROM usage_events WHERE org_id = toUUID(?) " +
        "GROUP BY request_id) AS ue ON ue.request_id = lc.request_id " +
        "GROUP BY day, caller ORDER BY day",
      [...binds, Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000), orgId],
    );
  }

  /** The stored request/response bodies for one call (admin only). */
  async payloads(orgId: string, requestId: string): Promise<Record<string, unknown>[]> {
    await this.ensureOnce();
    return this.client.query(
      "SELECT kind, body FROM llm_payloads WHERE org_id = toUUID(?) AND request_id = toUUID(?) ORDER BY kind",
      [orgId, requestId],
    );
  }
}

function countOf(rows: Record<string, unknown>[]): number {
  const value = Object.values(rows[0] ?? {})[0];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}
