// Pure derivations of the thread view's live status: what the sidebar shows,
// whether the open thread is writable, and which state the send button has.
import type { ChatRoute } from "./route";
import type { MachineInfo } from "../../lib/api/machines";
import type { ChatSubagentNode, ChatSummary, ThreadType } from "../../lib/api/chats";

/** One chat's live status — the only place the client keeps it. The list
 *  push seeds every listed chat; a thread-state or chat-status frame moves
 *  `generating` and `unread`; a sent read clears `unread`. `working` is the
 *  list row's subtree flag, the descendant fallback until a live tree
 *  exists (see `workingForChat`). */
export interface ChatStatusEntry {
  generating: boolean;
  working: boolean;
  unread: boolean;
}
export type ChatStatus = Record<string, ChatStatusEntry>;

export function statusFromThreads(chats: ChatSummary[]): ChatStatus {
  return Object.fromEntries(
    chats.map((chat) => [
      chat.id,
      {
        generating: !!chat.generating,
        working: !!chat.working,
        unread: !!chat.unread,
      },
    ]),
  );
}

/** A chat's status after the server reported its own turn's generating
 *  flag (a thread-state or a chat-status frame). A turn that ends while the
 *  reader is not watching the chat raises its unread dot; a watched chat is
 *  read. */
export function statusAfterGenerating(
  prev: ChatStatusEntry | undefined,
  generating: boolean,
  watching: boolean,
): ChatStatusEntry {
  return {
    generating,
    working: prev?.working ?? false,
    unread: watching ? false : !generating && prev?.generating ? true : (prev?.unread ?? false),
  };
}

/** A queued or running run in the chat's subtree. */
export function hasRunningSubagent(nodes: readonly ChatSubagentNode[] | undefined): boolean {
  return (nodes ?? []).some((node) => node.status === "running" || node.status === "queued");
}

/** The chat's work state: its own live turn, a descendant run, or the list
 *  row's precomputed subtree flag. `generating` stays the narrower flag for
 *  Stop, queue mode and "Stopping". */
