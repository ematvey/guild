// The member socket: one connection per view that owns thread
// reconciliation in both browser and Tauri webview mode. The Tauri app
// process keeps the separate machine socket.
import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { machineId, watchMachinePresence } from "../../../lib/machine-rpc";
import { setMachineIdentity } from "../../../lib/api/folders";
import { startSocket } from "../../../lib/socket-client";
import type { ChatSummary, ChatSubagentNode } from "../../../lib/api/chats";
import type { ThreadState } from "../../../lib/thread-events";
import type { Block, ThreadReducer } from "../../../lib/thread-reducer";
import type { OutgoingCommand } from "../../../lib/outgoing-command";
import { busyAfterThreadPush, statusFromThreads } from "../status";
import type { ChatStatus } from "./use-chat-data";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface MemberSocketDeps {
  signOut: () => void;
  chatsRef: RefObject<ChatSummary[] | null>;
  setChats: (update: ChatSummary[] | ((prev: ChatSummary[] | null) => ChatSummary[] | null)) => void;
  setChatStatus: (update: (prev: ChatStatus) => ChatStatus) => void;
  refreshChats: () => Promise<void>;
  reducerRef: RefObject<ThreadReducer>;
  setBlocks: (blocks: Block[]) => void;
  markBusy: (v: boolean) => void;
  busyRef: RefObject<boolean>;
  sendingRef: RefObject<boolean>;
  openChatIdRef: RefObject<string | null>;
  displayedChatIdRef: RefObject<string | null>;
  onThreadStateApplied: (cid: string) => void;
  updateContextRevision: (cid: string, events: ThreadState["events"]) => void;
  hasMoreRef: RefObject<boolean>;
  oldestSeqRef: RefObject<number>;
  setHasMore: (v: boolean) => void;
  setThreadLoading: (v: boolean) => void;
  setCompacting: (v: boolean) => void;
  setSubagentTree: (chatId: string, nodes: ChatSubagentNode[]) => void;
  outgoingRef: RefObject<Map<string, OutgoingCommand>>;
  observedUserIdsRef: RefObject<Set<string>>;
  settleOutgoing: (command: OutgoingCommand) => void;
  recoverMissingChatRef: RefObject<() => void>;
}

