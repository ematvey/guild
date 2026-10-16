// Codemode over the chat loop: the codemode tool rides every conversation
// configure (guild + coding tools + codemode), the model's request carries
// it with its `{ code }` input and the codemode prompt section, and the
// scripted model drives real scripts — nested tool calls (batched and
// failing), the store, truncation, and script errors — against the real
// harness + sandbox + mock provider.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { GuildRuntime } from "../harness/runtime.js";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

const TEST_TIMEOUT = 120_000;

let stack: M2Stack;
let port: number;
let memberToken: string;
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-codemode-sandbox-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "guild-codemode-data-"));

const toolCallSse = (name: string, args: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_cm","type":"function","function":{"name":"' +
  name +
  '","arguments":' +
  JSON.stringify(args) +
  "}}]}}]}\n\n" +
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
  "data: [DONE]\n\n";

const finalSse =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"all done"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

let probe: Server;

beforeAll(async () => {
  // The runtime reads the sandbox root from the process environment at env
  // resolution time (the production env var); point it at the test root.
  process.env.GUILD_SANDBOX_ROOT = sandboxRoot;
  probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupM2Stack(
    {
      GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
      GUILD_SANDBOX_ROOT: sandboxRoot,
      GUILD_DATA_DIR: dataDir,
      GUILD_ALLOW_SHELL_TOOLS: "1",
      GUILD_APPROVAL_TIMEOUT_MS: "3000",
      GUILD_CLIENT_TOOL_TIMEOUT_MS: "8000",
    },
    { dbPrefix: "guild_codemode_test", logLevel: process.env.CODEMODE_TEST_LOG ?? "error" },
  );
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
  memberToken = stack.memberToken;
}, 60_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

const auth = (token = memberToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

function scriptFor(...responses: { body: string }[]): void {
  stack.mock.setResponses(responses);
}

async function threadEvents(chatId: string): Promise<Record<string, unknown>[]> {
  const res = await stack.env.app.inject({
    method: "GET",
    url: `/api/v1/chats/${chatId}/thread`,
    headers: auth(),
  });
  return (JSON.parse(res.body) as { events: Record<string, unknown>[] }).events;
}

async function createChat(title: string): Promise<string> {
  const res = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/chats",
    headers: auth(),
    payload: { title },
  });
  expect(res.statusCode).toBe(200);
  const chatId = (JSON.parse(res.body) as { id: string }).id;
  // The scripted model's tool calls must run without the interactive
  // approval gate (the product's per-chat policy knob).
  await stack.env.db.query("UPDATE chats SET approval = '{\"default\":\"full_access\"}' WHERE id = $1", [chatId]);
  return chatId;
}

async function submitTurn(chatId: string, content: string): Promise<void> {
  const submit = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/gateway/chat",
    headers: auth(),
    payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content }] },
  });
  expect(submit.statusCode).toBe(200);
}

async function turnSettled(chatId: string): Promise<void> {
  await waitFor(async () => {
    const events = await threadEvents(chatId);
    const last = events[events.length - 1];
    if (last === undefined) return false;
    const ev = last.event as { type?: string; blocks?: { type: string }[] };
    return ev.type === "assistant_message" && (ev.blocks?.some((b) => b.type === "text") ?? false);
  });
}

function toolResults(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((e) => (e.event as { type?: string }).type === "tool_result");
}

function toolResultFor(events: Record<string, unknown>[], callId: string): { content: string; is_error: boolean } {
  const result = toolResults(events).find((e) => (e.event as { call_id: string }).call_id === callId);
  expect(result, "tool_result for the codemode call").toBeDefined();
  const ev = result!.event as { content: string; is_error: boolean };
  return { content: ev.content ?? "", is_error: ev.is_error };
}

