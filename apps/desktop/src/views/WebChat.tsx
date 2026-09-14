import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { clampSidebarWidth, saveSidebarWidth, storedSidebarWidth } from "../lib/sidebar-width";
import {
  ArrowUp,
  ShieldAlert,
  ShieldCheck,
  Brain,
  ChevronDown,
  ChevronUp,
  Copy,
  FileDiff,
  Download,
  FileText,
  Minimize2,
  Globe,
  Menu,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  FolderOpen,
  X as XIcon,
  SquareTerminal,
  Cpu,
  Wrench,
} from "lucide-react";

import { Button } from "@guild/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@guild/ui/components/dropdown-menu";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { toast } from "sonner";
import { UserBadge } from "../components/user-badge";
import { Caret } from "@guild/ui/components/caret";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Separator } from "@guild/ui/components/separator";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Spinner } from "@guild/ui/components/spinner";
import { Textarea } from "@guild/ui/components/textarea";
import { SettingsWindow } from "./settings/SettingsWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  attachmentBlobUrl,
  chatSnapshot,
  machineId,
  postApproval,
  pushChatDir,
  sendChatNoStream,
  setMachineIdentity,
  uploadAttachment,
  type StreamFrame,
} from "../transport";
import {
  createChat,
  getThread,
  listChats,
  listModels,
  markChatRead,
  streamChat,
  attachGeneration,
  createPairingToken,
  downloadRelease,
  listReleases,
  pairingCode,
  startEventStream,
  type ChatSummary,
  type MessageAttachmentMeta,
  type Release,
  type ThreadContext,
  type ThreadEventRow,
  type ThreadResult,
} from "../transport";


interface ToolBlock {
  callId: string;
  name: string;
  args: string;
  executor: "client" | "server";
  status: "running" | "done" | "error";
  content?: string;
  meta?: ToolMeta;
}

/// URL-driven navigation: the pathname is the single source of truth for
/// where the user is. Routes:
///   /                          — new chat
///   /thread/<id>               — open thread
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
  overlay: ChatOverlay;
}

export const parseChatRoute = (pathname: string): ChatRoute => {
  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  let chatId: string | null = null;
  if (parts[0] === "thread" && parts[1]) {
    chatId = parts[1];
    parts.splice(0, 2);
  }
  if (parts[0] === "device") return { chatId, overlay: { kind: "device" } };
  if (parts[0] === "settings") {
    // Everything after the section is the sub-page id; each segment was
    // encoded separately, so a model id like "a/b" round-trips as one part.
    const detail = parts.length > 2 ? parts.slice(2).map(decodeURIComponent).join("/") : null;
    return { chatId, overlay: { kind: "settings", section: parts[1] ?? null, detail } };
  }
  return { chatId, overlay: null };
};

export const chatRoutePath = (chatId: string | null, overlay: ChatOverlay): string => {
  const base = chatId ? `/thread/${encodeURIComponent(chatId)}` : "";
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

/// One durable approval gate (design spec section F): a client tool waiting
/// for (or having received) the user's allow/deny decision.
interface ApprovalBlock {
  callId: string;
  name: string;
  args: string;
  status: "pending" | "approved" | "denied";
  reason?: string;
}

/// One durable compaction event (compaction spec section E): the model's
/// summary of everything before this point in the thread.
interface CompactionBlock {
  summary: string;
  model?: string | null;
  keepLast?: number | null;
}

/// Widget payload persisted on tool/result events (spec C.2). Loose: the
/// server owns the shape, unknown fields are ignored by the widgets.
interface ToolMeta {
  card?: string;
  kind?: string;
  sources?: { url: string; title?: string; snippet?: string }[];
  truncated?: boolean;
  url?: string;
  status_code?: number;
  title?: string;
  output?: string;
  exit_code?: number;
  path?: string;
  offset?: number;
  total_lines?: number;
  lang?: string;
}

export interface Block {
  kind: "user" | "text" | "error" | "reasoning" | "tool" | "approval" | "compaction";
  text: string;
  /// Stable React key. Derived blocks use the source event's seq (plus an
  /// in-event index); streaming-built blocks use a live counter.
  key: string;
  /// kind === "user": context attachment chips (metadata only; images may
  /// carry a local preview URL for optimistic rendering).
  attachments?: (MessageAttachmentMeta & { previewUrl?: string })[];
  /// kind === "reasoning": the accumulated thinking text.
  reasoningText?: string;
  tool?: ToolBlock;
  approval?: ApprovalBlock;
  compaction?: CompactionBlock;
}

let liveKeyCounter = 0;
/// Key for blocks the stream builds (no source event seq to derive from).
function liveKey(): string {
  return `live-${++liveKeyCounter}`;
}

/// Tools the desktop executor runs locally (mirrors protocol `client_tool_specs`).
const CLIENT_TOOL_NAMES = [
  "read_file",
  "execute",
  "edit_file",
  "write_file",
];

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
      onClick={() => !onRemove && url && window.open(url, "_blank")}
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

/// Rebuilds the thread view from the persisted thread event log (spec C.3).
/// Tool calls, reasoning and text are all resident thread parts — nothing
/// disappears on refresh: every assistant block is replayed in stream order
/// and tool results fill their matching frames.
export function eventsToBlocks(rows: ThreadEventRow[]): Block[] {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const blocks: Block[] = [];
  const byCallId = new Map<string, ToolBlock>();
  const byApprovalId = new Map<string, ApprovalBlock>();
  for (const row of sorted) {
    const ev = row.event;
    const seqKey = (n: number) => `${row.seq}:${n}`;
    let inEvent = 0;
    switch (ev.type) {
      case "user_message": {
        // Event content is the model-facing turn: typed text plus inlined
        // "[Attachment: …]" blocks. Show the typed text; chips carry the
        // file references.
        const at = ev.attachments?.length ? ev.content.indexOf("\n\n[Attachment: ") : -1;
        blocks.push({
          kind: "user",
          text: at >= 0 ? ev.content.slice(0, at) : ev.content,
          attachments: ev.attachments,
          key: seqKey(inEvent++),
        });
        break;
      }
      case "system_message":
        break; // server-owned prompt, log-only
      case "assistant_message":
        for (const b of ev.blocks) {
          if (b.type === "reasoning") {
            blocks.push({ kind: "reasoning", text: "", reasoningText: b.text, key: seqKey(inEvent++) });
          } else if (b.type === "text") {
            blocks.push({ kind: "text", text: b.text, key: seqKey(inEvent++) });
          } else {
            const tb: ToolBlock = {
              callId: b.id,
              name: b.name,
              args: b.arguments,
              executor: CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server",
              status: "done", // filled by the matching tool_result below
            };
            byCallId.set(b.id, tb);
            blocks.push({ kind: "tool", text: "", tool: tb, key: seqKey(inEvent++) });
          }
        }
        break;
      case "tool_result": {
        const meta = (ev.meta ?? undefined) as ToolMeta | undefined;
        const tb = byCallId.get(ev.call_id);
        if (tb) {
          tb.content = ev.content;
          tb.status = ev.is_error ? "error" : "done";
          tb.meta = meta;
        } else {
          // Orphan result (call block missing): render it anyway rather than drop it.
          blocks.push({
            kind: "tool",
            text: "",
            tool: {
              callId: ev.call_id,
              name: ev.name || "tool",
              args: "",
              executor: "server",
              status: ev.is_error ? "error" : "done",
              content: ev.content,
              meta,
            },
            key: seqKey(inEvent++),
          });
        }
        break;
      }
      case "approval_request": {
        const a: ApprovalBlock = {
          callId: ev.call_id,
          name: ev.name,
          args: ev.arguments,
          status: "pending", // flipped by the matching decision below
        };
        byApprovalId.set(ev.call_id, a);
        blocks.push({ kind: "approval", text: "", approval: a, key: seqKey(inEvent++) });
        break;
      }
      case "approval_decision": {
        const a = byApprovalId.get(ev.call_id);
        if (a) {
          a.status = ev.approved ? "approved" : "denied";
          a.reason = ev.reason ?? undefined;
        }
        break; // orphan decision: the request block carries the story
      }
      case "compaction":
        // Stream-positioned: pushed at its event position, in order with the
        // messages around it.
        blocks.push({
          kind: "compaction",
          text: "",
          key: seqKey(inEvent++),
          compaction: {
            summary: ev.summary,
            model: ev.model ?? undefined,
            keepLast: ev.keep_last ?? null,
          },
        });
        break;
    }
  }
  return blocks;
}

/// ApprovalRequested inserts a pending card into the current blocks;
/// re-attach replays may fire it again for a card we already render, so
/// this is an upsert, not a blind append.
export function upsertApproval(blocks: Block[], a: ApprovalBlock): Block[] {
  const i = blocks.findIndex((x) => x.kind === "approval" && x.approval?.callId === a.callId);
  if (i < 0) return [...blocks, { kind: "approval", text: "", approval: a, key: `approval-${a.callId}` }];
  return blocks.map((x, j) => (j === i ? { ...x, approval: { ...a } } : x));
}

/// ApprovalResolved flips the matching card (no-op when it is absent, e.g.
/// the stream resolved before we rendered the request).
export function resolveApproval(
  blocks: Block[],
  callId: string,
  approved: boolean,
  reason?: string,
): Block[] {
  const i = blocks.findIndex((x) => x.kind === "approval" && x.approval?.callId === callId);
  if (i < 0) return blocks;
  return blocks.map((x, j) =>
    j === i && x.approval
      ? { ...x, approval: { ...x.approval, status: approved ? "approved" : "denied", reason } }
      : x,
  );
}

/// Thinking deltas accumulate into the trailing reasoning block. The first
/// frame after a (re)attach carries the full in-flight buffer (spec B.5), so
/// it replaces instead of appending.
function upsertThinking(blocks: Block[], content: string, replace: boolean): Block[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind === "reasoning") {
    const text = replace ? content : last.reasoningText + content;
    return [...blocks.slice(0, -1), { ...last, reasoningText: text }];
  }
  return [...blocks, { kind: "reasoning", text: "", reasoningText: content, key: liveKey() }];
}

