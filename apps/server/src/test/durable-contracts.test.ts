import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  watchEvents,
  ResetEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { Conversation, ToolRegistration } from "@earendil-works/pi-durable";
import { ChatBridge } from "../chats/bridge.js";
import { createApprovalGate } from "../harness/approvals.js";
import { SkillRuntime } from "../harness/skills.js";
import { GuildRuntime, SharedPoolDatabase } from "../harness/runtime.js";
import { UserMcpRuntime } from "../harness/userMcp.js";
import { ThreadStore } from "../platform/store/thread.js";
import { ChatStore } from "../platform/store/chats.js";
import { TurnCommandStore } from "../platform/store/turn_commands.js";
import { approvalDecisionEvent, assistantMessageEvent } from "../platform/domain/thread-events.js";
import { PostgresDurableStorage } from "../storage/postgres/storage.js";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

let stack: M2Stack;
let threads: ThreadStore;
const log = pino({ level: "silent" });
beforeAll(async () => {
  stack = await setupM2Stack({ GUILD_WORKER_MODE: "off" });
  threads = new ThreadStore(stack.env.db);
});
afterAll(async () => {
  await stack.close();
}, 60_000);
async function chat() {
  return (await new ChatStore(stack.env.db).createChat(stack.orgId, stack.memberId, "durable contracts", null)).id;
}
async function open(registry = createRegistry(), models = createModels()) {
  return Harness.open(
    await PostgresDurableStorage.open(new SharedPoolDatabase(stack.env.db)),
    { registry, models },
    context,
  );
}
async function until(probe: () => Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await probe())) {
    if (Date.now() > end) throw new Error("condition did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
}
function bridge(chatId: string, conversation: Conversation, store = threads) {
  const b = new ChatBridge({
    threads: store,
    chats: new ChatStore(stack.env.db),
    turnCommands: new TurnCommandStore(stack.env.db),
    routeSupportsImages: async () => false,
    log,
  });
  b.bind(String(conversation.id), chatId, stack.orgId);
  return b;
}

describe("durable integration contracts", () => {
  it("backfills cut history, adopts legacy events, and survives a cursor-write failure without duplicates", async () => {
    const h = await open();
    const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
    const id = await chat();
    try {
      await c.commit(async (tx) => {
        await tx.appendEntry(UserEntry, c.id, {
          model: [{ role: "user", content: "first", timestamp: 1 }],
        });
        await tx.appendEntry(AssistantEntry, c.id, {
          model: [fauxAssistantMessage("before reset")],
        });
        await tx.appendEntry(ResetEntry, c.id, { head: "self" });
        await tx.appendEntry(UserEntry, c.id, {
          model: [{ role: "user", content: "second", timestamp: 2 }],
        });
        await tx.appendEntry(AssistantEntry, c.id, {
          model: [fauxAssistantMessage("after reset")],
        });
      }, context);
      const model = fauxAssistantMessage("before reset");
      const legacy = await threads.appendEvent(
        id,
        assistantMessageEvent(
          1,
          1,
          [{ type: "text", text: "before reset" }],
          {
            tokens_in: model.usage.input,
            tokens_out: model.usage.output,
            cost_usd: model.usage.cost.total,
          },
          model.model,
        ),
      );
      const original = threads.advanceProjection.bind(threads);
      let failed = false;
      const flaky = Object.create(threads) as ThreadStore;
      flaky.advanceProjection = async (...args) => {
        if (args[2].step === 1 && !failed) {
          failed = true;
          throw new Error("cursor write failed");
        }
        await original(...args);
      };
      await expect(bridge(id, c, flaky).recover(c)).rejects.toThrow("cursor write failed");
      const recovered = bridge(id, c);
      await recovered.recover(c);
      await recovered.recover(c);
      const rows = await threads.listEvents(stack.orgId, id);
      expect(rows.filter((r) => r.event.type === "assistant_message")).toHaveLength(2);
      expect(rows[0]!.id).toBe(legacy.id);
      expect(rows[1]!.event).toMatchObject({
        type: "assistant_message",
        turn: 2,
        step: 1,
        blocks: [{ type: "text", text: "after reset" }],
      });
      const current = await c.viewState(context);
      expect(
        current.value.entries.some((e) =>
          e.model?.some(
            (m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "before reset"),
          ),
        ),
      ).toBe(false);
      current.dispose();
      await stack.env.db.query("DELETE FROM chat_projection_cursors WHERE chat_id=$1", [id]);
      await bridge(id, c).recover(c);
      expect(await threads.listEvents(stack.orgId, id)).toHaveLength(2);
    } finally {
      await h.close(context);
    }
  });

  it("recovers every immutable entry when a slow event consumer overflows to a snapshot", async () => {
    const h = await open();
    const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
    const id = await chat();
    const b = bridge(id, c);
    const stream = await watchEvents(h, c.id, context);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let overflow = false;
    stream.start(async (events) => {
      await gate;
      if (events.some((event) => event.type === "snapshot")) {
        overflow = true;
        await b.recover(c);
      }
    });
    try {
      for (let i = 0; i < 120; i++)
        await c.commit(async (tx) => {
          await tx.appendEntry(UserEntry, c.id, {
            model: [{ role: "user", content: `input ${i}`, timestamp: i }],
          });
          await tx.appendEntry(AssistantEntry, c.id, {
            model: [fauxAssistantMessage(`answer ${i}`)],
          });
        }, context);
      release();
      await until(async () => overflow && (await threads.listEvents(stack.orgId, id)).length === 120);
      await b.recover(c);
      const rows = await threads.listEvents(stack.orgId, id);
      expect(rows).toHaveLength(120);
      expect(rows[119]!.event).toMatchObject({
        turn: 120,
        step: 1,
        blocks: [{ type: "text", text: "answer 119" }],
      });
    } finally {
      release();
      await stream.stop();
      await h.close(context);
    }
  }, 15_000);

  it("does not reuse an unrelated legacy answer for an identical new response", async () => {
    const h = await open();
    const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
    const id = await chat();
    const message = fauxAssistantMessage("same answer");
    try {
      const legacy = await threads.appendEvent(
        id,
        assistantMessageEvent(
          1,
          1,
          [{ type: "text", text: "same answer" }],
          { tokens_in: message.usage.input, tokens_out: message.usage.output, cost_usd: message.usage.cost.total },
          message.model,
        ),
      );
      const b = bridge(id, c);
      await b.recover(c);
      await c.commit(async (tx) => {
        await tx.appendEntry(UserEntry, c.id, { model: [{ role: "user", content: "new input", timestamp: 1 }] });
        await tx.appendEntry(AssistantEntry, c.id, { model: [message] });
      }, context);
      await b.recover(c);
      const rows = await threads.listEvents(stack.orgId, id);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.id).not.toBe(legacy.id);
    } finally {
      await h.close(context);
    }
  });

  it("restores a live snapshot's partial and generation after attachment", async () => {
    const h = await open();
    const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
    const id = await chat();
    try {
      await c.commit(
        (tx) =>
          tx.appendEntry(UserEntry, c.id, {
            model: [{ role: "user", content: "pending", timestamp: 1 }],
          }),
        context,
      );
      const b = bridge(id, c);
      await b.recover(c);
      await b.handle(String(c.id), [
        {
          type: "snapshot",
          entries: [],
          run: { inputs: [] },
          generation: {
            attempt: 1,
            message: fauxAssistantMessage("committed partial"),
          },
          tools: [],
          nestedTools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: {},
        } as never,
      ]);
      expect(b.buffers(String(c.id))).toEqual({
        text: "committed partial",
        thinking: "",
      });
      expect(b.state(String(c.id)).turn).toBe(1);
      expect((await stack.env.db.query("SELECT generating FROM chats WHERE id=$1", [id])).rows[0].generating).toBe(
        true,
      );
    } finally {
      await h.close(context);
    }
  });

  it("first-touch worker bootstrap never rewrites another conversation's running task", async () => {
    const storage = await PostgresDurableStorage.open(new SharedPoolDatabase(stack.env.db));
    const cid = await storage.mintId();
    await storage.commit([{ type: "conversation", value: { id: cid } }] as never, context);
    const tid = await storage.mintId();
    await storage.commit(
      [
        {
          type: "task",
          value: {
            id: tid,
            conversationId: cid,
            kind: "test.foreign",
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            state: { status: "running", checkpoint: { phase: "work" } },
          },
        },
      ] as never,
      context,
    );
    const id = await chat();
    const worker = new GuildRuntime(
      stack.env.config,
      stack.env.db,
      log,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { chatId: id },
    );
    try {
      await worker.start();
      expect((await storage.task(tid as never, context))?.state.status).toBe("running");
    } finally {
      await worker.close();
      await storage.close(context);
      await stack.env.db.query("DELETE FROM tasks WHERE id=$1", [tid]);
    }
  });

  it("resolves script-only MCP tools, retains history tools, and clears stored choices after an empty preparation", async () => {
    const runtime = (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
    const id = await chat();
    const c = await runtime.conversationForChat(id, stack.orgId);
    const user = (runtime as unknown as { userMcpRuntime: UserMcpRuntime }).userMcpRuntime;
    const original = (user as unknown as { resolveSnapshot: unknown }).resolveSnapshot;
    const base = {
      orgId: stack.orgId,
      chatId: id,
      userId: stack.memberId,
      servers: [{ id: "fixture", name: "fixture" }],
      tools: [
        {
          serverId: "fixture",
          serverName: "fixture",
          toolName: "echo",
          description: "Echo",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      lines: [],
      at: Date.now(),
    };
    try {
      (user as unknown as { resolveSnapshot: () => Promise<unknown> }).resolveSnapshot = async () => base;
      await (
        runtime as unknown as {
          provisionTurnTools: (c: Conversation, id: string, org: string) => Promise<void>;
        }
      ).provisionTurnTools(c, id, stack.orgId);
      let agent = await c.agent(context);
      expect(agent.tools.map((t) => t.name)).toEqual(["codemode"]);
      expect(agent.callable.map((t) => t.name)).toEqual(
        expect.arrayContaining(["mcp_fixture_echo", "thread_history", "thread_search"]),
      );
      (user as unknown as { resolveSnapshot: () => Promise<unknown> }).resolveSnapshot = async () => ({
        ...base,
        servers: [],
        tools: [],
      });
      await (
        runtime as unknown as {
          provisionTurnTools: (c: Conversation, id: string, org: string) => Promise<void>;
        }
      ).provisionTurnTools(c, id, stack.orgId);
      agent = await c.agent(context);
      expect(agent.callable.map((t) => t.name)).not.toContain("mcp_fixture_echo");
      expect(agent.callable.map((t) => t.name)).toContain("thread_history");
    } finally {
      (user as unknown as { resolveSnapshot: unknown }).resolveSnapshot = original;
    }
  });

  it.each(["approve", "expired", "abort"] as const)(
    "preserves approval lifecycle across interruption (%s)",
    async (outcome) => {
      const id = await chat();
      await stack.env.db.query("UPDATE chats SET approval=$2::jsonb WHERE id=$1", [
        id,
        JSON.stringify({ default: "ask" }),
      ]);
      let executions = 0;
      const registry = createRegistry();
      const gate = createApprovalGate({
        pool: stack.env.db,
        threads,
        log,
        execPolicy: {} as never,
        approvalTimeoutMs: 60_000,
        selfBaseUrl: "",
        internalKey: null,
        allowShellTools: true,
        chatOfConversation: async () => id,
        executorKind: async () => "machine",
        currentModel: async () => null,
      });
      registry.install(
        defineExtension({
          name: "approval-test",
          hooks: [gate],
          tools: [
            defineTool({
              name: "write",
              description: "write",
              parameters: Type.Object({}),
              execute: async () => {
                executions++;
                return { output: [{ type: "text", text: "written" }] };
              },
            }),
          ],
        }),
      );
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", {}, { id: "approval-call" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      let h = await open(registry, models);
      const c = await h.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        },
        context,
      );
      try {
        const submission = await c.submit({ type: "input", content: "write" }, context);
        await until(async () =>
          (await threads.listEvents(stack.orgId, id)).some((r) => r.event.type === "approval_request"),
        );
        const firstCard = (await threads.listEvents(stack.orgId, id))[0]!;
        if (outcome === "abort") {
          await c.abort(context);
          expect(executions).toBe(0);
          expect(
            (await threads.listEvents(stack.orgId, id)).some(
              (row) => row.event.type === "approval_decision" && !row.event.approved,
            ),
          ).toBe(true);
          return;
        }
        await h.close(context);
        expect(
          (await threads.listEvents(stack.orgId, id)).filter((r) => r.event.type === "approval_decision"),
        ).toHaveLength(0);
        if (outcome === "expired") {
          await stack.env.db.query("UPDATE thread_events SET created_at=now()-interval '2 minutes' WHERE id=$1", [
            firstCard.id,
          ]);
        }
        h = await open(registry, models);
        h.resume();
        if (outcome === "approve")
          await threads.appendEvent(id, approvalDecisionEvent("approval-call", true, undefined));
        expect((await (await h.submission(submission.id, context))!.wait(context)).status).toBe("done");
        expect(executions).toBe(outcome === "approve" ? 1 : 0);
        expect(
          (await threads.listEvents(stack.orgId, id))
            .filter((r) => r.event.type === "approval_request")
            .map((r) => r.id),
        ).toEqual([firstCard.id]);
      } finally {
        await h.close(context);
      }
    },
    15_000,
  );

  it("does not replay a skill publication interrupted after its external effect", async () => {
    const push = new SkillRuntime({} as never).tools().find((t) => t.name === "push_skill")!;
    let calls = 0;
    let started!: () => void;
    const reached = new Promise<void>((r) => {
      started = r;
    });
    const tool: ToolRegistration = {
      ...push,
      execute: async (_args, _api, ctx) => {
        calls++;
        started();
        await new Promise<void>((_resolve, reject) => {
          ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), { once: true });
        });
        return {};
      },
    };
    const registry = createRegistry();
    registry.install(defineExtension({ name: "push-test", tools: [tool] }));
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("push_skill", { slug: "example" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("interrupted publication reported"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let h = await open(registry, models);
    const c = await h.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      context,
    );
    try {
      const submission = await c.submit({ type: "input", content: "publish" }, context);
      await reached;
      await h.close(context);
      h = await open(registry, models);
      h.resume();
      expect((await (await h.submission(submission.id, context))!.wait(context)).status).toBe("done");
      expect(calls).toBe(1);
    } finally {
      await h.close(context);
    }
  }, 15_000);
});
