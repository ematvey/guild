// Agent observability: the trace sink DDL + row mapping (traces, spans,
// payloads), the gateway's LLM span emission (run/chat context headers,
// skip-when-internal-caller), the judge's self-reported spans, run
// lifecycle mirroring, and the activity API authz + scoping. Runs against
// the disposable PG/ClickHouse stack with a scripted mock upstream.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { TraceStore } from "../platform/trace.js";
import { ClickhouseClient } from "../platform/clickhouse.js";
import { AgentStore } from "../agents/store.js";

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

async function rows(table: string, where: string): Promise<Record<string, unknown>[]> {
  return chClient().query(`SELECT * FROM ${table} WHERE ${where}`);
}

/** Waits until a ClickHouse count reaches `min` and stops changing. */
async function drainedCount(table: string, where: string, min: number): Promise<Record<string, unknown>[]> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  let last = -1;
  let out: Record<string, unknown>[] = [];
  for (let i = 0; i < 25; i++) {
    out = await rows(table, where);
    if (out.length >= min && out.length === last) return out;
    last = out.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return out;
}

describe("trace sink", () => {
  it(
    "DDL is idempotent; a trace, a span and a payload round-trip",
    async () => {
      const client = chClient();
      const sink = new TraceStore(client, true);
      await sink.ensureOnce();
      await sink.ensureOnce(); // second run: CREATE IF NOT EXISTS is a no-op
      const traceId = crypto.randomUUID();
      const spanId = crypto.randomUUID();
      const started = new Date(Date.now() - 1_000);
      await sink.recordTrace({
        trace_id: traceId,
        org_id: stack.orgId,
        user_id: stack.memberId,
        agent_id: null,
        agent_name: "Sink Agent",
        session_id: null,
        thread_id: null,
        trigger: "message",
        status: "succeeded",
        name: "Sink Agent",
        summary: "round-trip",
        started_at: started,
        finished_at: new Date(),
      });
      await sink.recordSpan({
        span_id: spanId,
        trace_id: traceId,
        org_id: stack.orgId,
        user_id: stack.memberId,
        name: "bash",
        span_type: "tool",
        status: "ok",
        start_time: started,
        end_time: new Date(),
        duration_ms: 250,
        input: '{"command":"ls"}',
        output: "file.txt",
      });
      const llmRequestId = crypto.randomUUID();
      await sink.record({
        ts: new Date(),
        request_id: llmRequestId,
        org_id: stack.orgId,
        user_id: stack.memberId,
        session_id: stack.apiKeyId,
        run_id: traceId,
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
      await sink.recordPayload(llmRequestId, stack.orgId, "request", "x");
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { rows: traces } = await sink.traces({
        orgId: stack.orgId,
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
        limit: 10,
        offset: 0,
      });
      const row = traces.find((item) => item["trace_id"] === traceId);
      expect(row).toBeDefined();
      expect(row!["summary"]).toBe("round-trip");
      expect(Number(row!["tool_count"])).toBe(1);
      expect(Number(row!["call_count"])).toBe(1);

      const detail = await sink.trace(stack.orgId, traceId);
      expect(detail.trace).not.toBeNull();
      expect(detail.spans.length).toBe(2);
      const llm = detail.spans.find((span) => span["span_type"] === "llm");
      expect(llm).toBeDefined();
      expect(Number(llm!["reasoning_tokens"])).toBe(5);

      // A trace-payloads-off sink records the call but no payload rows.
      const sinkOff = new TraceStore(client, false);
      await sinkOff.recordPayload(String(llm!["request_id"]), stack.orgId, "request", "should not land");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const payloads = await sink.payloads(stack.orgId, String(llm!["request_id"]));
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.["body"]).toBe("x");
    },
    TEST_TIMEOUT,
  );

  it(
    "a request stores only its new messages and the read path rebuilds the history",
    async () => {
      const client = chClient();
      const sink = new TraceStore(client, true);
      await sink.ensureOnce();
      const traceId = crypto.randomUUID();
      const filler = "x".repeat(500);
      const messages: Record<string, unknown>[] = [{ role: "user", content: `start ${filler}` }];
      const ids: string[] = [];
      const sizes: number[] = [];
      for (let step = 0; step < 3; step += 1) {
        messages.push({ role: "assistant", content: `step ${step} ${filler}` });
        const requestId = crypto.randomUUID();
        const body = JSON.stringify({ model: "m", messages: [...messages] });
        ids.push(requestId);
        sizes.push(body.length);
        await sink.recordPayload(requestId, stack.orgId, "request", body, traceId);
      }

      const stored = await client.query(
        `SELECT request_id, length(body) AS size, prefix_count, parent_request_id FROM llm_payloads ` +
          `WHERE org_id = toUUID('${stack.orgId}') AND kind = 'request' AND request_id IN (${ids.map((id) => `toUUID('${id}')`).join(", ")}) ` +
          "ORDER BY ts",
      );
      expect(stored).toHaveLength(3);
      // The first request is the root; the two later ones carry one message each.
      const byId = new Map(stored.map((row) => [String(row["request_id"]), row]));
      expect(Number(byId.get(ids[0]!)!["prefix_count"])).toBe(0);
      expect(Number(byId.get(ids[1]!)!["prefix_count"])).toBe(2);
      expect(Number(byId.get(ids[2]!)!["prefix_count"])).toBe(3);
      expect(Number(byId.get(ids[2]!)!["size"])).toBeLessThan(sizes[2]! / 2);
      expect(String(byId.get(ids[2]!)!["parent_request_id"])).toBe(ids[1]);

      // The API shape is unchanged: the leaf payload is the whole request.
      const rebuilt = (await sink.payloads(stack.orgId, ids[2]!)).find((row) => row["kind"] === "request");
      expect(rebuilt).toBeDefined();
      const parsed = JSON.parse(String(rebuilt!["body"])) as { messages: { content: string }[] };
      expect(parsed.messages).toHaveLength(messages.length);
      expect(parsed.messages.map((m) => m.content)).toEqual(messages.map((m) => String(m["content"])));

      // A request that does not extend the parent falls back to a full body.
      const diverged = crypto.randomUUID();
      const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "different" }] });
      await sink.recordPayload(diverged, stack.orgId, "request", body, traceId);
      const full = await sink.payloads(stack.orgId, diverged);
      const fullRow = full.find((row) => row["kind"] === "request");
      expect(Number(fullRow!["prefix_count"])).toBe(0);
      expect(JSON.parse(String(fullRow!["body"]))).toEqual(JSON.parse(body));
    },
    TEST_TIMEOUT,
  );
});

