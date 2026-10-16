// Baseline diagnostic for the 2026-10-16 Guild incident (chat 01a13f12).
// Native pi-durable deliberately retains queued inputs after a failed run;
// the next input or queued write places them oldest first. Resume/restart
// alone does not place them. Guild's stale generating flag blocked normal
// sends, making that documented recovery path unreachable from its UI.
//
// Four scenarios, each its own chat:
//   A: tool error (bash exit 3) → model 404 → input during retries
//   B: model 404 (no tool) → input during retries, then the idle-inbox drain
//   B2: model 404 → input after all generation tasks are terminal
//   C: tool error → model completes → new input
//
// B pins Guild's 0.5.70 automatic-continuation policy: the input queues
// natively during the retry window, and once the failed run settles the
// idle inbox is drained and the input is placed without another admission
// (queue-recovery.test.ts covers the same policy at the harness level).
// Queued state alone is valid native behavior, not a pi-durable defect.

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

const TEST_TIMEOUT = 120_000;

let stack: M2Stack;
let port: number;
let memberToken: string;
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-wedge-sandbox-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "guild-wedge-data-"));

const toolCallSse = (name: string, args: string, id = "call_w"): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"' +
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
  'data: {"choices":[{"delta":{"content":"all done"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

/** The incident's upstream failure: 404 with a FastAPI-style body. */
const notFound = { status: 404, contentType: "application/json", body: '{"detail":"Not Found"}' };

beforeAll(async () => {
  process.env.GUILD_SANDBOX_ROOT = sandboxRoot;
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
    { dbPrefix: "guild_wedge_test", logLevel: process.env.WEDGE_TEST_LOG ?? "error" },
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
  // Scripted tool calls must run without the interactive approval gate.
  await stack.env.db.query("UPDATE chats SET approval = '{\"default\":\"full_access\"}' WHERE id = $1", [chatId]);
  return chatId;
}

async function submitTurn(chatId: string, content: string): Promise<{ user_message_id: string; status: string }> {
  const submit = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/gateway/chat",
    headers: auth(),
    payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content }] },
  });
  expect(submit.statusCode).toBe(200);
  const ack = JSON.parse(submit.body) as { user_message_id: string; status: string };
  return { user_message_id: ack.user_message_id, status: ack.status };
}

/** Waits until the turn's last thread event is an assistant message. */
async function turnSettled(chatId: string): Promise<void> {
  await waitFor(async () => {
    const events = await threadEvents(chatId);
    const last = events[events.length - 1];
    if (last === undefined) return false;
    return (last.event as { type?: string }).type === "assistant_message";
  });
}

/** The durable observation: the second turn's submission state, whether a
 *  run started, and the generating flag. */
async function wedgeState(chatId: string, commandId: string): Promise<{
  submissionStatus: string | null;
  submissionReason: string | null;
  runTasks: { id: number; kind: string; status: string }[];
  generating: boolean;
}> {
  const db = stack.env.db;
  const conv = await db.query<{ conversation_id: string }>(
    "SELECT conversation_id FROM chat_conversations WHERE chat_id = $1",
    [chatId],
  );
  const conversationId = Number(conv.rows[0]!.conversation_id);
  // request_id is stored JSON-encoded (a quoted string), like the record.
  const submission = await db.query<{ status: string; record: string }>(
    "SELECT status, record FROM submissions WHERE request_id = $1",
    [JSON.stringify(commandId)],
  );
  const record = submission.rows[0] ? (JSON.parse(submission.rows[0].record) as { reason?: string }) : undefined;
  const tasks = await db.query<{ id: string; kind: string; status: string; record: string }>(
    "SELECT id, kind, status, record FROM tasks WHERE conversation_id = $1 ORDER BY id",
    [conversationId],
  );
  // The kind column is JSON-encoded ("pi.generation", quotes included).
  const runTasks = tasks.rows
    .map((r) => ({ id: Number(r.id), kind: r.kind.replaceAll('"', ""), status: r.status }))
    .filter((t) => t.kind === "pi.generation");
  const chat = await db.query<{ generating: boolean }>("SELECT generating FROM chats WHERE id = $1", [chatId]);
  return {
    submissionStatus: submission.rows[0]?.status ?? null,
    submissionReason: record?.reason ?? null,
    runTasks,
    generating: chat.rows[0]!.generating,
  };
}

/** Runs one scenario end to end and returns the second turn's wedge state.
 *  `submitSecondAfter` optionally delays the second submit until a probe
 *  (all generation tasks terminal) holds — admitting to a fully settled
 *  conversation, past any retry window. */
