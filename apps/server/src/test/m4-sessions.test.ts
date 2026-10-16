// M4 integration flow against the real app + harness + mock provider: the
// workspace agent-session routes (create/list/history/run-turn with the
// workspace-rooted env), the approval gate block/resume (approve / deny /
// timeout / static exec-policy deny), the tool-artifact spill store +
// routes, and the machine-dispatch round trip through a fake daemon speaking
// the captured ToolDispatch/ToolResult protocol.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const TEST_TIMEOUT = 120_000;
import { setupM2Stack, TEST_PASSWORD, type M2Stack } from "./platform/m2-harness.js";
import { hashPassword } from "../platform/crypto.js";

let stack: M2Stack;
let port: number;
let orgId: string;
let memberToken: string;
let memberId: string;
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-m4-sandbox-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "guild-m4-data-"));

// The scripted provider upstream: 16 responses consumed in strict order by
// the sequential tests below (turns are two model calls each: the tool call,
// then the final answer). Under codemode-only exposure the model scripts the
// call: one `codemode` request whose body runs the named tool as a nested
// call — the nested call runs the same pipeline (gate, exec policy, spill).
const toolCallSse = (name: string, args: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_m4","type":"function","function":{"name":"codemode","arguments":' +
  JSON.stringify(JSON.stringify({ code: `return await tools.${name}(${args});` })) +
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

beforeAll(async () => {
  // Pre-allocate the loopback port the harness's selfBaseUrl needs.
  const probe = createServer();
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
    { dbPrefix: "guild_m4_test", logLevel: process.env.M4_TEST_LOG ?? "error" },
  );
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
  orgId = stack.orgId;
  memberToken = stack.memberToken;
  memberId = stack.memberId;

}, 30_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

/** The PlatformContext the app embeds (buildApp's test surface). */
function platformOf(): import("../platform/context.js").PlatformContext {
  return (stack.env.app as unknown as { platform: import("../platform/context.js").PlatformContext }).platform;
}

const auth = (token = memberToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

// Generous: under the shared dev server's load a durable turn can stall
// tens of seconds on transient connection churn (the pi-durable retry
// policy alone can add ~14s); the polls are cheap.
async function waitFor(probe: () => Promise<boolean>, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

/** Installs a per-test script: a tool-call response, then the final answer. */
function scriptFor(name: string, args: string): void {
  stack.mock.setResponses([{ body: toolCallSse(name, args) }, { body: finalSse }]);
}

/** Waits for the turn to fully settle (the final text answer journaled).
 *  Without this, a turn's trailing model call bleeds into the next test's
 *  scripted responses and derails its script alignment. */
async function turnSettled(chatId: string): Promise<void> {
  await waitFor(async () => {
    const events = await threadEvents(chatId);
    const last = events[events.length - 1];
    if (last === undefined) return false;
    const ev = last.event as { type?: string; blocks?: { type: string }[] };
    return ev.type === "assistant_message" && (ev.blocks?.some((b) => b.type === "text") ?? false);
  });
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
  return (JSON.parse(res.body) as { id: string }).id;
}

describe("M4: workspace agent sessions", () => {
  it(
    "create → validation → list → run turn writes through the workspace env",
    async () => {
      // Boundary validation (the Rust workspace_boundary_tests contract).
      for (const name of ["/", "../other", "a/b", "", "C:\\Windows"]) {
        const bad = await stack.env.app.inject({
          method: "POST",
          url: "/api/v1/agents/sessions",
          headers: auth(),
          payload: { workspace_name: name },
        });
        expect(bad.statusCode, name).toBe(400);
      }

      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/agents/sessions",
        headers: auth(),
        payload: { workspace_name: "repo-1" },
      });
      expect(res.statusCode).toBe(200);
      const session = JSON.parse(res.body) as { id: string; chat_id: string; workspace_name: string };
      expect(session.workspace_name).toBe("repo-1");

      // The name is taken: a second create is 409 workspace_taken.
      const again = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/agents/sessions",
        headers: auth(),
        payload: { workspace_name: "repo-1" },
      });
      expect(again.statusCode).toBe(409);

      const list = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/agents/sessions",
        headers: auth(),
      });
      const sessions = JSON.parse(list.body) as { sessions: { id: string }[] };
      expect(sessions.sessions.some((s) => s.id === session.id)).toBe(true);

      // The turn: a write through the workspace-rooted env.
      scriptFor("write", JSON.stringify({ path: "notes.txt", content: "hello m4" }));
      const turn = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/agents/sessions/${session.id}/turns`,
        headers: auth(),
        payload: { message: "write the notes", model: "GLM-Test-Model" },
      });
      expect(turn.statusCode).toBe(200);
      expect(JSON.parse(turn.body).accepted).toBe(true);

      await waitFor(async () => {
        const events = await threadEvents(session.chat_id);
        return events.some((e) => (e.event as { type?: string }).type === "tool_result");
      });
      await turnSettled(session.chat_id);

      // The file landed inside the workspace dir under GUILD_DATA_DIR.
      const written = readFileSync(
        path.join(stack.env.config.dataDir, "workspaces", orgId, "repo-1", "notes.txt"),
        "utf8",
      );
      expect(written).toBe("hello m4");

      const events = await threadEvents(session.chat_id);
      // Nested calls make no cards: the codemode call is the card, and the
      // workspace write above proves the nested write ran.
      const toolResult = events.find((e) => (e.event as { type?: string }).type === "tool_result");
      expect((toolResult!.event as { name: string }).name).toBe("codemode");
      expect((toolResult!.event as { is_error: boolean }).is_error).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it("history route serves the thread journal", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents/sessions",
      headers: auth(),
      payload: { workspace_name: "repo-2" },
    });
    const session = JSON.parse(created.body) as { id: string; chat_id: string };
    const history = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/agents/sessions/${session.id}`,
      headers: auth(),
    });
    expect(history.statusCode).toBe(200);
    const body = JSON.parse(history.body) as { events: { event: { type: string } }[] };
    // The workspace name is the chat's title: the chat exists and the
    // journal renders (empty until a turn runs).
    expect(Array.isArray(body.events)).toBe(true);
    void session.chat_id;
  });
});

