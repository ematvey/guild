import { describe, expect, it, vi } from "vitest";
import { routeMessage, startSocket, type SocketHandlers, type SocketLike } from "../transport";

const chat = { id: "chat-1", title: "Chat", created_at: "now" };
const delta = { type: "delta" as const, content: "hello" };

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
    };

    routeMessage({ type: "hello" }, handlers);
    routeMessage({ type: "thread_list", chats: [chat] }, handlers);
    routeMessage({ type: "chat_status", chat_id: "chat-1", generating: true }, handlers);
    routeMessage({ type: "sync_begin", chat_id: "chat-1" }, handlers);
    routeMessage({ type: "thread_state", chat_id: "chat-1", seq: 1, events: [], text: "hello", thinking: "", generating: true, has_more_events: false }, handlers);
    routeMessage({ type: "sync_done", chat_id: "chat-1" }, handlers);
    routeMessage({ type: "live_frame", chat_id: "chat-1", generation_id: "generation-1", seq: 2, machine_id: undefined, event: delta }, handlers);
    routeMessage({ type: "displaced" }, handlers);
    routeMessage({ type: "auth_required" }, handlers);

    expect(calls).toEqual([
      "threads:1",
      "status:chat-1:true",
      "sync:chat-1:begin",
      "state:chat-1:1",
      "sync:chat-1:done",
      "frame:chat-1:delta",
      "displaced",
      "auth",
    ]);

    routeMessage({ type: "error", message: "bad" }, handlers);
    routeMessage({ type: "org_event", event: {} }, handlers);
    expect(calls.slice(-2)).toEqual(["error:bad", "org"]);
  });
});

describe("startSocket", () => {
  it.each(["reject", "http"])("recovers from a %s ticket failure", async (failure) => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "client-1" });
    const fetchMock = vi.fn(async () => {
      if (failure === "reject") throw new Error("offline");
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
    await vi.advanceTimersByTimeAsync(3000);
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
    await vi.advanceTimersByTimeAsync(3000);
    sockets[1].open();
    deliver(sockets[1], { type: "sync_begin", chat_id: "chat" });
    deliver(sockets[1], { ...state, seq: 10 });
    deliver(sockets[1], { type: "sync_done", chat_id: "chat" });
    expect(depths.get("chat")).toBe(0);
    expect(accepted).toEqual([9, 10]);
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
    await vi.advanceTimersByTimeAsync(3000);
    sockets[1].open();
    expect(paths).toEqual(transientFailure
      ? ["/api/v1/ws/ticket", "/api/v1/auth/refresh", "/api/v1/auth/refresh", "/api/v1/ws/ticket"]
      : ["/api/v1/ws/ticket", "/api/v1/auth/refresh", "/api/v1/ws/ticket"]);
    expect(connected).toHaveBeenCalledTimes(2);
    expect(signedOut).not.toHaveBeenCalled();
    connection.stop();
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("sends the current sync on open and reconnects after three seconds", async () => {
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
    await vi.advanceTimersByTimeAsync(2999);
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
});
