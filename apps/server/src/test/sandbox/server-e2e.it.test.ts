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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { setupM2Stack, type M2Stack } from "../platform/m2-harness.js";
import { RunnerClient } from "../../sandbox/client.js";
import { SandboxExecutionEnv } from "../../sandbox/env.js";

const URL_ = process.env.GUILD_SANDBOX_IT_URL;
const TOKEN = process.env.GUILD_SANDBOX_RUNNER_TOKEN ?? "";

const toolCallSse = (name: string, args: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_sbx","type":"function","function":{"name":"' +
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
  let stack: M2Stack;

  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    stack = await setupM2Stack(
      {
        GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
        GUILD_DATA_DIR: mkdtempSync(path.join(tmpdir(), "guild-sbx-e2e-data-")),
        GUILD_SANDBOX_RUNNER_URL: URL_!,
        GUILD_SANDBOX_RUNNER_TOKEN: TOKEN,
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
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const all = await events(chatId);
      const result = all.find((e) => e.event["type"] === "tool_result");
      const last = all[all.length - 1]?.event as { type?: string; blocks?: Array<{ type: string }> } | undefined;
      const settled = last?.type === "assistant_message" && (last.blocks?.some((b) => b.type === "text") ?? false);
      if (result !== undefined && settled) return result.event as unknown as { content: string; is_error: boolean };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("turn did not settle");
  }

  async function approveNext(chatId: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const request = (await events(chatId)).find((e) => e.event["type"] === "approval_request");
      if (request !== undefined) {
        const callId = String(request.event["call_id"]);
        const res = await stack.env.app.inject({
          method: "POST",
          url: `/api/v1/gateway/chat/${chatId}/approvals/${callId}`,
          headers: auth(),
          payload: { approved: true },
        });
        expect(res.statusCode).toBe(200);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("no approval request");
  }

  it("workspace session: shell and file tools run inside the gVisor sandbox", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents/sessions",
      headers: auth(),
      payload: { workspace_name: "sbx-e2e" },
    });
    expect(created.statusCode).toBe(200);
    const session = JSON.parse(created.body) as { id: string; chat_id: string };

    stack.mock.setResponses([
      {
        body: toolCallSse(
          "bash",
          JSON.stringify({
            command:
              "uname -r; id -u; tr '\\0' '\\n' < /proc/self/environ | grep -c '^GUILD_' ; ls /data 2>&1 | head -1; echo from-sandbox > out.txt; pwd",
          }),
        ),
      },
      { body: finalSse },
    ]);
    const turn = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/agents/sessions/${session.id}/turns`,
      headers: auth(),
      payload: { message: "inspect", model: "GLM-Test-Model" },
    });
    expect(turn.statusCode).toBe(200);
    // Command tools still go through the exec policy + approval gate in
    // workspace sessions; approve the card.
    await approveNext(session.chat_id);
    const result = await toolResult(session.chat_id);
    expect(result.is_error, result.content).toBe(false);
    expect(result.content).toMatch(/gvisor/);
    expect(result.content).toMatch(/^1000$/m);
    expect(result.content).toMatch(/^0$/m);
    expect(result.content).toMatch(/cannot access '\/data'/);
    expect(result.content).toMatch(/^\/workspace$/m);

    // The file is in the session's workspace on the sandbox volume.
    const runner = new RunnerClient(URL_!, TOKEN);
    const target = { key: `ws:${stack.orgId}:sbx-e2e`, subpath: `workspaces/${stack.orgId}/sbx-e2e` };
    const env = new SandboxExecutionEnv({ id: "check", cwd: "/workspace", connect: async () => runner.connect(await runner.ensure(target)) });
    const read = await env.readTextFile("out.txt", BACKGROUND_CONTEXT);
    env.disconnect();
    expect(read.ok && read.value).toBe("from-sandbox\n");
  }, 180_000);

  it("plain chat: the file tools cannot reach the server's secrets", async () => {
    const created = await stack.env.app.inject({ method: "POST", url: "/api/v1/chats", headers: auth(), payload: { title: "sbx" } });
    const chatId = (JSON.parse(created.body) as { id: string }).id;
    await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/approval`,
      headers: auth(),
      payload: { default: "full_access" },
    });
    stack.mock.setResponses([{ body: toolCallSse("read", JSON.stringify({ path: "/proc/self/environ" })) }, { body: finalSse }]);
    const submit = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(),
      payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content: "read env" }] },
    });
    expect(submit.statusCode).toBe(200);
    const result = await toolResult(chatId);
    expect(result.content).not.toMatch(/GUILD_MASTER_KEY_HEX|GUILD_JWT_SECRET|GUILD_DATABASE_URL|GUILD_SANDBOX_RUNNER_TOKEN/);
    expect(result.content).toMatch(/HOME=\/workspace\/\.sandbox-home/);
  }, 180_000);
});
