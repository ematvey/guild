import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { tmpdir } from "node:os";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { UserMcpRuntime } from "../harness/userMcp.js";
import { executeConnectorTool } from "../platform/integrations/execute.js";

const arrived = new Map<string, () => void>();
const closed = new Map<string, () => void>();
const requests: string[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const rpc = body ? (JSON.parse(body) as { id?: number; method: string }) : undefined;
  const method = rpc?.method ?? "search";
  requests.push(method);
  if (method === "tools/call" || method === "search") {
    res.on("close", () => closed.get(method)?.());
    arrived.get(method)?.();
    return;
  }
  if (method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpc!.id,
      result:
        method === "tools/list"
          ? {
              tools: [
                {
                  name: "wait",
                  description: "wait",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "fixture", version: "1" },
            },
    }),
  );
});
let base: string;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
function observe(method: string) {
  let start!: () => void;
  let end!: () => void;
  const started = new Promise<void>((r) => (start = r));
  const ended = new Promise<void>((r) => (end = r));
  arrived.set(method, start);
  closed.set(method, end);
  return { started, ended };
}

describe("external tool cancellation", () => {
  it("cancels an MCP tool transport through the actual tool adapter", async () => {
    const row = {
      id: "fixture",
      name: "fixture",
      url: base,
      headers_enc: null,
      enabled: true,
    };
    const runtime = new UserMcpRuntime(
      {
        store: {
          listEnabled: async () => [row],
          get: async () => row,
          resolveHeaders: () => ({}),
        },
        masterKey: () => Buffer.alloc(32),
        log: { warn: () => {} },
        chatOfConversation: async () => "chat",
        chatOwnerOf: async () => ({ org_id: "org", user_id: "user" }),
      } as never,
      createRegistry(),
    );
    const prepared = await runtime.prepareTurn(1, "chat", "org");
    const tool = prepared.tools.find((t) => t.name === "mcp7_fixture_wait")!;
    const controller = new AbortController();
    const observed = observe("tools/call");
    const result = tool.execute(
      {},
      { conversationId: 1, callId: "call" } as never,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    const rejected = expect(result).rejects.toThrow("stopped");
    await observed.started;
    controller.abort(new Error("stopped"));
    await rejected;
    await observed.ended;
    const count = requests.length;
    await expect(
      tool.execute(
        {},
        { conversationId: 1, callId: "call2" } as never,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toThrow("stopped");
    expect(requests).toHaveLength(count);
  }, 5000);
  it("propagates conversation Stop through a nested codemode MCP call", async () => {
    const row = {
      id: "fixture",
      name: "fixture",
      url: base,
      headers_enc: null,
      enabled: true,
    };
    const registry = createRegistry();
    const runtime = new UserMcpRuntime(
      {
        store: {
          listEnabled: async () => [row],
          get: async () => row,
          resolveHeaders: () => ({}),
        },
        masterKey: () => Buffer.alloc(32),
        log: { warn: () => {} },
        chatOfConversation: async () => "chat",
        chatOwnerOf: async () => ({ org_id: "org", user_id: "user" }),
      } as never,
      registry,
    );
    const prepared = await runtime.prepareTurn(1, "chat", "org");
    registry.install(defineExtension({ name: "fixture", tools: prepared.tools }));
    const sandbox = new CodemodeSandbox();
    registry.install(createCodemodeExtension({ sandbox, models: false }));
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: "return await tools.mcp7_fixture_wait({});",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const h = await Harness.open(
      new MemoryStorage(),
      { registry, models, env: () => new NodeExecutionEnv({ cwd: tmpdir() }) },
      BACKGROUND_CONTEXT,
    );
    const observed = observe("tools/call");
    try {
      const c = await h.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      const submission = await c.submit({ type: "input", content: "wait" }, BACKGROUND_CONTEXT);
      await observed.started;
      await c.abort(BACKGROUND_CONTEXT);
      await observed.ended;
      expect((await submission.status(BACKGROUND_CONTEXT)).status).toBe("unanswered");
    } finally {
      await h.close(BACKGROUND_CONTEXT);
      await sandbox.close();
    }
  }, 5000);

  it("cancels a builtin connector request without waiting for its own timeout", async () => {
    const controller = new AbortController();
    const observed = observe("search");
    const result = executeConnectorTool(
      "searxng",
      { base_url: base },
      "web_search",
      { query: "test" },
      [],
      null,
      controller.signal,
    );
    const rejected = expect(result).rejects.toThrow("stopped");
    await observed.started;
    controller.abort(new Error("stopped"));
    await rejected;
    await observed.ended;
  }, 5000);
});
