// Sequence tests for the visible-thread store: every reader field derives
// from one snapshot of the displayed chat, whatever order the writers run in.
import { describe, expect, it } from "vitest";
import type { ThreadEvent, ThreadEventRow, ThreadState } from "../../lib/thread-events";
import { createThreadViewStore, type ThreadViewStore } from "./thread-view-store";

function row(chatId: string, seq: number, event: ThreadEvent): ThreadEventRow {
  return { id: `${chatId}-e${seq}`, chat_id: chatId, seq, event, created_at: "t" };
}

function state(chatId: string, seq: number, events: ThreadEventRow[], hasMore = false): ThreadState {
  return {
    type: "thread_state", has_more_events: hasMore, chat_id: chatId, seq, events,
    text: "", thinking: "", generating: false,
  };
}

const say = (chatId: string, seq: number, content: string) =>
  row(chatId, seq, { type: "user_message", content, attachments: [] });

/** Opens a chat the way the view does: reducer first, then the navigation. */
function open(store: ThreadViewStore, chatId: string | null, treeKnown = true) {
  const opened = store.mutate((r) => r.open(chatId));
  return store.navigate({ type: "open", chatId, cached: opened.synced, treeKnown });
}

/** A ThreadState arriving over the socket for a chat. */
function deliver(store: ThreadViewStore, s: ThreadState) {
  store.mutate((r) => r.applyState(s));
  store.markSynced(s.chat_id);
  store.navigate({ type: "state", chatId: s.chat_id });
}

describe("thread view store", () => {
  it("a cold deep link shows the skeleton until its state swaps in", () => {
    const store = createThreadViewStore("a");
    expect(store.getSnapshot().loading).toBe(true);
    open(store, "a", false);
    expect(store.getSnapshot()).toMatchObject({ loading: true, navigating: true, displayedChatId: null });
    deliver(store, state("a", 1, [say("a", 1, "hi")]));
    // The tree is still on its way: the skeleton holds.
    expect(store.getSnapshot().loading).toBe(true);
    store.navigate({ type: "tree", chatId: "a" });
    const shown = store.getSnapshot();
    expect(shown).toMatchObject({ loading: false, navigating: false, displayedChatId: "a", synced: true });
    expect(shown.blocks.map((b) => b.text)).toEqual(["hi"]);
  });

  it("the compacting line belongs to its chat and never leaks onto another", () => {
    const store = createThreadViewStore(null);
    open(store, "a");
    deliver(store, state("a", 1, [say("a", 1, "hi")]));
    store.mutate((r) => r.setCompacting("a"));
    expect(store.getSnapshot().compacting).toBe(true);
    // A cached chat swaps at once; its screen has no compaction in flight.
    open(store, "b");
    deliver(store, state("b", 1, []));
    expect(store.getSnapshot()).toMatchObject({ displayedChatId: "b", compacting: false });
    open(store, "a");
    expect(store.getSnapshot()).toMatchObject({ displayedChatId: "a", compacting: true });
    // The durable compaction event settles it.
    deliver(store, state("a", 2, [row("a", 2, { type: "compaction", summary: "so far" })]));
    expect(store.getSnapshot().compacting).toBe(false);
  });

  it("the older-page cursor follows the displayed chat, not the pending one", () => {
    const store = createThreadViewStore(null);
    open(store, "a");
    deliver(store, state("a", 5, [say("a", 5, "tail")], true));
    expect(store.getSnapshot()).toMatchObject({ hasMore: true, oldestSeq: 5 });
    // A first visit to b keeps a on screen; b's window does not leak in.
    open(store, "b", false);
    store.mutate((r) => r.applyState(state("b", 9, [say("b", 9, "other")], false)));
    expect(store.getSnapshot()).toMatchObject({ displayedChatId: "a", hasMore: true, oldestSeq: 5 });
    store.mutate((r) => r.prependEvents("a", [say("a", 3, "older")], false));
    expect(store.getSnapshot()).toMatchObject({ hasMore: false, oldestSeq: 3 });
  });

  it("a reconnect keeps the displayed view synced while its resync runs", () => {
    const store = createThreadViewStore(null);
    open(store, "a");
    deliver(store, state("a", 1, [say("a", 1, "hi")]));
    store.mutate((r) => r.invalidate());
    expect(store.getSnapshot()).toMatchObject({ synced: true, loading: false });
    expect(store.getSnapshot().blocks.map((b) => b.text)).toEqual(["hi"]);
  });

  it("a first send's created chat shows its message from the scratch screen on", () => {
    const store = createThreadViewStore(null);
    open(store, null);
    store.mutate((r) => r.optimisticSend({ chatId: "new", text: "hello", key: "k1", sentAt: 1 }));
    store.seed("new");
    expect(store.getSnapshot().blocks.map((b) => b.text)).toEqual(["hello"]);
    open(store, "new", false);
    expect(store.getSnapshot()).toMatchObject({ loading: true, displayedChatId: null });
    expect(store.getSnapshot().blocks.map((b) => b.text)).toEqual(["hello"]);
    deliver(store, state("new", 1, [{ ...say("new", 1, "hello"), id: "k1" }]));
    store.navigate({ type: "tree", chatId: "new" });
    expect(store.getSnapshot()).toMatchObject({ displayedChatId: "new", loading: false });
    expect(store.getSnapshot().blocks.map((b) => b.text)).toEqual(["hello"]);
  });

  it("a cancelled cold load lowers the skeleton", () => {
    const store = createThreadViewStore("a");
    open(store, "a", false);
    store.navigate({ type: "cancel" });
    expect(store.getSnapshot()).toMatchObject({ loading: false, navigating: false });
  });

  it("a change to another chat's view does not republish the snapshot", () => {
    const store = createThreadViewStore(null);
    open(store, "a");
    deliver(store, state("a", 1, [say("a", 1, "hi")]));
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    const before = store.getSnapshot();
    store.mutate((r) => r.applyState(state("z", 1, [say("z", 1, "elsewhere")])));
    expect(calls).toBe(0);
    expect(store.getSnapshot()).toBe(before);
  });
});