async function scenario(
  name: string,
  responses: { status?: number; contentType?: string; body?: string }[],
  secondWaitMs = 8_000,
  submitSecondAfter?: (chatId: string) => Promise<boolean>,
): Promise<Awaited<ReturnType<typeof wedgeState>> & { chatId: string; secondCommandId: string }> {
  const chatId = await createChat(`wedge ${name}`);
  stack.mock.setResponses(responses);
  const first = await submitTurn(chatId, "first turn");
  await turnSettled(chatId);
  const events1 = await threadEvents(chatId);
  const last1 = events1[events1.length - 1]!.event as { error?: string; blocks?: { type: string; text?: string }[] };
  const error1 = last1.error ?? null;

  if (submitSecondAfter !== undefined) await waitFor(() => submitSecondAfter(chatId), 90_000);
  const second = await submitTurn(chatId, "second turn");
  // Give the admission + scheduler a fair window to act.
  await new Promise((resolve) => setTimeout(resolve, secondWaitMs));
  const state = await wedgeState(chatId, second.user_message_id);

  console.log(
    `\n=== scenario ${name} ===\n` +
      `turn 1: command=${first.status} error=${error1}\n` +
      `turn 2: command=${second.status} submission=${state.submissionStatus}` +
      ` reason=${state.submissionReason} generating=${state.generating}\n` +
      `generation tasks: ${JSON.stringify(state.runTasks)}\n` +
      `WEDGED: ${state.submissionStatus === "queued" && !state.runTasks.some((t) => t.status !== "terminal")}\n`,
  );
  return { ...state, chatId, secondCommandId: second.user_message_id };
}

/** All generation tasks of the conversation are terminal. */
async function allGenerationsTerminal(chatId: string): Promise<boolean> {
  const conv = await stack.env.db.query<{ conversation_id: string }>(
    "SELECT conversation_id FROM chat_conversations WHERE chat_id = $1",
    [chatId],
  );
  const tasks = await stack.env.db.query<{ kind: string; status: string }>(
    "SELECT kind, status FROM tasks WHERE conversation_id = $1",
    [Number(conv.rows[0]!.conversation_id)],
  );
  const gens = tasks.rows.filter((r) => r.kind.includes("pi.generation"));
  return gens.length > 0 && gens.every((r) => r.status === "terminal");
}

describe("wedge repro: input after a failed run", () => {
  it(
    "A: tool error then model 404 → is the next input stuck queued?",
    async () => {
      const state = await scenario("A tool-error + 404", [
        { body: toolCallSse("bash", JSON.stringify({ command: "exit 3" })) },
        notFound,
      ], 500, allGenerationsTerminal);
      expect(state.submissionStatus).toBe("placed");
    },
    TEST_TIMEOUT,
  );

  it(
    "B: failure-window input → Guild drains the idle inbox after the failed run (0.5.70 policy)",
    async () => {
      const { chatId, secondCommandId, ...state } = await scenario("B 404 only", [notFound]);
      // Native pi-durable queues this input (the run is live during the
      // retry window). Under the native contract alone it would wait for
      // the next admission; Guild's queue recovery (0.5.70) instead drains
      // the idle inbox once the failed run settles.
      expect(state.submissionStatus).toBe("queued");
      await waitFor(async () => allGenerationsTerminal(chatId), 60_000);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const after = await wedgeState(chatId, secondCommandId);
      console.log(
        `=== scenario B aftermath ===\n` +
          `after retries exhausted: submission=${after.submissionStatus} generating=${after.generating} tasks=${JSON.stringify(after.runTasks)}\n` +
          `DRAINED AND PLACED: ${after.submissionStatus !== "queued"}\n`,
      );
      // The drained input was placed and ran (here it settled unanswered:
      // the scripted model keeps 404ing). It must not stay queued.
      expect(after.submissionStatus).not.toBe("queued");
      expect(after.runTasks.length).toBeGreaterThan(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "B2: like B, but the second input waits for all tasks terminal → placed (mechanism check)",
    async () => {
      const state = await scenario("B2 404, delayed submit", [notFound], 2_000, (chatId) => allGenerationsTerminal(chatId));
      expect(state.submissionStatus).toBe("placed");
    },
    TEST_TIMEOUT,
  );

  it(
    "C: tool error then a normal answer → control, next input placed",
    async () => {
      const state = await scenario("C tool-error + ok", [
        { body: toolCallSse("bash", JSON.stringify({ command: "exit 3" })) },
        { body: finalSse },
      ]);
      // The mechanism check: a non-retryable first-turn failure ends the
      // run at once, so the next input is admitted to an IDLE conversation
      // and starts a run (it may itself fail on the scripted tail — what
      // matters is that it was PLACED, not stranded queued).
      expect(state.submissionStatus).not.toBe("queued");
    },
    TEST_TIMEOUT,
  );
});
