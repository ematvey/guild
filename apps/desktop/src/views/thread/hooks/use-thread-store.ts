// The open thread's view state: the visible-thread store (blocks, window,
// navigation), the live turn's local input, scroll geometry and the
// thread-tree node.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { fetchChatTree, type ChatTree } from "../../../lib/api/chats";
import { fetchThreadEventsPage, type ThreadState } from "../../../lib/thread-events";
import { traceEvent } from "../../../lib/telemetry";
import { EARLIER_PAGE_SIZE } from "../mentions";
import type { NavigationEvent } from "../navigation";
import { pendingAfterFrame } from "../status";
import { createThreadViewStore } from "../thread-view-store";

/** How long a first visit waits for the child tree after its state is in.
 *  A slow tree must not hold the old thread forever; the header fills in
 *  when the fetch settles. */
const TREE_WAIT_MS = 600;
/** A first visit that never receives its ThreadState falls back to the old
 *  view instead of holding navigation forever. */
const STATE_WAIT_MS = 5_000;

type ScrollMemory = { top: number; atBottom: boolean };

export function useThreadStore(chatId: string | null) {
  const [store] = useState(() => createThreadViewStore(chatId));
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  /** Scroll geometry captured before a prepend; the layout effect in the
   *  view restores the reader's position (the prepended blocks would
   *  otherwise push the view down by their height). */
  const earlierAnchor = useRef<{ height: number; top: number } | null>(null);
  // The context ring's revision: the displayed chat's newest applied seq.
  const [contextRevision, setContextRevision] = useState<{ chatId: string; seq: number } | null>(null);
  // The child tree cache: one HTTP request per chat id, including failures
  // cached as null. A repeat visit reads the cache and never refetches.
  const childTreesRef = useRef(new Map<string, ChatTree | null>());
  const [childTrees, setChildTrees] = useState<Record<string, ChatTree | null>>({});
  const treeControllers = useRef(new Map<string, AbortController>());
  // Cancellation-in-progress, per chat: a stop click flags the chat the
  // moment it lands so the composer's Stop button and the feed's shimmer
  // acknowledge it immediately. The server's stop is cooperative — the
  // runner observes the flag inside journaled steps — so the authoritative
  // generating=false push trails the click by the epilogue's round trips;
  // pruneStopping lifts the flag when that push lands, requestStop on a
  // rejected/failed stop.
  const [stopping, setStopping] = useState<Record<string, true>>({});
  // The local half of the composer's turn state: the chat this client sent
  // to whose own frame has not arrived yet. It is the only stored input —
  // `busy` derives from it plus the server's `generating` (see `busyFrom`),
  // so no handler has to clear a flag it did not set.
  const [pendingSend, setPendingSendState] = useState<string | null>(null);
  // Synchronous mirror: frame handlers retire a pending send before React
  // re-renders.
  const pendingSendRef = useRef<string | null>(null);
  const setSendPending = (chatId: string | null, source: string): void => {
    if (pendingSendRef.current === chatId) return;
    traceEvent("busy.pending", { chat: chatId ?? "-", source, action: chatId === null ? "clear" : "set" });
    pendingSendRef.current = chatId;
    setPendingSendState(chatId);
  };
  /** The server spoke for this chat: its `generating` owns the turn now. */
  const retireSendPending = (chatId: string, source: string): void => {
    if (pendingAfterFrame(pendingSendRef.current, chatId) !== null) return;
    setSendPending(null, source);
  };

  // Sticky-scroll: while streaming, follow the generated text ONLY when the
  // pane is already at the bottom; scrolling up detaches into free scroll,
  // scrolling back to the last character re-attaches. The scroll handler
  // keeps `stick.current` truthful.
  const pane = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const loadSeq = useRef(0); // guards against stale chat switches landing last
  const openChatIdRef = useRef<string | null>(chatId);
  openChatIdRef.current = chatId;

  // Per-chat reading position: a revisit returns where the reader left,
  // and only a chat that was at the bottom pins to the bottom again.
  const scrollMemory = useRef(new Map<string, ScrollMemory>());
  const scrollRestoreRef = useRef<{ chatId: string | null; top: number; atBottom: boolean } | null>(null);
  const treeTimer = useRef<number | null>(null);
  const stateTimer = useRef<number | null>(null);
  const stateTimerTarget = useRef<string | null>(null);

  const clearTreeTimer = () => {
    if (treeTimer.current !== null) {
      window.clearTimeout(treeTimer.current);
      treeTimer.current = null;
    }
  };

  const clearStateTimer = () => {
    if (stateTimer.current !== null) {
      window.clearTimeout(stateTimer.current);
      stateTimer.current = null;
    }
    stateTimerTarget.current = null;
  };

  const saveScroll = (cid: string | null) => {
    const el = pane.current;
    if (!el || cid === null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    scrollMemory.current.set(cid, { top: el.scrollTop, atBottom: near });
  };

  const abortTreeFetch = (cid: string | null) => {
    if (!cid) return;
    const controller = treeControllers.current.get(cid);
    if (controller) {
      controller.abort();
      treeControllers.current.delete(cid);
    }
  };

  const startTreeFetch = (cid: string) => {
    if (childTreesRef.current.has(cid) || treeControllers.current.has(cid)) return;
    const controller = new AbortController();
    treeControllers.current.set(cid, controller);
    const settle = (tree: ChatTree | null) => {
      if (controller.signal.aborted) return;
      childTreesRef.current.set(cid, tree);
      setChildTrees((prev) => ({ ...prev, [cid]: tree }));
      dispatchNavRef.current({ type: "tree", chatId: cid, ok: tree !== null });
    };
    void fetchChatTree(cid, controller.signal)
      .then(settle)
      .catch(() => settle(null))
      .finally(() => {
        if (treeControllers.current.get(cid) === controller) treeControllers.current.delete(cid);
      });
  };

  /** Applies one navigation event to the store and runs its side effects:
   *  the tree fetch, the swap's scroll restore and the wait timers. */
  const dispatchNav = (event: NavigationEvent) => {
    const priorPending = store.navigation().pendingChatId;
    const decision = store.navigate(event);
    if (decision.abortTree) abortTreeFetch(priorPending);
    if (decision.fetchTree) startTreeFetch(decision.fetchTree);
    if (decision.swapTo !== undefined) {
      clearTreeTimer();
      clearStateTimer();
      const target = decision.swapTo;
      const memory = target === null ? undefined : scrollMemory.current.get(target);
      scrollRestoreRef.current = {
        chatId: target,
        top: memory?.top ?? 0,
        atBottom: memory?.atBottom ?? true,
      };
      return;
    }
    if (decision.state.pendingChatId !== null && !decision.state.stateReady) {
      const target = decision.state.pendingChatId;
      if (stateTimer.current === null || stateTimerTarget.current !== target) {
        clearStateTimer();
        stateTimerTarget.current = target;
        stateTimer.current = window.setTimeout(() => {
          stateTimer.current = null;
          stateTimerTarget.current = null;
          toast.error("Thread did not load");
          dispatchNavRef.current({ type: "cancel" });
        }, STATE_WAIT_MS);
      }
    } else {
      clearStateTimer();
    }
    if (
      decision.state.pendingChatId !== null &&
      decision.state.stateReady &&
      !decision.state.treeReady
    ) {
      if (treeTimer.current === null) {
        const target = decision.state.pendingChatId;
        treeTimer.current = window.setTimeout(() => {
          treeTimer.current = null;
          dispatchNavRef.current({ type: "tree-timeout", chatId: target });
        }, TREE_WAIT_MS);
      }
    } else {
      clearTreeTimer();
    }
  };
  const dispatchNavRef = useRef(dispatchNav);
  dispatchNavRef.current = dispatchNav;

  /** Drops the pending target when its sync fails. The displayed chat stays. */
  const cancelPending = useCallback((cid: string) => {
    if (store.navigation().pendingChatId === cid) dispatchNavRef.current({ type: "cancel" });
  }, [store]);

  /** A ThreadState reached the reducer: the pending target can swap once its
   *  tree is also in. */
  const onThreadStateApplied = useCallback((cid: string) => {
    store.markSynced(cid);
    dispatchNavRef.current({ type: "state", chatId: cid });
  }, [store]);

  const updateContextRevision = useCallback((cid: string, events: ThreadState["events"]) => {
    const seq = events[events.length - 1]?.seq ?? 0;
    setContextRevision(prev => prev?.chatId === cid && prev.seq >= seq ? prev : { chatId: cid, seq });
  }, []);

  /** Loads the page before the displayed view's oldest loaded event. */
  const earlierController = useRef<AbortController | null>(null);
  const loadEarlier = useCallback(async () => {
    const before = store.getSnapshot();
    const cid = before.displayedChatId;
    if (!cid || before.pendingChatId !== null || loadingEarlierRef.current || !before.hasMore) return;
    if (before.oldestSeq < 0) return;
    const el = pane.current;
    const anchor = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    const controller = new AbortController();
    earlierController.current = controller;
    try {
      const page = await fetchThreadEventsPage(cid, before.oldestSeq, EARLIER_PAGE_SIZE, controller.signal);
      const now = store.getSnapshot();
      if (cid !== now.displayedChatId || now.pendingChatId !== null || controller.signal.aborted) return;
      earlierAnchor.current = anchor;
      store.mutate((r) => r.prependEvents(cid, page.events, page.has_more));
    } catch {
      if (!controller.signal.aborted) toast.error("Could not load earlier messages");
    } finally {
      if (earlierController.current === controller) {
        earlierController.current = null;
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [store]);
  useEffect(() => () => {
    earlierController.current?.abort();
    clearTreeTimer();
    clearStateTimer();
    for (const controller of treeControllers.current.values()) controller.abort();
  }, []);

  /** Opens a chat: a cached (synced) view swaps at once, a first visit keeps
   *  the old view until its state and child tree are in. The route chat is
   *  always the reducer's current view, so the socket buffers its state
   *  while the old view stays visible. */
  const openForChat = (cid: string | null) => {
    loadSeq.current++;
    const nav = store.navigation();
    if (cid === nav.displayedChatId && nav.pendingChatId === null) return;
    // Navigation never touches the turn state: `busy` derives from the open
    // chat id, so the target's own frame decides and the old chat's turn
    // cannot leak into it.
    saveScroll(nav.displayedChatId);
    const opened = store.mutate((r) => r.open(cid));
    dispatchNavRef.current({
      type: "open",
      chatId: cid,
      cached: opened.synced,
      treeKnown: cid !== null && childTreesRef.current.has(cid),
    });
  };

  const displayedChatId = view.displayedChatId;
  const childTree = displayedChatId !== null ? childTrees[displayedChatId] ?? null : null;
  const childTreeFailed =
    displayedChatId !== null &&
    Object.prototype.hasOwnProperty.call(childTrees, displayedChatId) &&
    childTrees[displayedChatId] === null;

  return {
    store,
    view,
    childTreeFailed,
    loadingEarlier,
    earlierAnchor,
    contextRevision,
    updateContextRevision,
    onThreadStateApplied,
    childTree,
    stopping,
    setStopping,
    pendingSend,
    pendingSendRef,
    setSendPending,
    retireSendPending,
    pane,
    stick,
    atBottom,
    setAtBottom,
    loadSeq,
    openChatIdRef,
    scrollRestoreRef,
    loadEarlier,
    openForChat,
    cancelPending,
  };
}
