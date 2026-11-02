// @vitest-environment happy-dom
// The member socket driven end to end through the hooks the thread view
// composes: a fake WebSocket feeds frames into useMemberSocket, which moves
// the thread store and the chat status; the derived `busy` and the visible
// snapshot are what the view would render.
import { useEffect, useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutgoingCommand } from "../../../lib/outgoing-command";
import type { ThreadEventRow } from "../../../lib/thread-events";
import { busyFrom } from "../status";
import { useChatData } from "./use-chat-data";
import { resetChatStores } from "../chat-stores";
import { useMemberSocket } from "./use-member-socket";
import { useThreadStore } from "./use-thread-store";
import { contextUsageOf } from "../../../lib/context-usage-store";

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const CHAT = "chat-1";

function echo(seq: number, content: string, id = `e${seq}`): ThreadEventRow {
  return { id, chat_id: CHAT, seq, event: { type: "user_message", content, attachments: [] }, created_at: "t" };
}

function threadState(seq: number, events: ThreadEventRow[], generating: boolean) {
  return {
    type: "thread_state",
    chat_id: CHAT,
    seq,
    events,
    text: "",
    thinking: "",
    generating,
    has_more_events: false,
  };
}

/** The slice of the thread view this test drives: data, store, socket. */
function useHarness() {
  const data = useChatData();
  const thread = useThreadStore(CHAT);
  const outgoingRef = useRef(new Map<string, OutgoingCommand>());
  const observedUserIdsRef = useRef(new Set<string>());
  const recoverMissingChatRef = useRef<() => void>(() => {});
  useMemberSocket({
    signOut: () => {},
    thread,
    outgoing: { outgoingRef, observedUserIdsRef, settleOutgoing: () => {} },
    recoverMissingChatRef,
  });
  useEffect(() => {
    thread.openForChat(CHAT);
    // One open for the mounted route chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const viewChatId = thread.view.displayedChatId ?? CHAT;
  const busy = busyFrom(!!data.chatStatus[viewChatId]?.generating, thread.pendingSend, viewChatId);
  return { data, thread, busy };
}

describe("member socket → thread store (integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.all = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/ws/ticket")
          ? { ok: true, status: 200, json: async () => ({ ticket: "t" }) }
          : { ok: false, status: 404, json: async () => ({}) },
      ),
    );
  });
  afterEach(() => {
    resetChatStores();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a pending send holds busy until its own state, and a reconnect resyncs without a skeleton", async () => {
    const { result, unmount } = renderHook(() => useHarness());
    expect(result.current.thread.view.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = FakeWebSocket.all[0]!;
    act(() => first.open());
    expect(JSON.parse(first.sent[0]!)).toEqual({ type: "sync", chat_id: CHAT });

    // The cold open: the sync's tree facts plus its state swap it in.
    await act(async () => {
      first.deliver({ type: "sync_begin", chat_id: CHAT });
      first.deliver({
        type: "chat_tree",
        chat_id: CHAT,
        tree: {
          chat_id: CHAT,
          type: "user",
          title: "Hi",
          agent_id: null,
          agent_name: null,
          status: null,
          depth: 0,
          parent: null,
          origin: null,
          archived: false,
          deleted: false,
        },
      });
      first.deliver(threadState(1, [echo(1, "hi")], false));
      first.deliver({ type: "sync_done", chat_id: CHAT });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.thread.view).toMatchObject({ displayedChatId: CHAT, loading: false, synced: true });
    expect(result.current.thread.view.blocks.map((b) => b.text)).toEqual(["hi"]);
    expect(result.current.busy).toBe(false);

    // The composer sends: the optimistic block and the pending send.
    act(() => {
      result.current.thread.store.mutate((r) =>
        r.optimisticSend({ chatId: CHAT, text: "go", key: "cmd-1", sentAt: 1 }),
      );
      result.current.thread.setSendPending(CHAT, "optimistic_send", "cmd-1");
    });
    expect(result.current.busy).toBe(true);

    // A state that predates the server's accept (idle, no echo of the sent
    // message) says nothing about this send: busy holds, no flicker.
    act(() => first.deliver(threadState(2, [echo(1, "hi")], false)));
    expect(result.current.thread.pendingSend).toBe(CHAT);
    expect(result.current.busy).toBe(true);

    // An unsequenced chat_status for the open chat neither retires the
    // pending send nor moves its flag; one for another chat moves that chat.
    act(() => {
      first.deliver({ type: "chat_status", chat_id: CHAT, generating: false });
      first.deliver({ type: "chat_status", chat_id: "chat-2", generating: true });
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.thread.pendingSend).toBe(CHAT);
    expect(result.current.data.chatStatus["chat-2"]?.generating).toBe(true);
    act(() => first.deliver({ type: "chat_status", chat_id: "chat-2", generating: false }));
    expect(result.current.data.chatStatus["chat-2"]).toMatchObject({ generating: false, unread: true });

    // The turn's own state retires the pending send; generating holds busy.
    act(() => first.deliver(threadState(3, [echo(1, "hi"), echo(2, "go", "cmd-1")], true)));
    expect(result.current.thread.pendingSend).toBeNull();
    expect(result.current.busy).toBe(true);
    expect(result.current.thread.view.blocks.filter((b) => b.pending)).toEqual([]);

    // The link drops mid-turn; the reconnect's sync re-derives the view and
    // the screen keeps its content (no skeleton) while it runs.
    act(() => first.close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const second = FakeWebSocket.all[1]!;
    expect(FakeWebSocket.all).toHaveLength(2);
    act(() => {
      second.open();
      second.deliver({ type: "sync_begin", chat_id: CHAT });
    });
    expect(result.current.thread.view).toMatchObject({ loading: false, synced: true });
    act(() => {
      second.deliver(threadState(4, [echo(1, "hi"), echo(2, "go", "cmd-1")], false));
      second.deliver({ type: "sync_done", chat_id: CHAT });
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.thread.view.blocks.map((b) => b.text)).toEqual(["hi", "go"]);

    unmount();
    expect(second.readyState).toBe(3);
  });

  it("declares chat_row, applies one changed row in place, and stores pushed context usage", async () => {
    const { result, unmount } = renderHook(() => useHarness());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const socket = FakeWebSocket.all[0]!;
    expect(socket.url).toContain("features=chat_row");
    act(() => socket.open());
    const row = (id: string, title: string, unread: boolean) => ({
      id,
      org_id: "o",
      user_id: "u",
      title,
      created_at: "2026-11-01T00:00:00Z",
      generating: false,
      unread,
      working: false,
      blocked: false,
      last_activity_at: "2026-11-01T00:00:00Z",
      machine_online: false,
      type: "user",
      archived: false,
      deleted: false,
    });
    act(() =>
      socket.deliver({ type: "thread_list", chats: [row("chat-2", "Two", false), row("chat-3", "Three", false)] }),
    );
    act(() => socket.deliver({ type: "chat_row", chat: row("chat-3", "Renamed", true) }));
    expect(result.current.data.chats?.map((c) => [c.id, c.title])).toEqual([
      ["chat-2", "Two"],
      ["chat-3", "Renamed"],
    ]);
    expect(result.current.data.chatStatus["chat-3"]).toMatchObject({ unread: true, generating: false });

    act(() =>
      socket.deliver({
        type: "context_usage",
        chat_id: CHAT,
        tokens: 1200,
        usage_model: "m",
        usage_model_alias: "Model",
      }),
    );
    expect(contextUsageOf(CHAT)).toEqual({ tokens: 1200, usage_model: "m", usage_model_alias: "Model" });
    unmount();
  });
});