/// Client-side tools need the desktop runtime (local files, shell); in a plain
/// browser they stay pending until the server-side timeout releases the turn.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Per-chat workspace folder ("run in folder"), desktop only: web clients
/// never show the picker and never send a project_dir. `null` chatId is the
/// last-used default a new chat starts from.
const dirKey = (chatId: string | null) => (chatId ? `guild.dir:${chatId}` : "guild.dir:last");
const storedDir = (chatId: string | null): string | null => {
  try {
    return localStorage.getItem(dirKey(chatId));
  } catch {
    return null;
  }
};
const saveDir = (chatId: string | null, dir: string | null) => {
  try {
    if (dir) localStorage.setItem(dirKey(chatId), dir);
    else localStorage.removeItem(dirKey(chatId));
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
};

/// Sentinel for a send stream that ended without a terminal frame: not a
/// user-facing error — the send path converts it into a reattach watch.
class DropError extends Error {}

/// Shown while a deep-linked thread's messages are in flight (the URL says
/// /thread/<id> but the view has nothing to render yet). Without this, the
/// new-thread hero would flash for the whole fetch duration.
function ThreadSkeleton() {
  // Conversation-shaped skeleton: mirrors the real thread layout (user
  // bubbles right, assistant text + tool frames left) instead of a spinner.
  const row = "flex flex-col gap-2";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <div className={row}>
          <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
        <div className={row}>
          <Skeleton className="h-9 w-1/2 rounded-2xl" />
          <Skeleton className="h-4 w-32 rounded-md" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
        <div className={row}>
          <Skeleton className="ml-auto h-9 w-3/5 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/// Markdown body class shared by text blocks and tool-card excerpts.
const MD_CLASS =
  "[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1,\&_h2,\&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre_[code]]:bg-transparent [&_pre_[code]]:p-0 [&_ul]:list-disc";

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
  icon: React.ReactNode;
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
      <div className="max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed text-muted-foreground">
        {text || "…"}
      </div>
    </Frame>
  );
}

/// Human-facing tool kind: drives the frame icon and widget selection.
function toolKind(t: ToolBlock): string {
  if (t.meta?.kind) return t.meta.kind;
  if (t.meta?.card) return t.meta.card;
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

function toolLabel(t: ToolBlock): string {
  const n = t.name.toLowerCase();
  const direct = TOOL_LABELS[n];
  if (direct) return direct;
  // Integration tools are namespaced on the wire (`int_searxng_web_search`):
  // the connector prefix is internal, the label is the bare tool name.
  if (n.startsWith("int_")) {
    for (const [key, label] of Object.entries(TOOL_LABELS)) {
      if (n.endsWith("_" + key)) return label;
    }
    return n.slice(4).replace(/_/g, " ");
  }
  return t.name;
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
    <Frame
      icon={<Minimize2 className="size-3 shrink-0 text-muted-foreground" />}
      title={
        <>
          <span>Thread compacted</span>
          {c.model && <span className="text-muted-foreground"> — {c.model}</span>}
        </>
      }
    >
      <div className="space-y-2">
        <div className={`max-h-64 overflow-y-auto leading-relaxed text-muted-foreground ${MD_CLASS}`}>
          <Markdown remarkPlugins={[remarkGfm]}>{c.summary}</Markdown>
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

/// Formats a token count as k with one decimal, trimming a trailing ".0"
/// (12300 → "12.3k", 128000 → "128k").
function fmtK(n: number): string {
  const k = n / 1000;
  const s = k.toFixed(1);
  return (s.endsWith(".0") ? Math.round(k).toString() : s) + "k";
}

/// Slim context-usage bar next to the model selector: fills as the
/// thread's context grows; amber past 80% of the window, red past 90%.
/// Compaction is automatic server-side — the gauge is read-only. Hidden
/// entirely when the server reports no context data.
function ContextGauge({ ctx }: { ctx: ThreadContext }) {
  const ratio = ctx.max > 0 ? Math.min(1, Math.max(0, ctx.tokens / ctx.max)) : 0;
  const stroke =
    ratio > 0.9 ? "stroke-destructive" : ratio >= 0.8 ? "stroke-amber-500" : "stroke-foreground";
  // Radial gauge: a circle that fills clockwise as the context grows.
  const size = 18;
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="flex shrink-0 items-center" title={`~${fmtK(ctx.tokens)} / ${fmtK(ctx.max)} context tokens`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="stroke-muted"
          strokeWidth="2.5"
          fill="none"
        />
        {ratio > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            className={`${stroke} transition-[stroke-dashoffset] duration-500`}
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - ratio)}
          />
        )}
      </svg>
    </span>
  );
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

