// The thread view's sidebar data: chat rows and their live status overlay,
// archived chats, projects and machines. Every list is server-pushed over
// the member socket (the connect bootstrap and each workspace change); this
// hook only holds the state.
import { useCallback, useRef, useState } from "react";
import type { ChatSubagentNode, ChatSummary } from "../../../lib/api/chats";
import { applySubagentTree, clearSubagentTrees, type ChatStatus } from "../status";
import type { Project } from "../../../lib/api/projects";
import { useMachines } from "../../../lib/machines-store";

export type { ChatStatus };

export function useChatData() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  // Every chat's live status (spinner, working, unread dot) — the one owner
  // of those flags; the rows' own copies only seed it. The list push, the
  // thread-state frames, the chat-status frames for chats other than the
  // open one, and a sent read write it. mark-read happens on thread load
  // for the visible open chat; a hidden tab never swallows its own dot.
  const [chatStatus, setChatStatus] = useState<ChatStatus>({});
  // Every chat's thread subtree, keyed by chat id. The socket updates a
  // chat's entry whether or not that chat is open, so switching back to a
  // chat reuses the last tree instead of waiting for a fresh sync.
  const [subagentTrees, setSubagentTrees] = useState<Record<string, ChatSubagentNode[]>>({});
  const setSubagentTree = useCallback((chatId: string, nodes: ChatSubagentNode[]) => {
    setSubagentTrees((prev) => applySubagentTree(prev, chatId, nodes));
  }, []);
  // A reconnect makes every cached tree suspect: a run can finish while the
  // socket is down and no tree push arrives. The bracket and NOTIFY re-push
  // live trees; the list's working flag is the fallback until then.
  const resetSubagentTrees = useCallback(() => setSubagentTrees(clearSubagentTrees()), []);
  const chatsRef = useRef<ChatSummary[] | null>(null);
  chatsRef.current = chats;

  // ---- archived chats (the sidebar's Archived section) ----
  const [archivedChats, setArchivedChats] = useState<ChatSummary[] | null>(null);

  // ---- projects (sidebar grouping + the composer's project binding) ----
  const [projects, setProjects] = useState<Project[] | null>(null);
  // The machine registry is shared app state (machines-store): the socket's
  // workspace push replaces it and presence frames patch it.
  const machines = useMachines();

  // Archived projects: the sidebar's Archived section, collapsed by default.
  const [archivedProjects, setArchivedProjects] = useState<Project[] | null>(null);

  return {
    chats,
    setChats,
    chatsRef,
    chatStatus,
    setChatStatus,
    subagentTrees,
    setSubagentTree,
    resetSubagentTrees,
    archivedChats,
    setArchivedChats,
    projects,
    setProjects,
    machines,
    archivedProjects,
    setArchivedProjects,
  };
}