describe("gateway emission + activity API", () => {
  it(
    "a model call records an llm span linked to the run id",
    async () => {
      const runId = crypto.randomUUID();
      const chatId = crypto.randomUUID();
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/openai/v1/chat/completions",
        headers: {
          authorization: `Bearer ${stack.apiKey}`,
          "content-type": "application/json",
          "x-guild-run-id": runId,
          "x-guild-chat-id": chatId,
          "x-guild-conversation-id": "9",
          "x-guild-turn": "4",
          "x-guild-cause": "turn-step",
        },
        payload: { model: "trace-model", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);

      const spans = await drainedCount(
        "agent_spans",
        `org_id = toUUID('${stack.orgId}') AND span_type = 'llm' AND model = 'trace-model'`,
        1,
      );
      const span = spans.find((item) => item["run_id"] === runId);
      expect(span).toBeDefined();
      expect(span!["trace_id"]).toBe(runId);
      expect(span!["chat_id"]).toBe(chatId);
      expect(span!["caller"]).toBe("model");
      expect(Number(span!["tokens_in"])).toBe(3);
      expect(Number(span!["tokens_out"])).toBe(2);
      const attributes = JSON.parse(String(span!["attributes"])) as Record<string, unknown>;
      expect(attributes["turn"]).toBe(4);
      expect(attributes["conversation_id"]).toBe(9);
      expect(attributes["cause"]).toBe("turn-step");

      // The join holds: the usage event carries the same request id.
      const usage = await stack.usageRows();
      expect(usage.some((row) => row["request_id"] === span!["request_id"])).toBe(true);

      // Payloads landed (GUILD_TRACE_PAYLOADS=1 on this stack).
      const payloads = await chClient().query(
        `SELECT kind FROM llm_payloads WHERE request_id = toUUID('${span!["request_id"]}') ORDER BY kind`,
      );
      expect(payloads.map((p) => p["kind"]).sort()).toEqual(["request", "response"]);

      // The admin API returns the span; the summary aggregates it.
      const calls = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/activity/spans?type=llm&caller=model",
        headers: orgAuth(stack.adminToken),
      });
      expect(calls.statusCode).toBe(200);
      const body = JSON.parse(calls.body) as { spans: Record<string, unknown>[]; total: number };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.spans.some((item) => item["span_id"] === span!["span_id"])).toBe(true);
      expect(String(body.spans[0]!["start_time"])).toContain("+00:00");

      const summary = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/activity/summary",
        headers: orgAuth(stack.adminToken),
      });
      expect(summary.statusCode).toBe(200);
      const totals = (JSON.parse(summary.body) as { totals: Record<string, unknown> }).totals;
      expect(Number(totals["calls"])).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "internal-caller requests are skipped by the gateway",
    async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 500));
      const spans = await rows("agent_spans", `org_id = toUUID('${stack.orgId}')`);
      expect(spans.some((span) => span["span_id"] === judgeReqId)).toBe(false);
      const usage = await stack.usageRows();
      expect(usage.some((row) => row["request_id"] === judgeReqId)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "member scoping: members see only their own spans; payloads stay admin-only",
    async () => {
      const sink = new TraceStore(chClient(), true);
      const foreign = crypto.randomUUID();
      await sink.recordSpan({
        span_id: foreign,
        trace_id: foreign,
        org_id: stack.orgId,
        user_id: stack.adminId,
        name: "model call",
        span_type: "llm",
        start_time: new Date(),
        end_time: new Date(),
        duration_ms: 10,
        model: "admin-only-model",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const member = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/activity/spans?type=llm",
        headers: orgAuth(stack.memberToken),
      });
      expect(member.statusCode).toBe(200);
      const memberBody = JSON.parse(member.body) as { spans: { span_id: string }[] };
      expect(memberBody.spans.some((span) => span.span_id === foreign)).toBe(false);

      const admin = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/activity/spans?type=llm",
        headers: orgAuth(stack.adminToken),
      });
      const adminBody = JSON.parse(admin.body) as { spans: { span_id: string }[] };
      expect(adminBody.spans.some((span) => span.span_id === foreign)).toBe(true);

      const anyId = crypto.randomUUID();
      const adminPayloads = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/activity/spans/${anyId}/payloads`,
        headers: orgAuth(stack.adminToken),
      });
      expect(adminPayloads.statusCode).toBe(200);
      expect(JSON.parse(adminPayloads.body).payloads).toEqual([]);
      const memberPayloads = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/activity/spans/${anyId}/payloads`,
        headers: orgAuth(stack.memberToken),
      });
      expect(memberPayloads.statusCode).toBe(403);
    },
    TEST_TIMEOUT,
  );
});

