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
  it("keeps the inbox thread on its own assistant", async () => {
    const app = stack.env.app;
    const headers = { authorization: `Bearer ${stack.memberToken}` };
    const opened = await app.inject({ method: "POST", url: "/api/v1/assistant", headers, payload: {} });
    const inbox = opened.json() as { agent_id: string; chat_id: string };
    const read = await app.inject({ method: "GET", url: `/api/v1/threads/${inbox.chat_id}/agent`, headers });
    expect((read.json() as { switcheable: boolean }).switcheable).toBe(false);
    const other = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers,
      payload: { name: "Other agent", model: "coordination-test", visibility: "org" },
    });
    const otherId = (other.json() as { agent: { id: string } }).agent.id;
    const moved = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${inbox.chat_id}/agent`,
      headers,
      payload: { agent_id: otherId },
    });
    expect(moved.statusCode).toBe(409);
    const after = await stack.env.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_threads WHERE chat_id = $1",
      [inbox.chat_id],
    );
    expect(after.rows[0]!.agent_id).toBe(inbox.agent_id);
  }, 30000);

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

  it("authorizes Routine mutations against the active attributed Member", async () => {
    const app = stack.env.app;
    const admin = { authorization: `Bearer ${stack.adminToken}` };
    const member = { authorization: `Bearer ${stack.memberToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: admin,
      payload: {
        name: "Shared Routine operator",
        model: "coordination-test",
        visibility: "org",
        resources: { assistant: { enabled: true } },
      },
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const agentId = created.json().agent.id as string;
    const thread = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/threads`,
      headers: admin,
      payload: { title: "Routine discussion" },
    });
    const threadPath = `/api/v1/agents/${agentId}/threads/${thread.json().thread.id}`;
    expect(thread.json().thread).toMatchObject({ is_default: false, archived: false, deleted: false });
    expect((await app.inject({ method: "GET", url: threadPath, headers: admin })).json().thread).toMatchObject({
      is_default: false,
    });
    expect(
      (await app.inject({ method: "PATCH", url: threadPath, headers: admin, payload: { title: "Renamed" } })).json()
        .thread,
    ).toMatchObject({ is_default: false, title: "Renamed" });

    const request = async (headers: typeof admin, message: string) => {
      const inbox = await app.inject({
        method: "POST",
        url: "/api/v1/assistant",
        headers,
        payload: { agent_id: agentId },
      });
      expect(inbox.statusCode, inbox.body).toBe(200);
      const event = randomUUID();
      const posted = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agentId}/threads/${inbox.json().thread_id}/turns`,
        headers,
        payload: { message, user_message_id: event },
      });
      expect(posted.statusCode, posted.body).toBeLessThan(300);
      const input = () =>
        stack.env.db.query<{ id: string }>("SELECT id FROM agent_coordination_inputs WHERE source_event_id=$1", [
          event,
        ]);
      await waitFor(async () => (await input()).rowCount === 1, 10000);
      return (await input()).rows[0]!.id;
    };
    const execute = async (code: string) => {
      const before = stack.mock.requests.length;
      stack.mock.setResponses([{ body: call("codemode", { code }) }, { body: final("Routine action checked") }]);
      await app.platform.coordination.tick();
      await waitFor(() => stack.mock.requests.length >= before + 2, 10000);
      await waitFor(
        async () =>
          (
            await stack.env.db.query(
              "SELECT 1 FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE t.agent_id=$1 AND t.execution_role='coordinator' AND r.status IN ('queued','running')",
              [agentId],
            )
          ).rowCount === 0,
        10000,
      );
      const request = stack.mock.requests[before + 1]?.body as { messages?: { role: string; content: string }[] };
      return request.messages?.at(-1)?.content ?? "";
    };
    const create = (input_id: string) =>
      `return await tools.create_routine(${JSON.stringify({ input_id, name: "Weekly review", schedule: "0 0 * * 1", prompt: "Review the week" })});`;
    const authorized = await request(admin, "Create a weekly review Routine");
    await execute(create(authorized));
    const routines = await stack.env.db.query<{ id: string; prompt: string }>(
      "SELECT id, prompt FROM agent_routines WHERE agent_id=$1",
      [agentId],
    );
    expect(routines.rows).toHaveLength(1);
    const routine_id = routines.rows[0]!.id;
    const useOnly = await request(member, "Change the weekly review Routine");
    const instructions = { input_id: useOnly, routine_id, prompt: "Different instructions" };
    const attempted = await execute(
      `try { await tools.update_routine(${JSON.stringify(instructions)}); } catch (error) { text(error.message); } return await tools.delete_routine(${JSON.stringify({ input_id: authorized, routine_id })});`,
    );
    expect(attempted.includes("you cannot manage this agent")).toBe(true);
    expect(attempted.includes("Routine changes require an input from the active Turn")).toBe(true);
    expect((await stack.env.db.query("SELECT prompt FROM agent_routines WHERE id=$1", [routine_id])).rows).toEqual([
      { prompt: "Review the week" },
    ]);
  }, 30000);

  it("delivers an explicit reply to the inbox without leaking its internal final answer", async () => {
    const app = stack.env.app;
    const headers = { authorization: `Bearer ${stack.memberToken}` };
    const opened = await app.inject({ method: "POST", url: "/api/v1/assistant", headers, payload: {} });
    expect(opened.statusCode, opened.body).toBe(200);
    const inbox = opened.json() as { chat_id: string; thread_id: string; agent_id: string };
    const index = await app.inject({ method: "GET", url: "/api/v1/threads", headers });
    expect(index.json().chats.find((row: { id: string }) => row.id === inbox.chat_id).assistant_inbox).toBe(true);
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
    const run = (
      await stack.env.db.query<{ id: string; status: string }>(
        `SELECT r.id, r.status FROM agent_runs r
         JOIN agent_threads t ON t.id=r.thread_id
         WHERE t.chat_id=$1 AND r.finished_at IS NOT NULL
         ORDER BY r.finished_at LIMIT 1`,
        [coordinator.chat_id],
      )
    ).rows[0]!;
    const adminHeaders = { authorization: `Bearer ${stack.adminToken}` };
    const traceUrl = `/api/v1/activity/traces/${run.id}`;
    const readAdminTrace = () => app.inject({ method: "GET", url: traceUrl, headers: adminHeaders });
    await waitFor(async () => {
      const response = await readAdminTrace();
      return response.statusCode === 200 && response.json().trace.status === run.status;
    }, 10000);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/activity/traces?session=${coordinator.chat_id}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ traces: [], total: 0 });
    const detail = await app.inject({ method: "GET", url: traceUrl, headers });
    expect(detail.statusCode).toBe(404);
    const adminList = await app.inject({
      method: "GET",
      url: `/api/v1/activity/traces?session=${coordinator.chat_id}`,
      headers: adminHeaders,
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().traces).toEqual(
      expect.arrayContaining([expect.objectContaining({ trace_id: run.id, status: run.status })]),
    );
    const adminDetail = await readAdminTrace();
    expect(adminDetail.statusCode).toBe(200);
    expect(adminDetail.json().trace.trace_id).toBe(run.id);
    expect(adminDetail.json().spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ span_type: "llm", session_id: coordinator.chat_id }),
        expect.objectContaining({ span_type: "tool", session_id: coordinator.chat_id, name: "codemode" }),
      ]),
    );
    const memberSpans = await app.inject({
      method: "GET",
      url: `/api/v1/activity/spans?session=${coordinator.chat_id}`,
      headers,
    });
    expect(memberSpans.statusCode).toBe(200);
    expect(memberSpans.json()).toEqual({ spans: [], total: 0 });
    const requests = stack.mock.requests.map((r) => JSON.stringify(r.body)).join("\n");
    expect(requests).toContain("persistent coordinator");
    expect(requests).toContain(input.id);
  }, 30000);
});
