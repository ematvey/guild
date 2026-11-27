// End to end: the real app + harness + scripted model provider, with
// server-side tools running in gVisor sandboxes through a real runner
// (scripts/sandbox-it.sh starts it). Skipped unless GUILD_SANDBOX_IT_URL
// is set.

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "../support/gateway-stack.js";
import { waitFor } from "../support/wait.js";

const URL_ = process.env.GUILD_SANDBOX_IT_URL;
const TOKEN = process.env.GUILD_SANDBOX_RUNNER_TOKEN ?? "";

const toolCallSse = (name: string, args: string, id = name): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_sbx_' +
  id +
  '","type":"function","function":{"name":"' +
  name +
  '","arguments":' +
  JSON.stringify(args) +
  "}}]}}]}\n\n" +
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
  "data: [DONE]\n\n";

const finalSse =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"done"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

describe.skipIf(URL_ === undefined)("server-side tools in sandboxes (e2e)", () => {
  let stack: GatewayStack;

  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const workspace = process.env.GUILD_SANDBOX_IT_WORKSPACE_ROOT;
    stack = await setupGatewayStack(
      {
        ...(workspace ? { GUILD_AGENT_WORKSPACE_ROOT: workspace, GUILD_AGENT_WORKSPACE_WRITE_ROOT: workspace } : {}),
        GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
        GUILD_DATA_DIR: mkdtempSync(path.join(tmpdir(), "guild-sbx-e2e-data-")),
        GUILD_SANDBOX_RUNNER_URL: URL_!,
        GUILD_SANDBOX_RUNNER_TOKEN: TOKEN,
        GUILD_ALLOW_SHELL_TOOLS: "1",
        GUILD_APPROVAL_TIMEOUT_MS: "60000",
      },
      { dbPrefix: "guild_sbx_e2e_test", logLevel: process.env.SBX_TEST_LOG ?? "error" },
    );
    await stack.env.app.listen({ port, host: "127.0.0.1" });
    await stack.routeModel("GLM-Test-Model");
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  }, 30_000);

  const auth = () => ({ authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" });

  async function events(chatId: string): Promise<Array<{ event: Record<string, unknown> }>> {
    const res = await stack.env.app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/thread`, headers: auth() });
    return (JSON.parse(res.body) as { events: Array<{ event: Record<string, unknown> }> }).events;
  }

  async function toolResult(chatId: string): Promise<{ content: string; is_error: boolean }> {
    let found: { content: string; is_error: boolean } | undefined;
    await waitFor(
      async () => {
        const all = await events(chatId);
        const result = all.findLast((e) => e.event["type"] === "tool_result");
        const last = all[all.length - 1]?.event as { type?: string; blocks?: Array<{ type: string }> } | undefined;
        const settled = last?.type === "assistant_message" && (last.blocks?.some((b) => b.type === "text") ?? false);
        if (result !== undefined && settled) found = result.event as unknown as { content: string; is_error: boolean };
        return found !== undefined;
      },
      120_000,
      200,
      "turn did not settle",
    );
    return found!;
  }

  it("plain chat: shell and file tools run inside the gVisor sandbox", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(),
      payload: { title: "sbx-shell" },
    });
    const chatId = (JSON.parse(created.body) as { id: string }).id;
    await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/approval`,
      headers: auth(),
      payload: { default: "full_access" },
    });

    stack.mock.setResponses([
      {
        body: toolCallSse(
          "bash",
          JSON.stringify({
            command:
              "uname -r; id -u; tr '\\0' '\\n' < /proc/self/environ | grep -c '^GUILD_' ; ls /data 2>&1 | head -1; echo from-sandbox > out.txt; cat out.txt; pwd",
          }),
        ),
      },
      { body: toolCallSse("read", JSON.stringify({ path: "out.txt" }), "read-output") },
      { body: finalSse },
    ]);
    const submit = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(),
      payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content: "inspect" }] },
    });
    expect(submit.statusCode).toBe(200);
    const file = await toolResult(chatId);
    const results = (await events(chatId)).filter(({ event }) => event["type"] === "tool_result");
    expect(results).toHaveLength(2);
    const result = results[0]!.event as { content: string; is_error: boolean };
    expect(result.is_error, result.content).toBe(false);
    expect(file.is_error, file.content).toBe(false);
    expect(file.content).toContain("from-sandbox");
    expect(result.content).toMatch(/gvisor/);
    expect(result.content).toMatch(/^1000$/m);
    expect(result.content).toMatch(/^0$/m);
    expect(result.content).toMatch(/cannot access '\/data'/);
    expect(result.content).toMatch(/^from-sandbox$/m);
    expect(result.content).toMatch(/^\/workspace$/m);
  }, 180_000);

  it("plain chat: file tools reject paths outside the Workspace", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(),
      payload: { title: "sbx" },
    });
    const chatId = (JSON.parse(created.body) as { id: string }).id;
    await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/approval`,
      headers: auth(),
      payload: { default: "full_access" },
    });
    stack.mock.setResponses([
      { body: toolCallSse("read", JSON.stringify({ path: "/proc/self/environ" })) },
      { body: finalSse },
    ]);
    const submit = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(),
      payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content: "read env" }] },
    });
    expect(submit.statusCode).toBe(200);
    const result = await toolResult(chatId);
    expect(result.content).not.toMatch(
      /GUILD_MASTER_KEY_HEX|GUILD_JWT_SECRET|GUILD_DATABASE_URL|GUILD_SANDBOX_RUNNER_TOKEN/,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("absolute paths are not allowed");
  }, 180_000);

  it("materializes inbox attachments for the internal coordinator's file tools", async () => {
    const { app, db } = stack.env;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Attachment coordinator", model: "GLM-Test-Model", resources: { assistant: { enabled: true } } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const inbox = await app.inject({
      method: "POST", url: "/api/v1/assistant", headers: auth(), payload: { agent_id: created.json().agent.id },
    });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const { agent_id, chat_id, thread_id } = inbox.json() as { agent_id: string; chat_id: string; thread_id: string };
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat_id}/attachments?filename=evidence.dat&content_type=application/octet-stream`,
      headers: { authorization: `Bearer ${stack.memberToken}`, "content-type": "application/octet-stream" },
      payload: Buffer.from("coordinator attachment fixture"),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const attachmentId = upload.json().id as string;
    stack.mock.setResponses([
      {
        body: async () => {
          const run = await db.query<{ id: string }>(
            `SELECT r.id FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id
             WHERE t.agent_id=$1 AND t.execution_role='coordinator' AND r.status='running'`,
            [agent_id],
          );
          return toolCallSse("read", JSON.stringify({ path: `/tmp/attachments/${run.rows[0]!.id}/evidence.dat` }));
        },
      },
      { body: finalSse },
    ]);
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent_id}/threads/${thread_id}/turns`,
      headers: auth(),
      payload: { message: "Read the attached evidence", attachment_ids: [attachmentId] },
    });
    expect(submitted.statusCode, submitted.body).toBeLessThan(300);
    await waitFor(
      async () =>
        (
          await db.query(
            "SELECT 1 FROM agent_coordination_inputs WHERE agent_id=$1 AND source_thread_id=$2 AND kind='request'",
            [agent_id, thread_id],
          )
        ).rowCount === 1,
      10000,
    );
    await app.platform.coordination.tick();
    let result: { content: string; is_error: boolean } | undefined;
    await waitFor(async () => {
      const rows = await db.query<{ payload: { content: string; is_error: boolean; name: string } }>(
        `SELECT e.payload FROM thread_events e JOIN agent_threads t ON t.chat_id=e.chat_id
         WHERE t.agent_id=$1 AND t.execution_role='coordinator' AND e.type='tool_result' AND e.payload->>'name'='read'`,
        [agent_id],
      );
      result = rows.rows[0]?.payload;
      return result !== undefined;
    }, 20000);
    expect(result?.is_error, result?.content).toBe(false);
    expect(result?.content).toContain("coordinator attachment fixture");
  }, 45000);
});
