// The open thread's view state: the block list advanced by the reducer, the
// live turn flags, scroll geometry and the thread-tree node.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchChatTree, type ChatTree } from "../../../lib/api/chats";
import { fetchThreadEventsPage, type ThreadState } from "../../../lib/thread-events";
import { createThreadReducer, type RenderBlock, type ThreadReducer } from "../../../lib/thread-reducer";
import { EARLIER_PAGE_SIZE } from "../mentions";
import {
  initialNavigation,
  transitionNavigation,
  type NavigationEvent,
  type NavigationState,
} from "../navigation";

/** How long a first visit waits for the child tree after its state is in.
 *  A slow tree must not hold the old thread forever; the header fills in
 *  when the fetch settles. */
const TREE_WAIT_MS = 600;
/** A first visit that never receives its ThreadState falls back to the old
 *  view instead of holding navigation forever. */
const STATE_WAIT_MS = 5_000;

type ScrollMemory = { top: number; atBottom: boolean };

export function useThreadStore(chatId: string | null) {
  const [blocks, setBlocks] = useState<RenderBlock[]>([]);
  const [threadLoading, setThreadLoading] = useState(() => chatId !== null); // cold deep link: skeleton with nothing to show
  const [displayedChatId, setDisplayedChatId] = useState<string | null>(null);
  const [displayedSynced, setDisplayedSynced] = useState(false);
  const displayedSyncedRef = useRef(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  // Manual /compact in flight: the optimistic "Compacting thread…" line at
  // the end of the feed until the durable compaction event lands (or the
  // busy flag clears — a failed compaction appends nothing to the log).
  const [compacting, setCompacting] = useState(false);
  // Older-page loader: the server sends a bounded tail of the durable log in
  // each ThreadState frame, and scrolling to the top prepends the page
  // before the loaded window.
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const hasMoreRef = useRef(false);
  const loadingEarlierRef = useRef(false);
  const oldestSeqRef = useRef(-1);
  /** Scroll geometry captured before a prepend; the layout effect below
   *  restores the reader's position (the prepended blocks would otherwise
   *  push the view down by their height). */
  const earlierAnchor = useRef<{ height: number; top: number } | null>(null);
  // The thread reducer: per-chat views (blocks + watermark + pending send +
  // compaction keys) advanced incrementally by the transitions below.
  const reducerRef = useRef<ThreadReducer>(createThreadReducer());
  // The open chat's server-side generating flag — the same truth the sidebar
  // spinner shows (live chat-status frames, optimistic send, then the fetched
  // list). The local stream state is per-view and is lost on a thread switch;
  // this keeps the window's in-progress state alive across switches.
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
  // pruneStopping lifts the flag when that push (or the list push) lands,
  // requestStop on a rejected/failed stop.
  const [stopping, setStopping] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  // Synchronous mirror of `busy`: frame handlers read it before React
  // re-renders, and a list push must not clear a child thread's live turn.
  const busyRef = useRef(false);
  const markBusy = (value: boolean): void => {
    busyRef.current = value;
    setBusy(value);
  };
  // A "normal" send's HTTP round trip is in flight: onThreadList consults
  // this and keeps the optimistic busy instead of lowering it from a list
  // push that predates the server's generating flag.
  const sendingRef = useRef(false);
  // Latest busy/threadLoading values for stable-ref consumers (the
  // deploy-freshness poll must not read stale closure state).
  const loadStateRef = useRef({ busy: false, threadLoading: false });
  loadStateRef.current = { busy, threadLoading };

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
  const navRef = useRef<NavigationState>(initialNavigation());
  const displayedRef = useRef<string | null>(null);
  const pendingRef = useRef<string | null>(null);
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

  const finishSwap = (target: string | null, clearBusy = true) => {
    clearStateTimer();
    // The target's ThreadState and status own the live turn. A cached swap
    // happens before its first state, so the old chat's busy must not leak.
    if (clearBusy) markBusy(false);
    const opened = reducerRef.current.open(target);
    setBlocks(opened.blocks);
    hasMoreRef.current = opened.hasMore;
    oldestSeqRef.current = opened.oldestSeq;
    setHasMore(opened.hasMore);
    displayedRef.current = target;
    setDisplayedChatId(target);
    displayedSyncedRef.current = opened.synced;
    setDisplayedSynced(opened.synced);
    pendingRef.current = null;
    setPendingChatId(null);
    setNavigating(false);
    setThreadLoading(false);
    const memory = target === null ? undefined : scrollMemory.current.get(target);
    scrollRestoreRef.current = {
      chatId: target,
      top: memory?.top ?? 0,
      atBottom: memory?.atBottom ?? true,
    };
  };

  const dispatchNav = (event: NavigationEvent) => {
    const decision = transitionNavigation(navRef.current, event);
    navRef.current = decision.state;
    if (decision.abortTree) abortTreeFetch(pendingRef.current);
    if (decision.fetchTree) startTreeFetch(decision.fetchTree);
    if (decision.swapTo !== undefined) {
      clearTreeTimer();
      clearStateTimer();
      finishSwap(decision.swapTo, decision.clearBusy === true);
      return;
    }
    if (decision.state.pendingChatId !== pendingRef.current) {
      pendingRef.current = decision.state.pendingChatId;
      setPendingChatId(decision.state.pendingChatId);
    }
    if (decision.state.pendingChatId !== null) {
      setNavigating(true);
      // Only a cold deep link has no visible thread to keep: it shows the
      // skeleton. A pending swap never raises the skeleton over the old one.
      setThreadLoading(decision.state.phase === "cold");
    } else {
      setNavigating(false);
      setThreadLoading(false);
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
    if (pendingRef.current === cid) dispatchNavRef.current({ type: "cancel" });
  }, []);

  /** A ThreadState reached the reducer: the pending target can swap once its
   *  tree is also in. */
  const onThreadStateApplied = useCallback((cid: string) => {
    if (cid === displayedRef.current) {
      displayedSyncedRef.current = true;
      setDisplayedSynced(true);
    }
    dispatchNavRef.current({ type: "state", chatId: cid });
  }, []);

  const updateContextRevision = (cid: string, events: ThreadState["events"]) => {
    const seq = events[events.length - 1]?.seq ?? 0;
    setContextRevision(prev => prev?.chatId === cid && prev.seq >= seq ? prev : { chatId: cid, seq });
  };

  /** Loads the page before the view's oldest loaded event. */
  const earlierController = useRef<AbortController | null>(null);
  const loadEarlier = useCallback(async () => {
    const cid = displayedRef.current;
    if (!cid || pendingRef.current !== null || loadingEarlierRef.current || !hasMoreRef.current) return;
    const before = oldestSeqRef.current;
    if (before < 0) return;
    const el = pane.current;
    const anchor = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    const controller = new AbortController();
    earlierController.current = controller;
    try {
      const page = await fetchThreadEventsPage(cid, before, EARLIER_PAGE_SIZE, controller.signal);
      if (cid !== displayedRef.current || pendingRef.current !== null || controller.signal.aborted) return;
      earlierAnchor.current = anchor;
      const applied = reducerRef.current.prependEvents(cid, page.events, page.has_more);
      if (cid !== displayedRef.current) return;
      hasMoreRef.current = applied.hasMore;
      oldestSeqRef.current = applied.oldestSeq;
      setHasMore(applied.hasMore);
      setBlocks(applied.blocks);
    } catch {
      if (!controller.signal.aborted) toast.error("Could not load earlier messages");
    } finally {
      if (earlierController.current === controller) {
        earlierController.current = null;
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }, []);
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
  const openForChat = (cid: string | null, skipBusyReset = false) => {
    loadSeq.current++;
    if (cid === displayedRef.current && pendingRef.current === null) return;
    // Navigation must not clear a live turn (A7): the target's ThreadState
    // or status push owns that flag. The scratch surface has no target, so
    // it clears its own optimistic state.
    if (cid === null && !skipBusyReset) markBusy(false);
    saveScroll(displayedRef.current);
    const opened = reducerRef.current.open(cid);
    dispatchNavRef.current({
      type: "open",
      chatId: cid,
      cached: opened.synced,
      treeKnown: cid !== null && childTreesRef.current.has(cid),
    });
  };

  const childTree = displayedChatId !== null ? childTrees[displayedChatId] ?? null : null;
  const childTreeFailed =
    displayedChatId !== null &&
    Object.prototype.hasOwnProperty.call(childTrees, displayedChatId) &&
    childTrees[displayedChatId] === null;

  return {
    blocks,
    setBlocks,
    threadLoading,
    setThreadLoading,
    displayedChatId,
    displayedSynced,
    displayedSyncedRef,
    childTreeFailed,
    pendingChatId,
    navigating,
    compacting,
    setCompacting,
    hasMore,
    setHasMore,
    hasMoreRef,
    loadingEarlier,
    loadingEarlierRef,
    oldestSeqRef,
    earlierAnchor,
    reducerRef,
    contextRevision,
    updateContextRevision,
    onThreadStateApplied,
    childTree,
    stopping,
    setStopping,
    busy,
    busyRef,
    markBusy,
    sendingRef,
    loadStateRef,
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
