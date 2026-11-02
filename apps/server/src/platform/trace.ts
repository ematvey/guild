// Agent observability store — ClickHouse. One trace is one agent run (or a
// plain chat turn when no run exists); spans are the LLM calls, tool calls
// and delegated runs inside it. Sessions group traces by chat. The run
// lifecycle mirrors agent_runs into agent_traces; the gateway and the tool
// hook append spans. Payload bodies land in llm_payloads unless payload
// tracing is disabled (GUILD_TRACE_PAYLOADS=0); a request stores only the
// messages its predecessor in the trace did not carry, and the read path
// rebuilds the full body from that chain. Same degradation rules as
// the usage sink: an unreachable ClickHouse never breaks a model call, a
// tool call or the approval gate — failures are logged and dropped. The
// tables are TS-owned (idempotent DDL on first use).

import { createHash } from "node:crypto";
import { clickhouseDateTime64, type ClickhouseClient } from "./clickhouse.js";
import { errorText } from "./usage.js";

/** The zero uuid: "no parent" on a payload row and "no chain row yet". */
const NO_PARENT = "00000000-0000-0000-0000-000000000000";

/** The stored body cap; a longer request is cut like before. */
const MAX_PAYLOAD_CHARS = 2_000_000;

/** Guard for a corrupt or cyclic parent chain on the read path. */
const MAX_CHAIN_DEPTH = 128;

/** sha256 hex of one JSON value — a chat message, used to prove that the
 *  parent's history is a prefix of the new request. */
function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The `messages` array of a raw OpenAI request body, or null when the body
 *  is not JSON or carries no array. */
function requestMessages(body: string): unknown[] | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const messages = parsed["messages"];
    return Array.isArray(messages) ? messages : null;
  } catch {
    return null;
  }
}

/** Rebuilds one request body from its delta chain (leaf first, root last).
 *  The root carries the whole history; each descendant carries only the
 *  messages appended since its parent. Every other field comes from the
 *  leaf, because the leaf is the request that ran. */
function rebuildRequest(chain: Record<string, unknown>[]): string {
  const ordered = [...chain].reverse();
  const root = ordered[0];
  const leaf = chain[0];
  if (root === undefined || leaf === undefined) return "";
  try {
    const base = JSON.parse(String(leaf["body"])) as Record<string, unknown>;
    const rootBody = JSON.parse(String(root["body"])) as Record<string, unknown>;
    const messages = Array.isArray(rootBody["messages"]) ? [...(rootBody["messages"] as unknown[])] : [];
    for (const row of ordered.slice(1)) {
      const delta = JSON.parse(String(row["body"])) as Record<string, unknown>;
      if (Array.isArray(delta["messages"])) messages.push(...(delta["messages"] as unknown[]));
    }
    base["messages"] = messages;
    return JSON.stringify(base);
  } catch {
    return String(leaf["body"] ?? "");
  }
}

export type SpanType = "llm" | "tool" | "run";
export type SpanStatus = "ok" | "error" | "running";

export interface TraceSpanInput {
  span_id: string;
  trace_id: string;
  /** The agent run id; null for a plain chat turn. */
  run_id?: string | null;
  parent_span_id?: string | null;
  org_id: string;
  user_id?: string | null;
  /** The chat id: the session that groups traces. */
  session_id?: string | null;
  chat_id?: string | null;
  name: string;
  span_type: SpanType;
  status?: SpanStatus;
  start_time: Date;
  end_time?: Date | null;
  duration_ms?: number;
  model?: string;
  provider?: string;
  tokens_in?: number;
  tokens_out?: number;
  reasoning_tokens?: number;
  cost_usd?: number;
  error?: string;
  input?: string;
  output?: string;
  attributes?: Record<string, unknown>;
  /** The gateway request id (LLM spans); also the payload join key. */
  request_id?: string | null;
  /** 'model' or 'judge' for LLM spans; empty otherwise. */
  caller?: string;
}