describe("M4: approval gate block/resume", () => {
  it(
    "ask mode suspends the tool on a card; the approval API resumes it",
    async () => {
      const chatId = await createChat("approval-approve");
      await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/chats/${chatId}/approval`,
        headers: auth(),
        payload: { default: "ask" },
      });
      scriptFor("bash", JSON.stringify({ command: "rm -rf ./approved-gone" }));
      const submit = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(),
        payload: {
          chat_id: chatId,
          model: "GLM-Test-Model",
          messages: [{ role: "user", content: "clean up the approved dir" }],
        },
      });
      expect(submit.statusCode).toBe(200);

      // The pending card rides the thread log.
      let callId = "";
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        const request = events.find((e) => (e.event as { type?: string }).type === "approval_request");
        if (request === undefined) return false;
        callId = (request.event as { call_id: string }).call_id;
        return true;
      });
      const request = (await threadEvents(chatId)).find((e) => (e.event as { type?: string }).type === "approval_request");
      expect((request!.event as { name: string }).name).toBe("bash");
      expect((request!.event as { arguments: string }).arguments).toContain("approved-gone");

      // The tool task is suspended: no tool_result yet.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(
        (await threadEvents(chatId)).some((e) => (e.event as { type?: string }).type === "tool_result"),
      ).toBe(false);

      // Approve → the gate resumes, the tool runs, the turn finishes.
      const decision = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/gateway/chat/${chatId}/approvals/${callId}`,
        headers: auth(),
        payload: { approved: true },
      });
      expect(decision.statusCode).toBe(200);
      expect(JSON.parse(decision.body)).toEqual({ ok: true, settled: false });

      // The final answer: an assistant_message with a text block (the
      // step-1 tool-call message is also an assistant_message).
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        return events.some(
          (e) =>
            (e.event as { type?: string; blocks?: { type: string }[] }).type === "assistant_message" &&
            (e.event as { blocks?: { type: string }[] }).blocks?.some((b) => b.type === "text"),
        );
      });
      const result = (await threadEvents(chatId)).find((e) => (e.event as { type?: string }).type === "tool_result");
      expect(result).toBeDefined();
      expect((result!.event as { is_error: boolean }).is_error).toBe(false);
      // The executed command really ran (the sandbox dir is disposable).
      const decisionEcho = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/gateway/chat/${chatId}/approvals/${callId}`,
        headers: auth(),
        payload: { approved: false, reason: "late click" },
      });
      // Late clicks echo the recorded decision idempotently.
      expect(JSON.parse(decisionEcho.body)).toEqual({ ok: true, settled: true, approved: true, reason: null, expired: false });
    },
    TEST_TIMEOUT,
  );

  it(
    "deny resolves the gate with a denied tool result",
    async () => {
      const chatId = await createChat("approval-deny");
      await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/chats/${chatId}/approval`,
        headers: auth(),
        payload: { default: "ask" },
      });
      scriptFor("bash", JSON.stringify({ command: "rm -rf ./denied-gone" }));
      await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(),
        payload: {
          chat_id: chatId,
          model: "GLM-Test-Model",
          messages: [{ role: "user", content: "clean up the denied dir" }],
        },
      });
      let callId = "";
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        const request = events.find((e) => (e.event as { type?: string }).type === "approval_request");
        if (request === undefined) return false;
        callId = (request.event as { call_id: string }).call_id;
        return true;
      });
      const deny = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/gateway/chat/${chatId}/approvals/${callId}`,
        headers: auth(),
        payload: { approved: false, reason: "keep it" },
      });
      if (deny.statusCode !== 200) console.log("DENY RESP", deny.statusCode, deny.body);
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        if (events.some((e) => (e.event as { type?: string }).type === "tool_result")) return true;
        return false;
      });
      const result = (await threadEvents(chatId)).find((e) => (e.event as { type?: string }).type === "tool_result");
      const ev = result!.event as { content: string; is_error: boolean };
      expect(ev.is_error).toBe(true);
      expect(ev.content).toContain("denied by user: keep it");
      await turnSettled(chatId);
    },
    TEST_TIMEOUT,
  );

  it(
    "a lapsed card auto-denies on the approval timeout",
    async () => {
      const chatId = await createChat("approval-timeout");
      await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/chats/${chatId}/approval`,
        headers: auth(),
        payload: { default: "ask" },
      });
      scriptFor("bash", JSON.stringify({ command: "rm -rf ./timed-out" }));
      await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(),
        payload: {
          chat_id: chatId,
          model: "GLM-Test-Model",
          messages: [{ role: "user", content: "clean up the timed-out dir" }],
        },
      });
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        return events.some((e) => (e.event as { type?: string }).type === "approval_request");
      });
      // GUILD_APPROVAL_TIMEOUT_MS=3000: the gate auto-denies, journals the
      // decision, and the turn continues with the denied tool result.
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        return events.some((e) => (e.event as { type?: string }).type === "tool_result");
      }, 20000);
      const events = await threadEvents(chatId);
      const decision = events.filter((e) => (e.event as { type?: string }).type === "approval_decision").pop();
      expect(decision).toBeDefined();
      expect((decision!.event as { approved: boolean; reason?: string }).approved).toBe(false);
      expect((decision!.event as { reason?: string }).reason).toContain("approval timed out");
      const result = events.find((e) => (e.event as { type?: string }).type === "tool_result");
      expect(((result!.event as { content: string }).content).toLowerCase()).toContain("timed out");
      await turnSettled(chatId);
    },
    TEST_TIMEOUT,
  );

  it(
    "static exec policy denies without any approval card",
    async () => {
      const chatId = await createChat("exec-policy-deny");
      await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/chats/${chatId}/approval`,
        headers: auth(),
        payload: { default: "ask" },
      });
      scriptFor("bash", JSON.stringify({ command: "dd if=/dev/sda of=/dev/null" }));
      await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(),
        payload: {
          chat_id: chatId,
          model: "GLM-Test-Model",
          messages: [{ role: "user", content: "clone the disk" }],
        },
      });
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        return events.some((e) => (e.event as { type?: string }).type === "tool_result");
      });
      const events = await threadEvents(chatId);
      expect(events.some((e) => (e.event as { type?: string }).type === "approval_request")).toBe(false);
      const result = events.find((e) => (e.event as { type?: string }).type === "tool_result");
      const ev = result!.event as { content: string; is_error: boolean };
      expect(ev.is_error).toBe(true);
      expect(ev.content).toContain("denied by exec policy:");
      expect(ev.content).toContain("destructive and irreversible");
      await turnSettled(chatId);
    },
    TEST_TIMEOUT,
  );
});

describe("M4: tool artifacts + oversized-result spill", () => {
  it(
    "spill store: threshold, pointer text, idempotent replay, one row",
    async () => {
      const chatId = await createChat("spill-store");
      const { spillOversizedResult } = await import("../chats/spill.js");
      const artifacts = platformOf().toolArtifacts;
      const raw = "x".repeat(64 * 1024 + 4096);
      const { spilled, pointer } = await spillOversizedResult(artifacts, platformOf().objects, orgId, chatId, "call-spill-1", "execute", raw);
      expect(spilled.filename).toBe("execute_result.txt");
      expect(spilled.size_bytes).toBe(raw.length);
      expect(pointer).toContain(spilled.path);
      expect(pointer).toContain("First 2 KiB");
      expect(pointer.length).toBeLessThan(2048 + 400);
      // Replay: same artifact id, same pointer, one row.
      const again = await spillOversizedResult(artifacts, platformOf().objects, orgId, chatId, "call-spill-1", "execute", raw);
      expect(again.spilled.artifact_id).toBe(spilled.artifact_id);
      expect(again.pointer).toBe(pointer);

      // Routes: list (owner) + download.
      const list = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/chats/${chatId}/tool_artifacts`,
        headers: auth(),
      });
      expect(list.statusCode).toBe(200);
      const rows = JSON.parse(list.body) as { id: string; filename: string; size_bytes: number }[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.filename).toBe("execute_result.txt");
      expect(rows[0]!.size_bytes).toBe(raw.length);

      const download = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/tool_artifacts/${rows[0]!.id}`,
        headers: auth(),
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-disposition"]).toContain("execute_result.txt");
      expect((download.body as string).length).toBe(raw.length);
      expect(download.body).toBe(raw);

      // Org scoping: a foreign org's artifact 404s.
      const foreign = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/tool_artifacts/${crypto.randomUUID()}`,
        headers: auth(),
      });
      expect(foreign.statusCode).toBe(404);
    },
    TEST_TIMEOUT,
  );

  it(
    "tool-output caps: the harness tail-caps bash output; spill fires above the 64 KiB threshold",
    async () => {
      // pi-durable's CodingTools tail-cap bash/read output at 50 KiB (the
      // model-facing window), so tool results that reach the bridge stay
      // under the 64 KiB machine-spill threshold. The >64 KiB spill
      // contract itself is proven by the store test above; this E2E pins
      // the cap behavior the bridge will actually see (documented as a
      // deviation in the report).
      const created = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/agents/sessions",
        headers: auth(),
        payload: { workspace_name: "cap-ws" },
      });
      const session = JSON.parse(created.body) as { id: string; chat_id: string };
      stack.mock.setResponses([
        { body: toolCallSse("write", JSON.stringify({ path: "big.txt", content: "A".repeat(70 * 1024) })) },
        { body: finalSse },
        { body: toolCallSse("bash", JSON.stringify({ command: "cat big.txt" })) },
        { body: finalSse },
      ]);
      for (const message of ["make the file", "show me the file"]) {
        const turn = await stack.env.app.inject({
          method: "POST",
          url: `/api/v1/agents/sessions/${session.id}/turns`,
          headers: auth(),
          payload: { message, model: "GLM-Test-Model" },
        });
        expect(turn.statusCode).toBe(200);
      }
      await waitFor(async () => {
        const events = await threadEvents(session.chat_id);
        const results = events.filter((e) => (e.event as { type?: string }).type === "tool_result");
        return results.length >= 2;
      }, 30000);
      await turnSettled(session.chat_id);
      const events = await threadEvents(session.chat_id);
      // Nested calls make no cards — both turns' work lands in the owning
      // codemode call's result. The second turn's script returns the nested
      // bash result, whose structured output carries the tail-capped text.
      const catResult = events
        .filter((e) => (e.event as { type?: string }).type === "tool_result")
        .map((e) => e.event as { name: string; content: string; is_error: boolean })
        .find((e) => e.name === "codemode" && e.content.includes('"output"'));
      expect(catResult).toBeDefined();
      expect(catResult!.is_error).toBe(false);
      // The tail-cap: the last ~50 KiB, not the file's 70 KiB head.
      expect(catResult!.content.length).toBeLessThanOrEqual(52 * 1024);
      expect(catResult!.content).toContain("AAAA");
      expect(catResult!.content).toContain('"truncated":true');
      const { shouldSpill } = await import("../chats/spill.js");
      expect(shouldSpill("x".repeat(65536))).toBe(false);
      expect(shouldSpill("x".repeat(65537))).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe("M4: machine-tool dispatch via the hub", () => {
  it(
    "a machine-bound chat dispatches tools to the connected daemon and resumes on its result",
    async () => {
      // The fake daemon: the shipped-client wire contract, no update.
      const ticket = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/ws/ticket",
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(ticket.statusCode).toBe(200);
      const machineId = "m4-dispatch-machine";
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/ws?ticket=${(JSON.parse(ticket.body) as { ticket: string }).ticket}` +
          `&machine_id=${machineId}&instance_id=${crypto.randomUUID()}`,
      );
      const dispatches: Record<string, unknown>[] = [];
      const openPromise = new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (msg["type"] === "tool_dispatch") {
          dispatches.push(msg);
          ws.send(
            JSON.stringify({
              type: "tool_result",
              chat_id: msg["chat_id"],
              call_id: msg["call_id"],
              content: "Linux workstation 6.1.0",
              is_error: false,
              meta: null,
            }),
          );
        }
      });
      await openPromise;

      // The connect adopted the registry row; bind the chat to the machine.
      await waitFor(async () => {
        const owner = await platformOf().machines.ownerOf(machineId);
        return owner !== null && owner[0] === memberId;
      });
      const chatId = await createChat("dispatch-chat");
      await platformOf().chats.setMachine(orgId, chatId, machineId, machineId);
      scriptFor("bash", JSON.stringify({ command: "echo hi" }));
      const submit = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(),
        payload: {
          chat_id: chatId,
          model: "GLM-Test-Model",
          messages: [{ role: "user", content: "what kernel is running" }],
        },
      });
      expect(submit.statusCode).toBe(200);

      // The dispatch frame went out on the executor socket; the fake
      // daemon's result resolved the suspended env call, the bridge
      // persisted the tool_result, the turn finished.
      await waitFor(async () => dispatches.length > 0, 20000);
      expect(dispatches[0]!["type"]).toBe("tool_dispatch");
      expect(dispatches[0]!["name"]).toBe("execute");
      expect(JSON.parse(dispatches[0]!["arguments"] as string)).toEqual({ command: "echo hi", timeout_ms: 300000 });
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        return events.some((e) => (e.event as { type?: string }).type === "tool_result");
      });
      const result = (await threadEvents(chatId)).find((e) => (e.event as { type?: string }).type === "tool_result");
      // The codemode card carries the script's return value: the nested
      // execute's structured output.
      expect((result!.event as { content: string }).content).toContain("Linux workstation 6.1.0");
      expect((result!.event as { is_error: boolean }).is_error).toBe(false);
      await turnSettled(chatId);
      ws.close();

      // A machine-bound chat without a live slot errors the tool cleanly.
      scriptFor("bash", JSON.stringify({ command: "echo hi" }));
      const offline = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(),
        payload: {
          chat_id: chatId,
          model: "GLM-Test-Model",
          messages: [{ role: "user", content: "try again now" }],
        },
      });
      expect(offline.statusCode).toBe(200);
      await waitFor(async () => {
        const events = await threadEvents(chatId);
        const results = events.filter((e) => (e.event as { type?: string }).type === "tool_result");
        return results.length >= 2;
      }, 30000);
      await turnSettled(chatId);
      const events = await threadEvents(chatId);
      const second = events.filter((e) => (e.event as { type?: string }).type === "tool_result").pop();
      // The nested call's failure rides back as the shell result (exit 1,
      // "machine offline" output); the owning codemode call completes.
      expect((second!.event as { is_error: boolean }).is_error).toBe(false);
      expect((second!.event as { content: string }).content).toContain("machine offline");
    },
    TEST_TIMEOUT,
  );

});

describe("M4: session auth boundary", () => {
  it("a member cannot run turns in another member's session", async () => {
    // Another org member creates a session; the first member cannot see it.
    const otherEmail = `m4-other-${crypto.randomUUID()}@example.test`;
    const hash = await hashPassword(TEST_PASSWORD);
    await stack.env.db.query(
      "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES ($1, $2, $3, $4, 'member', 'managed')",
      [crypto.randomUUID(), orgId, otherEmail, hash],
    );
    const loginRes = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: otherEmail, password: TEST_PASSWORD },
    });
    const otherToken = (JSON.parse(loginRes.body) as { token: string }).token;
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents/sessions",
      headers: auth(otherToken),
      payload: { workspace_name: "other-ws" },
    });
    const session = JSON.parse(created.body) as { id: string };
    const foreign = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/agents/sessions/${session.id}`,
      headers: auth(memberToken),
    });
    expect(foreign.statusCode).toBe(404);
    const foreignTurn = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/agents/sessions/${session.id}/turns`,
      headers: auth(memberToken),
      payload: { message: "hi", model: "GLM-Test-Model" },
    });
    expect(foreignTurn.statusCode).toBe(404);
  });
});
