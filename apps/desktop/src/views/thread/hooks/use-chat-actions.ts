// Sidebar row actions: rename and archive for chats and projects. Each one
// writes through the transport; the server pushes the updated workspace
// lists, so no list is re-read here.
import { useCallback } from "react";
import { toast } from "sonner";
import { updateChat } from "../../../lib/api/chats";
import { updateProject } from "../../../lib/api/projects";

export function useChatActions() {
  const renameChat = useCallback(async (id: string, title: string) => {
    try {
      await updateChat(id, { title });
    } catch {
      toast.error("Could not rename the chat");
    }
  }, []);
  const archiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: true });
    } catch {
      toast.error("Could not archive the chat");
    }
  }, []);
  const unarchiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: false });
    } catch {
      toast.error("Could not unarchive the chat");
    }
  }, []);
  const renameProject = useCallback(async (id: string, name: string) => {
    try {
      await updateProject(id, { name });
    } catch {
      toast.error("Could not rename the project");
    }
  }, []);
  const archiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: true });
    } catch {
      toast.error("Could not archive the project");
    }
  }, []);
  const unarchiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: false });
    } catch {
      toast.error("Could not unarchive the project");
    }
  }, []);

  return { renameChat, archiveChat, unarchiveChat, renameProject, archiveProject, unarchiveProject };
}
