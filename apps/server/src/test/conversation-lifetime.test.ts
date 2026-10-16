import { EventEmitter } from "node:events";
import type { fork } from "node:child_process";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { ConversationHost } from "../harness/conversation-host.js";
import { ConversationAdmissions } from "../harness/operations.js";
import { ForkSupervisor } from "../worker/supervisor.js";
import { loadConfig } from "../config.js";
import { userMcpToolName } from "../harness/userMcp.js";
import { toolSchema, toolDetails } from "../harness/tool-schema.js";

const log = pino({ level: "silent" });
afterEach(() => vi.useRealTimers());
describe("conversation ownership", () => {
  it("closes a resumed candidate when initialization fails and can open again", async () => {
    const host = new ConversationHost();
    const create = async () => {
      const storage = new MemoryStorage();
      return {
        storage,
        harness: await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context),
        watches: new Map(),
      };
    };
    const candidate = await create();
    await expect(
      host.replace(
        async () => candidate,
        async (value) => {
          value.harness.resume();
          throw new Error("reconciliation unavailable");
        },
        () => {},
      ),
    ).rejects.toThrow("reconciliation unavailable");
    expect((await candidate.harness.closed).reason).toBe("closed");
    expect(host.value).toBeUndefined();
    await host.replace(
      create,
      async () => {},
      () => {},
    );
    expect(host.value).toBeDefined();
    await host.close();
    expect(host.value).toBeUndefined();
  });
  it("Stop cancels both discovering and waiting admissions while other chats proceed", async () => {
    const admissions = new ConversationAdmissions();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = admissions.run("a", async (signal) => {
      await barrier;
      signal.throwIfAborted();
      return "admitted";
    });
    const queued = admissions.run("a", async () => "should not be admitted");
    const activeFailure = expect(active).rejects.toThrow("admission cancelled");
    const queuedFailure = expect(queued).rejects.toThrow("admission cancelled");
    admissions.cancel("a");
    expect(await admissions.run("b", async () => "other chat")).toBe("other chat");
    release();
    await activeFailure;
    await queuedFailure;
    expect(await admissions.run("a", async () => "new input")).toBe("new input");
    await admissions.close();
  });
  it("names MCP pairs unambiguously and validates external schemas/metadata", () => {
    expect(userMcpToolName("foo_bar", "baz")).not.toBe(userMcpToolName("foo", "bar_baz"));
    expect(() => toolSchema({ type: "string" })).toThrow("type object");
    expect(() => toolDetails({ value: Infinity })).toThrow("must be JSON");
    expect(toolDetails({ calls: [] })).toEqual({ calls: [] });
  });
});

class Child extends EventEmitter {
  connected = true;
  pid = 123;
  sent: unknown[] = [];
  killed = false;
  send(message: { ref: number }, callback?: () => void) {
    this.sent.push(message);
    queueMicrotask(() => this.emit("message", { t: "result", ref: message.ref, ok: true, data: 1 }));
    callback?.();
    return true;
  }
  kill() {
    this.killed = true;
    this.connected = false;
    this.emit("exit", 1, null);
    return true;
  }
}
const input = { orgId: "org", requestId: "request", content: "hello", images: [], model: null };
const config = () =>
  loadConfig({
    GUILD_DATABASE_URL: "postgres://unused",
    GUILD_MASTER_KEY_HEX: "11".repeat(32),
    GUILD_JWT_SECRET: "test-secret",
  });

