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
      onHistory: (chatId, events) => calls.push(`history:${chatId}:${events.length}`),
      onDisplaced: () => calls.push("displaced"),
      onAuthRequired: () => calls.push("auth"),
      onError: (message) => calls.push(`error:${message}`),
      onOrgEvent: () => calls.push("org"),
    };

    routeMessage({ type: "hello" }, handlers);
    routeMessage({ type: "thread_list", chats: [chat] }, handlers);
    routeMessage({ type: "chat_status", chat_id: "chat-1", generating: true }, handlers);
    routeMessage({ type: "sync_begin", chat_id: "chat-1" }, handlers);
    routeMessage({ type: "history", chat_id: "chat-1", events: [] }, handlers);
    routeMessage({ type: "snapshot_frame", chat_id: "chat-1", machine_id: null, event: delta }, handlers);
    routeMessage({ type: "sync_done", chat_id: "chat-1" }, handlers);
    routeMessage({ type: "live_frame", chat_id: "chat-1", machine_id: null, event: delta }, handlers);
    routeMessage({ type: "displaced" }, handlers);
    routeMessage({ type: "auth_required" }, handlers);

    expect(calls).toEqual([
      "threads:1",
      "status:chat-1:true",
      "sync:chat-1:begin",
      "history:chat-1:0",
      "frame:chat-1:delta",
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
});
