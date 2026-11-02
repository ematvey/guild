// The chat lists and their live overlays, as module stores the member socket
// writes and every view subscribes to: the active and archived chat rows,
// each chat's live status (spinner, working, unread dot), each chat's thread
// subtree, and the active and archived projects. Every value is server-pushed
// (the connect bootstrap and each change); nothing here is fetched.
import { useMemo } from "react";
import type { ChatSubagentNode, ChatSummary } from "../../lib/api/chats";
import type { Project } from "../../lib/api/projects";
import { createStore } from "../../lib/store";
import { byRecentActivity, sidebarGrouping } from "../projects/projects";
import { applySubagentTree, clearSubagentTrees, statusFromThreads, workingForChat, type ChatStatus } from "./status";

/** The sidebar's chats; null until the first push. */
export const chatsStore = createStore<ChatSummary[] | null>(null);
/** The archived chats (the sidebar's Archived section); null until pushed. */
export const archivedChatsStore = createStore<ChatSummary[] | null>(null);
/** Every chat's live status — the one owner of those flags; the rows' own
 *  copies only seed it. The list push, the thread-state frames, the
 *  chat-status frames for chats other than the open one, and a sent read
 *  write it. */
export const chatStatusStore = createStore<ChatStatus>({});
/** Every chat's thread subtree, keyed by chat id. The socket updates a
 *  chat's entry whether or not that chat is open, so switching back to a
 *  chat reuses the last tree instead of waiting for a fresh sync. */
export const subagentTreesStore = createStore<Record<string, ChatSubagentNode[]>>({});
/** Projects (sidebar grouping + the composer's project binding). */
export const projectsStore = createStore<Project[] | null>(null);
export const archivedProjectsStore = createStore<Project[] | null>(null);

/** Back to nothing pushed: a new workspace scope starts from an empty
 *  sidebar, never the previous one's rows. */
export function resetChatStores(): void {
  chatsStore.reset();
  archivedChatsStore.reset();
  chatStatusStore.reset();
  subagentTreesStore.reset();
  projectsStore.reset();
  archivedProjectsStore.reset();
}

/** A whole pushed list: replaces the rows and merges their status (a child
 *  thread is never in the list, so its live status survives every push). */
export function applyChatList(rows: ChatSummary[]): void {
  chatsStore.set(rows);
  chatStatusStore.update((prev) => ({ ...prev, ...statusFromThreads(rows) }));
}

/** Puts one changed row in place; a row the list does not hold joins at its
 *  recent-activity position, the order the sidebar shows. */
export function upsertChatRow(rows: ChatSummary[], row: ChatSummary): ChatSummary[] {
  if (rows.some((c) => c.id === row.id)) return rows.map((c) => (c.id === row.id ? row : c));
  const at = rows.findIndex((c) => byRecentActivity(row, c) <= 0);
  return at < 0 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)];
}

/** One pushed row (the `chat_row` frame). Before the first list there is no
 *  list to place it in. */
export function applyChatRow(row: ChatSummary): void {
  chatsStore.update((prev) => (prev === null ? prev : upsertChatRow(prev, row)));
  chatStatusStore.update((prev) => ({ ...prev, ...statusFromThreads([row]) }));
}

/** Moves a chat's recent-activity stamp forward, never back: a replayed or
 *  stale batch must not regress what a newer lane already set. */
export function bumpChatActivity(chatId: string, activity: string): void {
  chatsStore.update((prev) => {
    const row = prev?.find((c) => c.id === chatId);
    if (!row) return prev;
    if (row.last_activity_at !== undefined && Date.parse(row.last_activity_at) >= Date.parse(activity)) return prev;
    return prev!.map((c) => (c.id === chatId ? { ...c, last_activity_at: activity } : c));
  });
}

export function setSubagentTree(chatId: string, nodes: ChatSubagentNode[]): void {
  subagentTreesStore.update((prev) => applySubagentTree(prev, chatId, nodes));
}

/** A reconnect makes every cached tree suspect: a run can finish while the
 *  socket is down and no tree push arrives. The bracket and NOTIFY re-push
 *  live trees; the list's working flag is the fallback until then. */
export function resetSubagentTrees(): void {
  subagentTreesStore.set(clearSubagentTrees());
}

/** A row as the sidebar shows it: its flags come from the chat's status
 *  entry, never the row's own copy (the copy only seeded the entry). */
export function sidebarRow(
  c: ChatSummary,
  status: ChatStatus,
  trees: Record<string, ChatSubagentNode[]>,
): ChatSummary {
  const entry = status[c.id] ?? c;
  return { ...c, generating: !!entry.generating, unread: !!entry.unread, working: workingForChat(entry, trees[c.id]) };
}

/** The sidebar's grouped rows and archived rows, with live flags. */
export function useSidebarRows() {
  const chats = chatsStore.use();
  const archivedChats = archivedChatsStore.use();
  const status = chatStatusStore.use();
  const trees = subagentTreesStore.use();
  const grouping = useMemo(
    () => sidebarGrouping(chats === null ? null : chats.map((c) => sidebarRow(c, status, trees))),
    [chats, status, trees],
  );
  const archivedRows = useMemo(
    () => archivedChats?.map((c) => sidebarRow(c, status, trees)) ?? null,
    [archivedChats, status, trees],
  );
  return { chats, grouping, archivedRows };
}
