// The open thread's header: the mobile drawer button, the title (or a child
// thread's back link), the working badge, and the chat menu with its rename
// and delete dialogs.
import { useState } from "react";
import { Archive, ArchiveRestore, EllipsisVertical, Link2, Loader2, Menu, Pencil, Trash2 } from "lucide-react";
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

export function ThreadHeader({
  isMobile,
  onOpenDrawer,
  chatId,
  title,
  titleLoading,
  childTree,
  isSubagent,
  showWorking,
  showMenu,
  foreign,
  archived,
  renameSeed,
  onOpenChat,
  onRename,
  onArchiveToggle,
  onDelete,
}: {
  isMobile: boolean;
  onOpenDrawer: () => void;
  chatId: string | null;
  title: string;
  titleLoading: boolean;
  childTree: ChatTree | null;
  isSubagent: boolean;
  /** A descendant run works while the chat's own turn does not. */
  showWorking: boolean;
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
        <ThreadTitle chatId={chatId} title={title} loading={titleLoading} />
      )}
      {showWorking && (
        <span
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          title="Working"
          aria-label="Working"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span>Working</span>
        </span>
      )}
      {showMenu && (
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
            {!foreign && (
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
            <DropdownMenuItem
              onSelect={() =>
                void navigator.clipboard?.writeText(shareableUrl()).then(() => toast("Thread URL copied"))
              }
            >
              <Link2 className="size-4" />
              Copy thread URL
            </DropdownMenuItem>
            {!foreign && (
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
            className="min-w-0 w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-none"
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
