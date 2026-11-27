import { useRef, useState, type HTMLAttributes } from "react";
import { FadeTitle } from "./chrome";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Folder,
  FolderOpen,
  EllipsisVertical,
  Loader2,
  MessageCircle,
  Pencil,
  Pin,
  Plus,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";

/** Inline rename field: Enter or blur commits, Esc cancels; `onDone(null)`
 * means "no change". */
function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
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
      className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-base outline-none"
    />
  );
}

const ROW_FOCUS =
  "has-[>button:focus-visible]:bg-sidebar-accent";
const PIN_INDICATOR =
  "size-3 shrink-0 text-muted-foreground group-hover/row:hidden group-focus-within/row:hidden group-has-[[data-state=open]]/row:hidden pointer-coarse:hidden";

const ROW_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground data-[state=open]:bg-sidebar-accent";
const ROW_ACTIONS =
  "flex max-w-0 shrink-0 items-center overflow-hidden group-hover/row:max-w-none group-focus-within/row:max-w-none group-has-[[data-state=open]]/row:max-w-none pointer-coarse:max-w-none";

function PinButton({ pinned, onPin }: { pinned?: boolean; onPin?: () => void }) {
  if (!onPin) return null;
  const label = pinned ? "Unpin" : "Pin";
  return (
    <button type="button" className={`${ROW_BUTTON}${pinned ? "" : " max-md:hidden pointer-coarse:hidden"}`} aria-label={label} title={label} onClick={onPin}>
      <Pin aria-hidden="true" className="size-3.5 fill-current" />
    </button>
  );
}

