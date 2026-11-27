// The open thread's header: the mobile drawer button, the title (or a child
// thread's back link), and the chat menu with its rename
// and delete dialogs.
import { useState } from "react";
import { Archive, ArchiveRestore, EllipsisVertical, Link2, Menu, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@guild/ui/components/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { CAPTION_BUTTONS_INSET, TOP_ROW, titleBarDragDeep } from "../../lib/titlebar";
import { ChildThreadHeader } from "../agents/ChildThreadHeader";
import type { ChatTree } from "../../lib/api/chats";
import { shareableUrl } from "../../lib/session";
import { ThreadTitle } from "./blocks";
import type { PickedProject } from "../projects/projects";

export function ThreadHeader({
  isMobile,
  onOpenDrawer,
  chatId,
  title,
  titleLoading,
  project,
  onOpenProject,
  childTree,
  isSubagent,
  showMenu,
  foreign,
  archived,
  renameSeed,
  onOpenChat,
  onRename,
  onArchiveToggle,
  onMakeRecurring,
  onDelete,
}: {
  isMobile: boolean;
  onOpenDrawer: () => void;
  chatId: string | null;
  title: string;
  titleLoading: boolean;
  project?: PickedProject | null;
  onOpenProject?: (id: string) => void;
  childTree: ChatTree | null;
  isSubagent: boolean;
  /** The chat menu: a user thread that still exists. */
  showMenu: boolean;
  /** Another member's chat: every write is the owner's. */
  foreign: boolean;
  archived: boolean;
  /** The rename field's starting text. */
  renameSeed: string;
  onOpenChat: (chatId: string) => void;
  onRename: (title: string) => Promise<void>;
  onArchiveToggle: () => Promise<void>;
  onMakeRecurring?: () => void;
  onDelete: () => Promise<void>;
}) {
  // The menu's rename: a popup dialog around the sidebar's rename
  // transport. Enter or Save commits, Esc/cancel discards.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const commitRename = async () => {
    setRenameOpen(false);
    await onRename(renameValue.trim());
  };
  // Deletion is not archiving: a confirmation gates the click.
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <header
      {...titleBarDragDeep}
      className={`flex items-center gap-2 border-b border-border px-3 ${TOP_ROW} pt-[env(safe-area-inset-top)] text-base ${CAPTION_BUTTONS_INSET}`}
    >
      {isMobile && (
        <Button
          variant="ghost"
          size="icon"
          className="-ml-1.5 size-9 pointer-coarse:size-10"
          onClick={onOpenDrawer}
          aria-label="Open sidebar"
        >
          <Menu />
        </Button>
      )}
      {isSubagent && childTree?.parent ? (
        <ChildThreadHeader tree={childTree} onBack={onOpenChat} />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {project && (
            <>
              <a
                href={`/project/${encodeURIComponent(project.id)}`}
                title={project.name}
                className="max-w-[45%] shrink-0 truncate rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                onClick={(event) => {
                  if (
                    !onOpenProject ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onOpenProject(project.id);
                }}
              >
                {project.name}
              </a>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                /
              </span>
            </>
          )}
          <ThreadTitle chatId={chatId} title={title} loading={titleLoading} />
        </div>
      )}
      {(showMenu || onMakeRecurring) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1.5 size-9 shrink-0 pointer-coarse:size-10 text-muted-foreground"
              title="Chat options"
              aria-label="Chat options"
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {showMenu && !foreign && (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameValue(renameSeed);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void onArchiveToggle()}>
                  {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                  {archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {onMakeRecurring && (
              <DropdownMenuItem onSelect={onMakeRecurring}>Schedule as a task</DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() =>
                void navigator.clipboard?.writeText(shareableUrl()).then(() => toast("Thread URL copied"))
              }
            >
              <Link2 className="size-4" />
              Copy thread URL
            </DropdownMenuItem>
            {showMenu && !foreign && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this thread?</AlertDialogTitle>
            <AlertDialogDescription>
              The thread leaves your lists and its runs stop. Its transcript is kept. This cannot be undone in the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white"
              onClick={() => {
                setDeleteOpen(false);
                void onDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
            }}
            className="min-w-0 w-full rounded border border-border bg-background px-2 py-1.5 text-base outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void commitRename()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
