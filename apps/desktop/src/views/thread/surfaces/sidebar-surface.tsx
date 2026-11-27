import { useCallback } from "react";
import { useMachines } from "../../../lib/machines-store";
import type { PickedProject } from "../../projects/projects";
import { ChatsPanel } from "../../sidebar/chats-panel";
import { archivedProjectsStore, projectsStore, useSidebarRows } from "../chat-stores";
import { useChatActions } from "../hooks/use-chat-actions";
import type { ChatRoute } from "../route";

export function SidebarSurface({
  mode,
  historyFilter,
  onHistoryFilter,
  chatId,
  projectId,
  onOpenChat,
  onNewChatInProject,
  onNewProject,
  onOpenProject,
  onBackToProjects,
  onOpenChatDeleted,
}: {
  mode?: "history" | "projects" | "search";
  historyFilter?: ChatRoute["historyFilter"];
  onHistoryFilter?: (filter: ChatRoute["historyFilter"] | null) => void;
  /** The chat selected by the route. */
  chatId: string | null;
  projectId: string | null;
  onOpenChat: (chatId: string) => void;
  onNewChatInProject: (project: PickedProject) => void;
  onNewProject: () => void;
  onOpenProject?: (id: string) => void;
  onBackToProjects?: () => void;
  /** The shown chat was deleted from its row. */
  onOpenChatDeleted: () => void;
}) {
  const { chats, grouping, archivedRows } = useSidebarRows();
  const projects = projectsStore.use();
  const archivedProjects = archivedProjectsStore.use();
  const machines = useMachines();
  const {
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
  } = useChatActions();
  const renameChatRow = useCallback(
    (id: string, title: string) => {
      void renameChat(id, title);
    },
    [renameChat],
  );
  const archiveChatRow = useCallback(
    (id: string) => {
      void archiveChat(id);
    },
    [archiveChat],
  );
  const unarchiveChatRow = useCallback(
    (id: string) => {
      void unarchiveChat(id);
    },
    [unarchiveChat],
  );
  const deleteChatRow = useCallback(
    (id: string) => {
      void deleteChat(id);
      if (chatId === id) onOpenChatDeleted();
    },
    [deleteChat, chatId, onOpenChatDeleted],
  );
  const renameProjectRow = useCallback(
    (id: string, name: string) => {
      void renameProject(id, name);
    },
    [renameProject],
  );
  const archiveProjectRow = useCallback(
    (id: string) => {
      void archiveProject(id);
    },
    [archiveProject],
  );
  const unarchiveProjectRow = useCallback(
    (id: string) => {
      void unarchiveProject(id);
    },
    [unarchiveProject],
  );

  return (
    <ChatsPanel
      mode={mode}
      historyFilter={historyFilter}
      onHistoryFilter={onHistoryFilter}
      grouping={grouping}
      loadingChats={chats === null}
      chatId={chatId}
      archivedChats={archivedRows}
      projects={projects}
      archivedProjects={archivedProjects}
      machines={machines}
      projectId={projectId}
      onNewProject={onNewProject}
      onOpenProject={onOpenProject}
      onBackToProjects={onBackToProjects}
      onNewChatInProject={onNewChatInProject}
      onRenameProject={renameProjectRow}
      onArchiveProject={archiveProjectRow}
      onUnarchiveProject={unarchiveProjectRow}
      onReorderPin={reorderPin}
      onPinChat={pinChat}
      onPinProject={pinProject}
      onOpenChat={onOpenChat}
      onRenameChat={renameChatRow}
      onArchiveChat={archiveChatRow}
      onUnarchiveChat={unarchiveChatRow}
      onDeleteChat={deleteChatRow}
    />
  );
}
