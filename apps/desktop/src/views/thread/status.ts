// Pure derivations of the thread view's live status: what the sidebar shows,
// whether the open thread is writable, and which state the send button has.
import type { ChatRoute } from "./route";
import type { MachineInfo } from "../../lib/api/machines";
import type { ChatSubagentNode, ChatSummary, ThreadType } from "../../lib/api/chats";

export function statusFromThreads(chats: ChatSummary[]) {
  return Object.fromEntries(chats.map(chat => [chat.id, {
    generating: !!chat.generating,
    working: !!chat.working,
    unread: !!chat.unread,
    blocked: !!chat.blocked,
  }]));
}

/** A queued or running run in the chat's subtree. */
export function hasRunningSubagent(nodes: readonly ChatSubagentNode[] | undefined): boolean {
  return (nodes ?? []).some((node) => node.status === "running" || node.status === "queued");
}

/** The chat's work state: its own live turn, a descendant run, or the list
 *  row's precomputed subtree flag. `generating` stays the narrower flag for
 *  Stop, queue mode and "Stopping". */
export function workingForChat(
  chat: Pick<ChatSummary, "generating" | "working"> | undefined,
  nodes: readonly ChatSubagentNode[] | undefined,
): boolean {
  // The list row's working flag is a first-paint fallback. Once the live
  // tree exists it is authoritative for descendants: a finished run must
  // clear the spinner even while the list row is stale.
  const descendantWorking = nodes === undefined
    ? !!chat?.working
    : hasRunningSubagent(nodes);
  return !!chat?.generating || descendantWorking;
}

/** Stores one chat's whole subtree, whether or not that chat is open. */
export function applySubagentTree(
  trees: Record<string, ChatSubagentNode[]>,
  chatId: string,
  nodes: ChatSubagentNode[],
): Record<string, ChatSubagentNode[]> {
  return { ...trees, [chatId]: nodes };
}

/** A reconnect invalidates every cached tree: a run can finish while the
 *  socket is down. The bracket and NOTIFY re-push live trees; until then the
 *  list row's working flag is the fallback. */
export function clearSubagentTrees(): Record<string, ChatSubagentNode[]> {
  return {};
}

/** The open chat's remote bound machine when its socket is down — the
 * offline warning banner's subject. Machine binding is project-derived, so
 * only project-bound chats can have one. Null when unbound, bound to this
 * machine (desktop executes its own tools), online, or presence unknown.
 * Presence comes from the machines store, the only live source. */
export function offlineMachine(
  chats: ChatSummary[] | null,
  machines: MachineInfo[] | null,
  chatId: string | null,
  isTauri: boolean,
  localMachineId: string | undefined,
): { label: string } | null {
  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  if (!row?.machine_id || !row.project_id) return null;
  if (isTauri && row.machine_id === localMachineId) return null;
  const machine = machines?.find((m) => m.machine_id === row.machine_id);
  if (machine?.connected !== false) return null;
  return { label: row.machine_label ?? (machine.name || row.machine_id) };
}

/** The three independent facts about a thread: what it is, and whether the
 *  user archived or deleted it. They are not one state: an archived user
 *  thread stays a user thread, and a deleted thread stays deleted after it
 *  is unarchived. The sidebar lists are the live source for the flags; the
 *  tree supplies the type and is the fallback for a chat that is in no
 *  list (a subagent node). */
export interface ThreadFacts {
  type: ThreadType;
  archived: boolean;
  deleted: boolean;
}

export function threadFacts(input: {
  chatId: string | null;
  chats: ReadonlyArray<Pick<ChatSummary, "id" | "type" | "archived" | "deleted">> | null;
  archivedChats: ReadonlyArray<Pick<ChatSummary, "id" | "type" | "archived" | "deleted">> | null;
  childTree: { type: ThreadType; archived: boolean; deleted: boolean } | null;
}): ThreadFacts {
  const { chatId, chats, archivedChats, childTree } = input;
  const active = chatId === null ? undefined : chats?.find((c) => c.id === chatId);
  const archived = chatId === null ? undefined : archivedChats?.find((c) => c.id === chatId);
  const row = active ?? archived;
  return {
    type: childTree?.type ?? row?.type ?? "user",
    archived: active !== undefined ? !!active.archived : row !== undefined ? true : childTree?.archived === true,
    deleted: row !== undefined ? !!row.deleted : childTree?.deleted === true,
  };
}

/** What the composer may do for the visible thread. Type and flags are
 *  separate: only a live, active user thread is writable. An active list
 *  membership wins over a late archived list; an unknown thread hides the
 *  composer rather than showing an editable one that would flip a moment
 *  later. */
export type ThreadAccess = "writable" | "readonly" | "unknown";