export function workingForChat(
  chat: { generating?: boolean; working?: boolean } | undefined,
  nodes: readonly ChatSubagentNode[] | undefined,
): boolean {
  // The list row's working flag is a first-paint fallback. Once the live
  // tree exists it is authoritative for descendants: a finished run must
  // clear the spinner even while the list row is stale.
  const descendantWorking = nodes === undefined ? !!chat?.working : hasRunningSubagent(nodes);
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

/** A machine that runs a chat's tools somewhere else, with its live
 *  presence from the machines store (undefined while unknown). Null when
 *  there is no machine, or it is this client's own engine: a local engine
 *  executes its own tools and has no presence to show. */
export interface RemoteMachine {
  machineId: string;
  online: boolean | undefined;
  label: string;
}

export function remoteMachine(input: {
  machineId: string | null | undefined;
  /** The chat row's denormalised label, preferred over the registry name. */
  rowLabel?: string | null;
  machines: MachineInfo[] | null;
  /** This client's engine machine id; undefined on a client without one. */
  localMachineId: string | undefined;
}): RemoteMachine | null {
  const { machineId, rowLabel, machines, localMachineId } = input;
  if (!machineId || machineId === localMachineId) return null;
  const machine = machines?.find((m) => m.machine_id === machineId);
  return {
    machineId,
    online: machine?.connected,
    label: rowLabel ?? (machine?.name || machineId),
  };
}

/** The open chat's remote bound machine when its socket is down — the
 * offline warning banner's subject. Machine binding is project-derived, so
 * only project-bound chats can have one. Null when unbound, bound to this
 * client's engine, online, or presence unknown. */
export function offlineMachine(
  chats: ChatSummary[] | null,
  machines: MachineInfo[] | null,
  chatId: string | null,
  localMachineId: string | undefined,
): { label: string } | null {
  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  if (!row?.project_id) return null;
  const remote = remoteMachine({ machineId: row.machine_id, rowLabel: row.machine_label, machines, localMachineId });
  return remote?.online === false ? { label: remote.label } : null;
}

/** The independent facts about a thread: what it is, whether the user
 *  archived or deleted it, and whether the user owns it. They are not one
 *  state: an archived user thread stays a user thread, and a deleted thread
 *  stays deleted after it is unarchived. The sidebar lists are the live
 *  source for the flags; the tree supplies the type and is the fallback for
 *  a chat that is in no list (a subagent node, or a member's chat an admin
 *  reads). `owned` is null until either source speaks: a listed chat is the
 *  user's own, and the tree's `own` says so for every other chat. */
/** The agent the composer names. The pick (seeded from the chat's binding)
 *  gives the identity; pushed state gives its current face: the agent
 *  list's row for that id, else the chat tree's `agent_name` when the tree
 *  names the same agent. A rename shows as soon as either frame lands. */
export function composerAgent<A extends { id: string; name: string }>(
  picked: A | null,
  agents: ReadonlyArray<A> | null,
  tree: { agent_id: string | null; agent_name: string | null } | null,
): A | null {
  if (picked === null) return null;
  const live = agents?.find((a) => a.id === picked.id);
  if (live !== undefined) return live;
  if (tree?.agent_id === picked.id && tree.agent_name && tree.agent_name !== picked.name) {
    return { ...picked, name: tree.agent_name };
  }
  return picked;
}

/** The agent a chat is bound to, when the pushed agent list marks it as
 *  being deleted. Its threads keep their sidebar rows through the grace
 *  period — readable, and restored with the agent — but the server refuses
 *  their turns (409 `agent_deleting`), so the composer is read-only until
 *  the agent is restored or purged with its chats. Null while the binding
 *  or the list is unknown, or when the agent is live. */
export function agentDeleting<A extends { id: string; status: string }>(
  boundAgentId: string | null,
  agents: ReadonlyArray<A> | null,
): A | null {
  if (boundAgentId === null || agents === null) return null;
  const agent = agents.find((a) => a.id === boundAgentId);
  return agent !== undefined && (agent.status === "deleting" || agent.status === "deleted") ? agent : null;
}

export interface ThreadFacts {
  type: ThreadType;
  archived: boolean;
  deleted: boolean;
  owned: boolean | null;
}

export function threadFacts(input: {
  chatId: string | null;
  chats: ReadonlyArray<Pick<ChatSummary, "id" | "type" | "archived" | "deleted">> | null;
  archivedChats: ReadonlyArray<Pick<ChatSummary, "id" | "type" | "archived" | "deleted">> | null;
  childTree: { type: ThreadType; archived: boolean; deleted: boolean; own?: boolean } | null;
}): ThreadFacts {
  const { chatId, chats, archivedChats, childTree } = input;
  const active = chatId === null ? undefined : chats?.find((c) => c.id === chatId);
  const archived = chatId === null ? undefined : archivedChats?.find((c) => c.id === chatId);
  const row = active ?? archived;
  return {
    type: childTree?.type ?? row?.type ?? "user",
    archived: active !== undefined ? !!active.archived : row !== undefined ? true : childTree?.archived === true,
    deleted: row !== undefined ? !!row.deleted : childTree?.deleted === true,
    owned: chatId === null || row !== undefined ? true : typeof childTree?.own === "boolean" ? childTree.own : null,
  };
}

/** What the composer may do for the visible thread. Type and flags are
 *  separate: only a live, active user thread the user owns is writable. An
 *  active list membership wins over a late archived list; another member's
 *  chat (an admin reading it) is read-only; an unknown thread hides the
 *  composer rather than showing an editable one that would flip a moment
 *  later. */
export type ThreadAccess = "writable" | "readonly" | "unknown";

export function threadAccess(input: {
  chatId: string | null;
  chats: ReadonlyArray<Pick<ChatSummary, "id">> | null;
  facts: ThreadFacts;
  /** The chat was just created and its sidebar row may still be in flight. */
  justCreated?: boolean;
  /** The chat's agent is in its deletion grace period (`agentDeleting`). */
  agentDeleting?: boolean;
}): ThreadAccess {
  const { chatId, chats, facts, justCreated, agentDeleting } = input;
  if (chatId === null) return "writable";
  if (facts.type !== "user") return "readonly";
  if (facts.deleted) return "readonly";
  if (agentDeleting) return "readonly";
  if (chats?.some((c) => c.id === chatId)) return "writable";
  if (facts.owned === false) return "readonly";
  if (facts.archived) return "readonly";
  // A just-created chat keeps its editable composer while its row is still
  // in flight.
  if (justCreated) return "writable";
  return "unknown";
}

/** The composer's live turn: one derived value, two inputs. `generating` is
 * the server's truth for the open chat: its status entry, which the open
 * chat's sequenced thread-state frames move (the list push seeds it before
 * the first one). `pendingSend` is the only
 * local fact — a chat this client sent to whose own frame has not arrived
 * yet — and it retires the moment the server speaks for that chat, so no
 * caller has to remember to clear a flag. */
export function busyFrom(generating: boolean, pendingSend: string | null, openChatId: string | null): boolean {
  return generating || (pendingSend !== null && pendingSend === openChatId);
}

/** The retirement rule: a pending send lives only until the server speaks
 *  for that chat in sequence (a thread-state, or a failed submit). A
 *  chat-status frame carries no seq and never retires it: it can arrive
 *  before the state that says the turn is live. Frames for any other chat
 *  leave it alone. */
export function pendingAfterFrame(pendingSend: string | null, frameChatId: string): string | null {
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
 * generating state settled to false in its status entry (a frame or the
 * pushed list). The stop click flags the chat optimistically; the server's
 * stop is cooperative (journaled step checks), so the authoritative
 * generating=false push trails the click by the epilogue's round trips.
 * A chat with no status entry keeps the flag: no evidence is no
 * clearance. Returns null when nothing changed — the caller bails out of
 * the state update instead of re-rendering on every push. */
export function pruneStopping(
  stopping: Record<string, true>,
  chatStatus: Record<string, { generating: boolean }>,
): Record<string, true> | null {
  let changed = false;
  const next: Record<string, true> = {};
  for (const cid of Object.keys(stopping)) {
    if (chatStatus[cid]?.generating === false) {
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
 *  pick re-expands a collapsed panel. Mobile has no aside (the rail and
 *  panels live in the drawer); its main pane is the surface the URL names,
 *  the same page as on desktop. */
export type TabPane = "chat" | "skillsPage" | "agentsPage" | "integrationsPage" | "appsPage" | "settingsPage";
export function tabPaneLayout(
  route: Pick<ChatRoute, "tab" | "skills" | "agents"> & {
    integrations?: ChatRoute["integrations"];
    apps?: ChatRoute["apps"];
  },
  isMobile: boolean,
): { aside: boolean; mainPane: TabPane; expandsPanel: boolean } {
  if (isMobile) {
    const mainPane: TabPane =
      route.skills !== null
        ? "skillsPage"
        : route.agents !== null
          ? "agentsPage"
          : (route.integrations ?? null) !== null
            ? "integrationsPage"
            : (route.apps ?? null) !== null
              ? "appsPage"
              : route.tab === "settings"
                ? "settingsPage"
                : "chat";
    return { aside: false, mainPane, expandsPanel: false };
  }
  if (route.skills !== null) return { aside: false, mainPane: "skillsPage", expandsPanel: false };
  if (route.agents !== null) return { aside: false, mainPane: "agentsPage", expandsPanel: false };
  if ((route.integrations ?? null) !== null) return { aside: false, mainPane: "integrationsPage", expandsPanel: false };
  if ((route.apps ?? null) !== null) return { aside: false, mainPane: "appsPage", expandsPanel: false };
  if (route.tab === "settings") return { aside: true, mainPane: "settingsPage", expandsPanel: true };
  return { aside: true, mainPane: "chat", expandsPanel: true };
}
