// The sidebar panel the rail's tab picks: the chat list, the Work tab's
// projects, or the settings sections. It reads the chat stores the member
// socket writes and performs the row actions itself.
import { useCallback } from "react";
import { useMachines } from "../../../lib/machines-store";
import type { PickedProject } from "../../projects/projects";
import { ChatsPanel } from "../../sidebar/chats-panel";
import { SettingsPanel } from "../../sidebar/settings-panel";
import { WorkPanel } from "../../sidebar/work-panel";
import { archivedProjectsStore, projectsStore, useSidebarRows } from "../chat-stores";
import { useChatActions } from "../hooks/use-chat-actions";
import type { ChatRoute } from "../route";

export function SidebarSurface({
  tab,
  role,
  chatId,
  settingsSection,
  onNewChat,
  onOpenChat,
  onNewChatInProject,
  onNewProject,
  onSelectSection,
  onOpenChatDeleted,
  onCollapse,
  onClose,
}: {
  tab: ChatRoute["tab"];
  role: string;
  /** The chat the main column shows. */
  chatId: string | null;
  settingsSection: string | null;
  onNewChat: () => void;
  onOpenChat: (chatId: string) => void;
  onNewChatInProject: (project: PickedProject) => void;
  onNewProject: () => void;
  onSelectSection: (id: string) => void;
  /** The shown chat was deleted from its row. */
  onOpenChatDeleted: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  const { chats, grouping, archivedRows, archivedGrouping } = useSidebarRows();
  const projects = projectsStore.use();
  const archivedProjects = archivedProjectsStore.use();
  const machines = useMachines();
  const { renameChat, archiveChat, unarchiveChat, deleteChat, renameProject, archiveProject, unarchiveProject } =
    useChatActions();
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

  if (tab === "work") {
    return (
      <WorkPanel
        loadingChats={chats === null}
        loadingArchivedChats={archivedRows === null}
        grouping={grouping}
        archivedGrouping={archivedGrouping}
        projects={projects}
        archivedProjects={archivedProjects}
        machines={machines}
        chatId={chatId}
        onOpenChat={onOpenChat}
        onCollapse={onCollapse}
        onClose={onClose}
        onNewChatInProject={onNewChatInProject}
        onNewProject={onNewProject}
        onRenameChat={renameChatRow}
        onArchiveChat={archiveChatRow}
        onUnarchiveChat={unarchiveChatRow}
        onRenameProject={renameProjectRow}
        onArchiveProject={archiveProjectRow}
        onUnarchiveProject={unarchiveProjectRow}
      />
    );
  }
  if (tab === "settings") {
    return (
      <SettingsPanel
        role={role}
        activeSection={settingsSection}
        onSelectSection={onSelectSection}
        onCollapse={onCollapse}
        onClose={onClose}
      />
    );
  }
  return (
    <ChatsPanel
      grouping={grouping}
      loadingChats={chats === null}
      chatId={chatId}
      archivedChats={archivedRows}
      onNewChat={onNewChat}
      onOpenChat={onOpenChat}
      onCollapse={onCollapse}
      onClose={onClose}
      onRenameChat={renameChatRow}
      onArchiveChat={archiveChatRow}
      onUnarchiveChat={unarchiveChatRow}
      onDeleteChat={deleteChatRow}
    />
  );
}
