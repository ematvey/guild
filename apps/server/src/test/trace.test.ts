// LLM observability: the trace sink DDL + row mapping, the gateway's
// llm_calls emission (model rows with context headers, skip-when-internal-
// caller), the judge's self-reported rows, and the admin/member API
// authz + scoping. Runs against the disposable PG/ClickHouse stack with a
// scripted mock upstream (same harness the gateway suites use).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { LlmTraceSink } from "../platform/trace.js";
import { ClickhouseClient } from "../platform/clickhouse.js";

const TEST_TIMEOUT = 120_000;

// Payload tracing on for the whole suite (the sink no-ops when off; a
// separate opt-out test covers that path with its own sink instance).
const PAYLOADS_ON = { GUILD_TRACE_PAYLOADS: "1" };

let stack: M2Stack;
let port: number;
const orgAuth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

beforeAll(async () => {
  // Pre-allocate the loopback port the harness's selfBaseUrl needs (the
  // judge fetches the app itself).
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupM2Stack(
    {
      GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
      GUILD_ALLOW_SHELL_TOOLS: "1",
      ...PAYLOADS_ON,
    },
    { dbPrefix: "guild_trace_test" },
  );
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("trace-model");
}, 60_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

function chClient(): ClickhouseClient {
  return new ClickhouseClient({
    url: stack.env.config.clickhouseUrl,
    database: stack.env.clickhouseDatabase,
    user: stack.env.config.clickhouseUser,
    password: stack.env.config.clickhousePassword,
  });
}

async function traceRows(): Promise<Record<string, unknown>[]> {
  return chClient().query(
    `SELECT * FROM llm_calls WHERE org_id = toUUID('${stack.orgId}') ORDER BY ts, request_id`,
  );
}

/** Waits for ClickHouse to make the sinks' async inserts visible (the
 *  sink drops nothing silently: the row count must stabilize). */
async function traceDrained(minRows: number): Promise<Record<string, unknown>[]> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  let last = -1;
  let rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 25; i++) {
    rows = await traceRows();
    if (rows.length >= minRows && rows.length === last) return rows;
    last = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return rows;
}

describe("LLM trace sink", () => {
  it(
    "DDL is idempotent and a recorded row round-trips",
    async () => {
      const client = chClient();
      const sink = new LlmTraceSink(client, true);
      await sink.ensureOnce();
      await sink.ensureOnce(); // second run: CREATE IF NOT EXISTS is a no-op
      const requestId = crypto.randomUUID();
      await sink.record({
        ts: new Date(),
        request_id: requestId,
        org_id: stack.orgId,
        user_id: stack.memberId,
        session_id: stack.apiKeyId,
        chat_id: null,
        conversation_id: 42,
        turn: 7,
        caller: "model",
        cause: "turn-step",
        model: "m",
        provider: "p",
        tokens_in: 11,
        tokens_out: 22,
        reasoning_tokens: 5,
        cost_usd: 0.001,
        duration_ms: 1234,
        finish_reason: "stop",
        stream: true,
        error: "",
        verdict: null,
        verdict_reason: "",
        prompt_chars: 100,
        completion_chars: 50,
      });
      await sink.recordPayload(requestId, stack.orgId, "request", '{"q":1}');
      await sink.recordPayload(requestId, stack.orgId, "response", "ok");
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { rows, total } = await sink.calls({
        orgId: stack.orgId,
        caller: "model",
        model: "m",
        limit: 10,
        offset: 0,
      });
      expect(total).toBeGreaterThanOrEqual(1);
      const row = rows.find((r) => r["request_id"] === requestId);
      expect(row).toBeDefined();
      expect(row!["conversation_id"]).toBe(42);
      expect(row!["turn"]).toBe(7);
      expect(Number(row!["reasoning_tokens"])).toBe(5);
      expect(Boolean(row!["stream"])).toBe(true);

      // A trace-payloads-off sink records the call but no payload rows.
      const sinkOff = new LlmTraceSink(client, false);
      await sinkOff.recordPayload(requestId, stack.orgId, "request", "should not land");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const payloads = await sink.payloads(stack.orgId, requestId);
      expect(payloads.map((p) => p["kind"]).sort()).toEqual(["request", "response"]);
    },
    TEST_TIMEOUT,
  );
});

