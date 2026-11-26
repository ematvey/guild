// Sidebar row actions: rename, archive and delete for chats and projects.
// Each one writes through the transport; the server pushes the updated
// workspace lists, so no list is re-read here.
import { useCallback } from "react";
import { toast } from "sonner";
import { deleteChat as deleteChatRequest, reorderSidebarPin, updateChat } from "../../../lib/api/chats";
import { updateProject } from "../../../lib/api/projects";
import { ApiError } from "../../../lib/api/request";

/** Reports a failed row action. The title is fixed per action; the server's
 *  own message rides along as the description, so a refusal the user can act
 *  on (a folder a live project already holds) is not hidden behind it. */
function failed(title: string, error: unknown): void {
  const reason = error instanceof ApiError ? error.message : "";
  toast.error(title, reason === "" ? undefined : { description: reason });
}

export function useChatActions() {
  const renameChat = useCallback(async (id: string, title: string) => {
    try {
      await updateChat(id, { title });
    } catch (error) {
      failed("Could not rename the chat", error);
    }
  }, []);
  const archiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: true });
    } catch (error) {
      failed("Could not archive the chat", error);
    }
  }, []);
  const unarchiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: false });
    } catch (error) {
      failed("Could not unarchive the chat", error);
    }
  }, []);
  const deleteChat = useCallback(async (id: string) => {
    try {
      await deleteChatRequest(id);
    } catch (error) {
      failed("Could not delete the chat", error);
    }
  }, []);
  const renameProject = useCallback(async (id: string, name: string) => {
    try {
      await updateProject(id, { name });
    } catch (error) {
      failed("Could not rename the project", error);
    }
  }, []);
  const archiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: true });
    } catch (error) {
      failed("Could not archive the project", error);
    }
  }, []);
  const unarchiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: false });
    } catch (error) {
      failed("Could not unarchive the project", error);
    }
  }, []);

  const pinChat = useCallback(async (id: string, pinned: boolean) => {
    try {
      await updateChat(id, { pinned });
    } catch (error) {
      failed(pinned ? "Could not pin the chat" : "Could not unpin the chat", error);
    }
  }, []);
  const pinProject = useCallback(async (id: string, pinned: boolean) => {
    try {
      await updateProject(id, { pinned });
    } catch (error) {
      failed(pinned ? "Could not pin the project" : "Could not unpin the project", error);
    }
  }, []);

  const reorderPin = useCallback(async (id: string, anchorId: string, after: boolean) => {
    try {
      await reorderSidebarPin(id, anchorId, after);
    } catch (error) {
      failed("Could not reorder the pin", error);
    }
  }, []);

  return {
    reorderPin,
    pinChat,
    pinProject,
    renameChat,
    archiveChat,
    unarchiveChat,
    deleteChat,
    renameProject,
    archiveProject,
    unarchiveProject,
  };
}