export interface TraceRecordInput {
  trace_id: string;
  org_id: string;
  user_id?: string | null;
  agent_id?: string | null;
  agent_name?: string;
  session_id?: string | null;
  thread_id?: string | null;
  parent_trace_id?: string | null;
  routine_id?: string | null;
  trigger?: string;
  status?: string;
  name?: string;
  summary?: string;
  error?: string;
  started_at: Date;
  finished_at?: Date | null;
}

export interface LlmTraceCall {
  ts: Date;
  request_id: string;
  org_id: string;
  user_id: string;
  session_id: string;
  /** The agent run this call belongs to; null outside an agent run. */
  run_id?: string | null;
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

export interface TraceFilters {
  orgId: string;
  /** Member scoping: when set, only this user's traces. */
  userId?: string;
  from?: Date;
  to?: Date;
  agentId?: string;
  status?: string;
  trigger?: string;
  /** Free-text over the agent name and the run summary. */
  query?: string;
  parentTraceId?: string;
  /** One chat's traces (the session detail). */
  sessionId?: string;
  limit: number;
  offset: number;
}

export interface SpanFilters {
  orgId: string;
  userId?: string;
  from?: Date;
  to?: Date;
  spanType?: SpanType;
  traceId?: string;
  sessionId?: string;
  caller?: string;
  model?: string;
  status?: string;
  /** Free-text over the span name and the model. */
  query?: string;
  limit: number;
  offset: number;
}

export interface SessionFilters {
  orgId: string;
  userId?: string;
  from?: Date;
  to?: Date;
  query?: string;
  limit: number;
  offset: number;
}

const SPAN_COLUMNS =
  "span_id, trace_id, run_id, parent_span_id, org_id, user_id, session_id, chat_id, " +
  "name, span_type, status, start_time, end_time, duration_ms, model, provider, " +
  "tokens_in, tokens_out, reasoning_tokens, cost_usd, error, input, output, attributes, request_id, caller";

const TRACE_COLUMNS =
  "trace_id, org_id, user_id, agent_id, agent_name, session_id, thread_id, parent_trace_id, " +
  "routine_id, trigger, status, name, summary, error, started_at, finished_at, updated_at";

export class TraceStore {
  private ready: Promise<void> | null = null;

  constructor(
    readonly client: ClickhouseClient,
    /** Request/response payload capture (GUILD_TRACE_PAYLOADS, default on;
     *  "0" turns the bodies off). */
    private readonly tracePayloads: boolean,
  ) {}

