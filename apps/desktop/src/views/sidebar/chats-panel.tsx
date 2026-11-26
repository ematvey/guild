import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus, SquarePen } from "lucide-react";
import { DesktopTooltip } from "../../components/desktop-tooltip";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import type { ChatSummary } from "../../lib/api/chats";
import type { Project } from "../../lib/api/projects";
import type { MachineInfo } from "../../lib/api/machines";
import {
  byRecentActivity,
  PROJECT_PAGE_INITIAL,
  PROJECT_PAGE_STEP,
  type PickedProject,
  type SidebarGrouping,
} from "../projects/projects";
import { ChatListItem, ProjectHeader } from "./rows";
import { CloseSidebarButton, CollapseButton } from "./chrome";
import { TOP_ROW, titleBarDragDeep } from "../../lib/titlebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";

function ChatSection({
  label,
  open,
  onToggle,
  action,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="space-y-0.5 pb-3">
      <div className="flex h-8 items-center gap-1 px-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight aria-hidden="true" className={`size-3.5 ${open ? "rotate-90" : ""}`} />
          {label}
        </button>
        {action}
      </div>
      {open && children}
    </section>
  );
}

export const ChatsPanel = memo(function ChatsPanel({
  grouping,
  projects = null,
  archivedProjects,
  machines,
  projectId,
  onNewChatInProject,
  onNewProject,
  onRenameProject,
  onArchiveProject,
  onUnarchiveProject,
  onPinChat,
  onPinProject,
  loadingChats,
  chatId,
  archivedChats,
  onNewChat,
  onOpenChat,
  onCollapse,
  onClose,
  onRenameChat,
  onArchiveChat,
  onUnarchiveChat,
  onDeleteChat,
}: {
  grouping: SidebarGrouping;
  projects?: Project[] | null;
  archivedProjects?: Project[] | null;
  machines?: MachineInfo[] | null;
  projectId?: string | null;
  onNewChatInProject?: (project: PickedProject) => void;
  onNewProject?: () => void;
  onRenameProject?: (id: string, name: string) => void;
  onArchiveProject?: (id: string) => void;
  onUnarchiveProject?: (id: string) => void;
  onPinChat?: (id: string, pinned: boolean) => void;
  onPinProject?: (id: string, pinned: boolean) => void;
  /** True while the chat list is still loading (skeleton rows). */
  loadingChats: boolean;
  chatId: string | null;
  /** Archived section: the rows and their restore action. */
  archivedChats?: ChatSummary[] | null;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  /** Desktop only: collapse the sidebar from within its own header. */
  onCollapse?: () => void;
  /** Mobile drawer only: close the sheet from the panel header (the
   *  sheet's built-in corner close is suppressed to keep this row clean). */
  onClose?: () => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onUnarchiveChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [sections, setSections] = useState({ pinned: true, projects: false, recent: true, archived: false });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const activeProject = projects?.find((project) => project.id === projectId);
  const archivedProject = archivedProjects?.find((project) => project.id === projectId);
  const activeSection = archivedProject ? "archived" : activeProject?.pinned_at ? "pinned" : "projects";
  const hasProject = Boolean(activeProject || archivedProject);
  const activeProjectHeader = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!projectId || !hasProject) return;
    setExpanded((current) => ({ ...current, [projectId]: true }));
    setSections((current) => ({ ...current, [activeSection]: true }));
    const frame = requestAnimationFrame(() => activeProjectHeader.current?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [projectId, chatId, activeSection, hasProject]);

  const toggleSection = (section: keyof typeof sections) =>
    setSections((current) => ({ ...current, [section]: !current[section] }));
  const archivedProjectIds = new Set(archivedProjects?.map((project) => project.id));
  const assistants = grouping.visible.filter((chat) => chat.assistant_inbox);
  const activeProjectIds = new Set(projects?.map((project) => project.id));
  const recent = [
    ...grouping.visible.filter((chat) => !chat.assistant_inbox),
    ...Object.entries(grouping.chatsByProject).flatMap(([id, chats]) => (activeProjectIds.has(id) ? chats : [])),
  ].sort(byRecentActivity);
  const renderChat = (chat: ChatSummary, restricted = false) => (
    <ChatListItem
      key={chat.id}
      title={chat.title ?? ""}
      assistantInbox={chat.assistant_inbox}
      routine={chat.routine?.name}
      active={chat.id === chatId}
      status={{
        generating: !!chat.generating,
        working: !!chat.working,
        unread: !!chat.unread && !chat.archived,
        blocked: !!chat.blocked,
      }}
      pinned={!!chat.pinned_at}
      onPin={!restricted && !chat.assistant_inbox && onPinChat ? () => onPinChat(chat.id, !chat.pinned_at) : undefined}
      onClick={() => onOpenChat(chat.id)}
      onRename={!chat.archived && onRenameChat ? (title) => onRenameChat(chat.id, title) : undefined}
      archiveLabel={chat.archived ? "Unarchive" : undefined}
      onArchive={
        chat.archived
          ? onUnarchiveChat && (() => onUnarchiveChat(chat.id))
          : onArchiveChat && (() => onArchiveChat(chat.id))
      }
      onDelete={onDeleteChat ? () => setDeleteTarget({ id: chat.id, title: chat.title ?? "" }) : undefined}
    />
  );

  const renderProject = (project: Project, archived = false) => {
    const chats = grouping.chatsByProject[project.id] ?? [];
    const history = archived
      ? [...chats, ...(archivedChats ?? []).filter((chat) => chat.project_id === project.id)].sort(byRecentActivity)
      : chats;
    const open = !!expanded[project.id];
    const activeIndex = open && projectId === project.id ? history.findIndex((chat) => chat.id === chatId) : -1;
    const limit = Math.max(limits[project.id] ?? PROJECT_PAGE_INITIAL, activeIndex + 1);
    const machine = machines?.find((item) => item.machine_id === project.machine_id);
    return (
      <div key={project.id}>
        <div ref={projectId === project.id ? activeProjectHeader : undefined}>
          <ProjectHeader
            name={project.name}
            folder={project.folder}
            machine={{ name: machine?.name ?? project.machine_label, online: machine?.connected }}
            status={{
              generating: chats.some((chat) => !!chat.generating),
              working: chats.some((chat) => !!chat.working),
              unread: chats.some((chat) => !!chat.unread),
              blocked: chats.some((chat) => !!chat.blocked),
            }}
            open={open}
            onToggle={() => setExpanded((current) => ({ ...current, [project.id]: !open }))}
            onRename={(name) => onRenameProject?.(project.id, name)}
            onArchive={() => (archived ? onUnarchiveProject : onArchiveProject)?.(project.id)}
            archiveLabel={archived ? "Unarchive" : undefined}
            pinned={!!project.pinned_at}
            onPin={!archived && onPinProject ? () => onPinProject(project.id, !project.pinned_at) : undefined}
            onNewChat={!archived && onNewChatInProject ? () => onNewChatInProject(project) : undefined}
          />
        </div>
        {open && (
          <div className="ml-4 space-y-0.5 border-l border-border/60 py-0.5 pl-2">
            {loadingChats && <SkeletonRows rows={2} className="[&>div]:h-8 [&>div]:px-2" />}
            {history.slice(0, limit).map((chat) => renderChat(chat, archived))}
            {!loadingChats && history.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet.</p>
            )}
            {history.length > limit && (
              <button
                type="button"
                onClick={() => setLimits((current) => ({ ...current, [project.id]: limit + PROJECT_PAGE_STEP }))}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <ChevronDown aria-hidden="true" className="size-3.5" />
                Show {Math.min(PROJECT_PAGE_STEP, history.length - limit)} more
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const pins = [
    ...recent.flatMap((chat) =>
      chat.pinned_at ? [{ id: chat.id, time: chat.pinned_at, render: () => renderChat(chat) }] : [],
    ),
    ...(projects ?? []).flatMap((project) =>
      project.pinned_at ? [{ id: project.id, time: project.pinned_at, render: () => renderProject(project) }] : [],
    ),
  ].sort((a, b) => b.time.slice(0, -1).localeCompare(a.time.slice(0, -1)) || a.id.localeCompare(b.id));
  const unpinnedProjects = projects?.filter((project) => !project.pinned_at);
  const archivedThreads = archivedChats?.filter((chat) => !chat.project_id || !archivedProjectIds.has(chat.project_id));
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col text-base">
      <div {...titleBarDragDeep} className={`flex items-center justify-between px-3 ${TOP_ROW}`}>
        {/* The workspace switcher lives on the rail's first button; the panel
            header names the tab. A new chat is its own row under the
            assistant, not a header button. */}
        <span className="font-semibold">Chats</span>
        <span className="flex items-center gap-1">
          <CollapseButton onCollapse={onCollapse} />
          {onClose !== undefined && <CloseSidebarButton onClose={onClose} />}
        </span>
      </div>
      {!loadingChats && (
        <div
          className={`relative z-10 shrink-0 space-y-0.5 px-2 pb-3.5 pt-2 ${scrolled ? "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b after:border-border/60" : ""}`}
        >
          {assistants.length > 0 && (
            <div role="group" aria-label="Assistant conversations" className="space-y-0.5">
              {assistants.map((chat) => renderChat(chat))}
            </div>
          )}
          <DesktopTooltip label="New chat" hotkey="mod+N" browserHotkey="Ctrl+Alt+N">
            <button
              type="button"
              onClick={onNewChat}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <SquarePen aria-hidden="true" className="size-4 shrink-0" />
              <span>New chat</span>
            </button>
          </DesktopTooltip>
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      >
        {pins.length > 0 && (
          <ChatSection label="Pinned" open={sections.pinned} onToggle={() => toggleSection("pinned")}>
            {pins.map((pin) => pin.render())}
          </ChatSection>
        )}
        <ChatSection
          label="Projects"
          open={sections.projects}
          onToggle={() => toggleSection("projects")}
          action={
            onNewProject && (
              <button
                type="button"
                title="New project"
                aria-label="New project"
                onClick={() => {
                setSections((current) => ({ ...current, projects: true }));
                onNewProject();
              }}
                className="rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Plus aria-hidden="true" className="size-4" />
              </button>
            )
          }
        >
          {projects === null && onNewProject && <SkeletonRows rows={1} />}
          {unpinnedProjects?.map((project) => renderProject(project))}
          {projects?.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No projects yet.</p>}
        </ChatSection>
        <ChatSection label="Recent" open={sections.recent} onToggle={() => toggleSection("recent")}>
          {loadingChats && <SkeletonRows rows={5} className="[&>div]:h-8 [&>div]:px-2" />}
          {!loadingChats && recent.map((chat) => renderChat(chat))}
          {!loadingChats && recent.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">No conversations yet.</p>
          )}
        </ChatSection>
        {!!(archivedProjects?.length || archivedThreads?.length) && (
          <ChatSection label="Archived" open={sections.archived} onToggle={() => toggleSection("archived")}>
            {!!archivedProjects?.length && (
              <div role="group" aria-label="Archived projects" className="space-y-0.5">
                <p className="px-2 py-1 text-xs text-muted-foreground">Projects</p>
                {archivedProjects.map((project) => renderProject(project, true))}
              </div>
            )}
            {!!archivedThreads?.length && (
              <div role="group" aria-label="Archived chats" className="space-y-0.5">
                <p className="px-2 py-1 text-xs text-muted-foreground">Chats</p>
                {archivedThreads.map((chat) => renderChat(chat, true))}
              </div>
            )}
          </ChatSection>
        )}
      </div>
      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title || "this thread"}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The thread leaves your lists and its runs stop. Its transcript is kept. This cannot be undone in the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white"
              onClick={() => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) onDeleteChat?.(target.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