export function useMemberSocket(deps: MemberSocketDeps) {
  const {
    signOut, chatsRef, setChats, setChatStatus, refreshChats, reducerRef, setBlocks, markBusy,
    busyRef, sendingRef, openChatIdRef, displayedChatIdRef, onThreadStateApplied,
    updateContextRevision, hasMoreRef, oldestSeqRef,
    setHasMore, setThreadLoading, setCompacting, setSubagentTree, outgoingRef,
    observedUserIdsRef, settleOutgoing, recoverMissingChatRef,
  } = deps;
  const [machineTakenOver, setMachineTakenOver] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void watchMachinePresence(presence => {
      if (disposed) return;
      setMachineTakenOver(!!presence.displaced);
      if (presence.auth_required) signOut();
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, []);

  const socketRef = useRef<ReturnType<typeof startSocket> | null>(null);
  const syncingChatsRef = useRef(new Map<string, number>());
  // The newest event id whose read-marker POST already fired per chat:
  // thread_state frames arrive per streamed delta batch, and marking read
  // per frame spammed /read hundreds of times over one active turn — the
  // marker only needs to move when the view carries events it hasn't
  // covered yet.
  const lastReadMarkRef = useRef(new Map<string, string>());

  const applyHistory = (state: ThreadState) => {
    const cid = state.chat_id;
    // The reducer owns the watermark and the view: a sequenced state applies
    // only its new events (a stale one changes nothing anywhere).
    const applied = reducerRef.current.applyState(state);
    if (applied.stale) return;
    onThreadStateApplied(cid);
    for (const row of state.events) {
      if (row.event.type === "user_message") observedUserIdsRef.current.add(row.id);
      const command = outgoingRef.current.get(row.id);
      if (row.event.type === "user_message" && command && command.chatId === cid) settleOutgoing(command);
    }
    setChatStatus(prev => ({ ...prev, [cid]: {
      generating: state.generating,
      working: state.generating || (prev[cid]?.working ?? false),
      unread: cid === openChatIdRef.current ? false :
        (!state.generating && prev[cid]?.generating ? true : (prev[cid]?.unread ?? false)),
    } }));
    // ThreadState carries the chat's project fields: a live re-bind from
    // another device updates this client's row, so the chip and the sidebar
    // agree without a reload. It also carries the log through its last row:
    // that row's stamp is the chat's recent-activity sort key (the sidebar
    // fold-outs re-sort on it).
    const activity = state.events[state.events.length - 1]?.created_at;
    setChats(prev =>
      prev?.map(c =>
        c.id === cid
          ? {
              ...c,
              project_id: state.project_id,
              project_name: state.project_name,
              project_machine_label: state.project_machine_label,
              ...(activity !== undefined ? { last_activity_at: activity } : {}),
            }
          : c,
      ) ?? prev,
    );
    if (!chatsRef.current?.some(chat => chat.id === cid)) void refreshChats();
    if (cid !== openChatIdRef.current) return;
    // The route chat's live turn is the target's status even while the old
    // thread is still displayed (the composer is disabled during the swap).
    markBusy(state.generating);
    // A pending target's state stays in the reducer until the display swap;
    // the visible thread must not receive another chat's blocks.
    if (cid !== displayedChatIdRef.current) return;
    updateContextRevision(cid, state.events);
    setBlocks(applied.blocks);
    hasMoreRef.current = applied.hasMore;
    oldestSeqRef.current = applied.oldestSeq;
    setHasMore(applied.hasMore);
    setCompacting(applied.compacting);
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      const lastEventId = state.events[state.events.length - 1]?.id;
      if (lastEventId !== undefined && lastReadMarkRef.current.get(cid) !== lastEventId) {
        lastReadMarkRef.current.set(cid, lastEventId);
        socketRef.current?.markRead(cid);
        setChatStatus((prev) =>
          prev[cid]?.unread ? { ...prev, [cid]: { ...prev[cid], unread: false } } : prev,
        );
        setChats((prev) =>
          prev?.map((c) => (c.id === cid && c.unread ? { ...c, unread: false } : c)) ?? prev,
        );
      }
    }
  };

  // One member socket serves both browser tabs and Tauri webviews. The
  // Tauri app process has its own machine socket for tool execution.
  useEffect(() => {
    if (isTauri) void setMachineIdentity(machineId()).catch(() => {});
    const connection = startSocket({
      onConnect: () => {
        syncingChatsRef.current.clear();
        // The reconnect sync's state re-derives each open view in full.
        reducerRef.current.invalidate();
        markBusy(false);
      },
      onThreadList: (nextChats) => {
        setChats(nextChats);
        // Merge, not replace: a child thread is never in the list, so its
        // live status must survive every sidebar push.
        setChatStatus((prev) => ({ ...prev, ...statusFromThreads(nextChats) }));
        // busyAfterThreadPush keeps the optimistic busy while a send's
        // HTTP round trip is in flight (the push predates the server's
        // generating flag — clearing busy here would let a second send
        // race the first).
        markBusy(busyAfterThreadPush(nextChats, openChatIdRef.current, sendingRef.current, busyRef.current));
      },
      // Sequenced ThreadState owns busy state; older status notifications cannot override it.
      onChatStatus: () => {},
      onThreadState: (state) => applyHistory(state),
      onSubagentTree: (cid, nodes) => {
        // Every chat id updates the cache: the open thread reads its entry,
        // and a later switch reuses the tree without a fresh sync.
        setSubagentTree(cid, nodes);
      },
      onThreadEvents: (cid, _seq, events) => {
        // Incremental durable-log fan-out: the same rows a refresh replays,
        // applied live. Settles optimistic sends exactly like applyHistory.
        const applied = reducerRef.current.applyThreadEvents(cid, _seq, events);
        for (const row of events) {
          if (row.event.type === "user_message") observedUserIdsRef.current.add(row.id);
          const command = outgoingRef.current.get(row.id);
          if (row.event.type === "user_message" && command && command.chatId === cid) settleOutgoing(command);
        }
        // Recent-activity sort key: a background chat's durable rows move its
        // sidebar row (Recents / its project fold-out) forward between list
        // refreshes. Newer-only — a replayed or stale batch must not regress
        // the stamp the thread-state lane already advanced.
        const activity = events[events.length - 1]?.created_at;
        if (activity !== undefined) {
          setChats(prev => {
            const row = prev?.find((c) => c.id === cid);
            if (!row) return prev;
            if (row.last_activity_at !== undefined
              && Date.parse(row.last_activity_at) >= Date.parse(activity)) return prev;
            return prev!.map((c) => (c.id === cid ? { ...c, last_activity_at: activity } : c));
          });
        }
        if (applied.stale) return;
        if (cid === openChatIdRef.current && cid === displayedChatIdRef.current) {
          updateContextRevision(cid, events);
          setBlocks(applied.blocks);
          hasMoreRef.current = applied.hasMore;
          oldestSeqRef.current = applied.oldestSeq;
          setHasMore(applied.hasMore);
        }
      },
      onSync: (cid, phase) => {
        if (phase === "begin") {
          syncingChatsRef.current.set(cid, (syncingChatsRef.current.get(cid) ?? 0) + 1);
        } else {
          const depth = (syncingChatsRef.current.get(cid) ?? 1) - 1;
          if (depth > 0) syncingChatsRef.current.set(cid, depth);
          else syncingChatsRef.current.delete(cid);
        }
        if (cid !== openChatIdRef.current) return;
        // Only the visible thread owns the skeleton flag. A pending target
        // shows the thin navigation bar instead; a cold deep link already
        // set threadLoading before its first sync.
        if (cid !== displayedChatIdRef.current) return;
        if (phase === "begin") {
          setThreadLoading(true);
        } else if (!syncingChatsRef.current.has(cid)) {
          setThreadLoading(false);
        }
      },
      // Content is replaced by sequenced ThreadState at turn boundaries;
      // within a live turn the cheap frames render the stream (deltas, tool
      // status) through the reducer's frame merge.
      onFrame: (frame) => {
        if (frame.chat_id === openChatIdRef.current) {
          const applied = reducerRef.current.applyFrame(frame.event);
          if (!applied.stale && frame.chat_id === displayedChatIdRef.current) {
            setBlocks(applied.blocks);
          }
          if (frame.event.type === "error") {
            toast.error(frame.event.message?.trim() || "Model error", { id: "model-error" });
          }
        }
      },
      onError: (message) => {
        if (message === "frames dropped — resync") {
          socketRef.current?.resync();
        } else if (message === "no such chat" && openChatIdRef.current) {
          // The open chat no longer exists (stale deep link, chat deleted
          // elsewhere, server store reset): drop into a fresh chat instead
          // of showing an error the user cannot act on.
          recoverMissingChatRef.current();
        } else {
          setThreadLoading(false);
          // One toast per connection problem: the socket retries every few
          // seconds, and identical stacked toasts read as spam.
          toast.error(message, { id: "member-socket" });
        }
      },
      onDisplaced: () => toast.error("This chat connection was replaced"),
      onAuthRequired: () => signOut(),
      getOpenChatId: () => openChatIdRef.current,
    });
    socketRef.current = connection;
    return () => {
      if (socketRef.current === connection) socketRef.current = null;
      connection.stop();
    };
    // Stable refs keep this member socket alive for the component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { socketRef, syncingChatsRef, machineTakenOver };
}