describe("worker readiness and recovery", () => {
  it("all concurrent callers await one successful ready handshake", async () => {
    const child = new Child();
    const supervisor = new ForkSupervisor(config(), log, async () => false, undefined, {
      spawn: (() => child) as unknown as typeof fork,
    });
    try {
      const a = supervisor.submit("chat", input),
        b = supervisor.submit("chat", input);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(child.sent).toHaveLength(0);
      child.emit("message", { t: "ready" });
      expect(await Promise.all([a, b])).toEqual([1, 1]);
      expect(child.sent).toHaveLength(2);
    } finally {
      await supervisor.close();
    }
  });
  it("does not expire readiness after the handshake succeeded", async () => {
    const child = new Child();
    const supervisor = new ForkSupervisor(config(), log, async () => false, undefined, {
      spawn: (() => {
        queueMicrotask(() => child.emit("message", { t: "ready" }));
        return child;
      }) as unknown as typeof fork,
      readyTimeoutMs: 10,
    });
    try {
      await supervisor.submit("chat", input);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(child.killed).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  it("kills a child that never becomes ready and rejects all waiting callers", async () => {
    const child = new Child();
    const supervisor = new ForkSupervisor(config(), log, async () => false, undefined, {
      spawn: (() => child) as unknown as typeof fork,
      readyTimeoutMs: 10,
    });
    try {
      const results = await Promise.allSettled([supervisor.submit("chat", input), supervisor.submit("chat", input)]);
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(child.killed).toBe(true);
      expect(child.sent).toHaveLength(0);
    } finally {
      await supervisor.close();
    }
  });
  it("retries unavailable work lookup and preserves backoff across child replacement", async () => {
    const children: Child[] = [];
    let probes = 0;
    const probe = vi.fn(async () => {
      if (++probes === 1) throw new Error("database unavailable");
      return true;
    });
    const spawn = () => {
      const child = new Child();
      children.push(child);
      queueMicrotask(() => child.emit("message", { t: "ready" }));
      return child;
    };
    const supervisor = new ForkSupervisor(config(), log, probe, undefined, {
      spawn: spawn as unknown as typeof fork,
      respawnDelays: [5, 20, 50],
    });
    try {
      await supervisor.submit("chat", input);
      children[0]!.kill();
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 1000, interval: 5 });
      expect(probe).toHaveBeenCalledTimes(2);
      children[1]!.kill();
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(children).toHaveLength(2);
      await vi.waitFor(() => expect(children).toHaveLength(3), { timeout: 1000, interval: 5 });
    } finally {
      await supervisor.close();
    }
  });
});

it("attributes simultaneous provider calls by durable session identity", async () => {
  const { startMockUpstream } = await import("./platform/m2-harness.js");
  const { ensureOrgProvider, guildProviderId } = await import("../harness/models.js");
  const upstream = await startMockUpstream([
    {
      body: 'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    },
  ]);
  try {
    const models = createModels();
    const routes = [
      {
        model: "trace-model",
        reasoning: false,
        context_window: 8192,
        max_output_tokens: 1024,
        price_in: 0,
        price_out: 0,
      },
    ];
    ensureOrgProvider(
      models,
      {
        selfBaseUrl: upstream.url,
        internalKey: "test",
        traceHeaders: async (sessionId) => {
          await new Promise((resolve) => setTimeout(resolve, sessionId === "session-a" ? 15 : 1));
          return { "x-guild-chat-id": sessionId === "session-a" ? "chat-a" : "chat-b" };
        },
      },
      "org",
      routes,
    );
    const model = models.getModel(guildProviderId("org"), "trace-model")!;
    await Promise.all(
      ["session-a", "session-b"].map((sessionId) =>
        models
          .streamSimple(
            model,
            { messages: [{ role: "user", content: sessionId, timestamp: Date.now() }] },
            { sessionId },
          )
          .result(),
      ),
    );
    expect(upstream.requests).toHaveLength(2);
    for (const request of upstream.requests) {
      const body = request.body as { messages: { content: string }[] };
      const session = body.messages.at(-1)!.content;
      expect(request.headers["x-guild-chat-id"]).toBe(session === "session-a" ? "chat-a" : "chat-b");
    }
  } finally {
    await upstream.stop();
  }
});

it("retires projection-only boot workers after catch-up", async () => {
  const children: Child[] = [];
  const supervisor = new ForkSupervisor(config(), log, async () => false, undefined, {
    spawn: (() => {
      const child = new Child();
      children.push(child);
      queueMicrotask(() => child.emit("message", { t: "ready" }));
      return child;
    }) as unknown as typeof fork,
  });
  try {
    await supervisor.recoverFromJournal([{ chatId: "old-a" }, { chatId: "old-b" }]);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    await vi.waitFor(() => expect(children.every((child) => child.killed)).toBe(true));
    expect(supervisor.pidOf("old-a")).toBeUndefined();
    expect(supervisor.pidOf("old-b")).toBeUndefined();
  } finally {
    await supervisor.close();
  }
});