function ToolBody({ t }: { t: ToolBlock }) {
  const m = t.meta;
  const kind = toolKind(t);
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
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
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
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 truncate underline decoration-border underline-offset-2 hover:decoration-foreground"
                title={url}
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
          <div className={`max-h-64 overflow-y-auto ${MD_CLASS}`}>
            <Markdown remarkPlugins={[remarkGfm]}>{t.content}</Markdown>
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
function ApprovalPill({ status }: { status: "pending" | "approved" | "denied" }) {
  const cls = {
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    denied: "border-destructive/40 bg-destructive/10 text-destructive",
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
/// confirms the decision.
function ApprovalCard({ a, chatId }: { a: ApprovalBlock; chatId: string | null }) {
  const [acted, setActed] = useState<null | "approved" | "denied">(null);
  const resolved = a.status !== "pending";
  const busy = !resolved && acted !== null;
  const act = (approved: boolean) => {
    if (acted || resolved || !chatId) return;
    setActed(approved ? "approved" : "denied");
    // optimistic: keep the buttons disabled until the resolved frame or a
    // thread reload confirms; only a failed post re-enables for a retry
    void postApproval(chatId, a.callId, approved, approved ? undefined : "denied by user").catch(
      () => setActed(null),
    );
  };
  let prettyArgs = a.args;
  try {
    prettyArgs = JSON.stringify(JSON.parse(a.args), null, 2);
  } catch {
    /* keep the raw arguments string */
  }
  return (
    <Frame
      icon={
        resolved && a.status === "denied" ? (
          <ShieldAlert className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ShieldCheck className="size-3 shrink-0 text-muted-foreground" />
        )
      }
      title={
        <>
          <span className="font-mono">{a.name}</span>
          <span className="text-muted-foreground"> — approval</span>
        </>
      }
      badge={
        <>
          {a.reason && resolved && (
            <span className="hidden max-w-40 truncate text-muted-foreground sm:inline">
              {a.reason}
            </span>
          )}
          <ApprovalPill status={resolved ? a.status : busy ? (acted as "approved" | "denied") : "pending"} />
        </>
      }
      defaultOpen={!resolved}
    >
      <div className="space-y-2">
        {prettyArgs && (
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-muted-foreground">
            {prettyArgs}
          </pre>
        )}
        {resolved ? (
          a.status === "denied" && a.reason ? (
            <p className="text-muted-foreground">denied: {a.reason}</p>
          ) : a.status === "denied" ? (
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

/// Web-mode chat: streaming conversation through the org gateway, with a
/// server-backed conversation list. Full agent mode (local tools + project)
/// is the desktop (Tauri) flow.
export default function WebChat({
  email,
  role = "member",
  displayName,
  avatarUrl,
  onSignOut,
}: {
  email: string;
  role?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onSignOut: () => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState("");
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  // Live sidebar status overlay (thread-list spinner/dot): frames from the
  // server's chat-status channel win over the fetched list; refreshChats
  // reconciles the rest. mark-read happens on thread load for the visible
  // open chat; a hidden tab never swallows its own dot.
  const [chatStatus, setChatStatus] = useState<Record<string, { generating: boolean; unread: boolean }>>({});
  const chatsRef = useRef<ChatSummary[] | null>(null);
  chatsRef.current = chats;
  // URL-driven navigation state (see parseChatRoute above): everything the
  // user can navigate to — the open thread, the settings overlay with its
  // active section, the device dialog — lives in the pathname, so back/forward,
  // reloads and deep links all land in exactly the right place.
  const [route, setRoute] = useState<ChatRoute>(() => parseChatRoute(window.location.pathname));
  const chatId = route.chatId;
  const overlay = route.overlay;
  const [threadLoading, setThreadLoading] = useState(() => route.chatId !== null); // /thread/<id> fetch in flight with nothing to show
  const [prompt, setPrompt] = useState("");
  // Composer attachments: strip of previews above the input — image
  // thumbnails with an overlay ✕, file chips with an icon.
  const [pending, setPending] = useState<
    (MessageAttachmentMeta & { file?: File; previewUrl?: string })[]
  >([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
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
  const [ctx, setCtx] = useState<ThreadContext | null>(null); // server-reported context usage (G1); null = hide the gauge
  // Per-chat rendered-block cache: reopening a thread shows its last
  // rendered content immediately while the fresh thread rows load in place,
  // so switching chats never flashes a skeleton over known content.
  const threadCacheRef = useRef<Map<string, Block[]>>(new Map());
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const [busy, setBusy] = useState(false);
  // Latest busy/attaching/threadLoading values for stable-ref consumers (the
  // deploy-freshness poll below must not read stale closure state).
  const loadStateRef = useRef({ busy: false, attaching: false, threadLoading: false });
  const [attaching, setAttaching] = useState(false); // receiving a server-side generation
  // Watching a dropped generation for reattach (network send path): the
  // composer must stay disabled until the watch settles.
  const [reattaching, setReattaching] = useState(false);
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
  const attachAbort = useRef<AbortController | null>(null);
  const loadAbort = useRef<AbortController | null>(null); // in-flight thread-load fetch
  const sendAbort = useRef<AbortController | null>(null); // in-flight send stream
  const loadSeq = useRef(0); // guards against stale thread loads landing last
  const skipLoadRef = useRef<string | null>(null); // chatId whose URL move must not trigger a refetch (first send)

  // App-lifetime presence connection: the server uses it to detect that
  // this app instance is gone and resolve suspended client tools without
  // waiting for the 5-minute timeout. Web clients additionally consume the
  // connection's chat-status frames (desktop forwards them itself —
  // "chat-status" Tauri event, see the unlisteners below).
  useEffect(
    () =>
      startEventStream((f) => handleChatStatusRef.current(f.chat_id, f.generating)),
    [],
  );
  loadStateRef.current = { busy, attaching, threadLoading };

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
          if (!s.busy && !s.attaching && !s.threadLoading && !stopped) window.location.reload();
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
    // busyRef/attachingRef/threadLoadingRef are stable refs; see below.
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
    void refreshChats();
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
  const pushRoute = (next: { chatId?: string | null; overlay?: ChatOverlay }) => {
    const chatId = "chatId" in next ? (next.chatId as string | null) : route.chatId;
    const ov = "overlay" in next ? (next.overlay as ChatOverlay) : route.overlay;
    const path = chatRoutePath(chatId, ov);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute({ chatId, overlay: ov });
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

  /// One chat-status frame from the server (events stream on web, forwarded
  /// "chat-status" Tauri event on desktop): drives the sidebar spinner/dot
  /// for any chat, open or not. Turn end → the dot appears unless the turn
  /// finished on the visible open chat (mark-read already covered it).
  const handleChatStatus = (cid: string, generating: boolean) => {
    setChatStatus((prev) => {
      const seen = generating || (cid === openChatIdRef.current && document.visibilityState === "visible");
      const unread = generating ? (prev[cid]?.unread ?? false) : !seen;
      return { ...prev, [cid]: { generating, unread } };
    });
    // A status frame for a chat this client has never listed (created in
    // another tab/device): pull the list so the row exists.
    if (chatsRef.current && !chatsRef.current.some((c) => c.id === cid)) {
      void refreshChats();
    }
    if (!generating && cid === openChatIdRef.current && document.visibilityState === "visible") {
      void markChatRead(cid);
    }
  };
  const handleChatStatusRef = useRef(handleChatStatus);
  handleChatStatusRef.current = handleChatStatus;

  /// Reloads blocks from thread rows and tracks the high-water seq so a later
  /// compaction poll only waits for events newer than what is on screen.
  /// Also carries the server-reported context usage to the gauge; a server
  /// without it (pre-G1) leaves the gauge hidden.
  const applyThreadRows = (res: ThreadResult) => {
    setCtx(res.context ?? null);
    setBlocks(eventsToBlocks(res.events));
    // The open chat is on screen: it is read up to the newest event now.
    // Hidden tabs skip this — the dot must survive for the hidden window.
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      const cid = openChatIdRef.current;
      if (cid) {
        void markChatRead(cid);
        setChatStatus((prev) =>
          prev[cid]?.unread ? { ...prev, [cid]: { ...prev[cid], unread: false } } : prev,
        );
      }
    }
  };

  // Per-chat frame watermarks (desktop fan-out bus): frames with seq ≤ the
  // watermark are already reflected (the snapshot replay covers them).
  const appSeqRef = useRef<Map<string, number>>(new Map());
  const openChatIdRef = useRef<string | null>(chatId);
  openChatIdRef.current = chatId;
  // Reload tick: bumping re-runs the chatId load effect (fan-out reconnect).
  const [reloadTick, setReloadTick] = useState(0);

  // Load (or clear) the thread whenever the URL-driven chatId changes — one
  // path for deep links, back/forward, sidebar picks and "new chat" alike.
  const prevLoadedChatRef = useRef<string | null>(chatId);
  useEffect(() => {
    // Restore this thread's workspace folder (desktop); a new chat falls
    // back to the last used one.
    if (isTauri) setProjectDir(storedDir(chatId) ?? storedDir(null));
    const prev = prevLoadedChatRef.current;
    prevLoadedChatRef.current = chatId;
    if (prev !== null && prev !== chatId && blocksRef.current.length > 0) {
      // Bound the cache: drop the oldest entry past 20 threads.
      if (threadCacheRef.current.size >= 20) {
        const oldest = threadCacheRef.current.keys().next().value;
        if (oldest !== undefined) threadCacheRef.current.delete(oldest);
      }
      threadCacheRef.current.set(prev, blocksRef.current);
    }
    if (!chatId) {
      loadSeq.current++; // invalidate any in-flight load or generation attach
      loadAbort.current?.abort();
      loadAbort.current = null;
      sendAbort.current?.abort();
      sendAbort.current = null;
      attachAbort.current?.abort();
      attachAbort.current = null;
        setBlocks([]);
      setCtx(null);
      setThreadLoading(false);
      return;
    }
    if (skipLoadRef.current === chatId) {
      // First send just created this thread and its stream is live — the
      // URL moved to /thread/<id> but nothing may refetch/clear the view.
      skipLoadRef.current = null;
      return;
    }
    stick.current = true; // a freshly opened thread starts pinned to the bottom
    // Switching is allowed even mid-generation: the generation runs detached
    // server-side and keeps persisting; the client-side stream is cancelled
    // here and re-attached (with catch-up) when this thread is reopened.
    loadAbort.current?.abort();
    const loadAc = new AbortController();
    loadAbort.current = loadAc;
    sendAbort.current?.abort();
    sendAbort.current = null;
    attachAbort.current?.abort(); // replaced when the new thread's attach starts
    const seq = ++loadSeq.current;
    const cached = threadCacheRef.current.get(chatId) ?? null;
    setThreadLoading(cached === null);
    setBlocks(cached ?? []);
    setCtx(null);
    (async () => {
      try {
        const res: ThreadResult = await getThread(chatId, loadAc.signal);
        if (seq !== loadSeq.current) return; // a newer thread switch superseded this one
        threadCacheRef.current.set(chatId, eventsToBlocks(res.events));
        applyThreadRows(res);
        // The app process executes tools — push the folder for this chat.
        if (isTauri) void pushChatDir(chatId, storedDir(chatId) ?? storedDir(null));
        if (isTauri) {
          // Single-process link: in-flight catch-up comes from the app
          // process's fan-out mirror, not a second server connection.
          try {
            const snap = await chatSnapshot(chatId);
            if (seq !== loadSeq.current) return;
            appSeqRef.current.set(chatId, snap.seq);
            setBusy(snap.running);
            for (const f of snap.frames) applyRef.current(f, chatId);
          } catch {
            /* link not connected yet — live frames will arrive regardless */
          }
        } else {
          // A generation may still be running server-side (e.g. it outlived
          // a previous client, or the stream dropped earlier). Attach with
          // automatic reconnection and keep streaming it into the view.
          const ac = new AbortController();
          attachAbort.current = ac;
          void watchGeneration(chatId, seq, ac);
        }
      } catch {
        // aborted (a newer switch superseded this one) or a real error —
        // either way the pane falls back to the empty-thread view;
        // switching is non-destructive
      } finally {
        // only the load that is still current may clear the flag; a superseded
        // one finishing late must not extinguish a newer load's spinner
        if (seq === loadSeq.current) setThreadLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, reloadTick]);

  const openChat = (id: string) => {
    // Navigation only: the chatId effect performs the actual load, so back/
    // forward, deep links and sidebar picks all share one code path.
    setOpen(false);
    pushRoute({ chatId: id, overlay: null });
  };

  const newChat = () => {
    // Navigation only: the chatId effect clears the pane and aborts any
    // in-flight load/stream; the server-side generation keeps running and
    // is re-attachable when the thread is reopened.
    pushRoute({ chatId: null, overlay: null });
    setOpen(false);
    ta.current?.focus();
  };

  const autoGrow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  // ---- server-side tool loop support ----

  // Workspace folder ("run in folder"): desktop only. A new chat starts
  // from the last used folder; an existing chat restores its own (the
  // chatId effect below re-reads it on every switch).
  const [projectDir, setProjectDir] = useState<string | null>(() =>
    isTauri ? storedDir(route.chatId) ?? storedDir(null) : null,
  );
  const projectDirRef = useRef(projectDir);
  projectDirRef.current = projectDir;
  const pickProjectDir = (dir: string | null) => {
    setProjectDir(dir);
    saveDir(chatId, dir);
    saveDir(null, dir); // next new chat starts here
    // The app process executes tools — it needs the folder pushed.
    if (isTauri && chatId) void pushChatDir(chatId, dir);
  };

  // ---- single-process app link (desktop): the fan-out bus ----

  /// Applies one streamed event to the blocks. Shapes match the per-turn
  /// web path; the desktop router calls this for fan-out frames.
  const applyStreamEvent = (ev: StreamFrame, cid: string) => {
    if (ev.type === "delta" && ev.content) {
      setBlocks((b) => {
        const last = b[b.length - 1];
        if (last?.kind === "text") return [...b.slice(0, -1), { ...last, text: last.text + ev.content! }];
        return [...b, { kind: "text", text: ev.content!, key: liveKey() }];
      });
    } else if (ev.type === "thinking_delta" && ev.content) {
      setBlocks((b) => upsertThinking(b, ev.content!, false));
    } else if (ev.type === "tool_started" || ev.type === "tool_completed") {
      handleToolEvent(ev, cid, 0);
    } else if (ev.type === "approval_requested") {
      setBlocks((b) =>
        upsertApproval(b, {
          callId: ev.call_id as string,
          name: (ev.name as string) ?? "",
          args: (ev.arguments as string) ?? "{}",
          status: "pending",
        }),
      );
    } else if (ev.type === "approval_resolved") {
      setBlocks((b) =>
        resolveApproval(
          b,
          ev.call_id as string,
          !!ev.approved,
          (ev.reason as string | undefined) ?? undefined,
        ),
      );
    } else if (ev.type === "error") {
      setBlocks((b) => [...b, { kind: "error", text: ev.message ?? "model error", key: liveKey() }]);
    }
  };
  const applyRef = useRef(applyStreamEvent);
  applyRef.current = applyStreamEvent;

  // One subscription for the whole component lifetime; the handler reads the
  // latest closures through refs.
  useEffect(() => {
    if (!isTauri) return;
    void setMachineIdentity(machineId()).catch(() => {});
    const unlisteners: Promise<UnlistenFn>[] = [
      listen("app-frame", (e) => {
        const p = e.payload as { chat_id: string; seq: number; event: { type: string; [k: string]: unknown } };
        if (p.chat_id !== openChatIdRef.current) return; // renders only the open chat
        const seen = appSeqRef.current.get(p.chat_id) ?? -1;
        if (p.seq <= seen) return;
        appSeqRef.current.set(p.chat_id, p.seq);
        if (p.event.type === "done") {
          setBusy(false);
          // done: reload the durable thread (gauge + rebuilt blocks) and the
          // sidebar (titles)
          void (async () => {
            try {
              const res: ThreadResult = await getThread(p.chat_id);
              if (openChatIdRef.current === p.chat_id) applyThreadRows(res);
            } catch {
              /* keep the streamed view */
            }
            void refreshChats();
          })();
          return;
        }
        if (p.event.type === "error") setBusy(false);
        applyRef.current(p.event, p.chat_id);
      }),
      listen("app-stream-reconnected", () => {
        appSeqRef.current.clear();
        if (openChatIdRef.current) setReloadTick((t) => t + 1);
      }),
      // Sidebar status for every chat, not just the open one (the app
      // process forwards the events stream's chat_status frames here).
      listen("chat-status", (e) => {
        const p = e.payload as { chat_id?: string; generating?: boolean };
        if (p.chat_id && typeof p.generating === "boolean") {
          handleChatStatusRef.current(p.chat_id, p.generating);
        }
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// Handles tool lifecycle events (render only): since the single-process
  /// redesign, client tools are executed by the app process when the fan-out
  /// bus delivers them — the webview only renders the chips.
  const handleToolEvent = (ev: { type: string; [k: string]: unknown }, _cid: string, _seq: number) => {
    const callId = ev.call_id as string | undefined;
    if (!callId) return;
    if (ev.type === "tool_started") {
      const name = (ev.name as string) ?? "";
      const args = (ev.arguments as string) ?? "{}";
      const executor = ev.executor === "client" ? "client" : "server";
      setBlocks((b) => [
        ...b,
        { kind: "tool", text: "", tool: { callId, name, args, executor, status: "running" }, key: `tool-${callId}` },
      ]);
    } else if (ev.type === "tool_completed") {
      const status: "done" | "error" = ev.is_error ? "error" : "done";
      const content = (ev.content as string) ?? "";
      setBlocks((b) =>
        b.map((x) => {
          const t = x.tool;
          if (x.kind !== "tool" || !t || t.callId !== callId) return x;
          return { ...x, tool: { ...t, status, content } };
        }),
      );
    }
  };

  /// Watches a chat's server-side generation, reconnecting transparently when
  /// the SSE stream drops (server redeploy, network blip, laptop sleep).
  /// Every (re)connect first reloads the persisted messages — the durable
  /// source of truth — so text streamed before the drop is neither duplicated
  /// nor lost. The attach endpoint ends with `idle` when nothing is running,
  /// `done`/`error` when the turn finished; a stream that ends with neither
  /// is a dropped connection → backoff, reload, reattach. Returns what was
  /// observed so callers can decide on user-facing messaging.
  const watchGeneration = async (
    cid: string,
    seq: number,
    ac: AbortController,
  ): Promise<{ terminal: "done" | "error" | "idle" | "none"; sawContent: boolean }> => {
    // `attaching` feeds the visible streaming state (caret, live thinking);
    // set it only when the stream actually carries a turn — a plain attach
    // to an idle thread must not render as if the model were generating.
    let attachingShown = false;
    const showAttaching = () => {
      if (!attachingShown) {
        attachingShown = true;
        setAttaching(true);
      }
    };
    let sawContent = false;
    // holder object: the SSE callbacks mutate this after an await, which a
    // plain `let` cannot express under TS control-flow narrowing
    const term: { v: "done" | "error" | "idle" | "none" } = { v: "none" };
    let lastError: string | null = null;
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        if (seq !== loadSeq.current || ac.signal.aborted) break;
        try {
          // reconcile with durable state before (re)attaching
          const res: ThreadResult = await getThread(cid, ac.signal);
          if (seq !== loadSeq.current || ac.signal.aborted) break;
          applyThreadRows(res);
          term.v = "none";
          // The first delta after attach is the server's catch-up snapshot of
          // the in-flight turn (full buffer, not a delta) — or, when there is
          // no catch-up, the first live delta of that turn. Either way it
          // starts a NEW text block: the reload above restored persisted
          // messages only, so the in-flight turn has no block yet and the
          // last text block belongs to a previous turn. Later deltas append.
          let firstDelta = true;
          // Same contract for thinking: the first thinking_delta after attach
          // carries the full in-flight reasoning buffer (spec B.5).
          let firstThinking = true;
          await attachGeneration(
            cid,
            (ev) => {
              if (seq !== loadSeq.current) return; // user moved to another thread
              if (ev.type === "delta" && ev.content) {
                showAttaching();
                sawContent = true;
                const seed = firstDelta;
                firstDelta = false;
                setBlocks((b) => {
                  const last = b[b.length - 1];
                  if (!seed && last?.kind === "text") return [...b.slice(0, -1), { ...last, text: last.text + ev.content! }];
                  return [...b, { kind: "text", text: ev.content!, key: liveKey() }];
                });
              } else if (ev.type === "thinking_delta" && ev.content) {
                showAttaching();
                sawContent = true;
                const seed = firstThinking;
                firstThinking = false;
                setBlocks((b) => upsertThinking(b, ev.content!, seed));
              } else if (ev.type === "tool_started" || ev.type === "tool_completed") {
                showAttaching();
                sawContent = true;
                handleToolEvent(ev, cid, seq);
              } else if (ev.type === "approval_requested") {
                showAttaching();
                sawContent = true;
                setBlocks((b) =>
                  upsertApproval(b, {
                    callId: ev.call_id as string,
                    name: (ev.name as string) ?? "",
                    args: (ev.arguments as string) ?? "{}",
                    status: "pending",
                  }),
                );
              } else if (ev.type === "approval_resolved") {
                showAttaching();
                sawContent = true;
                setBlocks((b) =>
                  resolveApproval(
                    b,
                    ev.call_id as string,
                    !!ev.approved,
                    (ev.reason as string | undefined) ?? undefined,
                  ),
                );
              } else if (ev.type === "error") {
                lastError = ev.message ?? "model error";
                term.v = "error";
              } else if (ev.type === "done") {
                term.v = "done";
              } else if (ev.type === "idle") {
                term.v = "idle";
              }
            },
            ac.signal,
          );
          // re-read through a widened local: the SSE callbacks may have
          // reassigned term.v after the await, which TS narrowing can't see
          const outcome = term.v as "done" | "error" | "idle" | "none";
          if (outcome === "idle" || outcome === "done") {
            // the generation may have completed between the reload and the
            // attach; reload once more so the final events — and the fresh
            // context usage for the gauge — are on screen
            try {
              const final: ThreadResult = await getThread(cid, ac.signal);
              if (seq === loadSeq.current) {
                applyThreadRows(final);
              }
            } catch {
              /* keep what we have */
            }
            break;
          }
          if (outcome !== "none") break; // error: real end
          // no terminal frame → dropped connection; fall through to backoff
        } catch {
          /* network error while loading or attaching → retry */
        }
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
      }
    } finally {
      if (attachAbort.current === ac) {
        attachAbort.current = null;
        setAttaching(false);
      }
    }
    if (term.v === "error" && lastError !== null) {
      // (kept as-is: reached only when the loop broke on an error frame)
      setBlocks((b) => [...b, { kind: "error", text: lastError!, key: liveKey() }]);
    }
    return { terminal: term.v as "done" | "error" | "idle" | "none", sawContent };
  };

  const send = async () => {
    const text = prompt.trim();
    if ((!text && pendingRef.current.length === 0) || busy || !model) return;
    const mySeq = loadSeq.current; // switching away mid-send cancels the client stream
    setBusy(true);
    setPrompt("");
    if (ta.current) ta.current.style.height = "auto";
    // Focus stays in the composer after send. Scheduled after the pending
    // state commit: disabling the
    // Send button during the same commit would otherwise move focus to
    // body and override a synchronous focus().
    requestAnimationFrame(() => ta.current?.focus());
    const sentKey = liveKey();
    setBlocks((b) => [
      ...b,
      {
        kind: "user",
        text,
        key: sentKey,
        attachments: pendingRef.current.map((a) => ({
          id: `pending-${a.id}`,
          filename: a.filename,
          content_type: a.content_type,
          size_bytes: a.size_bytes,
          modality: a.modality,
          previewUrl: a.previewUrl,
        })),
      },
    ]);
    let cid = chatId;
    if (!cid) {
      cid = await createChat(text.slice(0, 48));
      if (cid && loadSeq.current === mySeq) {
        // Move the URL to the new thread; the live send stream must not be
        // interrupted by a refetch (the chatId effect skips via skipLoadRef).
        if (projectDirRef.current) saveDir(cid, projectDirRef.current);
        skipLoadRef.current = cid;
        pushRoute({ chatId: cid, overlay: null });
        void refreshChats();
        ta.current?.focus();
      }
    }
    if (!cid) {
      if (loadSeq.current === mySeq) {
        setBlocks((b) => [...b, { kind: "error", text: "chat create failed", key: liveKey() }]);
      }
      setBusy(false);
      return;
    }
    // Optimistic sidebar spinner: the server's generating flag lands via
    // the chat-status channel within a second; this makes it instant.
    setChatStatus((prev) => ({ ...prev, [cid]: { ...(prev[cid] ?? { unread: false }), generating: true } }));
    const ac = new AbortController();
    sendAbort.current = ac;
    // The Tauri send is fire-and-forget: after the POST resolves, the
    // fan-out done/error frames own `busy` — the finally below must leave
    // it set (only a POST failure returns through it with busy cleared).
    let keepBusyThroughFinally = false;
    try {
      // Upload attachments first; their ids ride along with the send and
      // the server inlines text / passes media parts per route modality.
      const attachmentIds: string[] = [];
      for (const a of pendingRef.current) {
        if (!a.file) continue;
        try {
          const meta = await uploadAttachment(cid, a.file);
          attachmentIds.push(meta.id);
          // The optimistic chip's composer URL dies with the send: swap the
          // block row to the uploaded id so its thumbnail is re-fetched from
          // storage (the hook owns that blob URL's lifecycle).
          setBlocks((b) =>
            b.map((bl) =>
              bl.key === sentKey && bl.kind === "user"
                ? {
                    ...bl,
                    attachments: bl.attachments?.map((att) =>
                      att.id === `pending-${a.id}`
                        ? { ...att, id: meta.id, previewUrl: undefined }
                        : att,
                    ),
                  }
                : bl,
            ),
          );
        } catch (e) {
          if (loadSeq.current === mySeq) {
            // Upload failed: the chip loses the composer-owned preview (it
            // is revoked below) and falls back to its file icon.
            setBlocks((b) =>
              b.map((bl) =>
                bl.key === sentKey && bl.kind === "user"
                  ? {
                      ...bl,
                      attachments: bl.attachments?.map((att) =>
                        att.id === `pending-${a.id}` ? { ...att, previewUrl: undefined } : att,
                      ),
                    }
                  : bl,
              ),
            );
            setBlocks((b) => [
              ...b,
              {
                kind: "error",
                key: liveKey(),
                text: `attachment upload failed (${a.filename}): ${e instanceof Error ? e.message : String(e)}`,
              },
            ]);
          }
        }
      }
      // Sent attachments leave the composer: revoke their preview URLs —
      // uploaded ones now render from the uploaded id, failed ones fell
      // back to the icon.
      for (const a of pendingRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      setPending([]);
      if (isTauri) {
        // Single-process link: the turn's frames arrive on the fan-out bus
        // (the app-frame listener); this POST is fire-and-forget. Done/error
        // frames clear `busy` and reload the durable thread.
        void pushChatDir(cid, projectDirRef.current);
        try {
          await sendChatNoStream(cid, model, text, attachmentIds, projectDirRef.current);
        } catch (e) {
          if (loadSeq.current === mySeq) {
            setBlocks((b) => [
              ...b,
              { kind: "error", text: e instanceof Error ? e.message : String(e), key: liveKey() },
            ]);
          }
          // The POST failed: no turn was started, so the finally below
          // clears busy.
          return;
        }
        // The turn streams on the fan-out bus now; busy stays set through
        // the finally below until the turn's done/error frame clears it.
        keepBusyThroughFinally = true;
        return;
      }
      let gotDone = false;
      await streamChat(
        cid,
        model,
        text,
        (ev) => {
          if (loadSeq.current !== mySeq) return; // user switched away mid-generation
          if (ev.type === "done") {
            gotDone = true;
            return;
          }
          if (ev.type === "delta" && ev.content) {
            // deltas are per model turn; every tool call emits tool_started,
            // so a tool block always separates turns — append to the current
            // text block, or start a new one after a tool block
            setBlocks((b) => {
              const last = b[b.length - 1];
              if (last?.kind === "text") return [...b.slice(0, -1), { ...last, text: last.text + ev.content! }];
              return [...b, { kind: "text", text: ev.content!, key: liveKey() }];
            });
          } else if (ev.type === "thinking_delta" && ev.content) {
            // live deltas: the send stream has no catch-up snapshot, every
            // frame is a pure delta (spec B.5)
            setBlocks((b) => upsertThinking(b, ev.content!, false));
          } else if (ev.type === "tool_started" || ev.type === "tool_completed") {
            handleToolEvent(ev, cid, mySeq);
          } else if (ev.type === "approval_requested") {
            setBlocks((b) =>
              upsertApproval(b, {
                callId: ev.call_id as string,
                name: (ev.name as string) ?? "",
                args: (ev.arguments as string) ?? "{}",
                status: "pending",
              }),
            );
          } else if (ev.type === "approval_resolved") {
            setBlocks((b) =>
              resolveApproval(
                b,
                ev.call_id as string,
                !!ev.approved,
                (ev.reason as string | undefined) ?? undefined,
              ),
            );
          } else if (ev.type === "error") {
            setBlocks((b) => [...b, { kind: "error", text: ev.message ?? "model error", key: liveKey() }]);
          }
        },
        ac.signal,
        attachmentIds,
        projectDirRef.current,
      );
      if (!gotDone) {
        // stream ended without a terminal frame: the connection dropped while
        // the durable generation keeps running server-side — watch it instead
        // of surfacing a dead "network error"
        throw new DropError();
      }
      // done: reload the durable thread once so the gauge's context usage
      // reflects the completed turn (blocks rebuild to the same view)
      try {
        const res: ThreadResult = await getThread(cid);
        if (loadSeq.current === mySeq) applyThreadRows(res);
      } catch {
        /* keep the streamed view */
      }
      void refreshChats();
    } catch (e) {
      if (loadSeq.current !== mySeq) return; // deliberate switch away, not an error
      setBusy(false);
      if (sendAbort.current === ac) sendAbort.current = null;
      const wac = new AbortController();
      attachAbort.current?.abort();
      attachAbort.current = wac;
      setReattaching(true);
      try {
        const r = await watchGeneration(cid, mySeq, wac);
        if (r.terminal === "done") {
          void refreshChats();
        } else if (r.terminal === "idle" && !r.sawContent) {
          setBlocks((b) => [
            ...b,
            { kind: "error", text: "connection dropped before the reply started — try sending again", key: liveKey() },
          ]);
        } else if (r.terminal === "none") {
          setBlocks((b) => [
            ...b,
            {
              kind: "error",
              key: liveKey(),
              text: "lost connection and could not reattach — the reply may still arrive; reopen this thread to catch up",
            },
          ]);
        }
      } finally {
        setReattaching(false);
      }
      return;
    } finally {
      // The Tauri send hands `busy` over to the fan-out done/error frames
      // (the comment on the POST branch); every other exit clears it.
      if (!keepBusyThroughFinally) setBusy(false);
      if (sendAbort.current === ac) sendAbort.current = null;
    }
  };

  const activeTitle =
    threadLoading && blocks.length === 0
      ? "Loading…"
      : (chats?.find((c) => c.id === chatId)?.title ?? "New chat");
  const boundMachine = chats?.find((c) => c.id === chatId)?.machine_label ?? null;
  const streaming = busy || attaching || reattaching;

  const sidebar = (
    <SidebarContent
      chats={
        chats === null
          ? null
          : chats.map((c) => ({ ...c, ...(chatStatus[c.id] ?? {}) }))
      }
      chatId={chatId}
      email={email}
      displayName={displayName}
      avatarUrl={avatarUrl}
      onNewChat={newChat}
      onOpenChat={openChat}
      onSignOut={onSignOut}
      onOpenSettings={() => pushRoute({ overlay: { kind: "settings", section: null, detail: null } })}
      onOpenDevice={() => pushRoute({ overlay: { kind: "device" } })}
      onCollapse={isMobile ? undefined : () => setCollapsed(true)}
    />
  );

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
    <div className="fixed inset-0 flex bg-background text-foreground">
      {/* desktop sidebar: resizable + collapsible; mobile: drawer */}
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Chats</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>
      ) : (
        <aside
          className={`relative flex shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground ${
            resizing ? "" : "transition-[width] duration-150"
          } ${collapsed ? "" : "border-r border-border"}`}
          style={{ width: collapsed ? 0 : width }}
        >
          {/* Collapsed = fully gone: the header toggle reopens it, so no rail
              is pre-reserved and the central pane reflows on toggle. */}
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
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
            <div className="rounded-xl border-2 border-dashed border-border bg-card px-6 py-5 text-muted-foreground shadow-lg">
              Drop files to attach
            </div>
          </div>
        )}
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
          <span className="min-w-0 flex-1 truncate font-medium">{activeTitle}</span>
          {boundMachine && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-muted-foreground"
              title={`Machine tools run on: ${boundMachine}`}
            >
              <Cpu className="size-3" />
              {boundMachine}
            </span>
          )}
        </header>

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
            <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-32 py-8">
              <p className="text-muted-foreground">No messages in this thread yet.</p>
            </div>
          )
        ) : (
          <div
            ref={pane}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
                    className="ml-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5"
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
                    className={`max-w-none space-y-2 leading-relaxed ${MD_CLASS}`}
                  >
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {/* streaming caret rides INSIDE the markdown source so
                          it lands on the forming line, not below the block */}
                      {streaming && i === blocks.length - 1 ? `${b.text}▍` : b.text}
                    </Markdown>
                  </div>
                ),
              )}
              {/* caret only while reply text is actually streaming; tool
                  blocks have their own status, silence shows nothing */}
              {streaming && blocks.length === 0 && (
                <div className="max-w-none">
                  <Caret />
                </div>
              )}
              <div ref={bottom} />
            </div>
          </div>
        )}

        {/* composer: floats over the chat content; the scroll pane runs
            full-height behind it */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/85 to-transparent pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:p-4">
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
            <Textarea
              ref={ta}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={models === null || model ? "Message Guild…" : "No model available"}
              // Not disabled while streaming: a disabled focused element
              // blurs to body, and the composer must keep focus/caret
              // during generation (send is guarded by `busy` anyway).
              disabled={models !== null && !model}
              className="max-h-40 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none"
            />
            <div className="flex items-center justify-between gap-2 px-1 pt-1">
              <div className="flex items-center gap-1">
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
                {isTauri && (projectDir ? (
                  <span
                    className="flex h-7 max-w-52 items-center gap-1 rounded-full bg-secondary px-2 text-muted-foreground"
                    title={projectDir}
                  >
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {projectDir.split(/[\\/]/).pop() || projectDir}
                    </span>
                    <button
                      type="button"
                      title="Stop working in this folder"
                      className="shrink-0 rounded-full p-0.5 hover:bg-foreground/10 hover:text-foreground"
                      onClick={() => pickProjectDir(null)}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 rounded-full px-2 text-muted-foreground hover:text-foreground"
                    onClick={async () => {
                      const picked = await openDialog({ directory: true, multiple: false });
                      if (typeof picked === "string") pickProjectDir(picked);
                    }}
                    title="Let the agent read and edit files in a local folder"
                  >
                    <FolderOpen className="size-3.5" />
                    Run in folder…
                  </Button>
                ))}
            {models !== null && models.length === 0 && (
              <span className="text-muted-foreground">no models</span>
            )}
              </div>
              <div className="flex items-center gap-2">
                {chatId && ctx && <ContextGauge ctx={ctx} />}
                {models !== null && models.length > 0 && (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="h-7 w-auto gap-1 border-none bg-secondary px-2 shadow-none">
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
                <Button
                  size="icon"
                  className="size-7 rounded-full"
                  onClick={() => void send()}
                  disabled={
                    streaming || !model || (!prompt.trim() && pending.length === 0)
                  }
                  title="Send"
                >
                  {busy ? <Spinner className="text-primary-foreground" /> : <ArrowUp />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DeviceSetupDialog
        open={overlay?.kind === "device"}
        onOpenChange={(o) => {
          if (!o) pushRoute({ overlay: null });
        }}
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
        chatId={chatId}
        currentMachineId={chats?.find((c) => c.id === chatId)?.machine_id ?? null}
        onMachineChanged={() => void refreshChats()}
        onOpenDevice={() => pushRoute({ overlay: { kind: "device" } })}
        onSignOut={onSignOut}
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
    releases === null ? null : releases.filter((r) => r.platform.startsWith(OS_KEY[os]));

  const generatePairing = () => {
    setPairBusy(true);
    createPairingToken(30)
      .then((t) => setPairCode(pairingCode(window.location.origin, t.secret)))
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


function ChatListItem({
  title,
  active,
  status,
  onClick,
}: {
  title: string;
  active: boolean;
  status: { generating: boolean; unread: boolean };
  onClick: () => void;
}) {
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
  }, [title]);

  const fade = overflowing
    ? {
        maskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
        WebkitMaskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
      }
    : undefined;

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
      title={title}
    >
      <span
        ref={ref}
        className="block min-w-0 flex-1 whitespace-nowrap"
        style={fade}
      >
        {title}
      </span>
      {status.generating ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : status.unread ? (
        <span className="size-2 shrink-0 rounded-full bg-accent" title="unseen replies" />
      ) : null}
    </button>
  );
}

function SidebarContent({
  chats,
  chatId,
  email,
  displayName,
  avatarUrl,
  onNewChat,
  onOpenChat,
  onSignOut,
  onOpenSettings,
  onOpenDevice,
  onCollapse,
}: {
  chats: ChatSummary[] | null;
  chatId: string | null;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  onOpenDevice: () => void;
  /** Desktop only: collapse the sidebar from within its own header. */
  onCollapse?: () => void;
}) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-semibold">Guild</span>
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={onCollapse}
            title="Close sidebar"
          >
            <PanelLeftClose />
          </Button>
        )}
      </div>
      <div className="px-2">
        <Button variant="ghost" className="w-full justify-start gap-2" onClick={onNewChat}>
          <Plus /> New chat
        </Button>
      </div>
      <div className="px-3 pb-1 pt-4 font-medium text-muted-foreground">Chats</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="space-y-0.5 pb-2">
          {chats === null &&
            [0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          {chats !== null &&
            chats.map((c) => (
              <ChatListItem
                key={c.id}
                title={c.title || "Untitled"}
                active={c.id === chatId}
                status={{ generating: !!c.generating, unread: !!c.unread }}
                onClick={() => onOpenChat(c.id)}
              />
            ))}
          {chats !== null && chats.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">No conversations yet.</p>
          )}
        </div>
      </div>
      <Separator />
      <div className="p-2">
        <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl}>
          <DropdownMenuItem onClick={onOpenDevice}>Set up a device</DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenSettings}>Settings</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSignOut} className="text-destructive focus:text-destructive">
            {/* Desktop: the engine keeps its session and restore re-logs-in,
                so this clears this window's token only (full engine sign-out
                needs an engine logout RPC that does not exist yet). */}
            {isTauri ? "Sign out (this window only)" : "Sign out"}
          </DropdownMenuItem>
        </UserBadge>
      </div>
    </div>
  );
}
