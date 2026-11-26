import { useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Circle,
  EllipsisVertical,
  Loader2,
  Pencil,
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
import { FadeTitle } from "./chrome";

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

/** Hover-revealed row menu (Rename / Archive). The trigger is absolutely
 * positioned and shown via opacity, so the row's layout never shifts;

/** Hover-revealed row menu (Rename / Archive). The trigger is absolutely
 * positioned and shown via opacity, so the row's layout never shifts;
 * stays visible while the menu is open. */
function RowActions({
  onRename,
  onArchive,
  onDelete,
  archiveLabel,
  open,
  onOpenChange,
}: {
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  archiveLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (!onRename && !onArchive && !onDelete) return null;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
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
  archiveLabel,
  assistantInbox,
  routine,
}: {
  title: string;
  active: boolean;
  status: RowState;
  assistantInbox?: boolean;
  /** The routine whose output this chat is: the row leads with its mark. */
  routine?: string;
  onClick: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
  onDelete?: () => void;
  /** Row-menu label for the archive action ("Unarchive" in the Archived
   * section); defaults to "Archive". */
  archiveLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasActions = !assistantInbox && Boolean(onRename || onArchive || onDelete);
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
    // A div row hosting two siblings — the open button and the (absolutely
    // positioned) Radix menu trigger — instead of a button containing the
    // trigger: an interactive control nested in a button is non-conforming
    // HTML and screen readers announce the menu trigger as part of the
    // row's name. The background/hover classes stay on the row so hovering
    // the trigger highlights it too.
    <div
      onContextMenu={hasActions ? (event) => {
        event.preventDefault();
        setMenuOpen(true);
      } : undefined}
      className={`group/row relative z-0 flex w-full items-center overflow-hidden rounded-md transition-colors hover:z-10 has-[[data-state=open]]:z-10 ${
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
      }`}
    >
      <button
        onClick={onClick}
        title={title}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left outline-none"
      >
        {assistantInbox ? (
          <Circle aria-hidden="true" className="size-4 shrink-0" />
        ) : routine !== undefined ? (
          <Repeat
            data-routine-mark
            aria-label={`Routine: ${routine}`}
            className="size-3.5 shrink-0 text-muted-foreground"
          >
            <title>{`Routine: ${routine}`}</title>
          </Repeat>
        ) : null}
        {title === "" ? (
          <span data-title-placeholder className="block min-w-0 flex-1 whitespace-nowrap text-muted-foreground">
            New thread
          </span>
        ) : (
          <FadeTitle text={title} />
        )}
        <RowStatus status={status} />
      </button>
      {hasActions && (
        <RowActions
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onRename={onRename ? () => setEditing(true) : undefined}
          onArchive={onArchive}
          onDelete={onDelete}
          archiveLabel={archiveLabel}
        />
      )}
    </div>
  );
}

/** Project row header: fold-out toggle + shaded title + row menu. While


/** Project row header: fold-out toggle + shaded title + row menu. While
 * renaming, the whole header is a plain div hosting the inline input. */
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
  open: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  /** Row-menu label for the archive action ("Unarchive" in the Archived
   *  section); defaults to "Archive". */
  archiveLabel?: string;
  onNewChat?: () => void;
}) {
  const [editing, setEditing] = useState(false);
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
    <button
      type="button"
      onClick={onToggle}
      // The two row buttons are always up on a touch screen, so the row
      // reserves their width there instead of letting the label run under.
      className="group/row relative z-0 flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none transition-colors text-muted-foreground hover:z-10 has-[[data-state=open]]:z-10 hover:bg-sidebar-accent hover:text-sidebar-foreground pointer-coarse:pr-14"
      title={folder}
    >
      <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      <FadeTitle text={name} />
      {machine?.name && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70">
          {machine.online !== undefined &&
            (machine.online ? (
              <span className="inline-flex size-2 shrink-0 rounded-full bg-emerald-500" />
            ) : (
              <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
            ))}
          <span className="max-w-20 truncate">{machine.name}</span>
        </span>
      )}
      <RowStatus status={status} />
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
          // right-1 + size-6 + 2px gap → the two hover buttons sit 2px apart.
          // A touch screen has no hover, so the plus is always up there.
          className="absolute right-[30px] top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-sidebar text-muted-foreground shadow-sm opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
        >
          <Plus className="size-4" />
        </span>
      )}
      <RowActions onRename={() => setEditing(true)} onArchive={onArchive} archiveLabel={archiveLabel} />
    </button>
  );
}
