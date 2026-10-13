import { Component, useCallback, useEffect, useMemo, useRef, useState,
  type ErrorInfo, type ReactNode, type RefObject } from "react";
import { applyMention, detectMention } from "../lib/skill-mention";
import { daemonFs, listSkills } from "../lib/context";
import { openExternal } from "../lib/open-external";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Client-side tools need the desktop runtime (local files, shell); in a plain
// browser they stay pending until the server-side timeout releases the turn.
import Markdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { clampSidebarWidth, saveSidebarWidth, storedSidebarWidth } from "../lib/sidebar-width";
import {
  ArrowUp,
  ShieldAlert,
  ShieldCheck,
  Brain,
  ChevronDown,
  ChevronUp,
  Check,
  Copy,
  FileDiff,
  Download,
  FileText,
  Hand,
  Globe,
  Menu,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  PanelLeftOpen,
  Plus,
  Search,
  FolderOpen,
  Square,
  X as XIcon,
  SquareTerminal,
  FileDown,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@guild/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { toast } from "sonner";
import { WorkingIndicator } from "@guild/ui/components/working-indicator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Textarea } from "@guild/ui/components/textarea";
import { SettingsSectionPane, SettingsWindow } from "./settings/SettingsWindow";
import { CreateProjectDialog } from "./projects/CreateProjectDialog";
import { ProjectPickerDialog } from "./projects/ProjectPickerDialog";
import { chatProjectOf, outgoingProjectId, pickAfterChatSwitch, projectChipLabel, sidebarGrouping, type PickedProject } from "./projects/projects";
import { ChatsPanel, FadeTitle, SettingsPanel, WorkPanel } from "./sidebar-contents";
import { SidebarRail, saveSidebarTab, storedSidebarTab, type SidebarTab } from "./sidebar-rail";
import {
  attachmentBlobUrl,
  toolArtifactBlobUrl,
  rpcCall,
  machineId,
  postApproval,
  sendChatNoStream,
  prepareTurn,
  compactChat,
  setMachineIdentity,
  stopChat,
  uploadAttachment,
} from "../transport";
import {
  apiUrl,
  createChat,
  getChatApproval,
  listArchivedChats,
  listChats,
  listMachines,
  listModels,
  listProjects,
  markChatRead,
  updateChat,
  updateProject,
  createPairingToken,
  downloadRelease,
  listReleases,
  pairingCode,
  serverUrl,
  setChatApproval,
  startSocket,
  watchMachinePresence,
  type ThreadState,
  getApproval,
  type ApprovalPolicy,
  type ChatApprovalMode,
  type ChatSummary,
  type MachineInfo,
  type MessageAttachmentMeta,
  type Project,
  type Release,
} from "../transport";
import {
  canPersistDraft,
  completeDraftInventory,
  clearDrafts,
  scopedDraftStorage,
  gcDrafts,
  readDraft,
  writeDraft,
} from "../lib/drafts";
import { BrowserSendStore } from "../lib/browser-send-store";
import { clearCommands, detachCommandDraft, selectRestoredCommand, captureCommand, forgetCommand, matchesCommandDraft, prepareOnSendingMachine, recoveryDraft, rememberCommand, restoreCommands, submitCommand,
  type DraftAttachment, type OutgoingCommand } from "../lib/outgoing-command";
import {
  artifactCardOf,
  createThreadReducer,
  type ApprovalBlock,
  type ArtifactCard,
  type Block,
  type CompactionBlock,
  type ThreadReducer,
  type ToolBlock,
} from "../lib/thread-reducer";
// The block layer (types + derivation + merge rules) lives in
// lib/thread-reducer; these names stay importable from the view.
export {
  artifactCardOf,
  eventsToBlocks,
  reconcilePendingSend,
  replayFrom,
  resolveApproval,
  threadStateBlocks,
  upsertApproval,
} from "../lib/thread-reducer";
export type {
  ApprovalBlock,
  ArtifactCard,
  Block,
  CompactionBlock,
  PendingSend,
  ToolBlock,
  ToolMeta,
} from "../lib/thread-reducer";


export function statusFromThreads(chats: ChatSummary[]) {
  return Object.fromEntries(chats.map(chat => [chat.id, { generating: !!chat.generating, unread: !!chat.unread }]));
}

/** The open chat's remote bound machine when its socket is down — the
 * offline warning banner's subject. Machine binding is project-derived, so
 * only project-bound chats can have one. Null when unbound, bound to this
 * machine (desktop executes its own tools), online, or presence unknown. */
export function offlineMachine(
  chats: ChatSummary[] | null,
  chatId: string | null,
  isTauri: boolean,
  localMachineId: string | undefined,
): { label: string } | null {
  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  if (!row?.machine_id || !row.project_id) return null;
  if (isTauri && row.machine_id === localMachineId) return null;
  if (row.machine_online !== false) return null;
  return { label: row.machine_label ?? row.machine_id };
}

/** Whether the open chat shows busy after a thread-list push: while a
 * send's HTTP round trip is in flight the pushed list predates the
 * server's generating flag, so its false must not clear the optimistic
 * busy (a second send could race the first). */
export function busyAfterThreadPush(
  chats: ChatSummary[],
  openChatId: string | null,
  sendInFlight: boolean,
): boolean {
  if (sendInFlight) return true;
  return !!chats.find((c) => c.id === openChatId)?.generating;
}

/** Drops a chat's cancellation-in-progress flag once that chat's own
 * generating state settled to false in a server-truth source — the
 * chat-status map (thread-state frames) or the pushed list. The stop
 * click flags the chat optimistically; the server's stop is cooperative
 * (journaled step checks), so the authoritative generating=false push
 * trails the click by the epilogue's round trips. Undefined generating
 * (chat unknown to both sources) keeps the flag: no evidence is no
 * clearance. Returns null when nothing changed — the caller bails out
 * of the state update instead of re-rendering on every push. */
export function pruneStopping(
  stopping: Record<string, true>,
  chatStatus: Record<string, { generating: boolean; unread: boolean }>,
  chats: ChatSummary[] | null,
): Record<string, true> | null {
  let changed = false;
  const next: Record<string, true> = {};
  for (const cid of Object.keys(stopping)) {
    const generating =
      chatStatus[cid]?.generating ?? chats?.find((c) => c.id === cid)?.generating;
    if (generating === false) {
      changed = true;
      continue;
    }
    next[cid] = true;
  }
  return changed ? next : null;
}


/// URL-driven navigation: the pathname is the single source of truth for
/// where the user is. Routes:
///   /                          — new chat (recents view)
///   /thread/<id>               — open thread
///   /project/<id>              — sidebar filtered to one project
///   /project/<id>/thread/<cid> — open thread within its project view
///   /device                    — device-setup dialog, optionally over a
///                                thread: /thread/<id>/device
///   /settings[/<section>[/<detail>]] — settings overlay (top-level; the
///                                thread underneath stays loaded in app
///                                state). <detail> addresses a sub-page
///                                inside a section: an integration slug,
///                                a user/team id or "new", a model route
///                                or "add", a registry kind/slug.
/// Back/forward, reloads and deep links all resolve through parseChatRoute.
type ChatOverlay =
  | { kind: "settings"; section: string | null; detail: string | null }
  | { kind: "device" }
  | null;
interface ChatRoute {
  chatId: string | null;
  /** Sidebar project filter (deep-linked /project/<id>). */
  projectId: string | null;
  overlay: ChatOverlay;
}

export const parseChatRoute = (pathname: string): ChatRoute => {
  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  let chatId: string | null = null;
  let projectId: string | null = null;
  if (parts[0] === "project" && parts[1]) {
    projectId = parts[1];
    parts.splice(0, 2);
  }
  if (parts[0] === "thread" && parts[1]) {
    chatId = parts[1];
    parts.splice(0, 2);
  }
  if (parts[0] === "device") return { chatId, projectId, overlay: { kind: "device" } };
  if (parts[0] === "settings") {
    // Everything after the section is the sub-page id; each segment was
    // encoded separately, so a model id like "a/b" round-trips as one part.
    const detail = parts.length > 2 ? parts.slice(2).map(decodeURIComponent).join("/") : null;
    return { chatId, projectId, overlay: { kind: "settings", section: parts[1] ?? null, detail } };
  }
  return { chatId, projectId, overlay: null };
};

export const chatRoutePath = (
  chatId: string | null,
  projectId: string | null,
  overlay: ChatOverlay,
): string => {
  const base = projectId
    ? `/project/${encodeURIComponent(projectId)}${
        chatId ? `/thread/${encodeURIComponent(chatId)}` : ""
      }`
    : chatId
      ? `/thread/${encodeURIComponent(chatId)}`
      : "";
  if (overlay?.kind === "device") return `${base}/device`;
  // Settings is chat-independent — top-level URL even when opened over a
  // thread (the thread stays loaded; closing the overlay restores it).
  if (overlay?.kind === "settings")
    return `/settings${overlay.section ? `/${encodeURIComponent(overlay.section)}` : ""}${
      overlay.detail
        ? "/" + overlay.detail.split("/").map(encodeURIComponent).join("/")
        : ""
    }`;
  return base || "/";
};

function modalityOf(contentType: string): string {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Icon for a non-image attachment by modality/type. */
function AttachmentFileIcon({ att }: { att: MessageAttachmentMeta }) {
  if (att.modality === "video" || att.content_type.startsWith("video/"))
    return <Film className="size-3.5 shrink-0 text-muted-foreground" />;
  if (att.modality === "audio" || att.content_type.startsWith("audio/"))
    return <Music className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** Authed blob fetch → object URL for a stored attachment (thumbnails and
 * downloads). `null` while loading; renders the file icon meanwhile. */
function useAttachmentPreview(
  att: MessageAttachmentMeta & { previewUrl?: string },
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    let minted: string | null = null;
    if (att.previewUrl) {
      // The composer owns previewUrl (revoked on send/remove) — only URLs
      // minted here are revoked on unmount/re-fetch.
      setUrl(att.previewUrl);
      return;
    }
    if (att.id.startsWith("pending-") || att.modality !== "image") return;
    void attachmentBlobUrl(att.id).then((u) => {
      if (dead) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      minted = u;
      setUrl(u);
    });
    return () => {
      dead = true;
      if (minted) URL.revokeObjectURL(minted);
      setUrl(null);
    };
  }, [att.id, att.modality, att.previewUrl]);
  return url;
}

/** Image attachment: 56px rounded thumbnail (preview when available, icon
 * fallback otherwise) with an overlaid ✕ when removable. */
function AttachmentImageThumb({
  att,
  onRemove,
}: {
  att: MessageAttachmentMeta & { previewUrl?: string };
  onRemove?: () => void;
}) {
  const url = useAttachmentPreview(att);
  const img = (
    <button
      type="button"
      title={att.filename}
      className="group relative size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary"
      onClick={() => {
        if (!onRemove && url) openExternal(url);
      }}
    >
      {url ? (
        <img src={url} alt={att.filename} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <ImageIcon className="size-4" />
        </span>
      )}
    </button>
  );
  return (
    <span className="relative">
      {img}
      {onRemove && (
        <button
          type="button"
          title="Remove"
          className="absolute -right-1.5 -top-1.5 flex size-4.5 items-center justify-center rounded-full bg-foreground/80 text-background shadow hover:bg-foreground"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Non-image attachment: compact chip with a type icon, name, size and an
 * optional ✕ (composer state). */
function AttachmentFileChip({
  att,
  onRemove,
}: {
  att: MessageAttachmentMeta & { previewUrl?: string };
  onRemove?: () => void;
}) {
  const body = (
    <>
      <AttachmentFileIcon att={att} />
      <span className="max-w-56 truncate">{att.filename}</span>
      <span className="shrink-0 text-muted-foreground">{fmtBytes(att.size_bytes)}</span>
      {onRemove && (
        <button
          type="button"
          title="Remove"
          className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </>
  );
  const cls =
    "flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 py-1";
  if (onRemove) {
    return <span className={cls}>{body}</span>;
  }
  return (
    <button
      type="button"
      title="Download"
      className={`${cls} hover:bg-accent`}
      onClick={() => {
        if (!att.id.startsWith("pending-")) void attachmentBlobUrl(att.id).then((u) => {
          if (!u) return;
          const a = document.createElement("a");
          a.href = u;
          a.download = att.filename;
          a.click();
          URL.revokeObjectURL(u);
        });
      }}
    >
      {body}
    </button>
  );
}

/// Anchor for markdown content: every link routes through `openExternal`.
/// Images never load from model/tool-controlled URLs: injected markdown
/// could otherwise exfiltrate via the image request; a rendered placeholder
/// links out instead.
const mdComponents: Components = {
  a: ({ node: _node, href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={e => {
        if (href) {
          e.preventDefault();
          openExternal(href);
        }
      }}
    >
      {children}
    </a>
  ),
  img: ({ node: _node, src, alt }) => {
    const url = typeof src === "string" ? src : undefined;
    const label = alt || url || "image";
    return (
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        onClick={() => url && openExternal(url)}
      >
        🖼 {label}
      </button>
    );
  },
};

/// Per-chat workspace state lives server-side now: the chat's project
/// (spec §5). No local folder storage — the project binding is the single
/// source of truth.

/// One row of the composer's /-autocomplete (skills.list result).
interface ComposerSkill {
  name: string;
  description: string;
  disabled: boolean;
}

/// Built-in composer commands — shown in the `/` autocomplete ahead of
/// skills, with a help comment each.
const BUILTIN_COMMANDS: { name: string; description: string }[] = [
  {
    name: "compact",
    description: "Compact this thread — summarize older messages to free context",
  },
];

/// The `/` autocomplete pool: built-in commands first, then enabled skills;
/// prefix-matched on the typed fragment. Pure for tests.
export function mentionCandidates(
  builtins: { name: string; description: string }[],
  skills: ComposerSkill[] | null,
  query: string,
): { name: string; description: string; builtin: boolean }[] {
  const pool: { name: string; description: string; builtin: boolean }[] = [
    ...builtins.map((c) => ({ ...c, builtin: true })),
    ...(skills ?? [])
      .filter((s) => !s.disabled)
      .map((s) => ({ name: s.name, description: s.description, builtin: false })),
  ];
  return pool
    .filter((c) => query === "" || c.name.startsWith(query))
    .slice(0, 6);
}

/// Sentinel for a send stream that ended without a terminal frame: not a
/// user-facing error — the send path converts it into a reattach watch.
/// Shown while a deep-linked thread's messages are in flight (the URL says
/// /thread/<id> but the view has nothing to render yet). Without this, the
/// new-thread hero would flash for the whole fetch duration.
function ThreadSkeleton() {
  // Conversation-shaped skeleton: mirrors the real thread layout (user
  // bubbles right, assistant text + tool frames left) instead of a spinner.
  const row = "flex flex-col gap-1.5";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4">
        <div className={row}>
          <Skeleton className="ml-auto h-6 w-1/2 rounded-2xl" />
          <Skeleton className="h-3 w-20 rounded-md" />
          <Skeleton className="h-10 w-5/6 rounded-lg" />
          <Skeleton className="h-12 w-5/6 rounded-lg" />
        </div>
        <div className={row}>
          <Skeleton className="h-6 w-2/5 rounded-2xl" />
          <Skeleton className="h-3 w-24 rounded-md" />
          <Skeleton className="h-10 w-5/6 rounded-lg" />
          <Skeleton className="h-12 w-5/6 rounded-lg" />
        </div>
        <div className={row}>
          <Skeleton className="ml-auto h-6 w-3/5 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/// Markdown body class shared by text blocks and tool-card excerpts.
const MD_CLASS =
  "[overflow-wrap:anywhere] " +
  "[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1,\&_h2,\&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre_[code]]:bg-transparent [&_pre_[code]]:p-0 [&_ul]:list-disc";
// Long unbreakable tokens (inline code, URLs) must wrap inside the message
// column, never widen it into a horizontal page scroll. overflow-wrap
// inherits, so the one declaration at the top of MD_CLASS covers every
// child; non-markdown blocks carry WRAP_ANYWHERE explicitly.
const WRAP_ANYWHERE = "[overflow-wrap:anywhere]";

/// GFM tables: block-level so wide tables scroll horizontally inside the
/// chat column instead of squishing; cell padding keeps adjacent columns
/// visually separated (the old rendering had none, so columns merged).
const MD_TABLE_CLASS =
  "[&_table]:my-2 [&_table]:block [&_table]:w-full [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[0.92em] [&_th]:border-b-2 [&_th]:border-border [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top [&_tbody_tr:nth-child(even)]:bg-muted/40";

/// Status pill on tool frames and page cards.
function StatusPill({ status }: { status: "running" | "done" | "error" }) {
  const cls = {
    running: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
  }[status];
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

/// Generic collapsible frame behind the reasoning and tool renders.
function Frame({
  icon,
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  icon?: React.ReactNode;
  /** A node, or a render function receiving `open` (to e.g. hide the
   * collapsed-row preview once the full content is shown below). */
  title: React.ReactNode | ((open: boolean) => React.ReactNode);
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const titleNode = typeof title === "function" ? title(open) : title;
  return (
    // A clickable text row on the page — no chip background, full width, the
    // The row blends into the conversation; the panel only exists below
    // the row once it is opened.
    <div className="flex w-full flex-col text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 py-1 text-left outline-none transition-colors hover:text-foreground"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{titleNode}</span>
        {badge}
        {open ? (
          <ChevronUp className="size-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
        )}
      </button>
      {open && (
        // No card boundary: the content just continues below the row as
        // smaller, grayer text, indented under the label.
        <div className="mb-2 pl-[22px] text-sm text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}

/// Collapsible "Thinking" frame for a reasoning block; default collapsed,
/// body is the accumulated thinking text.
function ReasoningFrame({ text, live }: { text: string; live: boolean }) {
  // Collapsed row carries the head of the thoughts as a preview (CSS
  // truncates to whatever fits on the line); the full text opens below.
  const head = text.replace(/\s+/g, " ").trim();
  return (
    <Frame
      icon={<Brain className="size-3 shrink-0 text-muted-foreground" />}
      title={(open) => (
        <>
          <span className="mr-3 font-medium text-foreground/80">
            {live ? "Thinking…" : "Thinking"}
          </span>
          {/* collapsed only: expanded, the full thoughts show below */}
          {head && !open && (
            <span className="hidden max-w-72 truncate text-muted-foreground sm:inline">
              {head.slice(0, 160)}
            </span>
          )}
        </>
      )}
    >
      {/* Full height in the page flow: the conversation pane owns
          scrolling, the block itself never clips or inner-scrolls. */}
      <div className={`whitespace-pre-wrap leading-relaxed text-muted-foreground ${WRAP_ANYWHERE}`}>
        {text || "…"}
      </div>
    </Frame>
  );
}

/// Human-facing tool kind: drives the frame icon and widget selection.
function toolKind(t: ToolBlock): string {
  if (t.kind === "web_search") return "search";
  if (t.kind === "web_browse") return "fetch";
  if (artifactCardOf(t)) return "artifact";
  if (t.meta?.kind) return t.meta.kind;
  if (typeof t.meta?.card === "string") return t.meta.card;
  const n = t.name.toLowerCase();
  if (n.includes("search")) return "search";
  if (n.includes("fetch")) return "fetch";
  if (n === "execute" || n === "bash" || n === "shell") return "terminal";
  if (n === "read_file" || n === "read") return "read";
  if (n === "edit_file" || n === "write_file" || n === "edit" || n === "write") return "diff";
  return "other";
}

/// Human-facing tool names (collapsed header): raw wire names like
/// `web_search` stay in the log.
const TOOL_LABELS: Record<string, string> = {
  web_search: "Web search",
  web_fetch: "Browse",
  execute: "Execute",
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
  // pre-rename wire names, kept so old thread history renders
  bash: "Execute",
  shell: "Execute",
  read: "Read",
  edit: "Edit",
  write: "Write",
};

/// The composer's approval-mode selector (per chat, migration 0043). The
/// mode sets the chat's tool-approval DEFAULT; per-tool exceptions from
/// Settings apply only while the chat is on the account default. The
/// popup lists exactly codex's three modes — an unset chat shows the
/// resolved account default without offering it as a pickable mode.
const APPROVAL_MODES: Record<
  ChatApprovalMode,
  { label: string; hint: string; icon: LucideIcon; iconCls?: string }
> = {
  ask: {
    label: "Ask for approval",
    hint: "Ask before any potentially unsafe actions.",
    icon: Hand,
  },
  approve_for_me: {
    label: "Approve for me",
    hint: "Let a separate AI determine if an action is potentially unsafe",
    icon: ShieldCheck,
  },
  full_access: {
    label: "Full access",
    hint: "Unrestricted, except for organization policy overrides.",
    icon: TriangleAlert,
    iconCls: "text-orange-500",
  },
};

const APPROVAL_MODE_LABELS: Record<ChatApprovalMode, string> = {
  ask: "Ask for approval",
  approve_for_me: "Approve for me",
  full_access: "Full access",
};

/// Label for an unset chat (the account default applies). The server treats
/// no stored account policy as the AI judge (approve_for_me); an explicit
/// Settings default maps onto the matching mode label.
export function accountDefaultLabel(p: ApprovalPolicy | null): string {
  if (p?.default === "ask") return APPROVAL_MODE_LABELS.ask;
  if (p?.default === "allow") return APPROVAL_MODE_LABELS.full_access;
  if (p?.default === "never") return "Deny all";
  return APPROVAL_MODE_LABELS.approve_for_me;
}

/**
 * Label for a bare wire tool name (exported for pure tests; approval cards
 * and tool frames must render the same tool identically). The connector
 * slug stays in the label — the wire name is what the model was offered,
 * and the prefix is part of the tool's identity, not noise to assume away.
 */
export function toolDisplayName(name: string): string {
  const n = name.toLowerCase();
  const direct = TOOL_LABELS[n];
  if (direct) return direct;
  // Legacy journals recorded the `int_` marker (`int_searxng_web_search`):
  // dead plumbing, strip it so old threads render like new ones. The slug
  // itself is kept.
  const bare = n.startsWith("int_") ? n.slice(4) : n;
  for (const [key, label] of Object.entries(TOOL_LABELS)) {
    if (bare.endsWith("_" + key)) return label;
  }
  return bare.replace(/_/g, " ");
}

/** Exposed for pure tests. */
export function toolLabel(t: ToolBlock): string {
  // Top-level tool kind wins: web_search/web_browse render natively no
  // matter which integration provides the tool.
  if (t.kind === "web_search") return "Web search";
  if (t.kind === "web_browse") return "Browse";
  // Older events without a persisted kind: the widget meta kind maps the
  // same way for web tools.
  if (t.meta?.kind === "search") return "Web search";
  if (t.meta?.kind === "fetch") return "Browse";
  return toolDisplayName(t.name);
}

function argOf(t: ToolBlock, keys: string[]): string | undefined {
  try {
    const a = JSON.parse(t.args);
    for (const k of keys) {
      const v = a?.[k];
      if (typeof v === "string" && v) return v;
    }
  } catch {
    /* args are not always JSON */
  }
  return undefined;
}

/// Request text shown on the frame header line (same line as the tool
/// name): search → query, fetch → URL, execute → command, read/edit → path.
function toolPreview(t: ToolBlock): string | undefined {
  const m = t.meta;
  switch (toolKind(t)) {
    case "search":
      return m?.title || argOf(t, ["query", "q", "search"]);
    case "fetch":
      return m?.url || argOf(t, ["url"]);
    case "terminal":
      return m?.title || argOf(t, ["command", "cmd", "script"]);
    case "read":
    case "diff":
      return m?.path || argOf(t, ["path", "file_path", "file"]);
    case "artifact":
      return artifactCardOf(t)?.filename;
    default:
      return m?.title || undefined;
  }
}

/// Fallback for search results arriving WITHOUT persisted meta (older
/// events): parses the numbered "N. Title / URL / snippet…" list the server
/// composes into source cards.
export function parseSearchResults(content: string): { url: string; title?: string; snippet?: string }[] {
  const out: { url: string; title?: string; snippet?: string }[] = [];
  let cur: { url: string; title?: string; snippet?: string } | null = null;
  for (const l of content.split("\n")) {
    const line = l.trim();
    const tMatch = line.match(/^\d+\.\s+(.*)$/);
    const uMatch = line.match(/^https?:\/\/\S+$/);
    if (tMatch) {
      if (cur) out.push(cur);
      cur = { url: "", title: tMatch[1].trim() };
    } else if (uMatch && cur) {
      cur.url = line;
    } else if (cur && line && !cur.url) {
      cur.title = `${cur.title} ${line}`;
    } else if (cur && line) {
      cur.snippet = cur.snippet ? `${cur.snippet} ${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.url);
}

function ToolKindIcon({ kind }: { kind: string }) {
  const cls = "size-3 shrink-0 text-muted-foreground";
  switch (kind) {
    case "search":
      return <Search className={cls} />;
    case "fetch":
      return <Globe className={cls} />;
    case "terminal":
      return <SquareTerminal className={cls} />;
    case "read":
      return <FileText className={cls} />;
    case "artifact":
      return <FileDown className={cls} />;
    case "diff":
      return <FileDiff className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

/// Collapsed system-style card for a compaction event: header names the
/// event (and the summarization model); the body holds the summary and the
/// retained-tail note. Always collapsed by default.
function CompactionCard({ c }: { c: CompactionBlock }) {
  return (
    <Frame title={<span>Context compacted</span>}>
      <div className="space-y-2">
        <div className={`max-h-64 overflow-y-auto leading-relaxed text-muted-foreground ${MD_CLASS} ${MD_TABLE_CLASS}`}>
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{c.summary}</Markdown>
        </div>
        {c.keepLast != null && <p className="text-muted-foreground">kept last {c.keepLast} messages</p>}
      </div>
    </Frame>
  );
}

function statusPillCls(ok: boolean): string {
  return ok
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "border-destructive/40 bg-destructive/10 text-destructive";
}

function TruncatedBadge() {
  return (
    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
      truncated
    </span>
  );
}

/// Per-widget body of an expanded tool frame, driven by the persisted `meta`
/// on the tool_result event (spec C.2 → C.3). Tools without meta fall back
/// to pretty JSON of the arguments plus the raw content.
/**
 * Tool-result metadata is attacker-influenced; only http(s) URLs may become
 * link targets. Anything else (javascript:, data:, malformed text) renders
 * as plain text instead of an anchor.
 */
function safeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/// Download chip for a spilled tool_result, mirroring the user-attachment
/// chip family: type icon, filename, human size, download button. Bytes
/// fetch authed from /api/v1/tool_artifacts/{id} and save through the
/// browser/app download path. Failed fetches re-enable the button for a
/// retry.
function ArtifactDownloadCard({ card }: { card: ArtifactCard }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const download = async () => {
    setState("busy");
    try {
      const u = await toolArtifactBlobUrl(card.id);
      if (!u) throw new Error("artifact fetch failed");
      const a = document.createElement("a");
      a.href = u;
      a.download = card.filename;
      a.click();
      URL.revokeObjectURL(u);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 py-1">
      <FileDown className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-56 truncate font-medium" title={card.filename}>
        {card.filename}
      </span>
      <span className="shrink-0 text-muted-foreground">{fmtBytes(card.size_bytes)}</span>
      {card.content_type !== "application/octet-stream" && (
        <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">{card.content_type}</span>
      )}
      {card.path && (
        <span
          className="hidden w-full truncate font-mono text-[10px] text-muted-foreground/60 sm:block"
          title={card.path}
        >
          {card.path}
        </span>
      )}
      <button
        type="button"
        title={state === "failed" ? "Download failed — retry" : "Download"}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
        disabled={state === "busy"}
        onClick={() => void download()}
      >
        {state === "busy" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Download className="size-3" />
        )}
        {state === "failed" ? "Retry" : "Download"}
      </button>
    </div>
  );
}

function ToolBody({ t }: { t: ToolBlock }) {
  const m = t.meta;
  const kind = toolKind(t);
  if (kind === "artifact") {
    const card = artifactCardOf(t);
    // The card replaces the raw content — the model-facing pointer text
    // (path + head excerpt) is not useful to show verbatim.
    if (card) return <ArtifactDownloadCard card={card} />;
  }
  if (kind === "search") {
    const sources = m?.sources?.length
      ? m.sources
      : parseSearchResults(t.content ?? "");
    return (
      <div className="space-y-2">
        {sources.map((s, i) => {
          const href = safeUrl(s.url);
          return (
            <div key={i}>
              {href ? (
                <a
                  href={href}
                  className="break-all font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
                  onClick={e => {
                    e.preventDefault();
                    openExternal(href);
                  }}
                >
                  {s.title || s.url}
                </a>
              ) : (
                <span className="break-all font-medium">{s.title || s.url}</span>
              )}
              {s.snippet && <p className="mt-0.5 text-muted-foreground">{s.snippet}</p>}
            </div>
          );
        })}
        {t.status === "running" && (
          <span className="animate-pulse text-muted-foreground">running…</span>
        )}
        {sources.length === 0 && t.content && (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-muted-foreground">
            {t.content}
          </pre>
        )}
      </div>
    );
  }
  if (kind === "fetch") {
    const url = m?.url || argOf(t, ["url"]) || "";
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(() => {
            const href = safeUrl(url);
            return href ? (
              <a
                href={href}
                className="min-w-0 flex-1 truncate underline decoration-border underline-offset-2 hover:decoration-foreground"
                title={url}
                onClick={e => {
                  e.preventDefault();
                  openExternal(href);
                }}
              >
                {url}
              </a>
            ) : url ? (
              <span className="min-w-0 flex-1 truncate" title={url}>
                {url}
              </span>
            ) : null;
          })()}
          {/* pills only for failures: HTTP errors surface, 2xx stays quiet */}
          {m?.status_code != null && m.status_code >= 400 && (
            <span
              className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${statusPillCls(false)}`}
            >
              {m.status_code}
            </span>
          )}
          {m?.truncated && <TruncatedBadge />}
        </div>
        {m?.title && <p className="font-medium">{m.title}</p>}
        {t.content && (
          <div className={`max-h-64 overflow-y-auto ${MD_CLASS} ${MD_TABLE_CLASS}`}>
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{t.content}</Markdown>
          </div>
        )}
        {t.status === "running" && (
          <span className="animate-pulse text-muted-foreground">running…</span>
        )}
      </div>
    );
  }
  if (kind === "terminal") {
    const command = argOf(t, ["command", "cmd", "script"]);
    const output = m?.output ?? t.content ?? "";
    return (
      <div className="space-y-2">
        {command && (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
            <span className="select-none text-muted-foreground/60">$ </span>
            {command}
          </pre>
        )}
        {output && (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
            {output}
          </pre>
        )}
        {/* failures only: a clean exit stays quiet */}
        {m?.exit_code != null && m.exit_code !== 0 && (
          <span
            className={`inline-block rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${statusPillCls(false)}`}
          >
            exit {m.exit_code}
          </span>
        )}
      </div>
    );
  }
  if (kind === "read") {
    const lines = (t.content ?? "").split("\n");
    const start = m?.offset ?? 1;
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={m?.path}>
            {m?.path}
          </span>
          {m?.total_lines != null && (
            <span className="shrink-0 text-[10px]">
              {lines.length}/{m.total_lines} lines
            </span>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-sm leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                {start + i}
              </span>
              <span className="whitespace-pre-wrap break-all">{l}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "diff") {
    return (
      <div className="space-y-2">
        {m?.path && (
          <span className="block min-w-0 truncate font-mono text-muted-foreground" title={m.path}>
            {m.path}
          </span>
        )}
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono">
          {(t.content ?? "").split("\n").map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith("+") && !l.startsWith("+++")
                  ? "text-emerald-600 dark:text-emerald-400"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "text-destructive"
                    : l.startsWith("@@")
                      ? "text-muted-foreground"
                      : undefined
              }
            >
              {l}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  let prettyArgs = t.args;
  try {
    prettyArgs = JSON.stringify(JSON.parse(t.args), null, 2);
  } catch {
    /* keep the raw arguments string */
  }
  return (
    <div className="space-y-2">
      {prettyArgs && prettyArgs !== "{}" && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
          {prettyArgs}
        </pre>
      )}
      {t.content && (
        <pre
          className={`max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed ${
            t.status === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {t.content}
        </pre>
      )}
      {t.status === "running" && (
        <span className="animate-pulse text-muted-foreground">running…</span>
      )}
    </div>
  );
}

/// One collapsible frame per tool_call block: header is kind icon + tool
/// name + request preview (search → query, fetch → URL, …). The preview
/// stays on the header line whether the frame is collapsed or expanded; a
/// running call pulses until its result lands.
function ToolFrame({ t }: { t: ToolBlock }) {
  const preview = toolPreview(t);
  const running = t.status === "running";
  const pulse = running ? "animate-pulse" : "";
  return (
    <Frame
      icon={<ToolKindIcon kind={toolKind(t)} />}
      title={
        <>
          <span className={`mr-3 font-medium text-foreground/80 ${pulse}`}>
            {toolLabel(t)}
          </span>
          {preview && (
            <span
              className={`hidden max-w-72 truncate text-muted-foreground sm:inline ${pulse}`}
              title={preview}
            >
              {preview}
            </span>
          )}
        </>
      }
      badge={
        // Pills only signal trouble: DONE is implicit, ERROR stays visible.
        t.status === "error" ? <StatusPill status={t.status} /> : undefined
      }
    >
      <ToolBody t={t} />
    </Frame>
  );
}

/// Status pill on approval cards (mirrors the tool-frame pill palette).
function ApprovalPill({ status }: { status: "pending" | "approved" | "denied" | "expired" }) {
  const cls = {
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    denied: "border-destructive/40 bg-destructive/10 text-destructive",
    expired: "border-border bg-muted text-muted-foreground",
  }[status];
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

/// Collapsible approval card (design spec section F), styled like the tool
/// frames. Pending cards offer Approve/Deny wired to the approvals endpoint;
/// the buttons optimistically disable on click and the card flips to the
/// resolved pill when the approval_resolved frame (or a thread reload)
/// confirms the decision. A settled response (recorded decision echoed, or
/// the call journaled expired) settles the card directly from the POST —
/// no frame is coming for those paths. A click whose POST hangs or lands
/// during the gate's own settle re-enables after 15 s so it can be retried;
/// retries are idempotent (the endpoint echoes the recorded decision).
function ApprovalCard({ a, chatId }: { a: ApprovalBlock; chatId: string | null }) {
  const [acted, setActed] = useState<null | "approved" | "denied">(null);
  const [remote, setRemote] = useState<null | { status: "approved" | "denied" | "expired"; reason?: string }>(
    null,
  );
  const status = remote?.status ?? a.status;
  const settled = status !== "pending";
  const busy = !settled && acted !== null;
  const act = (approved: boolean) => {
    if (acted || settled || !chatId) return;
    setActed(approved ? "approved" : "denied");
    const cap = window.setTimeout(() => setActed(null), 15_000);
    void postApproval(chatId, a.callId, approved, approved ? undefined : "denied by user")
      .then((r) => {
        window.clearTimeout(cap);
        if (r.settled) {
          setRemote({
            status: r.expired ? "expired" : r.approved ? "approved" : "denied",
            reason: r.reason ?? undefined,
          });
          setActed(null);
        }
        // settled=false: the gate took the decision and is journaling it —
        // the resolved frame (or a reload) lands the pill; keep the
        // optimistic state until then.
      })
      .catch(() => {
        window.clearTimeout(cap);
        setActed(null);
      });
  };
  let prettyArgs = a.args;
  try {
    prettyArgs = JSON.stringify(JSON.parse(a.args), null, 2);
  } catch {
    /* keep the raw arguments string */
  }
  // Shell-like tools get a terminal-style command line instead of the raw
  // JSON argument dump.
  let commandLine: string | null = null;
  if (a.name === "execute" || a.name === "bash" || a.name === "shell") {
    try {
      const parsed = JSON.parse(a.args);
      const cmd = parsed?.command ?? parsed?.cmd ?? parsed?.script;
      if (typeof cmd === "string" && cmd) commandLine = cmd;
    } catch {
      /* fall through to the JSON block */
    }
  }
  return (
    <Frame
      icon={
        settled && status !== "approved" ? (
          <ShieldAlert className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ShieldCheck className="size-3 shrink-0 text-muted-foreground" />
        )
      }
      title={
        <>
          <span className="font-medium text-foreground/80">{toolDisplayName(a.name)}</span>
          <span className="text-muted-foreground"> — approval</span>
        </>
      }
      badge={
        <>
          {a.reason && settled && status !== "expired" && (
            <span className="hidden max-w-40 truncate text-muted-foreground sm:inline">
              {a.reason}
            </span>
          )}
          <ApprovalPill
            status={settled ? (status as "approved" | "denied" | "expired") : busy ? (acted as "approved" | "denied") : "pending"}
          />
        </>
      }
      defaultOpen={status === "pending"}
    >
      <div className="space-y-2">
        {commandLine !== null ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
            <span className="select-none text-muted-foreground/60">$ </span>
            {commandLine}
          </pre>
        ) : (
          prettyArgs && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-muted-foreground">
              {prettyArgs}
            </pre>
          )
        )}
        {settled ? (
          status === "expired" ? (
            <p className="text-muted-foreground">expired — the turn was no longer waiting for this approval</p>
          ) : status === "denied" && (remote?.reason ?? a.reason) ? (
            <p className="text-muted-foreground">denied: {remote?.reason ?? a.reason}</p>
          ) : status === "denied" ? (
            <p className="text-muted-foreground">denied by user</p>
          ) : (
            <p className="text-muted-foreground">approved — the tool was allowed to run</p>
          )
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => act(true)} disabled={busy}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(false)} disabled={busy}>
              Deny
            </Button>
            {busy && <span className="text-muted-foreground">sending…</span>}
          </div>
        )}
      </div>
    </Frame>
  );
}

/// iOS Safari does not shrink the layout viewport when the keyboard opens —
/// it overlays it and pans the page to reveal the focused input, dragging
/// the fixed app shell (header included) off-screen. Pin the shell to the
/// visual viewport while that state lasts: same top offset, same visible
/// height, tracked live on every viewport resize/scroll. Android browsers
/// either resize the layout viewport natively (interactive-widget=
/// resizes-content) or report a shrunk visual viewport — both land here
/// correctly; when no keyboard is detected the shell falls back to plain
/// `fixed inset-0` (empty inline styles), so normal browsing is untouched.
function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    const apply = () => {
      const layoutH = document.documentElement.clientHeight;
      const pinned = vv.height < layoutH - 60 || vv.offsetTop > 0;
      if (!pinned) {
        el.style.top = "";
        el.style.height = "";
        return;
      }
      el.style.top = `${Math.max(0, vv.offsetTop)}px`;
      el.style.height = `${vv.height}px`;
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      el.style.top = "";
      el.style.height = "";
    };
  }, [ref]);
}

/// Chat view backed by the org gateway. Browser and Tauri webview members
/// render frames; the Tauri app process separately executes local tools.
type WebChatProps = {
  email: string;
  role?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onSignOut: () => void;
  /** Desktop multi-workspace: shows the pair/sign-in card over the running
   * app; the login activates the new workspace. Absent on the web. */
  onAddWorkspace?: () => void;
};

/** A render exception anywhere in the chat view must never unmount the app:
 * without this boundary the user is left on a bare background (there is no
 * other boundary above this subtree). */
class ChatErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Chat view crashed:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <p className="font-medium">The chat view crashed.</p>
        <p className="max-w-md text-sm text-muted-foreground">{String(this.state.error.message || this.state.error)}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}

export default function WebChat(props: WebChatProps) {
  const scope = `${apiUrl("")}\n${props.email}`;
  return (
    <ChatErrorBoundary key={scope}>
      <WebChatAccount key={scope} {...props} />
    </ChatErrorBoundary>
  );
}
function WebChatAccount({ email, role = "member", displayName, avatarUrl, onSignOut, onAddWorkspace }: WebChatProps) {
  const outgoingScope = `${apiUrl("")}\n${email}`;
  const draftStorage = useMemo(() => scopedDraftStorage(localStorage, outgoingScope), [outgoingScope]);
  const [fileStore] = useState(() => new BrowserSendStore(outgoingScope));
  const storageWarningRef = useRef(false);
  const [filesReady, setFilesReady] = useState(false);
  const deliveringRef = useRef(new Set<string>());
  const observedUserIdsRef = useRef(new Set<string>());
  const storageFailure = (reason?: unknown) => {
    console.error("Browser send storage write failed:", reason);
    if (!storageWarningRef.current && mountedRef.current) {
      storageWarningRef.current = true;
      toast.error("Attachments won't survive a reload on this browser");
    }
  };
  const persistCommand = async (command: OutgoingCommand) => {
    if (!mountedRef.current) throw new Error("Chat session closed");
    try { await fileStore.saveCommand(command); } catch (e) { storageFailure(e); }
  };
  const persistFiles = (target: string | null, files: readonly DraftAttachment[]) => {
    void fileStore.saveDraft(target, files).catch(storageFailure);
  };
  const [models, setModels] = useState<string[] | null>(null);
  // Sign-out hygiene: drafts can hold sensitive composer text, so they are
  // cleared with the session — a shared browser's next account must not
  // inherit them. Every sign-out path in this view goes through here.
  const signOut = useCallback(() => {
    mountedRef.current = false;
    clearDrafts(draftStorage);
    clearCommands(localStorage, outgoingScope);
    void fileStore.clear().catch(() => {}).finally(onSignOut);
  }, [onSignOut, draftStorage, fileStore, outgoingScope]);
  const [model, setModel] = useState("");
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  // Live sidebar status overlay (thread-list spinner/dot): frames from the
  // server's chat-status channel win over the fetched list; refreshChats
  // reconciles the rest. mark-read happens on thread load for the visible
  // open chat; a hidden tab never swallows its own dot.
  const [chatStatus, setChatStatus] = useState<Record<string, { generating: boolean; unread: boolean }>>({});
  // Cancellation-in-progress, per chat: a stop click flags the chat the
  // moment it lands so the composer's Stop button and the feed's shimmer
  // acknowledge it immediately. The server's stop is cooperative — the
  // runner observes the flag inside journaled steps — so the authoritative
  // generating=false push trails the click by the epilogue's round trips;
  // pruneStopping lifts the flag when that push (or the list push) lands,
  // requestStop on a rejected/failed stop.
  const [stopping, setStopping] = useState<Record<string, true>>({});
  const chatsRef = useRef<ChatSummary[] | null>(null);
  chatsRef.current = chats;
  // URL-driven navigation state (see parseChatRoute above): everything the
  // user can navigate to — the open thread, the settings overlay with its
  // active section, the device dialog — lives in the pathname, so back/forward,
  // reloads and deep links all land in exactly the right place.
  const [route, setRoute] = useState<ChatRoute>(() => parseChatRoute(window.location.pathname));
  const chatId = route.chatId;
  const overlay = route.overlay;
  // The open chat's server-side generating flag — the same truth the sidebar
  // spinner shows (live chat-status frames, optimistic send, then the fetched
  // list). The local stream state is per-view and is lost on a thread switch;
  // this keeps the window's in-progress state alive across switches.
  const openGenerating =
    !!chatId &&
    (chatStatus[chatId]?.generating ??
      (chats?.find((c) => c.id === chatId)?.generating ?? false));
  const [threadLoading, setThreadLoading] = useState(() => route.chatId !== null); // /thread/<id> fetch in flight with nothing to show
  // Manual /compact in flight: the optimistic "Compacting thread…" line at
  // the end of the feed until the durable compaction event lands (or the
  // busy flag clears — a failed compaction appends nothing to the log).
  // Data the reducer returns (its armed target vs the open chat), not a
  // chatId comparison here — a null-vs-null comparison once held and the
  // line flashed on every first send.
  const [compacting, setCompacting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const [restoredOutgoing] = useState(() => restoreCommands(localStorage, outgoingScope));
  const outgoingRef = useRef(restoredOutgoing);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const restoredCommandRef = useRef(new Map<string | null, string>());
  const [, refreshOutgoing] = useState(0);
  // The chat the chatId effect last restored a draft for (undefined = no
  // restore ran yet): the persist effect below writes only for this chat.
  const restoredForRef = useRef<string | null | undefined>(undefined);
  // Composer text persists per chat (localStorage, draftKey): every edit
  // writes the open chat's draft; the chatId effect swaps it on navigation
  // and sending overwrites it with "".
  useEffect(() => {
    // The gate: persist only after the chatId effect restored THIS chat's
    // draft. On a switch this effect runs first with the new chatId while
    // prompt still holds the previous chat's text — writing then would
    // clobber the destination chat's saved draft before its restore reads
    // it.
    if (!canPersistDraft(restoredForRef.current, chatId)) return;
    writeDraft(draftStorage, chatId, prompt);
  }, [prompt, chatId]);
  // ---- skill mentions: / opens the autocomplete (skills design §3) ----
  const [skills, setSkills] = useState<ComposerSkill[] | null>(null);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    // Skills discovery moved client-side (lib/context.ts over the fs bridge).
    const fs = daemonFs(rpcCall);
    fs.scopes()
      .then((scopes) => listSkills(fs, scopes))
      .then((rows) => {
        if (!cancelled) setSkills(rows as ComposerSkill[]);
      })
      .catch(() => {
        /* skills are optional composer sugar — silence */
      });
    return () => {
      cancelled = true;
    };
  }, [isTauri]);
  const mention = useMemo(
    () => (!mentionDismissed ? detectMention(prompt, caret) : null),
    [prompt, caret, mentionDismissed],
  );
  const mentionMatches = useMemo(
    () => (mention ? mentionCandidates(BUILTIN_COMMANDS, skills, mention.query) : []),
    [mention, skills],
  );
  // a fresh token re-opens the menu after Esc; typing within one stays closed
  useEffect(() => {
    setMentionDismissed(false);
  }, [mention?.start]);
  const acceptMention = useCallback(
    (name: string) => {
      const r = applyMention(prompt, caret, name);
      setPrompt(r.text);
      setCaret(r.caret);
      setMentionIndex(0);
      requestAnimationFrame(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(r.caret, r.caret);
        autoGrow();
      });
    },
    [prompt, caret],
  );
  // Composer attachments: strip of previews above the input — image
  // thumbnails with an overlay ✕, file chips with an icon.
  const [pending, renderPending] = useState<DraftAttachment[]>([]);
  const pendingRef = useRef(pending);
  const [restoredAttachmentDrafts] = useState(() => {
    const drafts = new Map<string | null, DraftAttachment[]>();
    for (const command of restoredOutgoing.values()) {
      const target = command.chatId ?? command.originChatId;
      if (!drafts.has(target) && readDraft(draftStorage, target) === command.text) {
        drafts.set(target, command.attachments);
        restoredCommandRef.current.set(target, command.id);
      }
    }
    return drafts;
  });
  const pendingDraftsRef = useRef(restoredAttachmentDrafts);
  const pendingChatRef = useRef<string | null>(chatId);
  const setPending = (update: DraftAttachment[] | ((old: DraftAttachment[]) => DraftAttachment[])) => {
    const next = typeof update === "function" ? update(pendingRef.current) : update;
    pendingRef.current = next;
    pendingDraftsRef.current.set(pendingChatRef.current, next);
    persistFiles(pendingChatRef.current, next);
    renderPending(next);
  };
  useEffect(() => () => {
    const urls = new Set<string>();
    for (const files of pendingDraftsRef.current.values()) for (const a of files) if (a.previewUrl) urls.add(a.previewUrl);
    for (const command of outgoingRef.current.values()) for (const a of command.attachments) if (a.previewUrl) urls.add(a.previewUrl);
    for (const url of urls) URL.revokeObjectURL(url);
  }, []);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Drag-and-drop target state: the whole chat pane accepts attachment
  // drops, with a drop-hint overlay.
  const [dragOver, setDragOver] = useState(false);


  const addFiles = (files: File[]) => {
    setPending((p) => [
      ...p,
      ...files.map((f) => ({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: f.name,
        content_type: f.type || "application/octet-stream",
        size_bytes: f.size,
        modality: modalityOf(f.type),
        file: f,
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      })),
    ]);
  };
  const [blocks, setBlocks] = useState<Block[]>([]);
  // The thread reducer: per-chat views (blocks + watermark + pending send +
  // compaction keys) advanced incrementally by the transitions below.
  const reducerRef = useRef<ThreadReducer>(createThreadReducer());
  // Per-chat approval mode (the composer's selector): "default" = the
  // account-level policy from Settings applies. Loaded on chat open,
  // written optimistically on pick.
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode | "default">("default");
  // The chat a pre-send pick belongs to: the first send creates the chat and
  // persists the picked mode; the load effect below skips that chat once so
  // the pick survives instead of being refetched back to "default".
  const justCreatedApprovalRef = useRef<string | null>(null);
  // The account-level approval default (Settings → Approvals), fetched once:
  // the label an unset chat shows on the selector trigger. The server
  // resolves the same value when the turn runs (unset policy = the AI
  // judge), so the label and the behavior stay in step.
  const [accountDefault, setAccountDefault] = useState<string>("Approve for me");
  useEffect(() => {
    let dead = false;
    void getApproval()
      .then((p) => {
        if (!dead) setAccountDefault(accountDefaultLabel(p));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);
  useEffect(() => {
    if (!chatId) {
      setApprovalMode("default");
      return;
    }
    if (justCreatedApprovalRef.current === chatId) {
      justCreatedApprovalRef.current = null;
      return;
    }
    let dead = false;
    void getChatApproval(chatId).then((m) => {
      if (!dead) setApprovalMode(m ?? "default");
    });
    return () => {
      dead = true;
    };
  }, [chatId]);
  const pickApprovalMode = (m: ChatApprovalMode | "default") => {
    const prev = approvalMode;
    setApprovalMode(m); // optimistic
    if (!chatId) return; // new thread: the pick applies when the send creates the chat
    void setChatApproval(chatId, m).catch(() => {
      setApprovalMode(prev);
      toast.error("Could not save approval mode");
    });
  };
  const [busy, setBusy] = useState(false);
  // A "normal" send's HTTP round trip is in flight: onThreadList consults
  // this and keeps the optimistic busy instead of lowering it from a list
  // push that predates the server's generating flag.
  const sendingRef = useRef(false);
  // Latest busy/threadLoading values for stable-ref consumers (the
  // deploy-freshness poll below must not read stale closure state).
  const loadStateRef = useRef({ busy: false, threadLoading: false });
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop sidebar
  const [width, setWidth] = useState<number>(() => storedSidebarWidth());
  // settings may resize the shared width while this sidebar stays mounted
  useEffect(() => {
    const resync = () => setWidth(storedSidebarWidth());
    window.addEventListener("guild:sidebar-width-changed", resync);
    return () => window.removeEventListener("guild:sidebar-width-changed", resync);
  }, []);
  const bottom = useRef<HTMLDivElement>(null);
  // Sticky-scroll: while streaming, follow the generated text ONLY when the
  // pane is already at the bottom; scrolling up detaches into free scroll,
  // scrolling back to the last character re-attaches . The scroll handler keeps `stick.current` truthful.
  const pane = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ta = useRef<HTMLTextAreaElement>(null);
  // The app shell root: pinned to the visual viewport while the on-screen
  // keyboard is up (see useVisualViewportPin) so the header stays visible.
  const shell = useRef<HTMLDivElement>(null);
  useVisualViewportPin(shell);
  // Only surfaces marked `data-scrollable` scroll by touch. Anywhere else a
  // drag must not pan the page over the fixed shell — iOS Safari pans the
  // visual viewport even under a `position: fixed` root (header, composer
  // and banners would all move with the content). A scroller already at its
  // edge in the drag direction is blocked too: WebKit turns that surplus
  // drag into pull-to-refresh / rubber-band, which pans the whole shell.
  useEffect(() => {
    const el = shell.current;
    if (!el) return;
    let startY: number | null = null;
    const touchStart = (e: TouchEvent) => { startY = e.touches[0]?.clientY ?? null; };
    const block = (e: TouchEvent) => {
      const target = e.target as Element | null;
      const scroller = target?.closest?.("[data-scrollable]") as HTMLElement | null;
      if (!scroller) { e.preventDefault(); return; }
      const dy = startY === null ? 0 : (e.touches[0]?.clientY ?? 0) - startY;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
    };
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", block, { passive: false });
    return () => {
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", block);
    };
  }, []);
  const loadSeq = useRef(0); // guards against stale chat switches landing last
  const skipLoadRef = useRef<string | null>(null); // chatId whose URL move must not trigger a refetch (first send)

  loadStateRef.current = { busy, threadLoading };

  // Reload the page once the served bundle hash differs from the running
  // one — never while a turn is streaming or a thread is loading.
  useEffect(() => {
    const currentBundle = () => {
      const m = document
        .querySelector('script[src*="/assets/index-"]')
        ?.getAttribute("src")
        ?.match(/index-([^"]+)\.js/);
      return m?.[1] ?? null;
    };
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch("/", { cache: "no-store" });
        if (!res.ok) return;
        const html = await res.text();
        const served = html.match(/index-([^"]+)\.js/)?.[1] ?? null;
        const mine = currentBundle();
        if (served && mine && served !== mine) {
          const s = loadStateRef.current;
          if (!s.busy && !s.threadLoading && !stopped && outgoingRef.current.size === 0 && ![...pendingDraftsRef.current.values()].some(files => files.length)) window.location.reload();
        }
      } catch {
        /* offline: nothing to compare this tick */
      }
    };
    const id = window.setInterval(tick, 60_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // busyRef/threadLoadingRef are stable refs; see below.
  }, []);

  useEffect(() => {
    listModels().then((m) => {
      if (m === null) {
        toast.error("Could not load models");
        return;
      }
      setModels(m);
      if (m.length > 0) setModel((cur) => cur || m[0]);
    });
  }, []);

  // Browser back/forward: re-derive the whole route from the URL. The
  // chatId effect below takes care of (re)loading or clearing the thread,
  // and the overlay state opens/closes the settings/device surfaces.
  useEffect(() => {
    const onPop = () => setRoute(parseChatRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Every navigation goes through here: history and route state move
  // together, so the URL always reflects what is on screen.
  const pushRoute = (next: { chatId?: string | null; projectId?: string | null; overlay?: ChatOverlay }) => {
    const chatId = "chatId" in next ? (next.chatId as string | null) : route.chatId;
    const projectId = "projectId" in next ? (next.projectId as string | null) : route.projectId;
    const ov = "overlay" in next ? (next.overlay as ChatOverlay) : route.overlay;
    const path = chatRoutePath(chatId, projectId, ov);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute({ chatId, projectId, overlay: ov });
  };

  useEffect(() => {
    if (!stick.current) return;
    bottom.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
  }, [blocks]);

  const refreshChats = async () => {
    const c = await listChats();
    if (c === null) {
      toast.error("Could not load chats");
      return;
    }
    setChats(c);
  };

  // ---- archived chats (the sidebar's Archived section) ----
  const [archivedChats, setArchivedChats] = useState<ChatSummary[] | null>(null);
  const refreshArchivedChats = useCallback(async () => {
    const c = await listArchivedChats();
    if (c !== null) setArchivedChats(c);
  }, []);
  useEffect(() => {
    void refreshArchivedChats();
  }, [refreshArchivedChats]);

  // ---- projects (sidebar grouping + the composer's project binding) ----

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [machines, setMachines] = useState<MachineInfo[] | null>(null);
  const refreshProjects = useCallback(async () => {
    const p = await listProjects();
    if (p === null) return; // silent: the sidebar degrades, chat keeps working
    setProjects(p);
  }, []);
  useEffect(() => {
    void refreshProjects();
    void listMachines().then(setMachines).catch(() => {});
  }, [refreshProjects]);

  // The composer's project binding. The chip is interactive only on a new
  // (unsent) chat, where the pick applies when the send creates the chat;
  // an existing chat displays its project read-only — the binding cannot
  // change after the chat started. Projectless is the default state.
  const [pickedProject, setPickedProject] = useState<PickedProject | null>(null);
  const pickedProjectRef = useRef<PickedProject | null>(pickedProject);
  pickedProjectRef.current = pickedProject;
  /** A pick made for the scratch view the navigation is entering (the
   * project row's "+"): the chatId switch consumes it, so the per-chat
   * reset applies to every other transition. */
  const scratchPickRef = useRef<PickedProject | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  /** Where the create-project dialog was opened from: only the composer's
   * project picker binds the new project to the chat — the sidebar's
   * "+" merely creates it. */
  const createProjectFromRef = useRef<"picker" | "sidebar">("picker");
  const openCreateProject = (from: "picker" | "sidebar") => {
    createProjectFromRef.current = from;
    setCreateProjectOpen(true);
  };
  const openRow = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  const currentProject = pickedProject ?? chatProjectOf(openRow);
  // Ref mirror for effects that must read the pick without re-running on
  // every pick change.
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const pickProject = (p: PickedProject | null) => {
    setPickedProject(p);
  };
  const projectCreated = (project: Project) => {
    void refreshProjects();
    if (createProjectFromRef.current !== "picker") return;
    pickProject({ id: project.id, name: project.name, machine_label: project.machine_label, folder: project.folder });
    setProjectPickerOpen(false);
  };

  // ---- sidebar row menu: rename + archive (row drop-out = list refresh) ----
  const renameChat = useCallback(async (id: string, title: string) => {
    try {
      await updateChat(id, { title });
      void refreshChats();
    } catch {
      toast.error("Could not rename the chat");
    }
  }, [refreshChats]);
  const archiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: true });
      await Promise.all([refreshChats(), refreshArchivedChats()]);
    } catch {
      toast.error("Could not archive the chat");
    }
  }, [refreshChats, refreshArchivedChats]);
  const unarchiveChat = useCallback(async (id: string) => {
    try {
      await updateChat(id, { archived: false });
      await Promise.all([refreshChats(), refreshArchivedChats()]);
    } catch {
      toast.error("Could not unarchive the chat");
    }
  }, [refreshChats, refreshArchivedChats]);
  const renameProject = useCallback(async (id: string, name: string) => {
    try {
      await updateProject(id, { name });
      // The chat list carries the project name on every row — refresh both.
      await Promise.all([refreshProjects(), refreshChats()]);
    } catch {
      toast.error("Could not rename the project");
    }
  }, [refreshChats, refreshProjects]);
  const archiveProject = useCallback(async (id: string) => {
    try {
      await updateProject(id, { archived: true });
      await Promise.all([refreshProjects(), refreshChats()]);
    } catch {
      toast.error("Could not archive the project");
    }
  }, [refreshChats, refreshProjects]);

  // The member socket owns thread reconciliation in both browser and Tauri
  // webview mode. The desktop app process keeps the separate machine socket.
  const openChatIdRef = useRef<string | null>(chatId);
  openChatIdRef.current = chatId;
  const knownDraftChatsRef = useRef(new Set<string>());
  // Draft GC: per-chat draft keys would otherwise accumulate forever and
  // outlive their chats. Drop the keys whose chat left the sidebar lists
  // (archived or deleted); the scratch draft ("new") and the open chat's
  // key always stay, and unloaded lists prune nothing.
  useEffect(() => {
    const keep = completeDraftInventory(chats, archivedChats, openChatIdRef.current);
    for (const chat of [...(chats ?? []), ...(archivedChats ?? [])]) knownDraftChatsRef.current.add(chat.id);
    if (keep) {
      // Active/archive refreshes can straddle an archive operation. Once a
      // chat was observed this session, absence from one refresh cannot
      // prove deletion. Unresolved sends also own their draft keys.
      for (const id of knownDraftChatsRef.current) keep.add(id);
      for (const command of outgoingRef.current.values()) if (command.chatId) keep.add(command.chatId);
      gcDrafts(draftStorage, keep);
    }
  }, [chats, archivedChats]);
  const socketRef = useRef<{ resync: () => void; stop: () => void } | null>(null);
  const syncingChatsRef = useRef(new Map<string, number>());

  const settleOutgoing = (command: OutgoingCommand) => {
    if (!mountedRef.current) return;
    command.accepted = true;
    outgoingRef.current.delete(command.id);
    forgetCommand(localStorage, outgoingScope, command.id);
    void fileStore.forgetCommand(command.id).catch(storageFailure);
    const target = command.chatId ?? command.originChatId;
    if (restoredCommandRef.current.get(target) === command.id) {
      const active = openChatIdRef.current === target;
      const draft = active ? promptRef.current : readDraft(draftStorage, target);
      const files = pendingDraftsRef.current.get(target) ?? [];
      if (matchesCommandDraft(command, draft, files)) {
        writeDraft(draftStorage, target, "");
        pendingDraftsRef.current.set(target, []);
        persistFiles(target, []);
        if (active) { promptRef.current = ""; setPrompt(""); setPending([]); }
      }
      restoredCommandRef.current.delete(target);
    }
    for (const a of command.attachments) {
      if (a.previewUrl && ![...pendingDraftsRef.current.values()].some(files => files.some(f => f.previewUrl === a.previewUrl))) {
        URL.revokeObjectURL(a.previewUrl);
      }
    }
    refreshOutgoing(n => n + 1);
  };

  const applyHistory = (state: ThreadState) => {
    const cid = state.chat_id;
    // The reducer owns the watermark and the view: a sequenced state applies
    // only its new events (a stale one changes nothing anywhere).
    const applied = reducerRef.current.applyState(state);
    if (applied.stale) return;
    for (const row of state.events) {
      if (row.event.type === "user_message") observedUserIdsRef.current.add(row.id);
      const command = outgoingRef.current.get(row.id);
      if (row.event.type === "user_message" && command && command.chatId === cid) settleOutgoing(command);
    }
    setChatStatus(prev => ({ ...prev, [cid]: {
      generating: state.generating,
      unread: cid === openChatIdRef.current ? false :
        (!state.generating && prev[cid]?.generating ? true : (prev[cid]?.unread ?? false)),
    } }));
    // ThreadState carries the chat's project fields: a live re-bind from
    // another device updates this client's row, so the chip and the sidebar
    // agree without a reload.
    setChats(prev =>
      prev?.map(c =>
        c.id === cid
          ? {
              ...c,
              project_id: state.project_id,
              project_name: state.project_name,
              project_machine_label: state.project_machine_label,
            }
          : c,
      ) ?? prev,
    );
    if (!chatsRef.current?.some(chat => chat.id === cid)) void refreshChats();
    if (cid !== openChatIdRef.current) return;
    setBusy(state.generating);
    setBlocks(applied.blocks);
    setCompacting(applied.compacting);
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void markChatRead(cid);
      setChatStatus((prev) =>
        prev[cid]?.unread ? { ...prev, [cid]: { ...prev[cid], unread: false } } : prev,
      );
      setChats((prev) =>
        prev?.map((c) => (c.id === cid && c.unread ? { ...c, unread: false } : c)) ?? prev,
      );
    }
  };

  // Chat switches keep cached content visible until the socket's History
  // frame overwrites it, then request a fresh sync for the new chat. The
  // project pick is per-chat: a pending pick (pre-first-send) or an old
  // chat's pick never carries over — except one carried in explicitly for
  // the destination (scratchPickRef: the project row's "+" enters the
  // scratch view with its project pre-picked).
  const prevLoadedChatRef = useRef<string | null>(chatId);
  useEffect(() => {
    const intendedPick = scratchPickRef.current;
    scratchPickRef.current = null;
    setPickedProject(pickAfterChatSwitch(chatId, intendedPick));
    // Per-chat draft: load the destination chat's saved composer text
    // instead of keeping the previous chat's text in the input. This
    // restore also marks the chat the persist effect may write for — from
    // here every prompt change belongs to this chatId.
    const restored = readDraft(draftStorage, chatId);
    promptRef.current = restored;
    pendingChatRef.current = chatId;
    pendingRef.current = pendingDraftsRef.current.get(chatId) ?? [];
    renderPending(pendingRef.current);
    setPrompt(restored);
    setCaret(restored.length);
    restoredForRef.current = chatId;
    if (restored) requestAnimationFrame(autoGrow);
    prevLoadedChatRef.current = chatId;
    loadSeq.current++;
    setBusy(false);
    stick.current = true;
    if (!chatId) {
      const opened = reducerRef.current.open(null);
      setBlocks(opened.blocks);
      setThreadLoading(false);
    } else if (skipLoadRef.current === chatId) {
      // Keep the optimistic first-send block: the created chat adopts the
      // scratch view; the socket still reconciles the new chat.
      skipLoadRef.current = null;
      setBlocks(reducerRef.current.adopt(chatId).blocks);
    } else {
      // The reducer's per-chat cache: a switch-back renders its last content
      // immediately, so switching never flashes a skeleton over known blocks.
      const opened = reducerRef.current.open(chatId);
      setThreadLoading(!opened.restored);
      setBlocks(opened.blocks);
    }
    socketRef.current?.resync();
  }, [chatId]);

  const openChat = (id: string) => {
    // Navigation only: the chatId effect performs the actual load, so back/
    // forward, deep links and sidebar picks all share one code path. The
    // chat's project rides along so the sidebar's project filter stays in
    // step with the URL.
    const row = chatsRef.current?.find((c) => c.id === id);
    setOpen(false);
    pushRoute({ chatId: id, projectId: row?.project_id ?? null, overlay: null });
  };

  const newChat = () => {
    // Navigation only: the chatId effect selects the new open chat and asks
    // the member socket to reconcile it. The new chat is projectless, so the
    // route's project id drops with it.
    pushRoute({ chatId: null, projectId: null, overlay: null });
    setOpen(false);
    ta.current?.focus();
  };

  /** The open chat is gone server-side (a sync hits "no such chat"): fall
   * back to a fresh chat silently, carrying the composer text over so a
   * resend just creates a new chat. Held in a ref because the socket effect
   * captures callbacks once and must not see a stale route. */
  const recoverMissingChat = () => {
    const dead = openChatIdRef.current;
    if (dead) {
      const text = readDraft(draftStorage, dead);
      if (text) writeDraft(draftStorage, null, text);
      writeDraft(draftStorage, dead, "");
    }
    newChat();
  };
  const recoverMissingChatRef = useRef(recoverMissingChat);
  recoverMissingChatRef.current = recoverMissingChat;

  /** Sidebar: new chat inside a project (the project row's hover "+").
   * Pre-picks the project so the composer binds the chat to it on send. The
   * chatId switch this triggers resets the pick per-chat — scratchPickRef
   * carries this pick through that same switch. */
  const newChatInProject = (project: PickedProject) => {
    scratchPickRef.current = project;
    pickProject(project);
    newChat();
  };

  const autoGrow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  // ---- member socket frame rendering ----

  const [machineTakenOver, setMachineTakenOver] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void watchMachinePresence(presence => {
      if (disposed) return;
      setMachineTakenOver(!!presence.displaced);
      if (presence.auth_required) signOut();
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, []);

  // One member socket serves both browser tabs and Tauri webviews. The
  // Tauri app process has its own machine socket for tool execution.
  useEffect(() => {
    if (isTauri) void setMachineIdentity(machineId()).catch(() => {});
    const connection = startSocket({
      onConnect: () => {
        syncingChatsRef.current.clear();
        // The reconnect sync's state re-derives each open view in full.
        reducerRef.current.invalidate();
        setBusy(false);
      },
      onThreadList: (nextChats) => {
        setChats(nextChats);
        setChatStatus(statusFromThreads(nextChats));
        // busyAfterThreadPush keeps the optimistic busy while a send's
        // HTTP round trip is in flight (the push predates the server's
        // generating flag — clearing busy here would let a second send
        // race the first).
        setBusy(busyAfterThreadPush(nextChats, openChatIdRef.current, sendingRef.current));
      },
      // Sequenced ThreadState owns busy state; older status notifications cannot override it.
      onChatStatus: () => {},
      onThreadState: (state) => applyHistory(state),
      onSync: (cid, phase) => {
        if (phase === "begin") {
          syncingChatsRef.current.set(cid, (syncingChatsRef.current.get(cid) ?? 0) + 1);
        } else {
          const depth = (syncingChatsRef.current.get(cid) ?? 1) - 1;
          if (depth > 0) syncingChatsRef.current.set(cid, depth);
          else syncingChatsRef.current.delete(cid);
        }
        if (cid !== openChatIdRef.current) return;
        if (phase === "begin") {
          setThreadLoading(true);
        } else if (!syncingChatsRef.current.has(cid)) {
          setThreadLoading(false);
        }
      },
      // Content is replaced only by sequenced ThreadState, never by raw deltas.
      onFrame: (frame) => {
        if (frame.chat_id === openChatIdRef.current && frame.event.type === "error") {
          toast.error(frame.event.message ?? "Model error");
        }
      },
      onError: (message) => {
        if (message === "frames dropped — resync") {
          socketRef.current?.resync();
        } else if (message === "no such chat" && openChatIdRef.current) {
          // The open chat no longer exists (stale deep link, chat deleted
          // elsewhere, server store reset): drop into a fresh chat instead
          // of showing an error the user cannot act on.
          recoverMissingChatRef.current();
        } else {
          setThreadLoading(false);
          toast.error(message);
        }
      },
      onDisplaced: () => toast.error("This chat connection was replaced"),
      onAuthRequired: () => signOut(),
      getOpenChatId: () => openChatIdRef.current,
    });
    socketRef.current = connection;
    return () => {
      if (socketRef.current === connection) socketRef.current = null;
      connection.stop();
    };
    // Stable refs keep this member socket alive for the component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recoverOutgoing = (command: OutgoingCommand) => {
    const target = command.chatId ?? command.originChatId;
    const active = openChatIdRef.current === target;
    const newerText = active ? promptRef.current : readDraft(draftStorage, target);
    const newerFiles = pendingDraftsRef.current.get(target) ?? [];
    // A newer draft wins. The failed command stays available separately.
    const recovered = recoveryDraft(command, newerText, newerFiles);
    if (recovered.restored) {
      writeDraft(draftStorage, target, recovered.text);
      pendingDraftsRef.current.set(target, recovered.files);
      persistFiles(target, recovered.files);
      restoredCommandRef.current.set(target, command.id);
      if (active) {
        promptRef.current = recovered.text;
        setPrompt(recovered.text);
        setPending(recovered.files);
      }
    }
    refreshOutgoing(n => n + 1);
  };

  const deliverOutgoing = async (command: OutgoingCommand) => {
    if (!mountedRef.current) return;
    if (command.running || command.accepted || deliveringRef.current.has(command.id)) return;
    deliveringRef.current.add(command.id);
    try { await persistCommand(command); } catch { deliveringRef.current.delete(command.id); return; }
    if (!mountedRef.current) { deliveringRef.current.delete(command.id); return; }
    const target = command.chatId ?? command.originChatId;
    detachCommandDraft(command, {
      read: target => ({ text: openChatIdRef.current === target ? promptRef.current : readDraft(draftStorage, target),
        files: pendingDraftsRef.current.get(target) ?? [] }),
      clear: target => {
        writeDraft(draftStorage, target, "");
        pendingDraftsRef.current.set(target, []);
        persistFiles(target, []);
        if (openChatIdRef.current === target) { promptRef.current = ""; setPrompt(""); setPending([]); }
      },
    });
    if (command.accepted) { deliveringRef.current.delete(command.id); return; }
    const mySeq = loadSeq.current;
    if (openChatIdRef.current === target) {
      setBusy(true);
      setBlocks(reducerRef.current.optimisticSend({ chatId: target, text: command.text,
        key: command.id, sentAt: command.sentAt,
        attachments: command.attachments.map(a => ({ ...a, file: undefined, id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}` })) }).blocks);
    }
    sendingRef.current = true;
    try {
      await submitCommand(command, {
        checkpoint: persistCommand,
        create: async (text, project) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          const cid = await createChat(text.slice(0, 48), project);
          if (!cid) throw new Error("Chat create failed");
          return cid;
        },
        created: (cid) => {
          if (!mountedRef.current) return;
          reducerRef.current.bindPending(cid, command.id);
          if (loadSeq.current === mySeq && openChatIdRef.current === command.originChatId) {
            // Preserve follow-up typing/files entered during chat creation.
            writeDraft(draftStorage, cid, promptRef.current);
            writeDraft(draftStorage, command.originChatId, "");
            pendingDraftsRef.current.set(cid, pendingRef.current);
            pendingDraftsRef.current.set(command.originChatId, []);
            persistFiles(cid, pendingRef.current);
            persistFiles(command.originChatId, []);
            skipLoadRef.current = cid;
            if (approvalMode !== "default") {
              justCreatedApprovalRef.current = cid;
              void setChatApproval(cid, approvalMode).catch(() => toast.error("Could not save approval mode"));
            }
            pushRoute({ chatId: cid, overlay: null });
            void refreshChats();
          }
        },
        upload: (cid, attachment) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          return uploadAttachment(cid, attachment.file!);
        },
        uploaded: (attachment, meta) => {
          if (!mountedRef.current) return;
          // The stamp persists with the attachment (localStorage and the
          // file store): a restored draft re-sends the server id instead of
          // its local identity.
          attachment.uploadedAs = meta;
          const changed = reducerRef.current.settleAttachment(command.id, `pending-${attachment.id}`, meta.id);
          if (openChatIdRef.current === command.chatId || loadSeq.current === mySeq) setBlocks(changed.blocks);
        },
        prepare: async (text, folder) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([prepareTurn(text, folder), new Promise<null>(resolve => {
              timer = setTimeout(() => resolve(null), 10_000);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        },
        submit: async (cid, id, body) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          rememberCommand(localStorage, outgoingScope, command);
          await sendChatNoStream(cid, body.model, body.prompt, body.attachmentIds, body.projectId,
            id, body.sendMode, body.skillsIndex, body.instructions);
        },
      });
      settleOutgoing(command);
    } catch (e) {
      if (!mountedRef.current) return;
      const cid = command.chatId ?? command.originChatId;
      const failed = reducerRef.current.failSend(cid, command.id, e instanceof Error ? e.message : String(e));
      if (openChatIdRef.current === cid) { setBlocks(failed.blocks); setBusy(false); }
      recoverOutgoing(command);
    } finally {
      deliveringRef.current.delete(command.id);
      if (!mountedRef.current) return;
      sendingRef.current = [...outgoingRef.current.values()].some(c => c.running && (c.chatId ?? c.originChatId) === openChatIdRef.current);
      if (command.error && openChatIdRef.current === (command.chatId ?? command.originChatId)) setBusy(false);
      refreshOutgoing(n => n + 1);
    }
  };

  const send = async (mode: "normal" | "queue" | "steer" = "normal") => {
    if (!mountedRef.current || !filesReady) return;
    const text = promptRef.current.trim();
    if ((!text && pendingRef.current.length === 0) || !model) return;
    if (text.toLowerCase() === "/compact") {
      if (!chatId) { toast.error("Compact needs an existing chat — send a message first"); return; }
      promptRef.current = "";
      setPrompt("");
      setCompacting(reducerRef.current.setCompacting(chatId).compacting);
      try { await compactChat(chatId); }
      catch (e) { setCompacting(reducerRef.current.setCompacting(null).compacting); toast.error(e instanceof Error ? e.message : String(e)); }
      return;
    }
    const retry = [...outgoingRef.current.values()].find(c => c.error && (c.chatId ?? c.originChatId) === chatId && matchesCommandDraft(c, text, pendingRef.current));
    if (retry) { await deliverOutgoing(retry); return; }
    const generating = busy || openGenerating;
    if (mode === "normal" && generating) return;
    if ([...outgoingRef.current.values()].some(c => deliveringRef.current.has(c.id) && !c.running && (c.chatId ?? c.originChatId) === chatId)) return;
    if (!chatId && [...outgoingRef.current.values()].some(c => c.running && c.originChatId === null)) return;
    const selected = currentProject ? projects?.find(p => p.id === currentProject.id) : undefined;
    const executor = selected?.machine_id ?? (currentProject ? openRow?.machine_id ?? undefined : undefined);
    const command = captureCommand({
      id: crypto.randomUUID(), originChatId: chatId, chatId, text, model,
      createProjectId: pickedProjectRef.current?.id ?? null,
      projectId: outgoingProjectId(pickedProjectRef.current),
      projectFolder: currentProject?.folder ?? selected?.folder,
      prepareLocally: prepareOnSendingMachine(isTauri, !!currentProject, executor ?? undefined, isTauri ? machineId() : ""),
      sendMode: generating ? (mode === "steer" ? "steer" : "queue") : undefined,
      attachments: pendingRef.current,
    });
    outgoingRef.current.set(command.id, command);
    // Persist the immutable file snapshot before detaching the composer.
    await deliverOutgoing(command);
  };

  useEffect(() => {
    let active = true;
    void fileStore.restore().then(({ drafts, commands }) => {
      if (!active || !mountedRef.current) {
        for (const files of drafts.values()) for (const file of files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        for (const command of commands.values()) for (const file of command.attachments) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        return;
      }
      for (const [target, files] of drafts) pendingDraftsRef.current.set(target, files);
      pendingRef.current = pendingDraftsRef.current.get(openChatIdRef.current) ?? [];
      renderPending(pendingRef.current);
      for (const [id, loaded] of commands) {
        // The synchronous fallback records the exact submitted body even
        // when an IndexedDB checkpoint failed; never replace it with an
        // earlier upload/context snapshot.
        const existing = outgoingRef.current.get(id);
        const command = selectRestoredCommand(existing, loaded);
        if (command !== loaded) for (const file of loaded.attachments) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        if (observedUserIdsRef.current.has(id)) {
          void fileStore.forgetCommand(id).catch(storageFailure);
          forgetCommand(localStorage, outgoingScope, id);
          for (const file of command.attachments) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
          continue;
        }
        outgoingRef.current.set(id, command);
        // Unfinished sends remain in their retry card. Composer records,
        // including intentionally emptied drafts, retain their own state.
      }
      // Files and text may both have been saved before a send detached its
      // composer. Keep their relationship so acceptance clears only that draft.
      for (const command of outgoingRef.current.values()) {
        const target = command.chatId ?? command.originChatId;
        const text = target === openChatIdRef.current ? promptRef.current : readDraft(draftStorage, target);
        if (matchesCommandDraft(command, text, pendingDraftsRef.current.get(target) ?? [])) restoredCommandRef.current.set(target, command.id);
      }
      refreshOutgoing(n => n + 1);
      setFilesReady(true);
    }).catch(() => { if (active) { storageFailure(); setFilesReady(true); } });
    return () => { active = false; };
    // One account-scoped instance; navigation/edits are resolved through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileStore]);

  // Stop the chat's in-flight turn. 409 (nothing generating) resolves
  // silently — the turn already ended between the render and the click.
  // The optimistic stopping flag rides the click: the button's Stop state
  // flips to "stopping" at once, and lifts when the server's own
  // generating=false lands (pruneStopping) — a rejected (409) or failed
  // stop lifts it here, so the button stays retryable.
  const requestStop = async () => {
    const cid = chatId;
    if (!cid || stopping[cid]) return;
    setStopping((prev) => (prev[cid] ? prev : { ...prev, [cid]: true }));
    try {
      if (!(await stopChat(cid))) {
        setStopping((prev) => {
          if (!prev[cid]) return prev;
          const next = { ...prev };
          delete next[cid];
          return next;
        });
      }
    } catch {
      // the turn already ended or the stop failed; the feed's own state
      // settles the spinner
      setStopping((prev) => {
        if (!prev[cid]) return prev;
        const next = { ...prev };
        delete next[cid];
        return next;
      });
    }
  };

  // Cancellation flags resolve into server truth: every push that moves a
  // chat's generating state gets a chance to lift its stopping flag.
  useEffect(() => {
    setStopping((prev) => pruneStopping(prev, chatStatus, chats) ?? prev);
  }, [chats, chatStatus]);

  const activeTitle = chats?.find((c) => c.id === chatId)?.title ?? "New chat";
  const offlineMachineBanner = offlineMachine(chats, chatId, isTauri, isTauri ? machineId() : undefined);
  const streaming = busy || openGenerating;

  const grouping = useMemo(
    () => sidebarGrouping(chats === null ? null : chats.map((c) => ({ ...c, ...(chatStatus[c.id] ?? {}) }))),
    [chats, chatStatus],
  );

  // Sidebar tab: one icon rail (desktop) switches the panel between chats,
  // work and settings; the choice persists across sessions.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(storedSidebarTab);
  // Settings tab: the section rendered inline in the main pane (the rail's
  // Settings tab is a persistent surface, not an overlay launcher). Sub-page
  // navigation stays local to the pane.
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [settingsDetail, setSettingsDetail] = useState<string | null>(null);
  const switchTab = (tab: SidebarTab) => {
    setSidebarTab(tab);
    saveSidebarTab(tab);
    // A collapsed panel hides the tab's content — a tab pick is an intent
    // to see it, so the panel re-expands on the newly picked tab.
    setCollapsed(false);
    // Entering Settings with no section picked lands on the first user
    // section instead of an empty main pane.
    if (tab === "settings") setSettingsSection((s) => s ?? "account");
  };
  const openSettingsSection = (id: string) => {
    setSettingsSection(id);
    setSettingsDetail(null);
  };

  /** Optional section id deep-links into the settings overlay (null = root). */
  const openSettings = (section?: string) =>
    pushRoute({ overlay: { kind: "settings", section: section ?? null, detail: null } });

  const sidebarCollapse = isMobile ? undefined : () => setCollapsed(true);
  // The mobile drawer has no rail, so it always shows the Chats panel — the
  // persisted tab must not leak into it.
  const chatsPanel = (
    <ChatsPanel
      grouping={grouping}
      loadingChats={chats === null}
      chatId={chatId}
      archivedChats={archivedChats}
      onNewChat={newChat}
      onOpenChat={openChat}
      onCollapse={sidebarCollapse}
      onRenameChat={(id, title) => void renameChat(id, title)}
      onArchiveChat={(id) => void archiveChat(id)}
      onUnarchiveChat={(id) => void unarchiveChat(id)}
    />
  );
  const sidebar =
    sidebarTab === "work" ? (
      <WorkPanel
        grouping={grouping}
        projects={projects}
        machines={machines}
        chatId={chatId}
        onOpenChat={openChat}
        onCollapse={sidebarCollapse}
        onNewChatInProject={newChatInProject}
        onNewProject={() => openCreateProject("sidebar")}
        onRenameChat={(id, title) => void renameChat(id, title)}
        onArchiveChat={(id) => void archiveChat(id)}
        onRenameProject={(id, name) => void renameProject(id, name)}
        onArchiveProject={(id) => void archiveProject(id)}
      />
    ) : sidebarTab === "settings" ? (
      <SettingsPanel
        role={role}
        activeSection={settingsSection}
        onSelectSection={openSettingsSection}
        onOpenSettings={() => openSettings()}
        onCollapse={sidebarCollapse}
      />
    ) : (
      chatsPanel
    );

  // A /project/<id> route (deep link, reload, or back/forward) opens on the
  // Work tab so the linked project is visible. Neither tab decision is
  // persisted: routes are navigation, not tab preferences.
  useEffect(() => {
    if (route.projectId) setSidebarTab("work");
  }, [route.projectId]);
  // Chat routes: a stateless chat lands on the Chats tab; a project-bound
  // chat belongs to its project row — it opens (or stays) on the Work tab
  // instead of yanking the user out of it. The decision waits for the chats
  // list; a chat not yet listed (just sent) counts as bound while the
  // composer still carries a project pick.
  const routeTabDecidedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!route.chatId) {
      routeTabDecidedRef.current = null;
      return;
    }
    if (routeTabDecidedRef.current === route.chatId) return; // already handled
    if (chats === null) return; // wait for the list before deciding
    const row = chats.find((c) => c.id === route.chatId);
    const projectBound = row ? !!row.project_id : !!currentProjectRef.current?.id;
    routeTabDecidedRef.current = route.chatId;
    setSidebarTab(projectBound ? "work" : "chats");
  }, [route.chatId, chats]);

  // The Settings tab's main pane renders the picked section inline instead
  // of the chat thread (desktop only — the mobile drawer has no settings
  // tab). The full overlay stays available via "All settings" and the
  // account menu, and keeps its URL-driven open/close.
  const inlineSettings =
    !isMobile && sidebarTab === "settings" && settingsSection !== null ? (
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <SettingsSectionPane
          sectionId={settingsSection}
          email={email}
          detail={settingsDetail}
          onDetailChange={setSettingsDetail}
        />
      </div>
    ) : null;

  // desktop: draggable resize handle. While dragging, the width transition
  // is suspended — an animated width chases the cursor and reads as lag.
  const [resizing, setResizing] = useState(false);
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      setResizing(true);
      const move = (ev: MouseEvent) => {
        const w = clampSidebarWidth(startW + ev.clientX - startX);
        setWidth(w);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        setResizing(false);
        setWidth((w) => {
          saveSidebarWidth(w);
          return w;
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [width],
  );

  return (
    <div ref={shell} className="fixed inset-0 flex bg-background text-foreground">
      {/* icon rail: desktop only, always visible — it switches the sidebar
          panel between chats / work / settings and carries the account menu */}
      {!isMobile && (
        <SidebarRail
          activeTab={sidebarTab}
          onTabChange={switchTab}
          email={email}
          displayName={displayName}
          avatarUrl={avatarUrl}
          onOpenSettings={openSettings}
          onOpenDevice={() => pushRoute({ overlay: { kind: "device" } })}
          onSignOut={signOut}
          onAddWorkspace={onAddWorkspace}
        />
      )}
      {/* desktop sidebar: resizable + collapsible; mobile: drawer */}
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Chats</SheetTitle>
            {chatsPanel}
          </SheetContent>
        </Sheet>
      ) : (
        <aside
          className={`relative flex shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground ${
            resizing ? "" : "transition-[width] duration-150"
          } ${collapsed ? "" : "border-r border-border"}`}
          style={{ width: collapsed ? 0 : width }}
        >
          {/* Collapsed = panel fully gone (the icon rail stays); the header
              toggle reopens it and the central pane reflows on toggle. */}
          {!collapsed && sidebar}
          {!collapsed && (
            <div
              className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ring"
              onMouseDown={startDrag}
              title="Drag to resize"
            />
          )}
        </aside>
      )}

      {/* main column */}
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          // only leaving the pane itself (not entering a child) clears the hint
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length === 0) return;
          e.preventDefault();
          setDragOver(false);
          addFiles(files);
        }}
      >
        {machineTakenOver && <div role="status" className="border-b border-border px-4 py-2 text-muted-foreground">Taken over on this machine. Tools run in the other Guild app.</div>}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
            <div className="rounded-xl border-2 border-dashed border-border bg-card px-6 py-5 text-muted-foreground shadow-lg">
              Drop files to attach
            </div>
          </div>
        )}
        {inlineSettings ? (
          inlineSettings
        ) : (
          <>
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
          {isMobile ? (
            <Button variant="ghost" size="icon" className="-ml-1.5 size-8" onClick={() => setOpen(true)}>
              <Menu />
            </Button>
          ) : (
            // Expanded: the collapse button lives in the sidebar's own header
            // (right side); only the reopen button stays here.
            collapsed && (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-1.5 size-8 text-muted-foreground"
                onClick={() => setCollapsed(false)}
                title="Open sidebar"
              >
                <PanelLeftOpen />
              </Button>
            )
          )}
          <span className="min-w-0 flex-1 truncate font-medium">
            {threadLoading && blocks.length === 0 ? (
              <Skeleton className="h-4 w-28 rounded-md" />
            ) : (
              activeTitle
            )}
          </span>
        </header>

        {offlineMachineBanner && (
          <div role="status" className="border-b border-amber-700/60 bg-amber-900/30 px-4 py-2 text-amber-300">
            {offlineMachineBanner.label} is offline — tools won't run until it reconnects.
          </div>
        )}

        {blocks.length === 0 ? (
          threadLoading ? (
            <ThreadSkeleton />
          ) : !chatId ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-32 py-8">
            {models !== null && models.length === 0 && (
              <p className="rounded-md border border-amber-700/60 bg-amber-900/30 px-3 py-1.5 text-amber-300">
                no models configured — ask an admin to add a route
              </p>
            )}
          </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-4 pb-32 py-8">
              <p className="text-muted-foreground">No messages in this thread yet.</p>
            </div>
          )
        ) : (
          <div
            ref={pane}
            data-scrollable
            className="min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain"
            onScroll={() => {
              const el = pane.current;
              if (!el) return;
              // near-bottom counts as bottom (sub-pixel/rounding slack)
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
            }}
          >
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-32 pt-6">
              {blocks.map((b, i) =>
                b.kind === "user" ? (
                  <div
                    key={b.key}
                    className={`ml-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 ${WRAP_ANYWHERE}`}
                  >
                    {b.text && <div className="whitespace-pre-wrap">{b.text}</div>}
                    {b.attachments && b.attachments.length > 0 && (
                      <div className="mt-1 flex max-w-full flex-wrap items-start justify-end gap-2">
                        {b.attachments.filter((a) => a.modality === "image").map((a) => (
                          <AttachmentImageThumb key={a.id} att={a} />
                        ))}
                        {b.attachments.filter((a) => a.modality !== "image").map((a) => (
                          <AttachmentFileChip key={a.id} att={a} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : b.kind === "reasoning" ? (
                  <ReasoningFrame
                    key={b.key}
                    text={b.reasoningText ?? ""}
                    live={streaming && i === blocks.length - 1}
                  />
                ) : b.kind === "tool" && b.tool ? (
                  <ToolFrame key={b.key} t={b.tool} />
                ) : b.kind === "approval" && b.approval ? (
                  <ApprovalCard key={b.key} a={b.approval} chatId={chatId} />
                ) : b.kind === "compaction" && b.compaction ? (
                  <CompactionCard key={b.key} c={b.compaction} />
                ) : b.kind === "error" ? (
                  <div
                    key={b.key}
                    className="w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
                  >
                    {b.text}
                  </div>
                ) : (
                  <div
                    key={b.key}
                    className={`max-w-none space-y-2 leading-relaxed ${MD_CLASS} ${MD_TABLE_CLASS}`}
                  >
                    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {/* streaming caret rides INSIDE the markdown source so
                          it lands on the forming line, not below the block */}
                      {streaming && i === blocks.length - 1 ? `${b.text}▍` : b.text}
                    </Markdown>
                    {b.interrupted && !streaming && (
                      <div className="text-xs text-muted-foreground">stopped</div>
                    )}
                  </div>
                ),
              )}
              {/* in-progress /compact line: replaced by the durable
                  "Context compacted" card when the event lands. The reducer
                  computes the guard (its armed target vs the open chat) —
                  with chatId still null during a first send it never holds. */}
              {compacting && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Compacting thread…</span>
                </div>
              )}
              {/* Working shimmer: the turn is generating but the log's tail
                  is not already animating — before the first token, after a
                  finished tool frame, or on a silent gap. A live text tail
                  rides its own ▍ caret and live thinking shows "Thinking…",
                  so those tails get no second indicator. */}
              {streaming &&
                !(
                  blocks.length > 0 &&
                  (blocks[blocks.length - 1].kind === "text" ||
                    blocks[blocks.length - 1].kind === "reasoning")
                ) && (
                  <div className="max-w-none py-1">
                    <WorkingIndicator
                      label={chatId && stopping[chatId] ? "Stopping" : "Working"}
                    />
                  </div>
                )}
              <div ref={bottom} />
            </div>
          </div>
        )}

        {/* composer: floats over the chat content; the scroll pane runs
            full-height behind it */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:px-4">
          <div className="pointer-events-auto mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card p-2 shadow-lg backdrop-blur-sm">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {[...outgoingRef.current.values()].filter(c => c.error && (c.chatId ?? c.originChatId) === chatId).map(command => (
              <div key={command.id} className="px-2 pb-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={command.text}>Send needs retry: {command.text || "attachments"}</span>
                  <Button variant="outline" size="sm" disabled={command.running} onClick={() => void deliverOutgoing(command)}>Retry send</Button>
                </div>
                {command.error && (
                  <div className="truncate text-xs text-muted-foreground/80" title={command.error}>{command.error}</div>
                )}
              </div>
            ))}
            {pending.length > 0 && (
              <div className="flex flex-wrap items-start gap-2 px-1 pb-2">
                {pending.filter((a) => a.modality === "image").map((a) => (
                  <AttachmentImageThumb
                    key={a.id}
                    att={a}
                    onRemove={() =>
                      setPending((p) =>
                        p.filter((x) => {
                          if (x.id !== a.id) return true;
                          if (x.previewUrl) URL.revokeObjectURL(x.previewUrl);
                          return false;
                        }),
                      )
                    }
                  />
                ))}
                {pending.filter((a) => a.modality !== "image").map((a) => (
                  <AttachmentFileChip
                    key={a.id}
                    att={a}
                    onRemove={() =>
                      setPending((p) =>
                        p.filter((x) => {
                          if (x.id !== a.id) return true;
                          if (x.previewUrl) URL.revokeObjectURL(x.previewUrl);
                          return false;
                        }),
                      )
                    }
                  />
                ))}
              </div>
            )}
            {mentionMatches.length > 0 && (
              <div data-scrollable className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-md">
                {mentionMatches.map((sk, i) => (
                  <button
                    key={sk.name}
                    type="button"
                    onMouseDown={(e) => {
                      // preventDefault keeps focus (and the caret) in the textarea
                      e.preventDefault();
                      acceptMention(sk.name);
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                      i === Math.min(mentionIndex, mentionMatches.length - 1) ? "bg-accent" : ""
                    }`}
                  >
                    <span className="text-sm font-medium">/{sk.name}</span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {sk.builtin ? sk.description : `${sk.description} — the skill's instructions are attached when you send`}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <Textarea
              ref={ta}
              value={prompt}
              onChange={(e) => {
                fileStore.touchDraft(chatId);
                promptRef.current = e.target.value;
                setPrompt(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                autoGrow();
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onPaste={(e) => {
                // Clipboard files (screenshot copies, image copies) attach
                // like drag-and-drop instead of doing nothing.
                const files = Array.from(e.clipboardData?.files ?? []);
                if (files.length > 0) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (mentionMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % mentionMatches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex(
                      (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptMention(mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)].name);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMentionDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  // While a turn runs: Enter queues for the turn's next
                  // pause; Ctrl/Cmd+Enter steers — interrupts the turn and
                  // sends immediately.
                  const generating = busy || openGenerating;
                  void send(
                    generating ? (e.ctrlKey || e.metaKey ? "steer" : "queue") : "normal",
                  );
                }
              }}
              rows={1}
              placeholder={models === null || model ? "Message Guild…" : "No model available"}
              data-scrollable
              // Not disabled while streaming: a disabled focused element
              // blurs to body, and the composer must keep focus/caret
              // during generation (send is guarded by `busy` anyway).
              disabled={models !== null && !model}
              className="max-h-40 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none"
            />
            {/* One line, never wrapping: on narrow screens the labeled badges
                collapse to their icons (text stays in the title tooltip). */}
            <div className="flex flex-nowrap items-center justify-between gap-x-2 px-1 pt-1">
              <div className="flex min-w-0 flex-nowrap items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  title="Attach images, audio, or files"
                >
                  <Plus className="size-4" />
                </Button>
                {(() => {
                  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
                  // One chip for project + machine. The executing machine is
                  // project-derived: an existing chat inherits its bound
                  // project's machine, a new chat the picked project's. The
                  // dot renders only for a remote machine (on desktop the
                  // local machine executes its own tools) whose live socket
                  // state is known — the chat row for existing chats, the
                  // machines list for new ones (hidden while unknown).
                  const chipMachineId =
                    row?.machine_id && row.project_id
                      ? row.machine_id
                      : projects?.find((p) => p.id === currentProject?.id)?.machine_id;
                  const remoteMachine =
                    !!chipMachineId && (!isTauri || chipMachineId !== machineId());
                  // The chat row may be absent right after a create (route
                  // pushed before the refetched list lands) — the chip then
                  // renders without a live socket state instead of crashing.
                  const machineOnline: boolean | undefined = remoteMachine
                    ? chatId
                      ? row?.machine_online
                      : machines?.find((m) => m.machine_id === chipMachineId)?.connected
                    : undefined;
                  const showMachine = remoteMachine && machineOnline !== undefined;
                  const machineLabel =
                    row?.machine_label ??
                    machines?.find((m) => m.machine_id === chipMachineId)?.name ??
                    chipMachineId;
                  return (
                    (!chatId || currentProject) && (
                      <span
                        className="flex h-7 max-w-52 items-center gap-1.5 rounded-full bg-secondary px-2 text-muted-foreground"
                        title={
                          showMachine
                            ? `${currentProject ? `${currentProject.name} — ` : ""}Machine: ${machineLabel}${machineOnline ? " (online)" : " (offline)"}`
                            : currentProject
                              ? `${currentProject.name} — ${currentProject.machine_label ?? "project"}`
                              : "Pick the folder the agent works in"
                        }
                      >
                        {showMachine && (
                          <span
                            className={`size-2 shrink-0 rounded-full ${machineOnline ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                          />
                        )}
                        {chatId ? (
                          // An existing chat: the binding is fixed at chat
                          // start — a bound project shows as a read-only
                          // label; a projectless existing chat renders no
                          // chip at all (outer guard above).
                          <span className="flex h-7 items-center gap-1 px-2">
                            <FolderOpen className="size-3.5 shrink-0" />
                            <span className="hidden min-w-0 sm:block sm:flex-1">
                              <FadeTitle text={projectChipLabel(currentProject)} />
                            </span>
                          </span>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 max-w-44 gap-1 rounded-full px-2 text-muted-foreground hover:text-foreground sm:max-w-40"
                              onClick={() => setProjectPickerOpen(true)}
                            >
                              <FolderOpen className="size-3.5 shrink-0" />
                              <span className="hidden min-w-0 sm:block sm:flex-1">
                                <FadeTitle text={projectChipLabel(currentProject)} />
                              </span>
                            </Button>
                            {currentProject && (
                              <button
                                type="button"
                                title="Detach the project (the agent works without a folder)"
                                className="shrink-0 rounded-full p-0.5 hover:bg-foreground/10 hover:text-foreground"
                                onClick={() => pickProject(null)}
                              >
                                <XIcon className="size-3" />
                              </button>
                            )}
                          </>
                        )}
                      </span>
                    )
                  );
                })()}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`h-7 gap-1 rounded-full px-2 ${
                        approvalMode === "full_access"
                          ? "text-orange-500 hover:text-orange-400"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      title="How tool actions are approved in this chat"
                    >
                      {(() => {
                        // Icon-only on narrow screens: the icon must say
                        // which mode is active, not always the shield.
                        const ActiveIcon = approvalMode === "default" ? ShieldCheck : APPROVAL_MODES[approvalMode].icon;
                        return <ActiveIcon className="size-3.5 shrink-0" />;
                      })()}
                      <span className="hidden sm:inline">
                        {approvalMode === "default" ? accountDefault : APPROVAL_MODE_LABELS[approvalMode]}
                      </span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      How should tool actions be approved?
                    </DropdownMenuLabel>
                    {(Object.keys(APPROVAL_MODES) as (keyof typeof APPROVAL_MODES)[]).map((m) => {
                      const entry = APPROVAL_MODES[m];
                      const Icon = entry.icon;
                      return (
                        <DropdownMenuItem key={m} onClick={() => pickApprovalMode(m)}>
                          <div className="flex w-full items-start gap-2.5">
                            <Icon className={`mt-0.5 size-4 shrink-0 ${entry.iconCls ?? "text-muted-foreground"}`} />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium">{entry.label}</div>
                              <div className="text-xs text-muted-foreground">{entry.hint}</div>
                            </div>
                            {approvalMode === m && <Check className="mt-1 size-3.5 shrink-0" />}
                          </div>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
            {models !== null && models.length === 0 && (
              <span className="text-muted-foreground">no models</span>
            )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {models !== null && models.length > 0 && (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="h-7 w-auto min-w-0 max-w-28 gap-1 border-none bg-secondary px-2 shadow-none sm:max-w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {(() => {
                  // While a turn generates the composer stays usable: with
                  // content the send queues (Ctrl/Cmd+Enter steers); empty,
                  // the button turns into Stop. A clicked stop shows its own
                  // state (pulsing square, "Stopping…") until the server's
                  // generating=false lands — the stop is cooperative
                  // server-side, so this is the only immediate feedback the
                  // click can honestly get.
                  const generating = busy || openGenerating;
                  const hasContent = !!prompt.trim() || pending.length > 0;
                  const stopMode = generating && !hasContent;
                  const stoppingMode = stopMode && !!chatId && !!stopping[chatId];
                  return (
                    <Button
                      size="icon"
                      className="size-7 rounded-full"
                      onClick={() =>
                        stopMode ? void requestStop() : void send(generating ? "queue" : "normal")
                      }
                      disabled={stoppingMode ? true : stopMode ? false : !model || !hasContent}
                      title={
                        stoppingMode
                          ? "Stopping…"
                          : stopMode
                            ? "Stop"
                            : generating
                              ? "Queue (Ctrl+Enter sends immediately)"
                              : "Send"
                      }
                    >
                      {stopMode ? (
                        <Square
                          className={`size-3.5 fill-current ${stoppingMode ? "animate-pulse" : ""}`}
                        />
                      ) : (
                        <ArrowUp />
                      )}
                    </Button>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
          </>
        )}
      </div>

      <DeviceSetupDialog
        open={overlay?.kind === "device"}
        onOpenChange={(o) => {
          if (!o) pushRoute({ overlay: null });
        }}
      />

      <ProjectPickerDialog
        open={projectPickerOpen}
        onOpenChange={setProjectPickerOpen}
        projects={projects}
        chats={chats}
        current={currentProject}
        onPick={pickProject}
        onCreateProject={() => openCreateProject("picker")}
      />

      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        machines={machines}
        localMachineId={machineId()}
        isTauri={isTauri}
        projects={projects}
        onCreated={projectCreated}
      />

      <SettingsWindow
        open={overlay?.kind === "settings"}
        onOpenChange={(o) => {
          if (!o) pushRoute({ overlay: null });
        }}
        section={overlay?.kind === "settings" ? overlay.section : null}
        detail={overlay?.kind === "settings" ? overlay.detail : null}
        onSectionChange={(id) =>
          pushRoute({ overlay: { kind: "settings", section: id, detail: null } })
        }
        onDetailChange={(d) =>
          pushRoute({
            overlay: {
              kind: "settings",
              section: overlay?.kind === "settings" ? overlay.section : null,
              detail: d,
            },
          })
        }
        email={email}
        role={role}
        displayName={displayName}
        avatarUrl={avatarUrl}
        onOpenDevice={() => pushRoute({ overlay: { kind: "device" } })}
        onAddWorkspace={onAddWorkspace}
      />
    </div>
  );
}

/// "Set up a device": explains why the desktop app exists, lists installers
/// with the visitor's OS preselected, and issues a pairing code.
type DesktopOs = "mac" | "windows" | "linux";

function detectOs(): DesktopOs {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

const OS_KEY: Record<DesktopOs, string> = { mac: "darwin", windows: "windows", linux: "linux" };

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const OS_LABEL: Record<DesktopOs, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

function platformLabel(platform: string): string {
  if (platform === "darwin-aarch64") return "Mac — Apple Silicon";
  if (platform === "darwin-x86_64") return "Mac — Intel";
  if (platform === "windows-x86_64") return "Windows — 64-bit";
  if (platform === "linux-x86_64") return "Linux — 64-bit";
  if (platform === "linux-aarch64") return "Linux — ARM64";
  return platform;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function DeviceSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [os, setOs] = useState<DesktopOs>("linux");
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairCopied, setPairCopied] = useState(false);
  const [dlBusy, setDlBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOs(detectOs());
    setReleases(null);
    setPairCode(null);
    listReleases().then((r) => {
      if (r === null) {
        toast.error("Could not load releases");
        return;
      }
      const desktop = r.filter((x) => x.kind === "desktop");
      // show only the latest version's installers, one per platform
      const latest = desktop.reduce<string | null>(
        (acc, x) => (acc === null || compareVersions(x.version, acc) > 0 ? x.version : acc),
        null,
      );
      setReleases(latest === null ? desktop : desktop.filter((x) => x.version === latest));
    });
  }, [open]);

  const installers =
    releases === null ? null : releases.filter((r) => r.platform.startsWith(OS_KEY[os]) && !r.filename.endsWith(".app.tar.gz"));

  const generatePairing = () => {
    setPairBusy(true);
    createPairingToken(30)
      .then((t) => setPairCode(pairingCode(serverUrl(), t.secret)))
      .finally(() => setPairBusy(false));
  };

  const startDownload = (r: Release) => {
    setDlBusy(r.id);
    downloadRelease(r.id)
      .catch(() => {})
      .finally(() => setDlBusy(null));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up a device</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 text-left">
          <p className="text-muted-foreground">
            The desktop app runs a Guild agent on your machine — it can work directly in your
            projects and with your files, which the browser chat can't. Chat alone stays right here.
          </p>

          <div>
            <p className="mb-1.5 font-medium text-muted-foreground">1. Download app</p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(Object.keys(OS_KEY) as DesktopOs[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setOs(k)}
                  className={`rounded-md px-2 py-1.5 outline-none transition-colors ${
                    os === k
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {OS_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="mt-2 min-w-0 space-y-2">
              {installers === null && [0, 1].map((i) => <Skeleton key={i} className="h-10 w-full rounded-md" />)}
              {installers !== null && installers.length === 0 && (
                <p className="text-muted-foreground">
                  No {OS_LABEL[os]} installer published yet — check back soon.
                </p>
              )}
              {installers?.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate" title={r.filename}>
                      {platformLabel(r.platform)}
                    </p>
                    <p className="text-muted-foreground">
                      v{r.version} · {formatSize(r.size_bytes)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => startDownload(r)} disabled={dlBusy === r.id}>
                    <Download /> {dlBusy === r.id ? "…" : "Download"}
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {os === "mac" && (
            <div className="mt-2 rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-muted-foreground">
              <p className="text-sm">
                <span className="font-medium text-amber-300">macOS first install:</span> the app is
                not notarized yet, so Gatekeeper may report it as "damaged". Run this once in
                Terminal after copying it to Applications:
              </p>
              <code className="mt-1.5 block truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                xattr -dr com.apple.quarantine /Applications/Guild.app
              </code>
              <p className="mt-1 text-xs">
                Updates delivered inside the app are signed and don't need this.
              </p>
            </div>
          )}

          <div className="mt-6">
            <p className="mb-1.5 font-medium text-muted-foreground">2. Pair with your account</p>
            {pairCode ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono"
                    title={pairCode}
                  >
                    {pairCode}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(pairCode);
                      setPairCopied(true);
                      setTimeout(() => setPairCopied(false), 1500);
                    }}
                  >
                    <Copy /> {pairCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  Paste into the desktop app's pairing screen. Single-use, expires in 30 minutes.
                </p>
              </div>
            ) : (
              <Button size="sm" onClick={generatePairing} disabled={pairBusy}>
                {pairBusy ? "Generating…" : "Generate pairing code"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