function RowActions({
  onRename,
  onArchive,
  onDelete,
  pinned,
  onPin,
  archiveLabel,
  open,
  onOpenChange,
}: {
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  pinned?: boolean;
  onPin?: () => void;
  archiveLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (!onRename && !onArchive && !onDelete && !onPin) return null;
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Row actions" title="Row actions" className={ROW_BUTTON}>
          <EllipsisVertical aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {onPin && (
          <DropdownMenuItem onSelect={onPin}>
            <Pin aria-hidden="true" className="size-4 fill-current" />
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
        )}
        {onRename && (
          <DropdownMenuItem onSelect={() => onRename()}>
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
        )}
        {onArchive && (
          <DropdownMenuItem onSelect={() => onArchive()}>
            {archiveLabel === "Unarchive" ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            {archiveLabel ?? "Archive"}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete()}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type RowState = { generating: boolean; working?: boolean; unread: boolean; blocked?: boolean };

/** The row's one indicator, by priority: a blocked tool call (red) beats
 *  the working spinner, which beats the unread dot. */
export function rowIndicator(status: RowState): "blocked" | "working" | "unread" | null {
  if (status.blocked) return "blocked";
  if (status.generating || status.working) return "working";
  if (status.unread) return "unread";
  return null;
}

function RowStatus({ status }: { status: RowState }) {
  switch (rowIndicator(status)) {
    case "blocked":
      return (
        <span
          className="size-2.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_4px_1px_rgba(239,68,68,0.6)]"
          title="waiting for approval"
        />
      );
    case "working":
      return (
        <Loader2
          className="size-4 shrink-0 animate-spin text-muted-foreground"
          aria-label={status.generating ? "Generating" : "Working"}
        />
      );
    case "unread":
      return (
        <span
          className="size-2.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_4px_1px_rgba(251,191,36,0.6)]"
          title="unseen replies"
        />
      );
    default:
      return null;
  }
}

export function ChatListItem({
  title,
  active,
  status,
  onClick,
  onRename,
  onArchive,
  onDelete,
  pinned,
  dragProps,
  onPin,
  archiveLabel,
  showChatIcon,
  routine,
  scheduledTask,
  project,
  lastActivity,
}: {
  title: string;
  active: boolean;
  status: RowState;
  showChatIcon?: boolean;
  /** The scheduled task that produced this chat, when known. */
  routine?: string;
  scheduledTask?: boolean;
  project?: boolean;
  lastActivity?: string;
  onClick: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
  onDelete?: () => void;
  pinned?: boolean;
  dragProps?: Pick<HTMLAttributes<HTMLButtonElement>, "draggable" | "onDragStart" | "onDragEnd">;
  onPin?: () => void;
  /** Row-menu label for the archive action ("Unarchive" in the Archived
   * section); defaults to "Archive". */
  archiveLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasActions = Boolean(onRename || onArchive || onDelete || onPin);
  if (editing) {
    return (
      <div className="flex h-8 w-full items-center gap-2 rounded-md px-2">
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
    <div
      onContextMenu={
        hasActions
          ? (event) => {
              event.preventDefault();
              setMenuOpen(true);
            }
          : undefined
      }
      className={`${ROW_FOCUS} group/row relative z-0 flex w-full items-center overflow-hidden rounded-lg transition-colors hover:z-10 has-[[data-state=open]]:z-10 ${
        active
          ? "guild-sidebar-selected bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
      }`}
    >
      <button
        {...dragProps}
        onClick={onClick}
        title={title}
        aria-current={active ? "page" : undefined}
        type="button"
        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 pl-2 pr-0.5 text-left outline-none"
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="flex min-w-0">
            {title === "" ? (
              <span data-title-placeholder className="truncate text-muted-foreground">New thread</span>
            ) : <FadeTitle text={title} fadeWidth={10} />}
          </span>
          {lastActivity && (
            <time dateTime={lastActivity} className="shrink-0 whitespace-nowrap text-muted-foreground">
              {new Date(lastActivity).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          )}
        </span>
        <RowStatus status={status} />
        {showChatIcon && <MessageCircle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
        {project && <Folder aria-label="Project chat" className="size-3.5 shrink-0 text-muted-foreground" />}
        {routine !== undefined ? (
          <Repeat data-routine-mark aria-label={`Scheduled task: ${routine}`} className="size-3.5 shrink-0 text-muted-foreground">
            <title>{`Scheduled task: ${routine}`}</title>
          </Repeat>
        ) : scheduledTask && (
          <CalendarClock aria-label="Scheduled task run" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {onPin && pinned && <Pin aria-label="Pinned" className={`${PIN_INDICATOR} fill-current`} />}
      </button>
      {hasActions && (
        <div className={ROW_ACTIONS}>
          <PinButton pinned={pinned} onPin={onPin} />
          <RowActions
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onRename={onRename ? () => setEditing(true) : undefined}
            onArchive={onArchive}
            onDelete={onDelete}
            archiveLabel={archiveLabel}
            pinned={pinned}
            onPin={onPin}
          />
        </div>
      )}
    </div>
  );
}

/** Expandable project row with independent controls for its actions. */
export function ProjectHeader({
  name,
  folder,
  machine,
  status,
  open,
  onToggle,
  onRename,
  onArchive,
  onNewChat,
  pinned,
  dragProps,
  onPin,
  archiveLabel,
}: {
  name: string;
  folder: string;
  /** The machine the project is bound to: its name rides the row title
   *  with an online/offline dot (hidden while the socket state is
   *  unknown — e.g. the machines list has not landed yet). */
  machine?: { name: string | null; online: boolean | undefined };
  /** Aggregate over the project's chats: the same status treatment the
   * chat rows use (generating spinner wins over the unread dot). */
  status: RowState;
  open?: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  /** Row-menu label for the archive action ("Unarchive" in the Archived
   *  section); defaults to "Archive". */
  archiveLabel?: string;
  onNewChat?: () => void;
  pinned?: boolean;
  dragProps?: Pick<HTMLAttributes<HTMLButtonElement>, "draggable" | "onDragStart" | "onDragEnd">;
  onPin?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const standalone = open === undefined;
  const machineLabel = machine?.name && (
    <span
      title={machine.name}
      className={`flex min-w-0 items-center gap-1.5 overflow-hidden text-base text-muted-foreground ${standalone ? "w-32 max-w-[42%] shrink-0" : ""}`}
    >
      <span className={standalone ? "truncate" : "hidden max-w-20 truncate @min-[16rem]:inline"}>{machine.name}</span>
      {machine.online !== undefined &&
        (machine.online ? (
          <span className="inline-flex size-2 shrink-0 rounded-full bg-emerald-500" />
        ) : (
          <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
        ))}
    </span>
  );
  if (editing) {
    return (
      <div className="flex h-8 w-full items-center gap-2 rounded-md px-2">
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
    <div
      className={`${ROW_FOCUS} @container group/row relative flex w-full items-center overflow-hidden rounded-lg text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        {...dragProps}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={folder}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left outline-none"
      >
        {standalone ? machineLabel : open ? (
          <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <Folder aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span className="flex min-w-10 flex-1">
          <FadeTitle text={name} fadeWidth={10} />
        </span>
        {!standalone && machineLabel}
        {onPin && pinned && <Pin aria-label="Pinned" className={`${PIN_INDICATOR} fill-current`} />}
        <RowStatus status={status} />
      </button>
      <div className={ROW_ACTIONS}>
        {onNewChat && (
          <button
            type="button"
            title="New chat in this project"
            aria-label="New chat in this project"
            className={ROW_BUTTON}
            onClick={onNewChat}
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        )}
        <PinButton pinned={pinned} onPin={onPin} />
        <RowActions
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onRename={() => setEditing(true)}
          onArchive={onArchive}
          archiveLabel={archiveLabel}
          pinned={pinned}
          onPin={onPin}
        />
      </div>
    </div>
  );
}
