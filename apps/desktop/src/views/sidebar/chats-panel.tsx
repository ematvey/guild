import { memo, useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { DesktopTooltip } from "../../components/desktop-tooltip";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import type { ChatSummary } from "../../lib/api/chats";
import { sidebarGrouping } from "../projects/projects";
import { ChatListItem } from "./rows";
import { CloseSidebarButton, CollapseButton } from "./chrome";
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

export const ChatsPanel = memo(function ChatsPanel({
  grouping,
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
  /** Mobile drawer only: close the sheet from the panel header (the
   *  sheet's built-in corner close is suppressed to keep this row clean). */
  onClose?: () => void;
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onUnarchiveChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        {/* The workspace switcher lives on the rail's first button; the panel
            header names the tab and carries the new-chat plus, like the
            Projects panel. */}
        <span className="font-semibold">Chats</span>
        <span className="flex items-center gap-1">
          <DesktopTooltip label="New thread" hotkey="mod+N" browserHotkey="Ctrl+Alt+N">
            <span
              role="button"
              tabIndex={0}
              aria-label="New thread"
              className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onClick={onNewChat}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onNewChat();
              }}
            >
              <Plus className="size-4" />
            </span>
          </DesktopTooltip>
          <CollapseButton onCollapse={onCollapse} />
          {onClose !== undefined && <CloseSidebarButton onClose={onClose} />}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="space-y-0.5 pb-2 pt-2">
          {loadingChats &&
            [0, 1, 2, 3, 4].map((i) => (
              <SkeletonRows key={i} rows={1} className="[&>div]:h-8 [&>div]:px-2" />
            ))}
          {!loadingChats &&
            grouping.visible.map((c) => (
              <ChatListItem
                key={c.id}
                title={c.title ?? ""}
                active={c.id === chatId}
                status={{ generating: !!c.generating, working: !!c.working, unread: !!c.unread, blocked: !!c.blocked }}
                onClick={() => onOpenChat(c.id)}
                onRename={(title) => onRenameChat?.(c.id, title)}
                onArchive={() => onArchiveChat?.(c.id)}
                onDelete={
                  onDeleteChat ? () => setDeleteTarget({ id: c.id, title: c.title ?? "" }) : undefined
                }
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
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </button>
            {archivedOpen && (
              <div className="space-y-0.5">
                {archivedChats.map((c) => (
                  <ChatListItem
                    key={c.id}
                    title={c.title ?? ""}
                    active={c.id === chatId}
                    status={{ generating: !!c.generating, working: !!c.working, unread: false }}
                    onClick={() => onOpenChat(c.id)}
                    archiveLabel="Unarchive"
                    onArchive={onUnarchiveChat ? () => onUnarchiveChat(c.id) : undefined}
                    onDelete={
                      onDeleteChat ? () => setDeleteTarget({ id: c.id, title: c.title ?? "" }) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title || "this thread"}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The thread leaves your lists and its runs stop. Its transcript is kept.
              This cannot be undone in the app.
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
