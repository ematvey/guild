// The thread view's sidebar data: chat rows and their live status overlay,
// archived chats, projects and machines.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { listArchivedChats, listChats, type ChatSubagentNode, type ChatSummary } from "../../../lib/api/chats";
import { applySubagentTree } from "../status";
import { listArchivedProjects, listProjects, type Project } from "../../../lib/api/projects";
import { listMachines, type MachineInfo } from "../../../lib/api/machines";

export type ChatStatus = Record<string, { generating: boolean; working: boolean; unread: boolean }>;

export function useChatData() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  // Live sidebar status overlay (thread-list spinner/dot): frames from the
  // server's chat-status channel win over the fetched list; refreshChats
  // reconciles the rest. mark-read happens on thread load for the visible
  // open chat; a hidden tab never swallows its own dot.
  const [chatStatus, setChatStatus] = useState<ChatStatus>({});
  // Every chat's thread subtree, keyed by chat id. The socket updates a
  // chat's entry whether or not that chat is open, so switching back to a
  // chat reuses the last tree instead of waiting for a fresh sync.
  const [subagentTrees, setSubagentTrees] = useState<Record<string, ChatSubagentNode[]>>({});
  const setSubagentTree = useCallback((chatId: string, nodes: ChatSubagentNode[]) => {
    setSubagentTrees((prev) => applySubagentTree(prev, chatId, nodes));
  }, []);
  const chatsRef = useRef<ChatSummary[] | null>(null);
  chatsRef.current = chats;

  const refreshChats = async () => {
    const c = await listChats();
    if (c === null) {
      toast.error("Could not load chats");
      return;
    }
    setChats(c);
  };

  // ---- archived chats (the sidebar's Archived section) ----
  const [archivedChats, setArchivedChats] = useState<ChatSummary[] | null>(null);
  const refreshArchivedChats = useCallback(async () => {
    const c = await listArchivedChats();
    if (c !== null) setArchivedChats(c);
  }, []);
  useEffect(() => {
    void refreshArchivedChats();
  }, [refreshArchivedChats]);

  // ---- projects (sidebar grouping + the composer's project binding) ----
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [machines, setMachines] = useState<MachineInfo[] | null>(null);
  const refreshProjects = useCallback(async () => {
    const p = await listProjects();
    if (p === null) return; // silent: the sidebar degrades, chat keeps working
    setProjects(p);
  }, []);
  useEffect(() => {
    void refreshProjects();
    void listMachines().then(setMachines).catch(() => {});
  }, [refreshProjects]);

  // Archived projects: the sidebar's Archived section, collapsed by default.
  const [archivedProjects, setArchivedProjects] = useState<Project[] | null>(null);
  const refreshArchivedProjects = useCallback(async () => {
    const p = await listArchivedProjects();
    if (p !== null) setArchivedProjects(p);
  }, []);
  useEffect(() => {
    void refreshArchivedProjects();
  }, [refreshArchivedProjects]);

  return {
    chats,
    setChats,
    chatsRef,
    chatStatus,
    setChatStatus,
    subagentTrees,
    setSubagentTree,
    refreshChats,
    archivedChats,
    setArchivedChats,
    refreshArchivedChats,
    projects,
    machines,
    refreshProjects,
    archivedProjects,
    refreshArchivedProjects,
  };
}
