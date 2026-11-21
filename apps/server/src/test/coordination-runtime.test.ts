import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { waitFor } from "./support/wait.js";

const final = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const call = (name: string, args: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "coordination-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
let stack: GatewayStack;
beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  stack = await setupGatewayStack({ GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}` });
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  stack.env.app.platform.coordination.stop();
  await stack.routeModel("coordination-test");
}, 30000);
afterAll(async () => {
  await stack?.close();
}, 30000);

describe("configured coordinator conversation", () => {
  it("rejects a stale inbox submission after coordination is disabled", async () => {
    const app = stack.env.app;
    const headers = { authorization: `Bearer ${stack.memberToken}` };
    const opened = await app.inject({ method: "POST", url: "/api/v1/assistant", headers, payload: {} });
    const inbox = opened.json() as { agent_id: string; thread_id: string; chat_id: string };
    await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${inbox.agent_id}`,
      headers,
      payload: { resources: { assistant: { enabled: false } } },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${inbox.agent_id}/threads/${inbox.thread_id}/turns`,
        headers,
        payload: { message: "Should be rejected" },
      });
      expect(result.statusCode, result.body).toBeGreaterThanOrEqual(400);
      expect(result.body).toContain("disabled");
    } finally {
      await app.inject({
        method: "PATCH",
        url: `/api/v1/agents/${inbox.agent_id}`,
        headers,
        payload: { resources: { assistant: { enabled: true } } },
      });
    }
  });

  it("delivers an explicit reply to the inbox without leaking its internal final answer", async () => {
    const app = stack.env.app;
    const headers = { authorization: `Bearer ${stack.memberToken}` };
    const opened = await app.inject({ method: "POST", url: "/api/v1/assistant", headers, payload: {} });
    expect(opened.statusCode, opened.body).toBe(200);
    const inbox = opened.json() as { chat_id: string; thread_id: string; agent_id: string };
    stack.mock.setResponses([{ body: final("INTERNAL ONLY") }]);
    const userMessageId = randomUUID();
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${inbox.agent_id}/threads/${inbox.thread_id}/turns`,
      headers,
      payload: { message: "Please check the project and only report problems.", user_message_id: userMessageId },
    });
    expect(posted.statusCode, posted.body).toBeLessThan(300);
    await waitFor(
      async () =>
        (
          await stack.env.db.query("SELECT 1 FROM agent_coordination_inputs WHERE agent_id=$1 AND kind='request'", [
            inbox.agent_id,
          ])
        ).rowCount! > 0,
      10000,
    );
    const input = (
      await stack.env.db.query<{ id: string }>(
        "SELECT id FROM agent_coordination_inputs WHERE agent_id=$1 AND kind='request' ORDER BY seq DESC LIMIT 1",
        [inbox.agent_id],
      )
    ).rows[0]!;
    stack.mock.setResponses([
      {
        body: call("codemode", {
          code: `return await tools.send_message(${JSON.stringify({ input_id: input.id, text: "I’ll check the project and report only problems." })});`,
        }),
      },
      { body: final("INTERNAL ONLY") },
    ]);
    await app.platform.coordination.tick();
    await waitFor(
      async () =>
        (
          await stack.env.db.query(
            "SELECT 1 FROM thread_events WHERE chat_id=$1 AND type='assistant_message' AND payload::text LIKE '%report only problems%'",
            [inbox.chat_id],
          )
        ).rowCount! > 0,
      20000,
    );
    await waitFor(
      async () =>
        (
          await stack.env.db.query(
            "SELECT 1 FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE t.agent_id=$1 AND t.execution_role='coordinator' AND r.status IN ('queued','running')",
            [inbox.agent_id],
          )
        ).rowCount === 0,
      10000,
    );
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${inbox.agent_id}/threads/${inbox.thread_id}/turns`,
      headers,
      payload: { message: "Please acknowledge this second request separately." },
    });
    expect(second.statusCode, second.body).toBeLessThan(300);
    await waitFor(
      async () =>
        (
          await stack.env.db.query(
            "SELECT 1 FROM agent_coordination_inputs WHERE agent_id=$1 AND kind='request' AND id<>$2",
            [inbox.agent_id, input.id],
          )
        ).rowCount! > 0,
      10000,
    );
    const next = (
      await stack.env.db.query<{ id: string }>(
        "SELECT id FROM agent_coordination_inputs WHERE agent_id=$1 AND kind='request' ORDER BY seq DESC LIMIT 1",
        [inbox.agent_id],
      )
    ).rows[0]!;
    stack.mock.setResponses([
      {
        body: call("codemode", {
          code: `return await tools.send_message(${JSON.stringify({ input_id: next.id, text: "Second acknowledgment delivered." })});`,
        }),
      },
      { body: final("INTERNAL ONLY") },
    ]);
    await app.platform.coordination.tick();
    await waitFor(
      async () =>
        (
          await stack.env.db.query(
            "SELECT 1 FROM thread_events WHERE chat_id=$1 AND payload::text LIKE '%Second acknowledgment delivered%'",
            [inbox.chat_id],
          )
        ).rowCount! > 0,
      20000,
    );
    const rows = await stack.env.db.query<{ payload: unknown }>("SELECT payload FROM thread_events WHERE chat_id=$1", [
      inbox.chat_id,
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain("INTERNAL ONLY");
    const visibleRequest = await stack.env.db.query(
      "SELECT id FROM thread_events WHERE chat_id=$1 AND type='user_message' AND payload->>'content'=$2",
      [inbox.chat_id, "Please check the project and only report problems."],
    );
    expect(visibleRequest.rows.map((row) => row.id)).toEqual([userMessageId]);
    const coordinator = (
      await stack.env.db.query<{ chat_id: string }>(
        "SELECT chat_id FROM agent_threads WHERE agent_id=$1 AND execution_role='coordinator'",
        [inbox.agent_id],
      )
    ).rows[0]!;
    const forbidden = await app.inject({ method: "GET", url: `/api/v1/chats/${coordinator.chat_id}`, headers });
    expect(forbidden.statusCode).toBe(404);
    const requests = stack.mock.requests.map((r) => JSON.stringify(r.body)).join("\n");
    expect(requests).toContain("persistent coordinator");
    expect(requests).toContain(input.id);
  }, 30000);
});
