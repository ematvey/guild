// WP2 acceptance: two child runs finish while the parent is busy, the parent
// takes one turn and one message with both results, and both child_result
// rows carry that parent run id. A user cancel of a child wakes the parent
// with cancelled/user.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { GuildRuntime } from "../../harness/runtime.js";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import { AgentRunLifecycle } from "../../agents/lifecycle.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { assistantMessageEvent } from "../../platform/domain/thread-events.js";
import { pgTimestampToRfc3339 } from "../../platform/time.js";
import { setupGatewayStack, type GatewayStack } from "../support/gateway-stack.js";

const answer = {
  body:
    'data: {"choices":[{"delta":{"role":"assistant","content":"done"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
};

async function until(probe: () => Promise<boolean>, timeout = 25_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition did not become true");
}

describe("child result delivery", () => {
  let stack: GatewayStack;
  let store: AgentStore;
  let threads: ThreadStore;
  let lifecycle: AgentRunLifecycle;
  const auth = () => ({ authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" });

  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    stack = await setupGatewayStack({
      GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
      GUILD_ALLOW_SHELL_TOOLS: "1",
    });
    await stack.env.app.listen({ port, host: "127.0.0.1" });
    await stack.routeModel("GLM-Test-Model");
    store = new AgentStore({ pool: stack.env.db, chats: new ChatStore(stack.env.db) });
    threads = new ThreadStore(stack.env.db);
    const runtime = (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
    lifecycle = new AgentRunLifecycle({
      pool: stack.env.db,
      log: pino({ level: "silent" }),
      delivery: { deliver: (input) => runtime.deliverChildResult(input) },
    });
  }, 60_000);

  afterAll(async () => {
    await stack.close();
  }, 60_000);

  /** Starts one parent turn whose first model call is a slow tool, so the
   *  parent is busy while children finish. */
  async function startBusyParent(title: string): Promise<{
    chatId: string;
    threadId: string;
    agentId: string;
    runId: string;
  }> {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: auth(),
      payload: { title },
    });
    const chatId = JSON.parse(created.body).id as string;
    await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/approval`,
      headers: auth(),
      payload: { default: "full_access" },
    });
    const code = JSON.stringify({ code: 'return await tools.bash({command:"sleep 3; echo boundary"});' });
    const toolBody =
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "slow-boundary", type: "function", function: { name: "codemode", arguments: code } }] } }] })}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    stack.mock.setResponses([{ body: toolBody }, answer, answer, answer]);
    const sent = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/turns`,
      headers: auth(),
      payload: {
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "run a slow tool" }],
      },
    });
    expect(sent.statusCode).toBe(200);
    await until(async () => {
      const rows = await stack.env.db.query(
        "SELECT 1 FROM tasks t JOIN chat_conversations c ON c.conversation_id=t.conversation_id WHERE c.chat_id=$1 AND t.kind=$2 AND t.status='running'",
        [chatId, JSON.stringify("pi.tool")],
      );
      return rows.rows.length > 0;
    });
    const thread = await stack.env.db.query<{ id: string; agent_id: string }>(
      "SELECT id, agent_id FROM agent_threads WHERE chat_id = $1",
      [chatId],
    );
    const threadRow = thread.rows[0]!;
    const run = await stack.env.db.query<{ id: string }>(
      "SELECT id FROM agent_runs WHERE thread_id = $1 AND status IN ('queued','running') ORDER BY created_at ASC LIMIT 1",
      [threadRow.id],
    );
    return { chatId, threadId: threadRow.id, agentId: threadRow.agent_id, runId: run.rows[0]!.id };
  }

  async function finishChild(args: {
    parentThreadId: string;
    parentRunId: string;
    agentId: string;
    text: string;
  }): Promise<{ threadId: string; runId: string; chatId: string }> {
    const child = await store.threads.createChildThread(
      args.parentThreadId,
      args.agentId,
      stack.memberId,
      `Child ${args.text}`,
    );
    const run = await store.runs.createRun({
      agent_id: args.agentId,
      user_id: stack.memberId,
      thread_id: child.id,
      parent_run_id: args.parentRunId,
      delegate_agent_id: args.agentId,
      depth: child.depth,
      trigger: "delegation",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await threads.appendEvent(child.chat_id, { type: "user_message", content: args.text, attachments: [] });
    const row = await threads.appendEvent(
      child.chat_id,
      assistantMessageEvent(
        1,
        1,
        [{ type: "text", text: args.text }],
        { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        "GLM-Test-Model",
      ),
    );
    await lifecycle.assistantEvent(child.chat_id, row);
    return { threadId: child.id, runId: run.id, chatId: child.chat_id };
  }

  function userTexts(body: Record<string, unknown>): string[] {
    return ((body["messages"] as { role: string; content: unknown }[] | undefined) ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  }

  it("delivers two finished children as one parent turn and one message", async () => {
    const parent = await startBusyParent("Two children");
    const first = await finishChild({
      parentThreadId: parent.threadId,
      parentRunId: parent.runId,
      agentId: parent.agentId,
      text: "child one result",
    });
    const second = await finishChild({
      parentThreadId: parent.threadId,
      parentRunId: parent.runId,
      agentId: parent.agentId,
      text: "child two result",
    });

    await until(async () => {
      const rows = await stack.env.db.query<{ consumed_by_run_id: string | null }>(
        "SELECT consumed_by_run_id FROM thread_events WHERE chat_id = $1 AND type = 'child_result' ORDER BY seq",
        [parent.chatId],
      );
      return rows.rows.length === 2 && rows.rows.every((row) => row.consumed_by_run_id === parent.runId);
    });
    await until(async () => {
      const rows = await stack.env.db.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [
        parent.runId,
      ]);
      return rows.rows[0]?.status !== "running" && rows.rows[0]?.status !== "queued";
    });

    const carrying = stack.mock.requests.filter((request) => {
      const texts = userTexts(request.body);
      return (
        texts.some((text) => text.includes("child one result")) &&
        texts.some((text) => text.includes("child two result"))
      );
    });
    expect(carrying).toHaveLength(1);
    expect(
      stack.mock.requests.filter((request) =>
        userTexts(request.body).some((text) => text.includes("child one result")),
      ),
    ).toHaveLength(1);
    expect(
      stack.mock.requests.filter((request) =>
        userTexts(request.body).some((text) => text.includes("child two result")),
      ),
    ).toHaveLength(1);

    const delivered = await stack.env.db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM thread_events WHERE chat_id = $1 AND type = 'child_result' ORDER BY seq",
      [parent.chatId],
    );
    expect(delivered.rows).toHaveLength(2);
    expect(delivered.rows.map((row) => row.payload.final_text)).toEqual(["child one result", "child two result"]);
    expect(delivered.rows.every((row) => typeof row.payload.thread_id === "string")).toBe(true);
    expect(delivered.rows.map((row) => row.payload.chat_id)).toEqual([first.chatId, second.chatId]);
    // The child thread's agent name labels the row; both children share it.
    const childAgents = await stack.env.db.query<{ name: string }>(
      "SELECT DISTINCT a.name FROM agent_threads t JOIN agents a ON a.id = t.agent_id WHERE t.id = ANY($1::uuid[])",
      [[first.threadId, second.threadId]],
    );
    expect(childAgents.rows).toHaveLength(1);
    expect(delivered.rows.map((row) => row.payload.agent_name)).toEqual([
      childAgents.rows[0]!.name,
      childAgents.rows[0]!.name,
    ]);
    expect(delivered.rows.map((row) => row.payload.title)).toEqual([
      "Child child one result",
      "Child child two result",
    ]);
    // The row rebuilt from the result alone carries the run's start.
    const starts = await stack.env.db.query<{ started_at: string }>(
      `SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at
       FROM agent_runs WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC`,
      [[first.runId, second.runId]],
    );
    expect(delivered.rows.map((row) => row.payload.started_at)).toEqual(
      starts.rows.map((row) => pgTimestampToRfc3339(row.started_at)),
    );

    const runs = await stack.env.db.query("SELECT id FROM agent_runs WHERE thread_id = $1", [parent.threadId]);
    expect(runs.rows).toHaveLength(1);
    expect(first.threadId).not.toBe(second.threadId);
  }, 30_000);

  it("delivers a user cancel of a child as cancelled/user", async () => {
    const parent = await startBusyParent("Cancel child");
    const child = await store.threads.createChildThread(
      parent.threadId,
      parent.agentId,
      stack.memberId,
      "Cancelled child",
    );
    const run = await store.runs.createRun({
      agent_id: parent.agentId,
      user_id: stack.memberId,
      thread_id: child.id,
      parent_run_id: parent.runId,
      delegate_agent_id: parent.agentId,
      depth: child.depth,
      trigger: "delegation",
      status: "running",
      started_at: new Date().toISOString(),
    });
    const runtime = (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
    await runtime.stopChat(child.chat_id);

    await until(async () => {
      const rows = await stack.env.db.query<{ payload: Record<string, unknown>; consumed_by_run_id: string | null }>(
        "SELECT payload, consumed_by_run_id FROM thread_events WHERE chat_id = $1 AND type = 'child_result'",
        [parent.chatId],
      );
      return (
        rows.rows.length === 1 &&
        rows.rows[0]!.payload.status === "cancelled" &&
        rows.rows[0]!.payload.reason === "user" &&
        rows.rows[0]!.consumed_by_run_id === parent.runId
      );
    });
    await until(async () => {
      const rows = await stack.env.db.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [
        parent.runId,
      ]);
      return rows.rows[0]?.status !== "running" && rows.rows[0]?.status !== "queued";
    });
    const cancelled = stack.mock.requests.filter((request) =>
      userTexts(request.body).some((text) => text.includes("cancelled") && text.includes("user")),
    );
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    const done = await store.runs.getRun(run.id);
    expect(done.status).toBe("cancelled");
  }, 30_000);

  it("drops the result of a closed child", async () => {
    const parent = await startBusyParent("Closed child");
    const child = await store.threads.createChildThread(
      parent.threadId,
      parent.agentId,
      stack.memberId,
      "Closed child",
    );
    const run = await store.runs.createRun({
      agent_id: parent.agentId,
      user_id: stack.memberId,
      thread_id: child.id,
      parent_run_id: parent.runId,
      delegate_agent_id: parent.agentId,
      depth: child.depth,
      trigger: "delegation",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await store.tree.closeSubtree(child.id);
    const runtime = (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
    await runtime.deliverChildResult({
      child_thread_id: child.id,
      run_id: run.id,
      status: "succeeded",
      reason: null,
      final_text: "too late",
    });
    const rows = await stack.env.db.query("SELECT 1 FROM thread_events WHERE chat_id = $1 AND type = 'child_result'", [
      parent.chatId,
    ]);
    expect(rows.rows).toHaveLength(0);
  }, 30_000);
});