/** The durable conversation's GuildRuntime (the app's decorated platform). */
function runtime(): GuildRuntime {
  return (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
}

async function firstRequest(): Promise<Record<string, unknown>> {
  await waitFor(() => Promise.resolve(stack.mock.requests.length > 0));
  return stack.mock.requests[0]!.body;
}

describe("codemode over the chat loop", () => {
  it(
    "offers the codemode tool with its { code } input and renders the codemode prompt section",
    async () => {
      const chatId = await createChat("codemode-declared");
      scriptFor({ body: finalSse });
      await submitTurn(chatId, "hello");
      await turnSettled(chatId);

      const body = await firstRequest();
      const tools = body["tools"] as { type: string; function: { name: string; description?: string; parameters: Record<string, unknown> } }[];
      const codemode = tools.find((t) => t.function?.name === "codemode");
      expect(codemode).toBeDefined();
      expect(codemode!.function.description).toContain("Run JavaScript that calls other tools");
      // The model-visible input is one `code` string parameter.
      const properties = codemode!.function.parameters["properties"] as Record<string, unknown>;
      expect(Object.keys(properties)).toEqual(["code"]);
      expect((properties["code"] as { type: string }).type).toBe("string");

      // The codemode section lands in the system prompt (the extension's
      // own section, not a guild duplicate).
      const messages = body["messages"] as { role: string; content: unknown }[];
      const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
      expect(system).toContain("Tools scripts can call (`await tools.<name>(args)`)");
      expect(system).toContain("### `read`");
      expect(system).toContain("### `bash`");
      // The guild notes section: the globals rule that stops the
      // `tools.searchTools` misread weaker models make.
      expect(system).toContain("Codemode rules:");
      expect(system).toContain("NEVER as `tools.searchTools`");
      // The codemode declaration itself is the section's priciest entry and
      // the budget drops it first — the tool description carries the
      // environment details instead.

      // The conversation's agent carries the tool as well (the harness view).
      const runtimeHandle = runtime();
      const conversationId = runtimeHandle.conversationIdForChat(chatId) as never;
      const conversation = await runtimeHandle.harnessForTest()!.conversation(conversationId, BACKGROUND_CONTEXT);
      const agent = await conversation!.agent(BACKGROUND_CONTEXT);
      expect(agent.tools.some((tool) => tool.name === "codemode")).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "runs a script's batched nested write/read calls and reports the console block",
    async () => {
      const chatId = await createChat("codemode-batch");
      const code = [
        "const results = await Promise.allSettled([",
        "  tools.write({ path: 'cm-a.txt', content: 'alpha' }),",
        "  tools.write({ path: 'cm-b.txt', content: 'beta' }),",
        "]);",
        "console.log('writes', results[0].status, results[1].status);",
        "return await tools.read({ path: 'cm-a.txt' });",
      ].join("\n");
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "write two files and read one back");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = (events as unknown as { event: { type?: string; blocks?: { type: string; name?: string; id?: string } }[] }[])
        .flatMap((e) => (e.event as { blocks?: { type: string; name?: string; id?: string }[] }).blocks ?? [])
        .find((b) => b.type === "tool_call" && b.name === "codemode");
      expect(call).toBeDefined();
      const result = toolResultFor(events, call!.id!);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain("Script completed");
      expect(result.content).toContain("alpha");
      expect(result.content).toContain("<console_output>");
      expect(result.content).toContain("writes fulfilled fulfilled");
      // Both nested writes landed in the conversation's sandbox.
      const conversationId = runtime().conversationIdForChat(chatId)!;
      const sandboxDir = path.join(sandboxRoot, String(conversationId));
      const files = await import("node:fs/promises");
      expect(await files.readFile(path.join(sandboxDir, "cm-a.txt"), "utf8")).toBe("alpha");
      expect(await files.readFile(path.join(sandboxDir, "cm-b.txt"), "utf8")).toBe("beta");
      // Nested calls do not surface as their own thread cards.
      const nestedCards = toolResults(events).filter((e) => (e.event as { call_id: string }).call_id.includes("/c"));
      expect(nestedCards).toHaveLength(0);
      expect(toolResults(events)).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps store() values across codemode calls in the same conversation",
    async () => {
      const chatId = await createChat("codemode-store");
      scriptFor(
        { body: toolCallSse("codemode", JSON.stringify({ code: 'store("cm-key", { n: 41 }); return "stored";' })) },
        { body: finalSse },
      );
      await submitTurn(chatId, "remember something");
      await turnSettled(chatId);

      scriptFor(
        { body: toolCallSse("codemode", JSON.stringify({ code: 'return "loaded " + load("cm-key").n;' })) },
        { body: finalSse },
      );
      await submitTurn(chatId, "read it back");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const codemodeResults = toolResults(events).filter((e) => !(e.event as { call_id: string }).call_id.includes("/c"));
      expect(codemodeResults.length).toBeGreaterThanOrEqual(2);
      const second = codemodeResults[codemodeResults.length - 1]!.event as { content: string; is_error: boolean };
      expect(second.is_error).toBe(false);
      expect(second.content).toContain("loaded 41");
    },
    TEST_TIMEOUT,
  );

  it(
    "reports a failing script with its partial output and the Script error block",
    async () => {
      const chatId = await createChat("codemode-failure");
      const code = 'text("before the failure"); throw new Error("boom");';
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "fail on purpose");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = (events as unknown as { event: { blocks?: { type: string; name?: string; id?: string } }[] }[])
        .flatMap((e) => (e.event as { blocks?: { type: string; name?: string; id?: string }[] }).blocks ?? [])
        .find((b) => b.type === "tool_call" && b.name === "codemode");
      const result = toolResultFor(events, call!.id!);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("before the failure");
      expect(result.content).toContain("Script error:");
      expect(result.content).toContain("boom");
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a failed nested call in the script with the tool's error text",
    async () => {
      const chatId = await createChat("codemode-nested-error");
      const code = [
        "try {",
        "  await tools.read({ path: 'cm-no-such-file.txt' });",
        '  return "unexpectedly read";',
        "} catch (error) {",
        '  return "caught: " + error.message;',
        "}",
      ].join("\n");
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "read a missing file");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = (events as unknown as { event: { blocks?: { type: string; name?: string; id?: string } }[] }[])
        .flatMap((e) => (e.event as { blocks?: { type: string; name?: string; id?: string }[] }).blocks ?? [])
        .find((b) => b.type === "tool_call" && b.name === "codemode");
      const result = toolResultFor(events, call!.id!);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain("caught: ");
      expect(result.content).not.toContain("unexpectedly read");
    },
    TEST_TIMEOUT,
  );

  it(
    "truncates oversized output to the script's own token budget with a spill file note",
    async () => {
      const chatId = await createChat("codemode-truncate");
      const code = '// @options: {"max_output_tokens": 100}\nreturn "x".repeat(5000);';
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "print a lot");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = (events as unknown as { event: { blocks?: { type: string; name?: string; id?: string } }[] }[])
        .flatMap((e) => (e.event as { blocks?: { type: string; name?: string; id?: string }[] }).blocks ?? [])
        .find((b) => b.type === "tool_call" && b.name === "codemode");
      const result = toolResultFor(events, call!.id!);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain("Warning: truncated output");
      expect(result.content).toContain("[Full output:");
      expect(result.content).toContain("tokens truncated");
      // The full text spills next to the conversation's sandbox.
      expect(result.content.length).toBeLessThan(2000);
    },
    TEST_TIMEOUT,
  );

  it(
    "offers only codemode to the model; scripts still reach every tool",
    async () => {
      const chatId = await createChat("codemode-only");
      scriptFor({ body: finalSse });
      await submitTurn(chatId, "hello");
      await turnSettled(chatId);

      // The model request declares exactly one tool: codemode.
      const body = await firstRequest();
      const tools = (body["tools"] as { function?: { name: string } }[]).map((t) => t.function?.name);
      expect(tools).toEqual(["codemode"]);

      // The agent's callable set still carries everything (script reach).
      const conversationId = runtime().conversationIdForChat(chatId) as never;
      const conversation = await runtime().harnessForTest()!.conversation(conversationId, BACKGROUND_CONTEXT);
      const agent = await conversation!.agent(BACKGROUND_CONTEXT);
      const callable = agent.callable.map((t) => t.name);
      for (const name of ["read", "write", "edit", "bash", "read_skill", "thread_history", "thread_search"]) {
        expect(callable).toContain(name);
      }
      // The codemode section lists the script-only tools for the model.
      const messages = body["messages"] as { role: string; content: unknown }[];
      const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
      expect(system).toContain("### `thread_history`");
      expect(system).toContain("### `thread_search`");
    },
    TEST_TIMEOUT,
  );

  it(
    "reads thread history and searches across the owner's chats from a script",
    async () => {
      // A second chat of the same user, with a distinctive marker in its
      // history (the user turn itself is a thread_event).
      const otherChat = await createChat("history-search-other");
      const marker = "xylophone-marker-4821";
      await stack.env.db.query(
        `INSERT INTO thread_events (id, chat_id, type, payload)
         VALUES (gen_random_uuid(), $1, 'user_message', $2::jsonb)`,
        [otherChat, JSON.stringify({ type: "user_message", content: `discussing the ${marker} project` })],
      );

      const chatId = await createChat("history-search-home");
      const code = [
        `const search = await tools.thread_search({ query: "${marker}" });`,
        "const hit = search.hits[0];",
        "const page = await tools.thread_history({ chatId: hit.chatId, limit: 10 });",
        "return { found: hit.snippet, title: hit.chatTitle, readBack: page.events.some((e) => e.text.includes('" +
          marker +
          "')) };",
      ].join("\n");
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "find the marker thread");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = (events as unknown as { event: { blocks?: { type: string; name?: string; id?: string } }[] }[])
        .flatMap((e) => (e.event as { blocks?: { type: string; name?: string; id?: string }[] }).blocks ?? [])
        .find((b) => b.type === "tool_call" && b.name === "codemode");
      const result = toolResultFor(events, call!.id!);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain("discussing the");
      expect(result.content).toContain("history-search-other");
      expect(result.content).toContain('readBack\":true');
    },
    TEST_TIMEOUT,
  );

  it(
    "denies thread_history on another user's chat",
    async () => {
      // A foreign chat: same org, a different owner (the org's other user).
      const foreign = await stack.env.db.query<{ id: string }>(
        `INSERT INTO chats (id, org_id, user_id, title)
         SELECT gen_random_uuid(), c.org_id, u.id, 'history-foreign'
         FROM (SELECT DISTINCT org_id, user_id FROM chats LIMIT 1) c
         JOIN users u ON u.id <> c.user_id
         LIMIT 1
         RETURNING id`,
      );
      const foreignChatId = foreign.rows[0]?.id;
      expect(foreignChatId).toBeDefined();

      const chatId = await createChat("history-deny");
      const code = `return await tools.thread_history({ chatId: "${foreignChatId}" });`;
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "peek elsewhere");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = (events as unknown as { event: { blocks?: { type: string; name?: string; id?: string } }[] }[])
        .flatMap((e) => (e.event as { blocks?: { type: string; name?: string; id?: string }[] }).blocks ?? [])
        .find((b) => b.type === "tool_call" && b.name === "codemode");
      const result = toolResultFor(events, call!.id!);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("not_found");
    },
    TEST_TIMEOUT,
  );
});
