import { useCallback } from "react";
import { useMachines } from "../../../lib/machines-store";
import type { PickedProject } from "../../projects/projects";
import { ChatsPanel } from "../../sidebar/chats-panel";
import { SettingsPanel } from "../../sidebar/settings-panel";
import { archivedProjectsStore, projectsStore, useSidebarRows } from "../chat-stores";
import { useChatActions } from "../hooks/use-chat-actions";
import type { ChatRoute } from "../route";

export function SidebarSurface({
  tab,
  role,
  inControl,
  onControlTab,
  chatId,
  projectId,
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
  inControl: boolean;
  onControlTab: (tab: "agents" | "activity" | "integrations") => void;
  /** The chat the main column shows. */
  chatId: string | null;
  projectId: string | null;
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

  if (tab === "settings") {
    return (
      <SettingsPanel
        role={role}
        inControl={inControl}
        onControlTab={onControlTab}
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
      projects={projects}
      archivedProjects={archivedProjects}
      machines={machines}
      projectId={projectId}
      onNewProject={onNewProject}
      onNewChatInProject={onNewChatInProject}
      onRenameProject={renameProjectRow}
      onArchiveProject={archiveProjectRow}
      onUnarchiveProject={unarchiveProjectRow}
      onReorderPin={reorderPin}
      onPinChat={pinChat}
      onPinProject={pinProject}
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
