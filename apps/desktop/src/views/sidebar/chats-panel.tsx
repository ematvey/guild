import { memo, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import { Input } from "@guild/ui/components/input";
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
  dropTarget,
  onDragOver,
  onDrop,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  dropTarget?: boolean;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="space-y-0.5 pb-4" onDragOver={onDragOver} onDrop={onDrop}>
      <div className={`flex h-9 items-center gap-1 rounded-md ${dropTarget ? "ring-1 ring-inset ring-ring/60" : ""}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-left text-base font-medium text-muted-foreground hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 ${open ? "rotate-90" : ""}`} />
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
  mode = "history",
  historyFilter,
  onHistoryFilter,
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
  onReorderPin,
  onPinProject,
  loadingChats,
  chatId,
  archivedChats,
  onOpenChat,
  onRenameChat,
  onArchiveChat,
  onUnarchiveChat,
  onDeleteChat,
}: {
  grouping: SidebarGrouping;
  mode?: "history" | "projects" | "search";
  historyFilter?: "chats" | "tasks";
  onHistoryFilter?: (filter: "chats" | "tasks" | null) => void;
  projects?: Project[] | null;
  archivedProjects?: Project[] | null;
  machines?: MachineInfo[] | null;
  projectId?: string | null;
  onNewChatInProject?: (project: PickedProject) => void;
  onNewProject?: () => void;
  onRenameProject?: (id: string, name: string) => void;
  onArchiveProject?: (id: string) => void;
  onUnarchiveProject?: (id: string) => void;
  onReorderPin?: (id: string, anchorId: string, after: boolean) => void;
  onPinChat?: (id: string, pinned: boolean) => void;
  onPinProject?: (id: string, pinned: boolean) => void;
  /** True while the chat list is still loading (skeleton rows). */
  loadingChats: boolean;
  chatId: string | null;
  /** Archived section: the rows and their restore action. */
  archivedChats?: ChatSummary[] | null;
  onOpenChat: (id: string) => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onUnarchiveChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [sections, setSections] = useState({ pinned: true, recent: true, archived: false });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const [dragged, setDragged] = useState<{ id: string; kind: "chat" | "project"; pinned: boolean } | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);

  const finishDrag = () => {
    setDragged(null);
    setDropHint(null);
  };
  const dragProps = (id: string, kind: "chat" | "project", pinned: boolean) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.setData("application/x-guild-sidebar-row", id);
      event.dataTransfer.effectAllowed = pinned ? "move" : "copy";
      setDragged({ id, kind, pinned });
    },
    onDragEnd: finishDrag,
  });
  const allowDrop = (event: DragEvent<HTMLElement>) => {
    if (!dragged || !event.dataTransfer.types.includes("application/x-guild-sidebar-row")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragged.pinned ? "move" : "copy";
  };

  const activeProject = projects?.find((project) => project.id === projectId);
  const archivedProject = archivedProjects?.find((project) => project.id === projectId);
  const activeSection = archivedProject ? "archived" : "pinned";
  const hasProject = Boolean(activeProject || archivedProject);
  const activeProjectHeader = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatId !== null || !projectId || !hasProject || (!archivedProject && !activeProject?.pinned_at)) return;
    setExpanded((current) => ({ ...current, [projectId]: true }));
    setSections((current) => ({ ...current, [activeSection]: true }));
    const frame = requestAnimationFrame(() => activeProjectHeader.current?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [projectId, chatId, activeSection, hasProject, archivedProject, activeProject?.pinned_at]);

  const toggleSection = (section: keyof typeof sections) =>
    setSections((current) => ({ ...current, [section]: !current[section] }));
  const archivedProjectIds = new Set(archivedProjects?.map((project) => project.id));
  const activeProjectIds = new Set(projects?.map((project) => project.id));
  const recent = [
    ...grouping.visible,
    ...Object.entries(grouping.chatsByProject).flatMap(([id, chats]) => (activeProjectIds.has(id) ? chats : [])),
  ].sort(byRecentActivity);
  const renderChat = (chat: ChatSummary, { restricted = false, showChatIcon = false } = {}) => {
    const sharedInbox = chat.shared_agent_inbox === true;
    return (
      <ChatListItem
        key={chat.id}
        title={chat.title ?? ""}
        showChatIcon={showChatIcon}
        routine={chat.routine?.name}
        active={chat.id === chatId}
        status={{
          generating: !!chat.generating,
          working: !!chat.working,
          unread: !!chat.unread && !chat.archived,
          blocked: !!chat.blocked,
        }}
        dragProps={
          !restricted && !chat.archived && !sharedInbox && onPinChat
            ? dragProps(chat.id, "chat", !!chat.pinned_at)
            : undefined
        }
        pinned={!!chat.pinned_at}
        onPin={
          !restricted && !sharedInbox && onPinChat
            ? () => onPinChat(chat.id, !chat.pinned_at)
            : undefined
        }
        onClick={() => onOpenChat(chat.id)}
        onRename={!chat.archived && !sharedInbox && onRenameChat ? (title) => onRenameChat(chat.id, title) : undefined}
        archiveLabel={chat.archived ? "Unarchive" : undefined}
        onArchive={
          sharedInbox
            ? undefined
            : chat.archived
              ? onUnarchiveChat && (() => onUnarchiveChat(chat.id))
              : onArchiveChat && (() => onArchiveChat(chat.id))
        }
        onDelete={
          onDeleteChat && !sharedInbox ? () => setDeleteTarget({ id: chat.id, title: chat.title ?? "" }) : undefined
        }
      />
    );
  };

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
            dragProps={!archived && onPinProject ? dragProps(project.id, "project", !!project.pinned_at) : undefined}
            pinned={!!project.pinned_at}
            onPin={!archived && onPinProject ? () => onPinProject(project.id, !project.pinned_at) : undefined}
            onNewChat={!archived && onNewChatInProject ? () => onNewChatInProject(project) : undefined}
          />
        </div>
        {open && (
          <div className="ml-5 space-y-0.5">
            {loadingChats && <SkeletonRows rows={2} className="[&>div]:h-8 [&>div]:px-2" />}
            {history.slice(0, limit).map((chat) => renderChat(chat, { restricted: archived }))}
            {!loadingChats && history.length === 0 && (
              <p className="px-2 py-1 text-base text-muted-foreground">No chats yet.</p>
            )}
            {history.length > limit && (
              <button
                type="button"
                onClick={() => setLimits((current) => ({ ...current, [project.id]: limit + PROJECT_PAGE_STEP }))}
                className="ml-1.5 mt-1 rounded-md px-2 py-1 text-base text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                Show more
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const pins = [
    ...recent.flatMap((chat) =>
      chat.pinned_at
        ? [
            {
              id: chat.id,
              rank: chat.pin_rank,
              time: chat.pinned_at,
              render: () => renderChat(chat, { showChatIcon: true }),
            },
          ]
        : [],
    ),
    ...(projects ?? []).flatMap((project) =>
      project.pinned_at
        ? [{ id: project.id, rank: project.pin_rank, time: project.pinned_at, render: () => renderProject(project) }]
        : [],
    ),
  ].sort(
    (a, b) =>
      (a.rank ?? -1) - (b.rank ?? -1) ||
      b.time.slice(0, -1).localeCompare(a.time.slice(0, -1)) ||
      a.id.localeCompare(b.id),
  );
  const dropOnPinned = (event: DragEvent<HTMLElement>, anchorId = pins[0]?.id, after = false) => {
    if (!dragged || event.dataTransfer.getData("application/x-guild-sidebar-row") !== dragged.id) return;
    event.preventDefault();
    if (dragged.pinned) {
      if (anchorId && anchorId !== dragged.id) onReorderPin?.(dragged.id, anchorId, after);
    } else {
      (dragged.kind === "chat" ? onPinChat : onPinProject)?.(dragged.id, true);
    }
    setSections((current) => ({ ...current, pinned: true }));
    finishDrag();
  };
  const archivedThreads = archivedChats?.filter((chat) => !chat.project_id || !archivedProjectIds.has(chat.project_id));
  const query = search.trim().toLocaleLowerCase();
  const matches = query === "" ? [] : [
    ...grouping.visible,
    ...Object.values(grouping.chatsByProject).flat(),
    ...(archivedChats ?? []),
  ]
    .filter((chat) => (chat.title ?? "").toLocaleLowerCase().includes(query))
    .sort(byRecentActivity);
  if (mode === "projects") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h1 className="text-base font-semibold">Projects</h1>
            <button type="button" onClick={onNewProject} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-base hover:bg-accent">
              <Plus aria-hidden="true" className="size-4" /> New project
            </button>
          </div>
          <div aria-label="Projects" className="divide-y divide-border rounded-lg border border-border bg-card px-2">
            {projects === null && <SkeletonRows rows={3} />}
            {projects?.map((project) => renderProject(project))}
            {projects?.length === 0 && <p className="p-4 text-base text-muted-foreground">No projects yet.</p>}
          </div>
        </div>
      </div>
    );
  }
  if (mode === "search") {
    return (
      <>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" aria-label="Search chats by title" placeholder="Search chats by title"
            value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9 text-base md:text-base" />
        </div>
        <section aria-label="Chat search results" className="max-h-[55dvh] space-y-0.5 overflow-y-auto">
          {loadingChats && <SkeletonRows rows={3} />}
          {!loadingChats && query !== "" && matches.length === 0 && (
            <p className="px-2 py-2 text-base text-muted-foreground">No matching chats.</p>
          )}
          {matches.map((chat) => renderChat(chat, { restricted: true, showChatIcon: true }))}
        </section>
      </>
    );
  }
  const history = recent.filter((chat) => !historyFilter || (chat.type === "routine" || Boolean(chat.routine)) === (historyFilter === "tasks"));
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col text-base">
      <div className="px-2">
        <ChatSection
          label="Pinned"
          open={sections.pinned}
          dropTarget={!!dragged && !dropHint}
          onToggle={() => toggleSection("pinned")}
          onDragOver={(event) => {
            allowDrop(event);
            if (dropHint) setDropHint(null);
          }}
          onDrop={dropOnPinned}
        >
          {pins.map((pin) => (
            <div
              key={pin.id}
              className="relative"
              onDragOver={(event) => {
                if (!dragged?.pinned || dragged.id === pin.id || !onReorderPin) return;
                event.stopPropagation();
                allowDrop(event);
                const bounds = event.currentTarget.getBoundingClientRect();
                const after = event.clientY >= bounds.top + bounds.height / 2;
                if (dropHint?.id !== pin.id || dropHint.after !== after) setDropHint({ id: pin.id, after });
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDropHint(null);
                }
              }}
              onDrop={(event) => {
                if (!dragged?.pinned) return;
                event.stopPropagation();
                dropOnPinned(event, pin.id, dropHint?.id === pin.id && dropHint.after);
              }}
            >
              {dropHint?.id === pin.id && (
                <div
                  className={`pointer-events-none absolute inset-x-1 z-20 h-0.5 rounded bg-ring ${dropHint.after ? "bottom-0" : "top-0"}`}
                />
              )}
              {pin.render()}
            </div>
          ))}
        </ChatSection>
        <ChatSection
          label="Chats and tasks"
          open={sections.recent}
          onToggle={() => toggleSection("recent")}
          action={onHistoryFilter && (
            <select aria-label="Filter history" value={historyFilter ?? ""}
              className="max-w-20 rounded-md bg-sidebar px-1 text-base text-muted-foreground hover:text-sidebar-foreground"
              onChange={(event) => {
                const value = event.currentTarget.value;
                onHistoryFilter(value === "chats" || value === "tasks" ? value : null);
              }}>
              <option value="">All</option>
              <option value="chats">Chats</option>
              <option value="tasks">Tasks</option>
            </select>
          )}
        >
          {loadingChats && <SkeletonRows rows={5} className="[&>div]:h-8 [&>div]:px-2" />}
          {!loadingChats && history.map((chat) => renderChat(chat))}
          {!loadingChats && history.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">No conversations yet.</p>
          )}
        </ChatSection>
        <ChatSection label="Archived" open={sections.archived} onToggle={() => toggleSection("archived")}>
          {!archivedProjects?.length && !archivedThreads?.length && (
            <p className="px-2 py-1.5 text-base text-muted-foreground">Nothing archived yet.</p>
          )}
          {!!archivedProjects?.length && (
            <div role="group" aria-label="Archived projects" className="space-y-0.5">
              <p className="px-2 py-1 text-base text-muted-foreground">Projects</p>
              {archivedProjects.map((project) => renderProject(project, true))}
            </div>
          )}
          {!!archivedThreads?.length && (
            <div role="group" aria-label="Archived chats" className="space-y-0.5">
              <p className="px-2 py-1 text-base text-muted-foreground">Chats</p>
              {archivedThreads.map((chat) => renderChat(chat, { restricted: true }))}
            </div>
          )}
        </ChatSection>
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