  /** Idempotent DDL for the trace tables; runs once per sink. */
  ensureOnce(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.client
        .execute(
          "CREATE TABLE IF NOT EXISTS agent_traces (" +
            "trace_id UUID, org_id UUID, user_id Nullable(UUID), agent_id Nullable(UUID), " +
            "agent_name String DEFAULT '', session_id Nullable(UUID), thread_id Nullable(UUID), " +
            "parent_trace_id Nullable(UUID), routine_id Nullable(UUID), " +
            "trigger LowCardinality(String) DEFAULT '', status LowCardinality(String) DEFAULT '', " +
            "name String DEFAULT '', summary String DEFAULT '', error String DEFAULT '', " +
            "started_at DateTime64(3), finished_at Nullable(DateTime64(3)), updated_at DateTime64(3)" +
            ") ENGINE = ReplacingMergeTree(updated_at) PARTITION BY toYYYYMM(started_at) " +
            "ORDER BY (org_id, trace_id) TTL toDateTime(started_at) + INTERVAL 180 DAY",
        )
        .then(() =>
          this.client.execute(
            "CREATE TABLE IF NOT EXISTS agent_spans (" +
              "span_id UUID, trace_id UUID, run_id Nullable(UUID), parent_span_id Nullable(UUID), " +
              "org_id UUID, user_id Nullable(UUID), session_id Nullable(UUID), chat_id Nullable(UUID), " +
              "name String, span_type LowCardinality(String), status LowCardinality(String) DEFAULT 'ok', " +
              "start_time DateTime64(3), end_time Nullable(DateTime64(3)), duration_ms UInt32 DEFAULT 0, " +
              "model String DEFAULT '', provider String DEFAULT '', " +
              "tokens_in UInt32 DEFAULT 0, tokens_out UInt32 DEFAULT 0, reasoning_tokens UInt32 DEFAULT 0, " +
              "cost_usd Float64 DEFAULT 0, error String DEFAULT '', " +
              "input String DEFAULT '' CODEC(ZSTD(3)), output String DEFAULT '' CODEC(ZSTD(3)), " +
              "attributes String DEFAULT '{}' CODEC(ZSTD(3)), request_id Nullable(UUID), " +
              "caller LowCardinality(String) DEFAULT ''" +
              ") ENGINE = MergeTree PARTITION BY toYYYYMM(start_time) ORDER BY (org_id, trace_id, start_time) " +
              "TTL toDateTime(start_time) + INTERVAL 90 DAY",
          ),
        )
        .then(() =>
          this.client.execute(
            "CREATE TABLE IF NOT EXISTS llm_payloads (" +
              "ts DateTime, request_id UUID, org_id UUID, " +
              "kind LowCardinality(String), body String CODEC(ZSTD(3)), " +
              `parent_request_id UUID DEFAULT '${NO_PARENT}', prefix_count UInt32 DEFAULT 0` +
              ") ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (request_id, kind) " +
              "TTL toDateTime(ts) + INTERVAL 14 DAY",
          ),
        )
        // Columns added after the table shipped: an existing table keeps its
        // rows and gets them with defaults (prefix_count 0 = a full body).
        .then(() =>
          this.client.execute(
            "ALTER TABLE llm_payloads " +
              `ADD COLUMN IF NOT EXISTS parent_request_id UUID DEFAULT '${NO_PARENT}', ` +
              "ADD COLUMN IF NOT EXISTS prefix_count UInt32 DEFAULT 0",
          ),
        )
        // The write-path index: the newest request of one trace, by trace.
        // The payload table is ordered by request id, so a parent lookup
        // there would scan the whole table on every model call.
        .then(() =>
          this.client.execute(
            "CREATE TABLE IF NOT EXISTS llm_payload_chains (" +
              "ts DateTime64(3), org_id UUID, trace_id UUID, request_id UUID, " +
              "message_count UInt32 DEFAULT 0, last_hash String DEFAULT ''" +
              ") ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (org_id, trace_id, ts, request_id) " +
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

  /** Records one run (or updates it: ReplacingMergeTree keeps the newest
   *  `updated_at` row). Every failure is logged and dropped. */
  async recordTrace(trace: TraceRecordInput): Promise<void> {
    try {
      await this.ensureOnce();
      await this.client.insert("agent_traces", [
        {
          trace_id: trace.trace_id,
          org_id: trace.org_id,
          user_id: trace.user_id ?? null,
          agent_id: trace.agent_id ?? null,
          agent_name: trace.agent_name ?? "",
          session_id: trace.session_id ?? null,
          thread_id: trace.thread_id ?? null,
          parent_trace_id: trace.parent_trace_id ?? null,
          routine_id: trace.routine_id ?? null,
          trigger: trace.trigger ?? "",
          status: trace.status ?? "queued",
          name: trace.name ?? "",
          summary: (trace.summary ?? "").slice(0, 4000),
          error: (trace.error ?? "").slice(0, 4000),
          started_at: clickhouseDateTime64(trace.started_at),
          finished_at:
            trace.finished_at === null || trace.finished_at === undefined
              ? null
              : clickhouseDateTime64(trace.finished_at),
          updated_at: clickhouseDateTime64(new Date()),
        },
      ]);
    } catch (error) {
      console.warn(`agent trace row dropped: ${errorText(error)}`);
    }
  }

  /** Records one span (LLM call, tool call, or synthetic step). */
  async recordSpan(span: TraceSpanInput): Promise<void> {
    try {
      await this.ensureOnce();
      const start = span.start_time;
      const end = span.end_time ?? null;
      const duration = span.duration_ms ?? (end === null ? 0 : Math.max(0, end.getTime() - start.getTime()));
      await this.client.insert("agent_spans", [
        {
          span_id: span.span_id,
          trace_id: span.trace_id,
          run_id: span.run_id ?? null,
          parent_span_id: span.parent_span_id ?? null,
          org_id: span.org_id,
          user_id: span.user_id ?? null,
          session_id: span.session_id ?? null,
          chat_id: span.chat_id ?? null,
          name: span.name,
          span_type: span.span_type,
          status: span.status ?? "ok",
          start_time: clickhouseDateTime64(start),
          end_time: end === null ? null : clickhouseDateTime64(end),
          duration_ms: Math.min(4_294_967_295, Math.round(duration)),
          model: span.model ?? "",
          provider: span.provider ?? "",
          tokens_in: span.tokens_in ?? 0,
          tokens_out: span.tokens_out ?? 0,
          reasoning_tokens: span.reasoning_tokens ?? 0,
          cost_usd: span.cost_usd ?? 0,
          error: (span.error ?? "").slice(0, 2000),
          input: (span.input ?? "").slice(0, 200_000),
          output: (span.output ?? "").slice(0, 200_000),
          attributes: JSON.stringify(span.attributes ?? {}).slice(0, 20_000),
          request_id: span.request_id ?? null,
          caller: span.caller ?? "",
        },
      ]);
    } catch (error) {
      console.warn(`agent span row dropped: ${errorText(error)}`);
    }
  }

  /** Records one LLM call as an `llm` span. The span id is the request id,
   *  which is also the payload join key. */
  async record(call: LlmTraceCall): Promise<void> {
    const traceId = call.run_id ?? call.chat_id ?? call.request_id;
    await this.recordSpan({
      span_id: call.request_id,
      trace_id: traceId,
      run_id: call.run_id ?? null,
      org_id: call.org_id,
      user_id: call.user_id,
      session_id: call.chat_id,
      chat_id: call.chat_id,
      name: call.caller === "judge" ? "approval judge" : "model call",
      span_type: "llm",
      status: call.error === "" ? "ok" : "error",
      start_time: new Date(call.ts.getTime() - call.duration_ms),
      end_time: call.ts,
      duration_ms: call.duration_ms,
      model: call.model,
      provider: call.provider,
      tokens_in: call.tokens_in,
      tokens_out: call.tokens_out,
      reasoning_tokens: call.reasoning_tokens,
      cost_usd: call.cost_usd,
      error: call.error,
      attributes: {
        caller: call.caller,
        cause: call.cause,
        conversation_id: call.conversation_id,
        turn: call.turn,
        finish_reason: call.finish_reason,
        stream: call.stream,
        verdict: call.verdict,
        verdict_reason: call.verdict_reason,
        prompt_chars: call.prompt_chars,
        completion_chars: call.completion_chars,
        session_id: call.session_id,
      },
      request_id: call.request_id,
      caller: call.caller,
    });
  }

  /** Records one payload row; a no-op (not an error) when payload tracing
   *  is disabled. A request stores the whole body only when no earlier
   *  request of the same trace is its prefix; otherwise it stores the new
   *  messages and points at its parent (`traceId` is the run id, else the
   *  chat id, else the request id). Failures are logged and dropped. */
  async recordPayload(
    requestId: string,
    orgId: string,
    kind: "request" | "response",
    body: string,
    traceId: string = requestId,
  ): Promise<void> {
    if (!this.tracePayloads) return;
    try {
      await this.ensureOnce();
      const ts = clickhouseDateTime64(new Date());
      const row: Record<string, unknown> = {
        ts,
        request_id: requestId,
        org_id: orgId,
        kind,
        body: body.slice(0, MAX_PAYLOAD_CHARS),
        parent_request_id: NO_PARENT,
        prefix_count: 0,
      };
      const messages = kind === "request" ? requestMessages(body) : null;
      if (messages === null || messages.length === 0) {
        await this.client.insert("llm_payloads", [row]);
        return;
      }
      const parent = await this.chainParent(orgId, traceId);
      const last = messages[messages.length - 1];
      const prefix =
        parent !== null &&
        parent.messageCount > 0 &&
        parent.messageCount <= messages.length &&
        hashJson(messages[parent.messageCount - 1]) === parent.lastHash
          ? parent.messageCount
          : 0;
      if (prefix > 0 && parent !== null) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        parsed["messages"] = messages.slice(prefix);
        const delta = JSON.stringify(parsed);
        // A delta longer than the cap would cut JSON mid-value and break the
        // chain. Fall back to the capped full body, which reads as before.
        if (delta.length <= MAX_PAYLOAD_CHARS) {
          row["body"] = delta;
          row["parent_request_id"] = parent.requestId;
          row["prefix_count"] = prefix;
        }
      }
      await this.client.insert("llm_payloads", [row]);
      await this.client.insert("llm_payload_chains", [
        {
          ts,
          org_id: orgId,
          trace_id: traceId,
          request_id: requestId,
          message_count: messages.length,
          last_hash: hashJson(last),
        },
      ]);
    } catch (error) {
      console.warn(`llm trace payload dropped: ${errorText(error)}`);
    }
  }

  /** The newest request of one trace, as the write path needs it: the row to
   *  point at and the proof that a new request extends it. */
  private async chainParent(
    orgId: string,
    traceId: string,
  ): Promise<{ requestId: string; messageCount: number; lastHash: string } | null> {
    const rows = await this.client.query(
      "SELECT request_id, message_count, last_hash FROM llm_payload_chains " +
        "WHERE org_id = toUUID(?) AND trace_id = toUUID(?) ORDER BY ts DESC, request_id DESC LIMIT 1",
      [orgId, traceId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      requestId: String(row["request_id"]),
      messageCount: Number(row["message_count"]),
      lastHash: String(row["last_hash"]),
    };
  }

  /** Trace rows (newest first) with their span aggregates. */
  async traces(filter: TraceFilters): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const where: string[] = ["org_id = toUUID(?)"];
    const binds: (string | number)[] = [filter.orgId];
    if (filter.userId !== undefined) {
      where.push("user_id = toUUID(?)");
      binds.push(filter.userId);
    }
    if (filter.from !== undefined) {
      where.push("started_at >= toDateTime64(?, 3)");
      binds.push(clickhouseDateTime64(filter.from));
    }
    if (filter.to !== undefined) {
      where.push("started_at <= toDateTime64(?, 3)");
      binds.push(clickhouseDateTime64(filter.to));
    }
    if (filter.agentId !== undefined) {
      where.push("agent_id = toUUID(?)");
      binds.push(filter.agentId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.trigger !== undefined) {
      where.push("trigger = ?");
      binds.push(filter.trigger);
    }
    if (filter.parentTraceId !== undefined) {
      where.push("parent_trace_id = toUUID(?)");
      binds.push(filter.parentTraceId);
    }
    if (filter.sessionId !== undefined) {
      where.push("session_id = toUUID(?)");
      binds.push(filter.sessionId);
    }
    if (filter.query !== undefined && filter.query !== "") {
      where.push(
        "(positionCaseInsensitive(summary, ?) > 0 OR positionCaseInsensitive(agent_name, ?) > 0 OR positionCaseInsensitive(name, ?) > 0)",
      );
      binds.push(filter.query, filter.query, filter.query);
    }
    const predicate = where.join(" AND ");
    await this.ensureOnce();
    const totalRes = await this.client.query(
      `SELECT count() AS total FROM agent_traces FINAL WHERE ${predicate}`,
      binds,
    );
    const rows = await this.client.query(
      `SELECT ${TRACE_COLUMNS} FROM agent_traces FINAL WHERE ${predicate} ` +
        "ORDER BY started_at DESC, trace_id DESC LIMIT ? OFFSET ?",
      [...binds, filter.limit, filter.offset],
    );
    const aggregates = await this.spanAggregates(
      filter.orgId,
      rows.map((row) => String(row["trace_id"])),
    );
    return {
      rows: rows.map((row) => ({ ...row, ...(aggregates.get(String(row["trace_id"])) ?? {}) })),
      total: countOf(totalRes),
    };
  }

  /** One trace row with its spans and direct child traces. */
  async trace(
    orgId: string,
    traceId: string,
  ): Promise<{
    trace: Record<string, unknown> | null;
    spans: Record<string, unknown>[];
    children: Record<string, unknown>[];
  }> {
    await this.ensureOnce();
    const traces = await this.client.query(
      `SELECT ${TRACE_COLUMNS} FROM agent_traces FINAL WHERE org_id = toUUID(?) AND trace_id = toUUID(?) LIMIT 1`,
      [orgId, traceId],
    );
    const spans = await this.client.query(
      `SELECT ${SPAN_COLUMNS} FROM agent_spans WHERE org_id = toUUID(?) AND trace_id = toUUID(?) ` +
        "ORDER BY start_time ASC, span_id ASC",
      [orgId, traceId],
    );
    const children = await this.client.query(
      `SELECT ${TRACE_COLUMNS} FROM agent_traces FINAL WHERE org_id = toUUID(?) AND parent_trace_id = toUUID(?) ` +
        "ORDER BY started_at ASC, trace_id ASC",
      [orgId, traceId],
    );
    const trace = traces[0] ?? null;
    if (trace !== null) Object.assign(trace, spanTotals(spans));
    const childAggregates = await this.spanAggregates(
      orgId,
      children.map((row) => String(row["trace_id"])),
    );
    return {
      trace,
      spans,
      children: children.map((row) => ({
        ...row,
        ...(childAggregates.get(String(row["trace_id"])) ?? {}),
      })),
    };
  }

  /** Filtered spans (newest first) + the total matching count. */
  async spans(filter: SpanFilters): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const where: string[] = ["org_id = toUUID(?)"];
    const binds: (string | number)[] = [filter.orgId];
    if (filter.spanType !== undefined) {
      where.push("span_type = ?");
      binds.push(filter.spanType);
    }
    if (filter.userId !== undefined) {
      where.push("user_id = toUUID(?)");
      binds.push(filter.userId);
    }
    if (filter.from !== undefined) {
      where.push("start_time >= toDateTime64(?, 3)");
      binds.push(clickhouseDateTime64(filter.from));
    }
    if (filter.to !== undefined) {
      where.push("start_time <= toDateTime64(?, 3)");
      binds.push(clickhouseDateTime64(filter.to));
    }
    if (filter.traceId !== undefined) {
      where.push("trace_id = toUUID(?)");
      binds.push(filter.traceId);
    }
    if (filter.sessionId !== undefined) {
      where.push("session_id = toUUID(?)");
      binds.push(filter.sessionId);
    }
    if (filter.caller !== undefined) {
      where.push("caller = ?");
      binds.push(filter.caller);
    }
    if (filter.model !== undefined) {
      where.push("model = ?");
      binds.push(filter.model);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.query !== undefined && filter.query !== "") {
      where.push("(positionCaseInsensitive(name, ?) > 0 OR positionCaseInsensitive(model, ?) > 0)");
      binds.push(filter.query, filter.query);
    }
    const predicate = where.join(" AND ");
    await this.ensureOnce();
    const totalRes = await this.client.query(`SELECT count() AS total FROM agent_spans WHERE ${predicate}`, binds);
    const rows = await this.client.query(
      `SELECT ${SPAN_COLUMNS} FROM agent_spans WHERE ${predicate} ` +
        "ORDER BY start_time DESC, span_id DESC LIMIT ? OFFSET ?",
      [...binds, filter.limit, filter.offset],
    );
    return { rows, total: countOf(totalRes) };
  }

  /** Sessions (chats) with their trace, call and token totals. */
  async sessions(filter: SessionFilters): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const where: string[] = ["org_id = toUUID(?)", "session_id IS NOT NULL"];
    const binds: (string | number)[] = [filter.orgId];
    if (filter.userId !== undefined) {
      where.push("user_id = toUUID(?)");
      binds.push(filter.userId);
    }
    if (filter.from !== undefined) {
      where.push("start_time >= toDateTime64(?, 3)");
      binds.push(clickhouseDateTime64(filter.from));
    }
    if (filter.to !== undefined) {
      where.push("start_time <= toDateTime64(?, 3)");
      binds.push(clickhouseDateTime64(filter.to));
    }
    const predicate = where.join(" AND ");
    await this.ensureOnce();
    const totals = await this.client.query(
      `SELECT count(DISTINCT session_id) AS total FROM agent_spans WHERE ${predicate}`,
      binds,
    );
    const rows = await this.client.query(
      "SELECT session_id, " +
        "count(DISTINCT trace_id) AS traces, countIf(span_type = 'llm') AS calls, " +
        "countIf(span_type = 'tool') AS tool_calls, " +
        "sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd, " +
        "min(start_time) AS started_at, max(coalesce(end_time, start_time)) AS ended_at, " +
        "countIf(status = 'error') AS errors " +
        `FROM agent_spans WHERE ${predicate} GROUP BY session_id ` +
        "ORDER BY ended_at DESC LIMIT ? OFFSET ?",
      [...binds, filter.limit, filter.offset],
    );
    return { rows, total: countOf(totals) };
  }

  /** Totals for the activity header + the daily series. */
  async summary(filter: { orgId: string; userId?: string; from: Date; to: Date }): Promise<Record<string, unknown>> {
    const where = ["org_id = toUUID(?)", "start_time >= toDateTime64(?, 3)", "start_time <= toDateTime64(?, 3)"];
    const binds: (string | number)[] = [
      filter.orgId,
      clickhouseDateTime64(filter.from),
      clickhouseDateTime64(filter.to),
    ];
    if (filter.userId !== undefined) {
      where.push("user_id = toUUID(?)");
      binds.push(filter.userId);
    }
    const predicate = where.join(" AND ");
    await this.ensureOnce();
    const totals = await this.client.query(
      "SELECT countIf(span_type = 'llm') AS calls, countIf(span_type = 'tool') AS tool_calls, " +
        "countIf(status = 'error') AS errors, " +
        "sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(reasoning_tokens) AS reasoning_tokens, " +
        "sum(cost_usd) AS cost_usd, quantile(0.5)(duration_ms) AS p50_ms, quantile(0.95)(duration_ms) AS p95_ms " +
        `FROM agent_spans WHERE ${predicate}`,
      binds,
    );
    const traceWhere = ["org_id = toUUID(?)", "started_at >= toDateTime64(?, 3)", "started_at <= toDateTime64(?, 3)"];
    const traceBinds: (string | number)[] = [
      filter.orgId,
      clickhouseDateTime64(filter.from),
      clickhouseDateTime64(filter.to),
    ];
    if (filter.userId !== undefined) {
      traceWhere.push("user_id = toUUID(?)");
      traceBinds.push(filter.userId);
    }
    const traces = await this.client.query(
      `SELECT count() AS traces, countIf(status = 'failed') AS failed FROM agent_traces FINAL WHERE ${traceWhere.join(" AND ")}`,
      traceBinds,
    );
    const byDay = await this.client.query(
      "SELECT toStartOfDay(start_time) AS day, countIf(span_type = 'llm') AS calls, " +
        "sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd, " +
        "quantile(0.95)(duration_ms) AS p95_ms " +
        `FROM agent_spans WHERE ${predicate} GROUP BY day ORDER BY day`,
      binds,
    );
    return {
      totals: {
        ...(totals[0] ?? {}),
        traces: Number(traces[0]?.["traces"] ?? 0),
        failed_traces: Number(traces[0]?.["failed"] ?? 0),
      },
      by_day: byDay,
    };
  }

  /** The stored request/response bodies for one span (admin only). */
  async payloads(orgId: string, spanId: string): Promise<Record<string, unknown>[]> {
    await this.ensureOnce();
    const rows = await this.client.query(
      "SELECT kind, body, parent_request_id, prefix_count FROM llm_payloads " +
        "WHERE org_id = toUUID(?) AND request_id = toUUID(?) ORDER BY kind",
      [orgId, spanId],
    );
    const request = rows.find((row) => row["kind"] === "request");
    if (request === undefined || Number(request["prefix_count"]) === 0) return rows;
    const chain: Record<string, unknown>[] = [request];
    let parentId = String(request["parent_request_id"]);
    while (parentId !== NO_PARENT && chain.length < MAX_CHAIN_DEPTH) {
      const parent = (
        await this.client.query(
          "SELECT kind, body, parent_request_id, prefix_count FROM llm_payloads " +
            "WHERE org_id = toUUID(?) AND request_id = toUUID(?) AND kind = 'request' LIMIT 1",
          [orgId, parentId],
        )
      )[0];
      if (parent === undefined) break;
      chain.push(parent);
      parentId = String(parent["parent_request_id"]);
    }
    const body = rebuildRequest(chain);
    return rows.map((row) => (row === request ? { ...row, body } : row));
  }

  /** One trace's model and tool call counts, counted as the trace list
   *  counts them. A run's trace id is the run id. */
  async callCounts(orgId: string, traceId: string): Promise<{ call_count: number; tool_count: number }> {
    await this.ensureOnce();
    const row = (await this.spanAggregates(orgId, [traceId])).get(traceId);
    return { call_count: Number(row?.["call_count"] ?? 0), tool_count: Number(row?.["tool_count"] ?? 0) };
  }

  /** Per-trace span totals for the listed trace ids. */
  private async spanAggregates(orgId: string, traceIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (traceIds.length === 0) return out;
    const list = traceIds.map((id) => `toUUID('${id.replace(/'/g, "")}')`).join(", ");
    const rows = await this.client.query(
      "SELECT trace_id, count() AS span_count, countIf(span_type = 'llm') AS call_count, " +
        "countIf(span_type = 'tool') AS tool_count, countIf(status = 'error') AS error_count, " +
        "sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(reasoning_tokens) AS reasoning_tokens, " +
        "sum(cost_usd) AS cost_usd, max(duration_ms) AS longest_ms " +
        `FROM agent_spans WHERE org_id = toUUID(?) AND trace_id IN (${list}) GROUP BY trace_id`,
      [orgId],
    );
    for (const row of rows) out.set(String(row["trace_id"]), row);
    return out;
  }
}

/** Span totals for one trace, from the rows already loaded. */
function spanTotals(spans: Record<string, unknown>[]): Record<string, unknown> {
  let tokensIn = 0;
  let tokensOut = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let longestMs = 0;
  let calls = 0;
  let tools = 0;
  let errors = 0;
  const number = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0) || 0);
  for (const span of spans) {
    tokensIn += number(span["tokens_in"]);
    tokensOut += number(span["tokens_out"]);
    reasoningTokens += number(span["reasoning_tokens"]);
    costUsd += number(span["cost_usd"]);
    longestMs = Math.max(longestMs, number(span["duration_ms"]));
    if (span["span_type"] === "llm") calls += 1;
    if (span["span_type"] === "tool") tools += 1;
    if (span["status"] === "error") errors += 1;
  }
  return {
    span_count: spans.length,
    call_count: calls,
    tool_count: tools,
    error_count: errors,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    reasoning_tokens: reasoningTokens,
    cost_usd: costUsd,
    longest_ms: longestMs,
  };
}

function countOf(rows: Record<string, unknown>[]): number {
  const value = Object.values(rows[0] ?? {})[0];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}
