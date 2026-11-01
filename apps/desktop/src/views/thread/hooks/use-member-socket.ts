// The member socket: one connection per view that owns thread
// reconciliation in both browser and Tauri webview mode. The Tauri app
// process keeps the separate machine socket.
import { useEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";
import { startSocket } from "../../../lib/socket-client";
import { applyMachineList, applyMachineStatus } from "../../../lib/machines-store";
import { applyModelList } from "../../../lib/models-store";
import { applyContextUsage, clearContextUsage } from "../../../lib/context-usage-store";
import { registerCacheClear } from "../../settings/use-cached-api";
import { applyWorkspaceIdentity } from "../../../lib/workspace-store";
import type { ChatSummary, ChatSubagentNode } from "../../../lib/api/chats";
import type { Project } from "../../../lib/api/projects";
import type { ThreadState } from "../../../lib/thread-events";
import type { OutgoingCommand } from "../../../lib/outgoing-command";
import { statusAfterGenerating, statusFromThreads, type ChatStatus } from "../status";
import type { ThreadViewStore } from "../thread-view-store";
import { applyWindowTitle } from "../../../lib/window-title";
import { applyTelemetrySetting, traceEvent } from "../../../lib/telemetry";
import {
  applyAgentList,
  applyAgentRoutines,
  applyAgentRun,
  applyAgentThreads,
  resetAgentSlices,
} from "../../agents/agents-store";
import { applyOrgEvent, applySkillCatalog } from "../../skills/skills-store";
import type { ChatTree } from "../../../lib/api/chats";

registerCacheClear(clearContextUsage);

export interface MemberSocketDeps {
  signOut: () => void;
  chatsRef: RefObject<ChatSummary[] | null>;
  setChats: (update: ChatSummary[] | ((prev: ChatSummary[] | null) => ChatSummary[] | null)) => void;
  setChatStatus: (update: (prev: ChatStatus) => ChatStatus) => void;
  setArchivedChats: (chats: ChatSummary[]) => void;
  setProjects: (projects: Project[]) => void;
  setArchivedProjects: (projects: Project[]) => void;
  store: ThreadViewStore;
  retireSendPending: (chatId: string, source: string) => void;
  openChatIdRef: RefObject<string | null>;
  onThreadStateApplied: (cid: string) => void;
  setSubagentTree: (chatId: string, nodes: ChatSubagentNode[]) => void;
  resetSubagentTrees: () => void;
  /** One chat's header facts arrived (inside its sync bracket or live). */
  applyChatTree: (tree: ChatTree) => void;
  cancelPending: (cid: string) => void;
  outgoingRef: RefObject<Map<string, OutgoingCommand>>;
  observedUserIdsRef: RefObject<Set<string>>;
  settleOutgoing: (command: OutgoingCommand) => void;
  recoverMissingChatRef: RefObject<() => void>;
}

export function useMemberSocket(deps: MemberSocketDeps) {
  const {
    signOut, chatsRef, setChats, setChatStatus, setArchivedChats, setProjects,
    setArchivedProjects, store, retireSendPending, openChatIdRef,
    onThreadStateApplied, setSubagentTree, resetSubagentTrees, applyChatTree,
    cancelPending, outgoingRef, observedUserIdsRef, settleOutgoing, recoverMissingChatRef,
  } = deps;
  const socketRef = useRef<ReturnType<typeof startSocket> | null>(null);
  const syncingChatsRef = useRef(new Map<string, number>());
  // The newest event id whose read-marker POST already fired per chat:
  // thread_state frames arrive per streamed delta batch, and marking read
  // per frame spammed /read hundreds of times over one active turn — the
  // marker only needs to move when the view carries events it hasn't
  // covered yet.
  const lastReadMarkRef = useRef(new Map<string, string>());
  // Chats whose read frame reached the socket in this connection: a push
  // may only hide an open chat's dot once its read was actually sent.
  const readSentRef = useRef(new Set<string>());
  // Chats whose sync bracket applied a state. A sync that failed carries
  // no view to read, so its done phase must not move the marker.
  const syncedAppliedRef = useRef(new Set<string>());
  // Chats whose read already went out inside the current sync bracket, so
  // the done phase does not send it a second time.
  const syncedReadRef = useRef(new Set<string>());

  const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

  /** Sends one read mark and hides the chat's dot only when the frame left
   *  the socket. A dropped frame keeps the dot and the guard, so the next
   *  state or sync retries instead of losing the mark until a reload. */
  const sendRead = (cid: string): boolean => {
    if (socketRef.current?.markRead(cid) !== true) return false;
    readSentRef.current.add(cid);
    setChatStatus((prev) =>
      prev[cid]?.unread ? { ...prev, [cid]: { ...prev[cid], unread: false } } : prev,
    );
    return true;
  };

  /** Pushed list rows as this client shows them. The open chat's turns are
   *  on screen: the server's read watermark lags the local read, so a push
   *  landing in between must not raise its unread badge. A title is
   *  write-once after it is set: a row without one is older than the row
   *  already held, so the known title stays. */
  const pushedRows = (rows: ChatSummary[]): ChatSummary[] => {
    const open = openChatIdRef.current;
    const read = open !== null && readSentRef.current.has(open);
    const known = new Map((chatsRef.current ?? []).map((c) => [c.id, c.title]));
    return rows.map((c) => {
      const unread = read && c.id === open && c.unread ? { ...c, unread: false } : c;
      const prior = known.get(c.id);
      return prior && !unread.title ? { ...unread, title: prior } : unread;
    });
  };

  const applyHistory = (state: ThreadState) => {
    const cid = state.chat_id;
    // The reducer owns the watermark and the view: a sequenced state applies
    // only its new events (a stale one changes nothing anywhere).
    const applied = store.mutate((r) => r.applyState(state));
    traceEvent("thread.state", {
      seq: state.seq,
      events: state.events.length,
      generating: state.generating,
      open: cid === openChatIdRef.current,
      synced: syncingChatsRef.current.has(cid),
      stale: applied.stale,
    });
    if (applied.stale) return;
    onThreadStateApplied(cid);
    for (const row of state.events) {
      if (row.event.type === "user_message") observedUserIdsRef.current.add(row.id);
      const command = outgoingRef.current.get(row.id);
      if (row.event.type === "user_message" && command && command.chatId === cid) settleOutgoing(command);
    }
    const watching = cid === openChatIdRef.current && isVisible();
    setChatStatus(prev => ({ ...prev, [cid]: statusAfterGenerating(prev[cid], state.generating, watching) }));
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
    if (cid !== openChatIdRef.current) return;
    if (syncingChatsRef.current.has(cid)) syncedAppliedRef.current.add(cid);
    // The server spoke for this chat: the local pending send retires and
    // `generating` owns the turn from here (the route chat is the target even
    // while the old thread is still displayed).
    retireSendPending(cid, "thread_state");
    // The read mark follows the route chat, not the painted one: the first
    // state of an uncached open is what triggers the swap, and the paint ref
    // still names the old chat at this point.
    if (isVisible()) {
      const lastEventId = state.events[state.events.length - 1]?.id;
      if (
        lastEventId !== undefined &&
        lastReadMarkRef.current.get(cid) !== lastEventId &&
        sendRead(cid)
      ) {
        lastReadMarkRef.current.set(cid, lastEventId);
        syncedReadRef.current.add(cid);
      }
    }
  };

  // One member socket serves both browser tabs and Tauri webviews. The
  // Tauri app process has its own machine socket for tool execution.
  useEffect(() => {
    const connection = startSocket({
      onConnect: () => {
        syncingChatsRef.current.clear();
        // A read frame sent just before the old socket died may never have
        // been processed: forget the guard so the reconnect sync re-sends it.
        lastReadMarkRef.current.clear();
        readSentRef.current.clear();
        // The reconnect sync's state re-derives each open view in full.
        store.mutate((r) => r.invalidate());
        resetSubagentTrees();
        resetAgentSlices();
      },
      onMachineStatus: applyMachineStatus,
      onWorkspaceIdentity: (identity) => {
        applyWorkspaceIdentity(identity);
        // The org's telemetry switch rides the identity frame: the client
        // obeys it and never decides on its own.
        applyTelemetrySetting(identity.telemetry);
        traceEvent("telemetry.switch", { enabled: identity.telemetry });
        applyWindowTitle(identity.name);
      },
      onMachineList: applyMachineList,
      onModelList: applyModelList,
      onAgentList: applyAgentList,
      onAgentRun: applyAgentRun,
      onAgentThreads: applyAgentThreads,
      onAgentRoutines: applyAgentRoutines,
      onSkillCatalog: (items, installs) => applySkillCatalog({ items, installs }),
      onOrgEvent: applyOrgEvent,
      onChatTree: applyChatTree,
      onArchivedThreadList: (next) => setArchivedChats(next),
      onContextUsage: applyContextUsage,
      onProjectList: (next, archived) => {
        setProjects(next);
        setArchivedProjects(archived);
      },
      onThreadList: (nextChats) => {
        const open = openChatIdRef.current;
        const rows = pushedRows(nextChats);
        setChats(rows);
        // Merge, not replace: a child thread is never in the list, so its
        // live status must survive every sidebar push.
        setChatStatus((prev) => ({ ...prev, ...statusFromThreads(rows) }));
        traceEvent("thread.list", {
          chats: rows.length,
          open: open ?? "-",
          openGenerating: rows.find((c) => c.id === open)?.generating ?? "absent",
          sending: [...outgoingRef.current.values()].some(
            (c) => c.running && (c.chatId ?? c.originChatId) === open,
          ),
        });
      },
      // One row changed in place: it replaces its own entry, read through
      // the same masks as a whole list.
      onChatRow: (chat) => {
        const [row] = pushedRows([chat]);
        setChats((prev) => {
          if (prev === null) return prev;
          return prev.some((c) => c.id === row!.id)
            ? prev.map((c) => (c.id === row!.id ? row! : c))
            : [row!, ...prev];
        });
        setChatStatus((prev) => ({ ...prev, ...statusFromThreads([row!]) }));
      },
      // A chat_status frame moves the spinner and the unread dot of every
      // chat but the open one. The open chat's turn belongs to its sequenced
      // ThreadState: the frame carries no seq, so it never retires a pending
      // send (that would drop `busy` before the state saying the turn is live
      // arrives) and never overrides a newer state's flag.
      onChatStatus: ({ chat_id, generating }) => {
        if (chat_id === openChatIdRef.current) return;
        setChatStatus((prev) => ({ ...prev, [chat_id]: statusAfterGenerating(prev[chat_id], generating, false) }));
      },
      onThreadState: (state) => applyHistory(state),
      onSubagentTree: (cid, nodes) => {
        // Every chat id updates the cache: the open thread reads its entry,
        // and a later switch reuses the tree without a fresh sync.
        setSubagentTree(cid, nodes);
      },
      onThreadEvents: (cid, seq, events) => {
        // Incremental durable-log fan-out: the same rows a refresh replays,
        // applied live. Settles optimistic sends exactly like applyHistory.
        store.mutate((r) => r.applyThreadEvents(cid, seq, events));
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
      },
      onSync: (cid, phase) => {
        traceEvent("thread.sync", { chat: cid, phase, open: cid === openChatIdRef.current });
        if (phase === "begin") {
          syncingChatsRef.current.set(cid, (syncingChatsRef.current.get(cid) ?? 0) + 1);
          syncedAppliedRef.current.delete(cid);
          syncedReadRef.current.delete(cid);
        } else {
          const depth = (syncingChatsRef.current.get(cid) ?? 1) - 1;
          if (depth > 0) syncingChatsRef.current.set(cid, depth);
          else syncingChatsRef.current.delete(cid);
          // Every open and reconnect re-asserts the marker: the event-id
          // guard only throttles live frames, so a mark the server lost (or
          // a reopen with no new events) still gets written.
          const applied = syncedAppliedRef.current.delete(cid);
          const alreadyRead = syncedReadRef.current.delete(cid);
          if (applied && !alreadyRead && cid === openChatIdRef.current && isVisible()) sendRead(cid);
        }
      },
      // Content is replaced by sequenced ThreadState at turn boundaries;
      // within a live turn the cheap frames render the stream (deltas, tool
      // status) through the reducer's frame merge.
      onFrame: (frame) => {
        if (frame.chat_id === openChatIdRef.current) {
          store.mutate((r) => r.applyFrame(frame.event));
          if (frame.event.type === "error") {
            toast.error(frame.event.message?.trim() || "Model error", { id: "model-error" });
          }
        }
      },
      onError: (message) => {
        traceEvent("socket.error_frame", { message: message.slice(0, 160) });
        if (message === "no such chat" && openChatIdRef.current) {
          // The open chat no longer exists (stale deep link, chat deleted
          // elsewhere, server store reset): drop into a fresh chat instead
          // of showing an error the user cannot act on.
          recoverMissingChatRef.current();
        } else {
          // A cold load waiting on this chat gives up: the skeleton derives
          // from the pending navigation, so cancelling it lowers it.
          const route = openChatIdRef.current;
          if (route !== null) cancelPending(route);
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

  return { socketRef, syncingChatsRef };
}