describe("LLM trace: gateway emission + API", () => {
  it(
    "a model call records one llm_calls row joined to its usage event",
    async () => {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/openai/v1/chat/completions",
        headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
        payload: {
          model: "trace-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(res.statusCode).toBe(200);

      const rows = await traceDrained(1);
      const row = rows.find((r) => r["caller"] === "model" && r["model"] === "trace-model");
      expect(row).toBeDefined();
      expect(row!["user_id"]).toBe(stack.memberId);
      expect(Number(row!["tokens_in"])).toBe(3);
      expect(Number(row!["tokens_out"])).toBe(2);
      expect(row!["chat_id"]).toBeNull();
      expect(row!["cause"]).toBe("");

      // The join holds: the usage event carries the same request id.
      const usage = await stack.usageRows();
      const urow = usage.find((u) => u["request_id"] === row!["request_id"]);
      expect(urow).toBeDefined();

      // Payloads landed (GUILD_TRACE_PAYLOADS=1 on this stack).
      const payloads = await chClient().query(
        `SELECT kind FROM llm_payloads WHERE request_id = toUUID('${row!["request_id"]}') ORDER BY kind`,
      );
      expect(payloads.map((p) => p["kind"]).sort()).toEqual(["request", "response"]);

      // The admin API returns the row; the summary aggregates it.
      const calls = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/admin/observability/calls?caller=model",
        headers: orgAuth(stack.adminToken),
      });
      expect(calls.statusCode).toBe(200);
      const body = JSON.parse(calls.body) as { calls: Record<string, unknown>[]; total: number };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.calls.some((c) => c["request_id"] === row!["request_id"])).toBe(true);
      expect(String(body.calls[0]!["ts"])).toContain("+00:00");

      const summary = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/admin/observability/summary",
        headers: orgAuth(stack.adminToken),
      });
      expect(summary.statusCode).toBe(200);
      const srows = (JSON.parse(summary.body) as { rows: Record<string, unknown>[] }).rows;
      const modelDay = srows.find((r) => r["caller"] === "model");
      expect(modelDay).toBeDefined();
      expect(Number(modelDay!["calls"])).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "context headers ride onto the row; internal-caller requests are skipped",
    async () => {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/openai/v1/chat/completions",
        headers: {
          authorization: `Bearer ${stack.apiKey}`,
          "content-type": "application/json",
          "x-guild-chat-id": stack.orgId, // syntactically valid uuid
          "x-guild-conversation-id": "9",
          "x-guild-turn": "4",
          "x-guild-cause": "turn-step",
        },
        payload: { model: "trace-model", messages: [{ role: "user", content: "ctx" }] },
      });
      expect(res.statusCode).toBe(200);

      // Internal-caller marker: usage still meters, no llm_calls row.
      const judgeReqId = crypto.randomUUID();
      await stack.env.app.inject({
        method: "POST",
        url: "/openai/v1/chat/completions",
        headers: {
          authorization: `Bearer ${stack.apiKey}`,
          "content-type": "application/json",
          "x-guild-internal-caller": "judge",
          "x-guild-request-id": judgeReqId,
        },
        payload: { model: "trace-model", messages: [{ role: "user", content: "internal" }] },
      });

      const rows = await traceDrained(2);
      const withCtx = rows.filter((r) => r["cause"] === "turn-step" && r["model"] === "trace-model");
      expect(withCtx.length).toBeGreaterThanOrEqual(1);
      expect(withCtx[0]!["turn"]).toBe(4);
      expect(Number(withCtx[0]!["conversation_id"])).toBe(9);

      const internal = rows.filter((r) => r["model"] === "trace-model");
      // No model row may carry the judge's pinned request id — the gateway
      // skipped it (the judge self-reports its own).
      expect(internal.some((r) => r["request_id"] === judgeReqId)).toBe(false);
      const usage = await stack.usageRows();
      expect(usage.some((u) => u["request_id"] === judgeReqId)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "member scoping: members see only their own calls; payloads stay admin-only",
    async () => {
      const res = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/observability/calls",
        headers: orgAuth(stack.memberToken),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { calls: { user_id: string }[]; total: number };
      for (const c of body.calls) expect(c.user_id).toBe(stack.memberId);

      // The admin endpoint rejects members.
      const forbidden = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/admin/observability/calls",
        headers: orgAuth(stack.memberToken),
      });
      expect(forbidden.statusCode).toBe(403);

      // Payload endpoint: admin ok, member forbidden.
      const anyId = crypto.randomUUID();
      const adminPayloads = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/admin/observability/calls/${anyId}/payloads`,
        headers: orgAuth(stack.adminToken),
      });
      expect(adminPayloads.statusCode).toBe(200);
      expect(JSON.parse(adminPayloads.body).payloads).toEqual([]);
      const memberPayloads = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/admin/observability/calls/${anyId}/payloads`,
        headers: orgAuth(stack.memberToken),
      });
      expect(memberPayloads.statusCode).toBe(403);

      // Member summary is scoped to the member's own calls (all model rows
      // on this stack belong to the member-minted key).
      const summary = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/observability/summary",
        headers: orgAuth(stack.memberToken),
      });
      expect(summary.statusCode).toBe(200);
      const srows = (JSON.parse(summary.body) as { rows: { caller: string }[] }).rows;
      expect(srows.some((r) => r.caller === "model")).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe("LLM trace: judge self-report", () => {
  it(
    "an approved judge call lands as a judge row with the tool call in cause",
    async () => {
      // A chat whose approval mode delegates to the judge.
      const created = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/chats",
        headers: orgAuth(stack.memberToken),
        payload: { title: "trace-judge" },
      });
      const chatId = (JSON.parse(created.body) as { id: string }).id;
      await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/chats/${chatId}/approval`,
        headers: orgAuth(stack.memberToken),
        payload: { default: "approve_for_me" },
      });

      // Script: the tool-call turn (the model scripts the bash call through
      // codemode — the nested call runs the same approval gate, which
      // delegates to the judge), the judge's verdict (a non-stream
      // gateway call → the mock serves SSE frames the gateway accumulates),
      // then the final answer.
      const judgeCode = 'return await tools.bash({ command: "rm -rf ./trace-judge-gone" });';
      stack.mock.setResponses([
        {
          body:
            'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_trace","type":"function","function":{"name":"codemode","arguments":' +
            JSON.stringify(JSON.stringify({ code: judgeCode })) +
            '}}]}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
            "data: [DONE]\n\n",
        },
        {
          body:
            'data: {"choices":[{"delta":{"content":"{\\"approve\\": true, \\"reason\\": \\"safe\\"}"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n' +
            "data: [DONE]\n\n",
        },
        {
          body:
            'data: {"choices":[{"delta":{"content":"done"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
            "data: [DONE]\n\n",
        },
      ]);
      const submit = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: orgAuth(stack.memberToken),
        payload: {
          chat_id: chatId,
          model: "trace-model",
          messages: [{ role: "user", content: "clean up the trace-judge dir" }],
        },
      });
      expect(submit.statusCode).toBe(200);

      const rows = await traceDrained(3);
      const judge = rows.find((r) => r["caller"] === "judge");
      expect(judge).toBeDefined();
      expect(judge!["verdict"]).toBe(true);
      expect(String(judge!["verdict_reason"])).toBe("safe");
      expect(String(judge!["cause"])).toContain("approval-gate:bash:call_trace/c");
      expect(judge!["chat_id"]).toBe(chatId);
      expect(judge!["user_id"]).toBe(stack.memberId);
      expect(Number(judge!["tokens_in"])).toBe(12);
      expect(Number(judge!["tokens_out"])).toBe(4);
      expect(Number(judge!["duration_ms"])).toBeGreaterThanOrEqual(0);
      expect(String(judge!["error"])).toBe("");

      // The gateway did NOT record a model row for the judge's own call:
      // exactly one row carries the judge's pinned request id.
      const withJudgeReqId = rows.filter((r) => r["request_id"] === judge!["request_id"]);
      expect(withJudgeReqId.length).toBe(1);
      expect(withJudgeReqId[0]!["caller"]).toBe("judge");

      // The judge row's request id joins its usage_events row.
      const usage = await stack.usageRows();
      expect(usage.some((u) => u["request_id"] === judge!["request_id"])).toBe(true);

      // Payloads for the judge's call: the gateway records none for
      // internal-caller requests, so exactly one request + one response.
      const judgePayloads = await chClient().query(
        `SELECT kind FROM llm_payloads WHERE request_id = toUUID('${judge!["request_id"]}') ORDER BY kind`,
      );
      expect(judgePayloads.map((p) => p["kind"]).sort()).toEqual(["request", "response"]);

      // Model attribution uses the durable conversation identity. Turn zero
      // is the trace schema's unknown sentinel, not a process-local counter.
      const turnModelRows = rows.filter(
        (r) => r["caller"] === "model" && r["chat_id"] === chatId,
      );
      expect(turnModelRows.length).toBeGreaterThanOrEqual(2);
      for (const r of turnModelRows) {
        expect(Number(r["turn"])).toBe(0);
        expect(Number(r["conversation_id"])).toBeGreaterThan(0);
        expect(String(r["cause"])).toBe("conversation-request");
        expect(r["user_id"]).toBe(stack.memberId);
      }
    },
    TEST_TIMEOUT,
  );
});
