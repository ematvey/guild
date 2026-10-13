// The three sidebar panels (Chats / Work / Settings) plus the row
// primitives they render. WebChat composes exactly one per rail tab; the
// rail carries the account menu, so none of these render it.

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  EllipsisVertical,
  Loader2,
  PanelLeftClose,
  Pencil,
  Plus,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { Skeleton } from "@guild/ui/components/skeleton";
import type { ChatSummary, MachineInfo, Project } from "../transport";
import {
  PROJECT_PAGE_INITIAL,
  PROJECT_PAGE_STEP,
  sidebarGrouping,
  type PickedProject,
} from "./projects/projects";
import { SETTINGS_SECTIONS } from "./settings/SettingsWindow";

/** Row title that fades out at the right edge when it overflows (instead
 * of an ellipsis); also used by the composer's project chip in WebChat. */
export function FadeTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const fade = overflowing
    ? {
        maskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
        WebkitMaskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
      }
    : undefined;

  return (
    <span ref={ref} className="block min-w-0 flex-1 whitespace-nowrap" style={fade}>
      {text}
    </span>
  );
}

/** Inline rename field: Enter or blur commits, Esc cancels; `onDone(null)`
 * means "no change". */
function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const v = ref.current?.value.trim();
    onDone(commit && v && v !== initial ? v : null);
  };
  return (
    <input
      ref={ref}
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-sm outline-none"
    />
  );
}

/** Hover-revealed row menu (Rename / Archive). The trigger is absolutely
 * positioned and shown via opacity, so the row's layout never shifts;
 * stays visible while the menu is open. */