describe("run lifecycle mirror", () => {
  it(
    "createRun and updateRun reach agent_traces",
    async () => {
      const created = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/agents",
        headers: orgAuth(stack.adminToken),
        payload: { name: "Trace Mirror Agent", model: "trace-model" },
      });
      expect(created.statusCode).toBe(200);
      const agentId = (JSON.parse(created.body) as { agent: { id: string } }).agent.id;

      const store = new AgentStore(stack.env.db, stack.env.app.platform.trace);
      const run = await store.createRun({
        agent_id: agentId,
        user_id: stack.memberId,
        trigger: "message",
        status: "running",
        started_at: new Date().toISOString(),
      });
      const createdRows = await drainedCount(
        "agent_traces",
        `org_id = toUUID('${stack.orgId}') AND trace_id = toUUID('${run.id}')`,
        1,
      );
      expect(createdRows[0]?.["status"]).toBe("running");
      expect(createdRows[0]?.["agent_name"]).toBe("Trace Mirror Agent");

      await new Promise((resolve) => setTimeout(resolve, 10));
      await store.updateRun(run.id, {
        status: "succeeded",
        summary: "finished cleanly",
        finished_at: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const final = await chClient().query(
        `SELECT status, summary FROM agent_traces FINAL WHERE trace_id = toUUID('${run.id}')`,
      );
      expect(final[0]?.["status"]).toBe("succeeded");
      expect(final[0]?.["summary"]).toBe("finished cleanly");

      const detail = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/activity/traces/${run.id}`,
        headers: orgAuth(stack.adminToken),
      });
      expect(detail.statusCode).toBe(200);
      const body = JSON.parse(detail.body) as { trace: { trace_id: string } };
      expect(body.trace.trace_id).toBe(run.id);
    },
    TEST_TIMEOUT,
  );
});
