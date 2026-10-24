// The open thread's view state: the block list advanced by the reducer, the
// live turn flags, scroll geometry and the thread-tree node.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchChatTree, type ChatSubagentNode, type ChatTree } from "../../../lib/api/chats";
import { fetchThreadEventsPage, type ThreadState } from "../../../lib/thread-events";
import { createThreadReducer, type Block, type ThreadReducer } from "../../../lib/thread-reducer";
import { EARLIER_PAGE_SIZE } from "../mentions";

export function useThreadStore(chatId: string | null) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [threadLoading, setThreadLoading] = useState(() => chatId !== null); // /thread/<id> fetch in flight with nothing to show
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
  // The open chat's thread subtree, pushed whole on every change (sync
  // bracket and the guild_subagent_tree NOTIFY). No poll: the tree is live
  // display state.
  const [subagentNodes, setSubagentNodes] = useState<ChatSubagentNode[]>([]);
  // The open chat's thread-tree node: a child header renders from its parent.
  // The node keeps the chat it describes, so a switch never applies the
  // previous chat's parent and a sync refresh never blanks the header.
  const [childTreeNode, setChildTreeNode] = useState<{ chatId: string; tree: ChatTree | null } | null>(null);
  const childTree = childTreeNode !== null && childTreeNode.chatId === chatId ? childTreeNode.tree : null;
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
  // scrolling back to the last character re-attaches . The scroll handler keeps `stick.current` truthful.
  const pane = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const loadSeq = useRef(0); // guards against stale chat switches landing last
  const openChatIdRef = useRef<string | null>(chatId);
  openChatIdRef.current = chatId;

  const updateContextRevision = (cid: string, events: ThreadState["events"]) => {
    const seq = events[events.length - 1]?.seq ?? 0;
    setContextRevision(prev => prev?.chatId === cid && prev.seq >= seq ? prev : { chatId: cid, seq });
  };

  /** Loads the page before the view's oldest loaded event. */
  const earlierController = useRef<AbortController | null>(null);
  const loadEarlier = useCallback(async () => {
    const cid = openChatIdRef.current;
    if (!cid || loadingEarlierRef.current || !hasMoreRef.current) return;
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
      if (cid !== openChatIdRef.current || controller.signal.aborted) return;
      earlierAnchor.current = anchor;
      const applied = reducerRef.current.prependEvents(cid, page.events, page.has_more);
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
  useEffect(() => () => earlierController.current?.abort(), []);

  // The tree node rides with the thread load: one request per chat id. The
  // parent title and depth do not change, and refetching on every event let
  // a busy child abort each request before it settled, so the header stayed
  // on the generic "Subagent thread" label for the whole run.
  useEffect(() => {
    if (!chatId) return;
    let live = true;
    const controller = new AbortController();
    void fetchChatTree(chatId, controller.signal)
      .then((tree) => {
        if (live) setChildTreeNode({ chatId, tree });
      })
      .catch(() => {
        if (live) setChildTreeNode({ chatId, tree: null });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [chatId]);

  /** Opens a chat in the reducer's per-chat cache: a switch-back renders its
   *  last content immediately, so switching never flashes a skeleton over
   *  known blocks. A just-created chat lands here too: its view is empty, so
   *  the skeleton holds until the first thread state arrives. */
  const openForChat = (cid: string | null, skipBusyReset = false) => {
    loadSeq.current++;
    setSubagentNodes([]);
    if (!skipBusyReset) markBusy(false);
    stick.current = true;
    setAtBottom(true);
    if (!cid) {
      const opened = reducerRef.current.open(null);
      setBlocks(opened.blocks);
      hasMoreRef.current = false;
      oldestSeqRef.current = -1;
      setHasMore(false);
      setThreadLoading(false);
      return;
    }
    const opened = reducerRef.current.open(cid);
    setThreadLoading(!opened.restored);
    setBlocks(opened.blocks);
    hasMoreRef.current = opened.hasMore;
    oldestSeqRef.current = opened.oldestSeq;
    setHasMore(opened.hasMore);
  };

  return {
    blocks,
    setBlocks,
    threadLoading,
    setThreadLoading,
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
    subagentNodes,
    setSubagentNodes,
    childTreeNode,
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
    loadEarlier,
    openForChat,
  };
}