export function threadAccess(input: {
  chatId: string | null;
  chats: ReadonlyArray<Pick<ChatSummary, "id">> | null;
  facts: ThreadFacts;
  /** The child-tree request settled without a tree (cached as null). */
  treeFailed?: boolean;
  /** An authoritative ThreadState has built the visible view. */
  synced?: boolean;
  /** The chat was just created and its sidebar row may still be in flight. */
  justCreated?: boolean;
}): ThreadAccess {
  const { chatId, chats, facts, treeFailed, synced, justCreated } = input;
  if (chatId === null) return "writable";
  if (facts.type !== "user") return "readonly";
  if (facts.deleted) return "readonly";
  if (chats?.some((c) => c.id === chatId)) return "writable";
  if (facts.archived) return "readonly";
  // A just-created chat keeps its editable composer while its row is still
  // in flight.
  if (justCreated) return "writable";
  // A child thread is absent from both lists and its tree request can fail.
  // Once the view is synced, absence plus a failed tree is a child, not an
  // unknown thread.
  if (treeFailed && synced) return "readonly";
  return "unknown";
}

/** The composer's live turn: one derived value, two inputs. `generating` is
 * the server's truth for the open chat (a thread-state frame, a chat-status
 * frame, or the sidebar row, in that order). `pendingSend` is the only
 * local fact — a chat this client sent to whose own frame has not arrived
 * yet — and it retires the moment the server speaks for that chat, so no
 * caller has to remember to clear a flag. */
export function busyFrom(
  generating: boolean,
  pendingSend: string | null,
  openChatId: string | null,
): boolean {
  return generating || (pendingSend !== null && pendingSend === openChatId);
}

/** The retirement rule: a pending send lives only until the server speaks for
 *  that chat (a thread-state, a chat-status, or a failed submit). Frames for
 *  any other chat leave it alone. */
export function pendingAfterFrame(
  pendingSend: string | null,
  frameChatId: string,
): string | null {
  return pendingSend === frameChatId ? null : pendingSend;
}

/** The composer's send button: the four states it can honestly show.
 * Precedence: the stop click's own state, then a live turn (Stop), then a
 * first-send submit in flight (spinner — the chat does not exist yet, so
 * there is no turn to stop and nothing to send again), then the plain
 * send/queue arrow. */
export type SendButtonMode = "send" | "pending" | "stop" | "stopping";
export function sendButtonState(input: {
  hasContent: boolean;
  hasModel: boolean;
  generating: boolean;
  stopping: boolean;
  submitting: boolean;
}): SendButtonMode {
  if (input.generating && !input.hasContent) return input.stopping ? "stopping" : "stop";
  if (input.submitting) return "pending";
  return "send";
}

/** Drops a chat's cancellation-in-progress flag once that chat's own
 * generating state settled to false in a server-truth source — the
 * chat-status map (thread-state frames) or the pushed list. The stop
 * click flags the chat optimistically; the server's stop is cooperative
 * (journaled step checks), so the authoritative generating=false push
 * trails the click by the epilogue's round trips. Undefined generating
 * (chat unknown to both sources) keeps the flag: no evidence is no
 * clearance. Returns null when nothing changed — the caller bails out
 * of the state update instead of re-rendering on every push. */
export function pruneStopping(
  stopping: Record<string, true>,
  chatStatus: Record<string, { generating: boolean; unread: boolean }>,
  chats: ChatSummary[] | null,
): Record<string, true> | null {
  let changed = false;
  const next: Record<string, true> = {};
  for (const cid of Object.keys(stopping)) {
    const generating =
      chatStatus[cid]?.generating ?? chats?.find((c) => c.id === cid)?.generating;
    if (generating === false) {
      changed = true;
      continue;
    }
    next[cid] = true;
  }
  return changed ? next : null;
}

/** Layout mode for one route (desktop rail). The skills and agents pages
 *  are full main-column swaps: NO sidebar aside at all — the page replaces
 *  the chat thread — so picking one must not touch the persisted sidebar
 *  collapsed state either (leaving restores the sidebar exactly as it was).
 *  Every other tab keeps the resizable panel next to the chat, and a tab
 *  pick re-expands a collapsed panel. Mobile has no rail aside at all
 *  (chats-only drawer) and always shows the chat. */
export type TabPane = "chat" | "skillsPage" | "agentsPage" | "settingsPage";
export function tabPaneLayout(
  route: Pick<ChatRoute, "tab" | "skills" | "agents">,
  isMobile: boolean,
): { aside: boolean; mainPane: TabPane; expandsPanel: boolean } {
  if (isMobile) return { aside: false, mainPane: "chat", expandsPanel: false };
  if (route.skills !== null)
    return { aside: false, mainPane: "skillsPage", expandsPanel: false };
  if (route.agents !== null)
    return { aside: false, mainPane: "agentsPage", expandsPanel: false };
  if (route.tab === "settings")
    return { aside: true, mainPane: "settingsPage", expandsPanel: true };
  return { aside: true, mainPane: "chat", expandsPanel: true };
}
