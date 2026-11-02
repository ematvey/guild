import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeMessage, startSocket, type SocketHandlers, type SocketLike } from "./socket-client";
import type { ThreadEventRow } from "./thread-events";
import type { ThreadEvent } from "./thread-events";

const chat = {
  id: "chat-1", org_id: "o1", user_id: "u1", title: "Chat", created_at: "now",
  generating: false, unread: false, working: false, blocked: false,
  last_activity_at: "now", machine_online: false, type: "user" as const, archived: false, deleted: false,
};
const delta = { type: "delta" as const, content: "hello" };

function row(seq: number, event: ThreadEvent): ThreadEventRow {
  return { id: `e${seq}`, chat_id: "chat-1", seq, event, created_at: "t" };
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event?: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event?: any) => void) | null = null;
  onclose: ((event?: any) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe("routeMessage", () => {
  it("dispatches protocol messages to their matching handlers", () => {
    const calls: string[] = [];
    const handlers: SocketHandlers = {
      onThreadList: (chats) => calls.push(`threads:${chats.length}`),
      onChatStatus: (frame) => calls.push(`status:${frame.chat_id}:${frame.generating}`),
      onFrame: (frame) => calls.push(`frame:${frame.chat_id}:${frame.event.type}`),
      onSync: (chatId, phase) => calls.push(`sync:${chatId}:${phase}`),
      onThreadState: (state) => calls.push(`state:${state.chat_id}:${state.seq}`),
      onDisplaced: () => calls.push("displaced"),
      onAuthRequired: () => calls.push("auth"),
      onError: (message) => calls.push(`error:${message}`),
      onOrgEvent: () => calls.push("org"),
      onWorkspaceIdentity: (identity) => calls.push(`info:${identity.name}`),
      onMachineStatus: (machineId, online) => calls.push(`machine:${machineId}:${online}`),
    };

    routeMessage({ type: "hello" }, handlers);
    routeMessage({ type: "thread_list", chats: [chat] }, handlers);
    routeMessage({ type: "chat_status", chat_id: "chat-1", generating: true }, handlers);
    routeMessage({ type: "sync_begin", chat_id: "chat-1" }, handlers);
    routeMessage({ type: "thread_state", chat_id: "chat-1", seq: 1, events: [], text: "hello", thinking: "", generating: true, has_more_events: false }, handlers);
    routeMessage({ type: "sync_done", chat_id: "chat-1" }, handlers);
    routeMessage({ type: "live_frame", chat_id: "chat-1", generation_id: "generation-1", seq: 2, machine_id: null, event: delta }, handlers);
    routeMessage({ type: "displaced" }, handlers);
    routeMessage({ type: "auth_required" }, handlers);
    routeMessage({ type: "machine_status", machine_id: "m1", online: false }, handlers);

    expect(calls).toEqual([
      "threads:1",
      "status:chat-1:true",
      "sync:chat-1:begin",
      "state:chat-1:1",
      "sync:chat-1:done",
      "frame:chat-1:delta",
      "displaced",
      "auth",
      "machine:m1:false",
    ]);

    routeMessage({ type: "error", message: "bad" }, handlers);
    routeMessage(
      {
        type: "org_event",
        event: { id: "e1", org_id: "o1", kind: "member_added", payload: {}, created_at: "now" },
      },
      handlers,
    );
    expect(calls.slice(-2)).toEqual(["error:bad", "org"]);

    routeMessage({ type: "workspace_identity", name: "Acme", telemetry: true }, handlers);
    expect(calls.at(-1)).toBe("info:Acme");
  });

  it("hands the identity's web bundle and the model list to their handlers", () => {
    const identities: unknown[] = [];
    const lists: unknown[] = [];
    const handlers: SocketHandlers = {
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      onWorkspaceIdentity: (identity) => identities.push(identity),
      onModelList: (models) => lists.push(models),
    };
    routeMessage({ type: "workspace_identity", name: "Acme", telemetry: false, web_bundle: "abc123" }, handlers);
    routeMessage({ type: "model_list", models: [{ id: "m1", alias: "Auto" }] }, handlers);
    expect(identities).toEqual([{ name: "Acme", telemetry: false, web_bundle: "abc123" }]);
    expect(lists).toEqual([[{ id: "m1", alias: "Auto" }]]);
  });

  it("hands the pushed member profile to its handler", () => {
    const seen: unknown[] = [];
    const user = {
      id: "u1", email: "ada@example.org", org_id: "o1", role: "admin",
      display_name: "Ada", avatar_url: null, onboarded: true,
    };
    routeMessage(
      { type: "member_profile", user },
      { onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
        onMemberProfile: (profile) => seen.push(profile) },
    );
    expect(seen).toEqual([user]);
  });

  it("routes the agent, skill catalog and chat tree frames", () => {
    const calls: string[] = [];
    const handlers: SocketHandlers = {
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      onAgentList: (agents) => calls.push(`agents:${agents.length}`),
      onAgentRun: (run) => calls.push(`run:${run.id}`),
      onAgentThreads: (agentId, threads) => calls.push(`threads:${agentId}:${threads.length}`),
      onAgentRoutines: (agentId, routines) => calls.push(`routines:${agentId}:${routines.length}`),
      onSkillCatalog: (items, installs) => calls.push(`skills:${items.length}:${installs.length}`),
      onChatTree: (tree) => calls.push(`tree:${tree.chat_id}`),
    };
    routeMessage({ type: "agent_list", agents: [] }, handlers);
    routeMessage({ type: "agent_run", run: { id: "r1" } } as never, handlers);
    routeMessage({ type: "agent_threads", agent_id: "a1", threads: [] }, handlers);
    routeMessage({ type: "agent_routines", agent_id: "a1", routines: [] }, handlers);
    routeMessage({ type: "skill_catalog", items: [], installs: [] }, handlers);
    routeMessage({ type: "chat_tree", chat_id: "c1", tree: { chat_id: "c1" } } as never, handlers);
    expect(calls).toEqual([
      "agents:0", "run:r1", "threads:a1:0", "routines:a1:0", "skills:0:0", "tree:c1",
    ]);
  });

  it("routes incremental thread_events frames to their handler", () => {
    const seen: { chatId: string; seq: number; rows: ThreadEventRow[] }[] = [];
    routeMessage(
      { type: "thread_events", chat_id: "chat-1", seq: 9, events: [row(9, { type: "user_message", content: "go", attachments: [] })] } as never,
      { onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
        onThreadEvents: (chatId, seq, rows) => seen.push({ chatId, seq, rows }) },
    );
    expect(seen).toEqual([{ chatId: "chat-1", seq: 9, rows: [row(9, { type: "user_message", content: "go", attachments: [] })] }]);
  });
});

describe("startSocket", () => {
  // Pin the reconnect jitter: the first redial waits 750 ms, the next 1.5 s.
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.mocked(Math.random).mockRestore();
  });

  it.each(["reject", "http", "network"])("recovers from a %s ticket failure", async (failure) => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "client-1" });
    const fetchMock = vi.fn(async () => {
      if (failure === "reject") throw new Error("offline");
      if (failure === "network") throw new TypeError("Failed to fetch");
      return { ok: false, statusText: "Unavailable", json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];
    const connection = startSocket({
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      onError: (message) => errors.push(message), getOpenChatId: () => null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    if (failure === "network") expect(errors[0]).toBe("Can't reach the server — reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    connection.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("discards reflected views and resets an interrupted sync on reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "client" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "ticket" }) })));
    const sockets: FakeSocket[] = [];
    const accepted: number[] = [];
    const depths = new Map<string, number>();
    const connection = startSocket({
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {},
      onConnect: () => depths.clear(),
      onSync: (chat, phase) => depths.set(chat, (depths.get(chat) ?? 0) + (phase === "begin" ? 1 : -1)),
      onThreadState: state => accepted.push(state.seq), getOpenChatId: () => "chat",
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    const deliver = (socket: FakeSocket, message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) });
    const state = { type: "thread_state", chat_id: "chat", seq: 9, text: "latest", thinking: "", events: [], generating: false };
    deliver(sockets[0], state);
    deliver(sockets[0], { ...state, seq: 8, text: "older" });
    deliver(sockets[0], state);
    expect(accepted).toEqual([9]);
    deliver(sockets[0], { type: "sync_begin", chat_id: "chat" });
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1].open();
    deliver(sockets[1], { type: "sync_begin", chat_id: "chat" });
    deliver(sockets[1], { ...state, seq: 10 });
    deliver(sockets[1], { type: "sync_done", chat_id: "chat" });
    expect(depths.get("chat")).toBe(0);
    expect(accepted).toEqual([9, 10]);
    connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("reports a dropped read mark instead of claiming it was sent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "client" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "ticket" }) })));
    const sockets: FakeSocket[] = [];
    const connection = startSocket({
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      getOpenChatId: () => "chat",
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.markRead("chat")).toBe(false);
    sockets[0].open();
    expect(connection.markRead("chat")).toBe(true);
    expect(sockets[0].sent.some((frame) => frame.includes('"type":"read"'))).toBe(true);
    sockets[0].close();
    expect(connection.markRead("chat")).toBe(false);
    connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it.each([false, true])("refreshes before reminting, including transient refresh failure (%s)", async (transientFailure) => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "token", setItem: () => {} });
    const paths: string[] = [];
    let refreshAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      paths.push(url);
      if (url.endsWith("refresh") && transientFailure && refreshAttempts++ === 0) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => url.endsWith("refresh") ? { token: "fresh" } : { ticket: "one-use" } };
    }));
    const sockets: FakeSocket[] = [];
    const signedOut = vi.fn();
    const connected = vi.fn();
    const connection = startSocket({
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      onAuthRequired: signedOut, onConnect: connected, getOpenChatId: () => "chat-1",
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "auth_required" }) });
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1].open();
    expect(paths).toEqual(transientFailure
      ? ["/api/v1/ws/ticket", "/api/v1/auth/refresh", "/api/v1/auth/refresh", "/api/v1/ws/ticket"]
      : ["/api/v1/ws/ticket", "/api/v1/auth/refresh", "/api/v1/ws/ticket"]);
    expect(connected).toHaveBeenCalledTimes(2);
    expect(signedOut).not.toHaveBeenCalled();
    connection.stop();
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("sends the current sync on open and reconnects after the backoff delay", async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>([["guild_client_id", "client-1"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      json: async () => ({ ticket: `ticket-${fetchMock.mock.calls.length}` }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const sockets: FakeSocket[] = [];
    let openChatId: string | null = "chat-1";
    const connection = startSocket({
      onThreadList: () => {},
      onChatStatus: () => {},
      onFrame: () => {},
      onSync: () => {},
      getOpenChatId: () => openChatId,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "sync", chat_id: "chat-1" });

    openChatId = "chat-2";
    connection.resync();
    expect(JSON.parse(sockets[0].sent[1])).toEqual({ type: "sync", chat_id: "chat-2" });
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(749);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(JSON.parse(sockets[1].sent[0])).toEqual({ type: "sync", chat_id: "chat-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    connection.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pings while open and force-reconnects a silent (half-open) socket", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "client" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "t" }) })));
    const sockets: FakeSocket[] = [];
    const connection = startSocket({
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      getOpenChatId: () => null,
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();

    // Healthy socket: pings flow every 5s, pongs keep the watchdog quiet.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      sockets[0].onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    }
    expect(sockets[0].closed).toBe(false);

    // Silence: no pong (half-open tunnel). The watchdog closes the socket
    // after 15s without any server frame; the reconnect timer then dials a
    // fresh one and the open sync re-derives the missed state.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets.length).toBe(2);

    connection.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("wake-ups", () => {
    /** A browser-shaped host: window and document as event targets. */
    function stubHost() {
      const win = Object.assign(new EventTarget(), { location: { protocol: "http:", host: "test" } });
      const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
      vi.stubGlobal("window", win);
      vi.stubGlobal("document", doc);
      vi.stubGlobal("localStorage", { getItem: () => "client" });
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "t" }) })));
      return { win, doc };
    }
    const handlers = {
      onThreadList: () => {}, onChatStatus: () => {}, onFrame: () => {}, onSync: () => {},
      getOpenChatId: () => null,
    };

    it("a wake during a pending reconnect dials once, not twice", async () => {
      vi.useFakeTimers();
      const { win } = stubHost();
      const sockets: FakeSocket[] = [];
      const connection = startSocket({
        ...handlers,
        socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      });
      await vi.advanceTimersByTimeAsync(0);
      sockets[0].open();
      sockets[0].close();
      // The reconnect timer is pending; a silent socket past the dead line
      // makes the wake-up dial at once.
      await vi.advanceTimersByTimeAsync(500);
      vi.setSystemTime(Date.now() + 20_000);
      win.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets).toHaveLength(2);
      connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
    });

    it("a fresh dial closes the socket it replaces", async () => {
      vi.useFakeTimers();
      const { doc } = stubHost();
      const sockets: FakeSocket[] = [];
      const states: number[] = [];
      const connection = startSocket({
        ...handlers,
        onThreadState: (state) => states.push(state.seq),
        socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      });
      await vi.advanceTimersByTimeAsync(0);
      // Still connecting (readyState 0) and silent past the dead line: the
      // wake-up gives up on it and dials again.
      vi.setSystemTime(Date.now() + 20_000);
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(sockets[0].closed).toBe(true);
      // The replaced socket's late frame never reaches the handlers.
      sockets[0].onmessage?.({ data: JSON.stringify({ type: "thread_state", chat_id: "c", seq: 1, text: "", thinking: "", events: [], generating: false }) });
      expect(states).toEqual([]);
      connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
    });

    it("a wake on a current link probes it without a resync; a stale one resyncs", async () => {
      vi.useFakeTimers();
      const { doc } = stubHost();
      const sockets: FakeSocket[] = [];
      const connection = startSocket({
        ...handlers,
        socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      });
      await vi.advanceTimersByTimeAsync(0);
      sockets[0].open();
      const sent = () => sockets[0].sent.map((frame) => JSON.parse(frame).type as string);
      expect(sent()).toEqual(["sync"]);
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(sent()).toEqual(["sync", "ping"]);
      // Silent past two ping intervals (a throttled background tab): the
      // wake probes and resyncs.
      vi.setSystemTime(Date.now() + 12_000);
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(sent().slice(-2)).toEqual(["ping", "sync"]);
      expect(sockets).toHaveLength(1);
      connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
    });

    it("stop removes the wake listeners", async () => {
      vi.useFakeTimers();
      const { win, doc } = stubHost();
      const sockets: FakeSocket[] = [];
      const connection = startSocket({
        ...handlers,
        socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      });
      await vi.advanceTimersByTimeAsync(0);
      const removedWin = vi.spyOn(win, "removeEventListener");
      const removedDoc = vi.spyOn(doc, "removeEventListener");
      connection.stop();
      expect(removedWin).toHaveBeenCalledWith("online", expect.any(Function));
      expect(removedDoc).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      vi.setSystemTime(Date.now() + 20_000);
      win.dispatchEvent(new Event("online"));
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets).toHaveLength(1);
      vi.useRealTimers(); vi.unstubAllGlobals();
    });
  });

  it("routes liveness and machine-socket frames to no handler", () => {
    const handlers = {
      onThreadList: vi.fn(), onChatStatus: vi.fn(), onFrame: vi.fn(), onSync: vi.fn(), onError: vi.fn(),
    } satisfies SocketHandlers;
    routeMessage({ type: "pong" }, handlers);
    routeMessage({ type: "machine_request", request_id: "r", op: "fs.read", payload: null }, handlers);
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
  });
});