function RowActions({
  onRename,
  onArchive,
  archiveLabel,
}: {
  onRename?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
}) {
  if (!onRename && !onArchive) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          title="Row actions"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-sidebar text-muted-foreground shadow-sm opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
        >
          <EllipsisVertical className="size-4" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {onRename && (
          <DropdownMenuItem onSelect={() => onRename()}>
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
        )}
        {onArchive && (
          <DropdownMenuItem onSelect={() => onArchive()}>
            {archiveLabel === "Unarchive" ? (
              <ArchiveRestore className="size-3.5" />
            ) : (
              <Archive className="size-3.5" />
            )}
            {archiveLabel ?? "Archive"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatListItem({
  title,
  active,
  status,
  onClick,
  onRename,
  onArchive,
  archiveLabel,
}: {
  title: string;
  active: boolean;
  status: { generating: boolean; unread: boolean };
  onClick: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
  /** Row-menu label for the archive action ("Unarchive" in the Archived
   * section); defaults to "Archive". */
  archiveLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5">
        <RenameInput
          initial={title}
          onDone={(v) => {
            setEditing(false);
            if (v) onRename?.(v);
          }}
        />
      </div>
    );
  }
  return (
    // A div row hosting two siblings — the open button and the (absolutely
    // positioned) Radix menu trigger — instead of a button containing the
    // trigger: an interactive control nested in a button is non-conforming
    // HTML and screen readers announce the menu trigger as part of the
    // row's name. The background/hover classes stay on the row so hovering
    // the trigger highlights it too.
    <div
      className={`group/row relative z-0 flex w-full items-center overflow-hidden rounded-md transition-colors hover:z-10 has-[[data-state=open]]:z-10 ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      <button
        onClick={onClick}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left outline-none"
      >
        <FadeTitle text={title} />
        {status.generating ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : status.unread ? (
          <span className="size-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_4px_1px_rgba(251,191,36,0.6)]" title="unseen replies" />
        ) : null}
      </button>
      <RowActions
        onRename={onRename ? () => setEditing(true) : undefined}
        onArchive={onArchive}
        archiveLabel={archiveLabel}
      />
    </div>
  );
}

/** Project row header: fold-out toggle + shaded title + row menu. While
 * renaming, the whole header is a plain div hosting the inline input. */
function ProjectHeader({
  name,
  folder,
  machine,
  status,
  open,
  onToggle,
  onRename,
  onArchive,
  onNewChat,
}: {
  name: string;
  folder: string;
  /** The machine the project is bound to: its name rides the row title
   *  with an online/offline dot (hidden while the socket state is
   *  unknown — e.g. the machines list has not landed yet). */
  machine?: { name: string | null; online: boolean | undefined };
  /** Aggregate over the project's chats: the same status treatment the
   * chat rows use (generating spinner wins over the unread dot). */
  status: { generating: boolean; unread: boolean };
  open: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onNewChat?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5">
        <RenameInput
          initial={name}
          onDone={(v) => {
            setEditing(false);
            if (v) onRename(v);
          }}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/row relative z-0 flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none transition-colors text-muted-foreground hover:z-10 has-[[data-state=open]]:z-10 hover:bg-accent hover:text-accent-foreground"
      title={folder}
    >
      <ChevronRight
        className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      />
      <FadeTitle text={name} />
      {machine?.name && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70">
          {machine.online !== undefined &&
            (machine.online ? (
              <span className="relative flex size-1.5 shrink-0">
                <span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-emerald-500/60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
              </span>
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            ))}
          <span className="max-w-20 truncate">{machine.name}</span>
        </span>
      )}
      {status.generating ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : status.unread ? (
        <span className="size-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_4px_1px_rgba(251,191,36,0.6)]" title="unseen replies" />
      ) : null}
      {onNewChat && (
        <span
          role="button"
          tabIndex={0}
          title="New chat in this project"
          onClick={(e) => {
            e.stopPropagation();
            onNewChat();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onNewChat();
            }
          }}
          // right-1 + size-6 + 2px gap → the two hover buttons sit 2px apart
          className="absolute right-[30px] top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-sidebar text-muted-foreground shadow-sm opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <Plus className="size-4" />
        </span>
      )}
      <RowActions onRename={() => setEditing(true)} onArchive={onArchive} />
    </button>
  );
}

/** Collapse button shared by every panel header (desktop only). */
export function CollapseButton({ onCollapse }: { onCollapse?: () => void }) {
  return onCollapse ? (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      onClick={onCollapse}
      title="Close sidebar"
    >
      <PanelLeftClose />
    </Button>
  ) : null;
}

// ---- Chats tab ----

export function ChatsPanel({
  grouping,
  loadingChats,
  chatId,
  archivedChats,
  onNewChat,
  onOpenChat,
  onCollapse,
  onRenameChat,
  onArchiveChat,
  onUnarchiveChat,
}: {
  grouping: ReturnType<typeof sidebarGrouping>;
  /** True while the chat list is still loading (skeleton rows). */
  loadingChats: boolean;
  chatId: string | null;
  /** Archived section: the rows and their restore action. */
  archivedChats?: ChatSummary[] | null;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  /** Desktop only: collapse the sidebar from within its own header. */
  onCollapse?: () => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onUnarchiveChat?: (id: string) => void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        {/* The workspace switcher lives on the rail's first button; the panel
            header names the tab and carries the new-chat plus, like the
            Projects panel. */}
        <span className="font-semibold">Chats</span>
        <span className="flex items-center gap-1">
          <span
            role="button"
            tabIndex={0}
            title="New chat"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onNewChat}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onNewChat();
            }}
          >
            <Plus className="size-4" />
          </span>
          <CollapseButton onCollapse={onCollapse} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="flex items-center gap-1.5 pb-1 pt-4 font-medium text-muted-foreground">
          <span className="px-1">Recents</span>
        </div>
        <div className="space-y-0.5 pb-2">
          {loadingChats &&
            [0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          {!loadingChats &&
            grouping.visible.map((c) => (
              <ChatListItem
                key={c.id}
                title={c.title || "Untitled"}
                active={c.id === chatId}
                status={{ generating: !!c.generating, unread: !!c.unread }}
                onClick={() => onOpenChat(c.id)}
                onRename={(title) => onRenameChat?.(c.id, title)}
                onArchive={() => onArchiveChat?.(c.id)}
              />
            ))}
          {!loadingChats && grouping.visible.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">No conversations yet.</p>
          )}
        </div>
        {/* Archived: collapsed by default; rows open by direct link (the
            thread always resolves) and their menu offers Unarchive. */}
        {archivedChats != null && archivedChats.length > 0 && (
          <div className="pb-2">
            <button
              type="button"
              onClick={() => setArchivedOpen((o) => !o)}
              className="flex w-full items-center justify-between px-1 pb-1 pt-4 font-medium text-muted-foreground outline-none hover:text-foreground"
            >
              <span>Archived</span>
              {archivedOpen ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>
            {archivedOpen && (
              <div className="space-y-0.5">
                {archivedChats.map((c) => (
                  <ChatListItem
                    key={c.id}
                    title={c.title || "Untitled"}
                    active={c.id === chatId}
                    status={{ generating: !!c.generating, unread: false }}
                    onClick={() => onOpenChat(c.id)}
                    archiveLabel="Unarchive"
                    onArchive={onUnarchiveChat ? () => onUnarchiveChat(c.id) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Work tab ----

export function WorkPanel({
  grouping,
  projects,
  machines,
  chatId,
  onOpenChat,
  onCollapse,
  onNewChatInProject,
  onNewProject,
  onRenameChat,
  onArchiveChat,
  onRenameProject,
  onArchiveProject,
}: {
  grouping: ReturnType<typeof sidebarGrouping>;
  projects: Project[] | null;
  /** Registered machines with their live socket state — feeds each
   *  project row's machine label + online/offline dot. */
  machines?: MachineInfo[] | null;
  chatId: string | null;
  onOpenChat: (id: string) => void;
  onCollapse?: () => void;
  /** New chat with this project pre-picked (project row's hover "+"). */
  onNewChatInProject?: (project: PickedProject) => void;
  onNewProject: () => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onRenameProject?: (id: string, name: string) => void;
  onArchiveProject?: (id: string) => void;
}) {
  /** Which project fold-outs are expanded (per-session, all collapsed). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** How many chats each expanded fold-out shows; starts at
   * PROJECT_PAGE_INITIAL, "Show more" adds PROJECT_PAGE_STEP. */
  const [limits, setLimits] = useState<Record<string, number>>({});
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-semibold">Projects</span>
        <span className="flex items-center gap-1">
          <span
            role="button"
            tabIndex={0}
            title="New project"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onNewProject}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onNewProject();
            }}
          >
            <Plus className="size-4" />
          </span>
          <CollapseButton onCollapse={onCollapse} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {projects === null &&
            [0, 1].map((i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
          {projects?.map((p) => {
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
                    unread: chats.some((c) => !!c.unread),
                  }}
                  open={open}
                  onToggle={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                  onRename={(name) => onRenameProject?.(p.id, name)}
                  onArchive={() => onArchiveProject?.(p.id)}
                  onNewChat={
                    onNewChatInProject
                      ? () => onNewChatInProject({ id: p.id, name: p.name, machine_label: p.machine_label })
                      : undefined
                  }
                />
                {open && (
                  <div className="ml-4 space-y-0.5 border-l border-border/60 py-0.5 pl-2">
                    {chats.slice(0, limit).map((c) => (
                      <ChatListItem
                        key={c.id}
                        title={c.title || "Untitled"}
                        active={c.id === chatId}
                        status={{ generating: !!c.generating, unread: !!c.unread }}
                        onClick={() => onOpenChat(c.id)}
                        onRename={(title) => onRenameChat?.(c.id, title)}
                        onArchive={() => onArchiveChat?.(c.id)}
                      />
                    ))}
                    {chats.length === 0 && (
                      <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet.</p>
                    )}
                    {chats.length > limit && (
                      <button
                        type="button"
                        onClick={() =>
                          setLimits((l) => ({ ...l, [p.id]: limit + PROJECT_PAGE_STEP }))
                        }
                        className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <ChevronDown className="size-3" />
                        Show {Math.min(PROJECT_PAGE_STEP, chats.length - limit)} more
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {projects !== null && projects.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No projects yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Settings tab ----

export function SettingsPanel({
  role,
  activeSection,
  onSelectSection,
  onOpenSettings,
  onCollapse,
}: {
  /** "admin" turns on the workspace sections, same as the overlay. */
  role: string;
  /** The section rendered in the main pane (inline settings); null = none
   * picked yet. */
  activeSection: string | null;
  /** A section pick renders that section inline in the main pane. */
  onSelectSection: (id: string) => void;
  /** "All settings": opens the full settings overlay (root). */
  onOpenSettings: () => void;
  onCollapse?: () => void;
}) {
  const isAdmin = role === "admin";
  const visible = SETTINGS_SECTIONS.filter((s) => !s.admin || isAdmin);
  const groups: { key: "user" | "workspace"; label: string }[] = [
    { key: "user", label: "User" },
    ...(isAdmin ? [{ key: "workspace" as const, label: "Workspace" }] : []),
  ];
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-semibold">Settings</span>
        <CollapseButton onCollapse={onCollapse} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left outline-none transition-colors text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            All settings
          </button>
        </div>
        {groups.map((g) => {
          const items = visible.filter((s) => s.group === g.key);
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <p className="px-1 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {g.label}
              </p>
              <div className="space-y-0.5">
                {items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelectSection(s.id)}
                    className={`relative flex w-full items-center rounded-md px-2 py-1.5 text-left outline-none transition-colors ${
                      activeSection === s.id
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    {activeSection === s.id && (
                      <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-foreground/40" />
                    )}
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
