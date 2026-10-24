// The thread view's sidebar data: chat rows and their live status overlay,
// archived chats, projects and machines.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  listArchivedChats,
  listArchivedProjects,
  listChats,
  listMachines,
  listProjects,
  type ChatSummary,
  type MachineInfo,
  type Project,
} from "../../../transport";

export type ChatStatus = Record<string, { generating: boolean; unread: boolean }>;

export function useChatData() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  // Live sidebar status overlay (thread-list spinner/dot): frames from the
  // server's chat-status channel win over the fetched list; refreshChats
  // reconciles the rest. mark-read happens on thread load for the visible
  // open chat; a hidden tab never swallows its own dot.
  const [chatStatus, setChatStatus] = useState<ChatStatus>({});
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
