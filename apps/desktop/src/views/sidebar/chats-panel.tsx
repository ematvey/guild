import { memo, useState } from "react";
import { ChevronDown, ChevronUp, SquarePen } from "lucide-react";
import { DesktopTooltip } from "../../components/desktop-tooltip";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import type { ChatSummary } from "../../lib/api/chats";
import type { sidebarGrouping } from "../projects/projects";
import { ChatListItem } from "./rows";
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
  const [scrolled, setScrolled] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const assistants = grouping.visible.filter((chat) => chat.assistant_inbox);
  const threads = grouping.visible.filter((chat) => !chat.assistant_inbox);
  const renderChat = (c: ChatSummary) => (
    <ChatListItem
      key={c.id}
      title={c.title ?? ""}
      assistantInbox={c.assistant_inbox}
      routine={c.routine?.name}
      active={c.id === chatId}
      status={{ generating: !!c.generating, working: !!c.working, unread: !!c.unread, blocked: !!c.blocked }}
      onClick={() => onOpenChat(c.id)}
      onRename={(title) => onRenameChat?.(c.id, title)}
      onArchive={() => onArchiveChat?.(c.id)}
      onDelete={onDeleteChat ? () => setDeleteTarget({ id: c.id, title: c.title ?? "" }) : undefined}
    />
  );
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
          className={`relative z-10 shrink-0 space-y-0.5 px-2 pb-1.5 pt-2 ${scrolled ? "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b after:border-border/60" : ""}`}
        >
          {assistants.length > 0 && (
            <div role="group" aria-label="Assistant conversations" className="space-y-0.5">
              {assistants.map(renderChat)}
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
        <div className={`space-y-0.5 pb-2 ${loadingChats ? "pt-2" : "pt-0.5"}`}>
          {loadingChats &&
            [0, 1, 2, 3, 4].map((i) => <SkeletonRows key={i} rows={1} className="[&>div]:h-8 [&>div]:px-2" />)}
          {!loadingChats && threads.map(renderChat)}
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
              {archivedOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
            {archivedOpen && (
              <div className="space-y-0.5">
                {archivedChats.map((c) => (
                  <ChatListItem
                    key={c.id}
                    title={c.title ?? ""}
                    assistantInbox={c.assistant_inbox}
                    routine={c.routine?.name}
                    active={c.id === chatId}
                    status={{ generating: !!c.generating, working: !!c.working, unread: false }}
                    onClick={() => onOpenChat(c.id)}
                    archiveLabel="Unarchive"
                    onArchive={onUnarchiveChat ? () => onUnarchiveChat(c.id) : undefined}
                    onDelete={onDeleteChat ? () => setDeleteTarget({ id: c.id, title: c.title ?? "" }) : undefined}
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
