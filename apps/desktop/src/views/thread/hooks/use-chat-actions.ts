// Sidebar row actions: rename and archive for chats and projects. Each one
// writes through the transport and refreshes the affected lists.
import { useCallback } from "react";
import { toast } from "sonner";
import { updateChat } from "../../../lib/api/chats";
import { updateProject } from "../../../lib/api/projects";

export function useChatActions({
  refreshChats,
  refreshArchivedChats,
  refreshProjects,
  refreshArchivedProjects,
}: {
  refreshChats: () => Promise<void>;
  refreshArchivedChats: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshArchivedProjects: () => Promise<void>;
}) {
  const renameChat = useCallback(async (id: string, title: string) => {
    try {
      await updateChat(id, { title });
      void refreshChats();
    } catch {
      toast.error("Could not rename the chat");
    }
  }, [refreshChats]);
  const archiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: true });
      await Promise.all([refreshChats(), refreshArchivedChats()]);
    } catch {
      toast.error("Could not archive the chat");
    }
  }, [refreshChats, refreshArchivedChats]);
  const unarchiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: false });
      await Promise.all([refreshChats(), refreshArchivedChats()]);
    } catch {
      toast.error("Could not unarchive the chat");
    }
  }, [refreshChats, refreshArchivedChats]);
  const renameProject = useCallback(async (id: string, name: string) => {
    try {
      await updateProject(id, { name });
      // The chat list carries the project name on every row — refresh both.
      await Promise.all([refreshProjects(), refreshChats()]);
    } catch {
      toast.error("Could not rename the project");
    }
  }, [refreshChats, refreshProjects]);
  const archiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: true });
      await Promise.all([refreshProjects(), refreshArchivedProjects(), refreshChats()]);
    } catch {
      toast.error("Could not archive the project");
    }
  }, [refreshChats, refreshProjects, refreshArchivedProjects]);
  const unarchiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: false });
      await Promise.all([refreshProjects(), refreshArchivedProjects(), refreshChats()]);
    } catch {
      toast.error("Could not unarchive the project");
    }
  }, [refreshChats, refreshProjects, refreshArchivedProjects]);

  return { renameChat, archiveChat, unarchiveChat, renameProject, archiveProject, unarchiveProject };
}
