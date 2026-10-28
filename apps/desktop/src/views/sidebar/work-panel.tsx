import { memo, useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import type { MachineInfo } from "../../lib/api/machines";
import type { Project } from "../../lib/api/projects";
import {
  PROJECT_PAGE_INITIAL,
  PROJECT_PAGE_STEP,
  sidebarGrouping,
  type PickedProject,
} from "../projects/projects";
import { ChatListItem, ProjectHeader } from "./rows";
import { CloseSidebarButton, CollapseButton } from "./chrome";

export const WorkPanel = memo(function WorkPanel({
  grouping,
  loadingChats,
  projects,
  archivedProjects,
  machines,
  chatId,
  onOpenChat,
  onCollapse,
  onClose,
  onNewChatInProject,
  onNewProject,
  onRenameChat,
  onArchiveChat,
  onRenameProject,
  onArchiveProject,
  onUnarchiveProject,
}: {
  grouping: ReturnType<typeof sidebarGrouping>;
  loadingChats: boolean;
  projects: Project[] | null;
  /** Archived section: the rows and their restore action. */
  archivedProjects?: Project[] | null;
  /** Registered machines with their live socket state — feeds each
   *  project row's machine label + online/offline dot. */
  machines?: MachineInfo[] | null;
  chatId: string | null;
  onOpenChat: (id: string) => void;
  onCollapse?: () => void;
  /** Mobile drawer only: close the sheet from the panel header. */
  onClose?: () => void;
  /** New chat with this project pre-picked (project row's hover "+"). */
  onNewChatInProject?: (project: PickedProject) => void;
  onNewProject: () => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onRenameProject?: (id: string, name: string) => void;
  onArchiveProject?: (id: string) => void;
  onUnarchiveProject?: (id: string) => void;
}) {
  /** Which project fold-outs are expanded (per-session, all collapsed). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** How many chats each expanded fold-out shows; starts at
   * PROJECT_PAGE_INITIAL, "Show more" adds PROJECT_PAGE_STEP. */
  const [limits, setLimits] = useState<Record<string, number>>({});
  /** Archived: collapsed by default, same as the chats panel's section. */
  const [archivedOpen, setArchivedOpen] = useState(false);

  const renderProject = (p: Project, archived: boolean) => {
    const open = !!expanded[p.id];
    const chats = grouping.chatsByProject[p.id] ?? [];
    const limit = limits[p.id] ?? PROJECT_PAGE_INITIAL;
    const machine = machines?.find((m) => m.machine_id === p.machine_id);
    return (
      <div key={p.id}>
        <ProjectHeader
          name={p.name}
          folder={p.folder}
          machine={
            machine || p.machine_label
              ? { name: machine?.name ?? p.machine_label ?? null, online: machine?.connected }
              : undefined
          }
          status={{
            generating: chats.some((c) => !!c.generating),
            working: chats.some((c) => !!c.generating || !!c.working),
            unread: chats.some((c) => !!c.unread),
            blocked: chats.some((c) => !!c.blocked),
          }}
          open={open}
          onToggle={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
          onRename={(name) => onRenameProject?.(p.id, name)}
          onArchive={
            archived
              ? () => onUnarchiveProject?.(p.id)
              : () => onArchiveProject?.(p.id)
          }
          archiveLabel={archived ? "Unarchive" : undefined}
          onNewChat={
            !archived && onNewChatInProject
              ? () => onNewChatInProject({ id: p.id, name: p.name, machine_label: p.machine_label })
              : undefined
          }
        />
        {open && (
          <div className="ml-4 space-y-0.5 border-l border-border/60 py-0.5 pl-2">
            {loadingChats && <SkeletonRows rows={2} className="[&>div]:h-8 [&>div]:px-2" />}
            {!loadingChats && chats.slice(0, limit).map((c) => (
              <ChatListItem
                key={c.id}
                title={c.title ?? ""}
                active={c.id === chatId}
                status={{ generating: !!c.generating, working: !!c.working, unread: !!c.unread, blocked: !!c.blocked }}
                onClick={() => onOpenChat(c.id)}
                onRename={(title) => onRenameChat?.(c.id, title)}
                onArchive={() => onArchiveChat?.(c.id)}
              />
            ))}
            {!loadingChats && chats.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet.</p>
            )}
            {chats.length > limit && (
              <button
                type="button"
                onClick={() =>
                  setLimits((l) => ({ ...l, [p.id]: limit + PROJECT_PAGE_STEP }))
                }
                className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <ChevronDown className="size-3.5" />
                Show {Math.min(PROJECT_PAGE_STEP, chats.length - limit)} more
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-semibold">Projects</span>
        <span className="flex items-center gap-1">
          <span
            role="button"
            tabIndex={0}
            title="New project"
            className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={onNewProject}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onNewProject();
            }}
          >
            <Plus className="size-4" />
          </span>
          <CollapseButton onCollapse={onCollapse} />
          {onClose !== undefined && <CloseSidebarButton onClose={onClose} />}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {projects === null &&
            [0, 1].map((i) => <SkeletonRows key={i} rows={1} className="[&>div]:h-8 [&>div]:px-2" />)}
          {projects?.map((p) => renderProject(p, false))}
          {projects !== null && projects.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No projects yet.</p>
          )}
        </div>
        {/* Archived: collapsed by default; rows expand to their chats and
            their menu offers Unarchive. */}
        {archivedProjects != null && archivedProjects.length > 0 && (
          <div className="pb-2">
            <button
              type="button"
              onClick={() => setArchivedOpen((o) => !o)}
              className="flex w-full items-center justify-between px-1 pb-1 pt-4 font-medium text-muted-foreground outline-none hover:text-foreground"
            >
              <span>Archived</span>
              {archivedOpen ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </button>
            {archivedOpen && (
              <div className="space-y-0.5">
                {archivedProjects.map((p) => renderProject(p, true))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
