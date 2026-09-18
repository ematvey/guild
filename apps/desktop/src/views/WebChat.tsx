import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyMention, detectMention } from "../lib/skill-mention";
import Markdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { clampSidebarWidth, saveSidebarWidth, storedSidebarWidth } from "../lib/sidebar-width";
import {
  ArrowUp,
  ShieldAlert,
  ShieldCheck,
  Brain,
  ChevronDown,
  ChevronRight,
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
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  FolderOpen,
  Square,
  X as XIcon,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  Archive,
  EllipsisVertical,
  Pencil,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { toast } from "sonner";
import { UserBadge } from "../components/user-badge";
import { Caret } from "@guild/ui/components/caret";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Separator } from "@guild/ui/components/separator";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Textarea } from "@guild/ui/components/textarea";
import { SettingsWindow } from "./settings/SettingsWindow";
import { CreateProjectDialog } from "./projects/CreateProjectDialog";
import { ProjectPickerDialog } from "./projects/ProjectPickerDialog";
import { chatProjectOf, outgoingProjectId, projectChipLabel, PROJECT_PAGE_INITIAL, PROJECT_PAGE_STEP, sidebarGrouping, type PickedProject } from "./projects/projects";
import {
  attachmentBlobUrl,
  rpcCall,
  machineId,
  postApproval,
  sendChatNoStream,
  prepareTurn,
  compactChat,
  setMachineIdentity,
  stopChat,
  uploadAttachment,
  type StreamFrame,
} from "../transport";
import {
  createChat,
  getChatApproval,
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
  type ThreadContext,
  type ThreadEventRow,
} from "../transport";


export function statusFromThreads(chats: ChatSummary[]) {
  return Object.fromEntries(chats.map(chat => [chat.id, { generating: !!chat.generating, unread: !!chat.unread }]));
}

/** The open chat's remote bound machine when its socket is down — the
 * offline warning banner's subject. Null when unbound, bound to this
 * machine (desktop executes its own tools), online, or presence unknown. */
export function offlineMachine(
  chats: ChatSummary[] | null,
  chatId: string | null,
  isTauri: boolean,
  localMachineId: string | undefined,
): { label: string } | null {
  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  if (!row?.machine_id) return null;
  if (isTauri && row.machine_id === localMachineId) return null;
  if (row.machine_online !== false) return null;
  return { label: row.machine_label ?? row.machine_id };
}

export function threadStateBlocks(state: ThreadState): Block[] {
  let blocks = eventsToBlocks(state.events);
  if (state.thinking)
    blocks = upsertThinking(blocks, state.thinking, true, `live-thinking-${state.chat_id}`);
  if (state.text) blocks.push({ kind: "text", text: state.text, key: `unpersisted-${state.chat_id}` });
  return blocks;
}

interface ToolBlock {
  callId: string;
  name: string;
  args: string;
  executor: "client" | "server";
  status: "running" | "done" | "error";
  content?: string;
  meta?: ToolMeta;
  /// Coarse category from the server (web_search | web_browse | generic):
  /// drives the native label/icon regardless of the providing integration.
  kind?: string;
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

/// One durable approval gate (design spec section F): a client tool waiting
/// for (or having received) the user's allow/deny decision. `expired` marks
/// an orphaned call: its turn ended before the card was answered, so the
/// call can never execute — the card stays visible, non-actionable.
interface ApprovalBlock {
  callId: string;
  name: string;
  args: string;
  status: "pending" | "approved" | "denied" | "expired";
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
  /// An optimistic user command not yet present in the durable history.
  pending?: boolean;
  /// kind === "reasoning": the accumulated thinking text.
  reasoningText?: string;
  /// kind === "text": the turn was stopped mid-stream; the text is the
  /// delivered prefix.
  interrupted?: boolean;
  tool?: ToolBlock;
  approval?: ApprovalBlock;
  compaction?: CompactionBlock;
}

export interface PendingSend {
  chatId: string;
  text: string;
  key: string;
  sentAt: number;
  attachments?: (MessageAttachmentMeta & { previewUrl?: string })[];
}

/** Keeps a pending command visible while a sync races its HTTP request. */
export function reconcilePendingSend(
  rows: ThreadEventRow[],
  blocks: Block[],
  pending: PendingSend | null,
): Block[] {
  if (!pending) return blocks;
  const durable = rows.some(row => row.event.type === "user_message" && row.id === pending.key);
  if (durable) return blocks;
  if (blocks.some((block) => block.key === pending.key)) return blocks;
  return [
    ...blocks,
    {
      kind: "user",
      text: pending.text,
      key: pending.key,
      attachments: pending.attachments,
      pending: true,
    },
  ];
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
        // "[Attachment: …]" blocks, plus the skill-invocation block the
        // client expanded for `/name` mentions. Show the typed text; the
        // model-facing payloads stay in the event.
        const at = ev.content.indexOf("\n\n[Attachment: ");
        const inv = ev.content.indexOf("\n\n---\nInvoked skills");
        const cut = [at, inv].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
        blocks.push({
          kind: "user",
          text: cut >= 0 ? ev.content.slice(0, cut) : ev.content,
          attachments: ev.attachments,
          key: seqKey(inEvent++),
        });
        break;
      }
      case "system_message":
        break; // server-owned prompt, log-only
      case "assistant_message": {
        const start = blocks.length;
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
        if (ev.interrupted) {
          for (let j = blocks.length - 1; j >= start; j--) {
            if (blocks[j].kind === "text") {
              blocks[j].interrupted = true;
              break;
            }
          }
        }
        break;
      }
      case "tool_result": {
        const meta = (ev.meta ?? undefined) as ToolMeta | undefined;
        const kind = (ev as { kind?: string | null }).kind ?? undefined;
        const tb = byCallId.get(ev.call_id);
        if (tb) {
          tb.content = ev.content;
          tb.status = ev.is_error ? "error" : "done";
          tb.meta = meta;
          tb.kind = kind;
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
              kind,
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
          a.status = ev.expired ? "expired" : ev.approved ? "approved" : "denied";
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
  // Resolved approvals are decisions, not conversation content: a card whose
  // decision event arrived is dropped, so history renders only approvals
  // still waiting for an answer. Expired cards stay: no tool result tells
  // their story — the card itself is the record that the call never ran.
  return blocks.filter(
    (b) =>
      !(
        b.kind === "approval" &&
        b.approval &&
        (b.approval.status === "approved" || b.approval.status === "denied")
      ),
  );
}

/// ApprovalRequested inserts a pending card into the current blocks;
/// re-attach replays may fire it again for a card we already render, so
/// this is an upsert, not a blind append.
export function upsertApproval(blocks: Block[], a: ApprovalBlock): Block[] {
  const i = blocks.findIndex((x) => x.kind === "approval" && x.approval?.callId === a.callId);
  if (i < 0) return [...blocks, { kind: "approval", text: "", approval: a, key: `approval-${a.callId}` }];
  return blocks.map((x, j) => (j === i ? { ...x, approval: { ...a } } : x));
}

/// Desktop switch-back replay: the fan-out mirror holds every frame since
/// the turn started, while the thread reload already restored the persisted
/// steps. Everything up to the last completed tool call is durable (results
/// persist before the completion broadcasts), so the replay keeps only the
/// in-flight step — the frames after the last tool_completed. Before the
/// turn's first tool completes that is the whole frame list: the reload has
/// none of the turn's text yet.
export function replayFrom(frames: StreamFrame[]): StreamFrame[] {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].type === "tool_completed") return frames.slice(i + 1);
  }
  return frames;
}

/// ApprovalResolved removes the matching card — a decided approval is not
/// conversation content (no-op when it is absent, e.g. the stream resolved
/// before we rendered the request).
export function resolveApproval(
  blocks: Block[],
  callId: string,
  _approved: boolean,
  _reason?: string,
): Block[] {
  return blocks.filter((x) => !(x.kind === "approval" && x.approval?.callId === callId));
}

/// Thinking deltas accumulate into the trailing reasoning block. A seed
/// frame carries the FULL in-flight reasoning buffer (spec B.5) right after
/// the durable reload — the in-flight step has no block yet, so the seed
/// starts one; later deltas append to the trailing reasoning block.
function upsertThinking(
  blocks: Block[],
  content: string,
  seed: boolean,
  seedKey?: string,
): Block[] {
  const last = blocks[blocks.length - 1];
  // A stable key keeps the Frame instance (and its open/collapsed state)
  // alive across views: seed views carry the full buffer, live views
  // append — either way the trailing reasoning block persists. The seed
  // key must be caller-chosen and deterministic: the state feed rebuilds
  // blocks from events every publish (~100ms while thinking streams), and
  // a per-call liveKey() would remount the frame each time, snapping an
  // expanded block shut mid-click.
  if (last?.kind === "reasoning") {
    const text = seed ? content : last.reasoningText + content;
    return [...blocks.slice(0, -1), { ...last, reasoningText: text }];
  }
  return [
    ...blocks,
    { kind: "reasoning", text: "", reasoningText: content, key: seedKey ?? liveKey() },
  ];
}

/// Client-side tools need the desktop runtime (local files, shell); in a plain
/// browser they stay pending until the server-side timeout releases the turn.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Links always open in the user's browser, never navigate the app window:
/// in the Tauri webview a plain anchor navigation would load the URL in
/// place, so external opens go through the opener plugin there.
const openExternal = (url: string) => {
  if (isTauri) {
    void import("@tauri-apps/plugin-opener")
      .then(m => m.openUrl(url))
      .catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
};

/// Anchor for markdown content: every link routes through `openExternal`.
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
  "[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1,\&_h2,\&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre_[code]]:bg-transparent [&_pre_[code]]:p-0 [&_ul]:list-disc";

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
      <div className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
        {text || "…"}
      </div>
    </Frame>
  );
}

/// Human-facing tool kind: drives the frame icon and widget selection.
function toolKind(t: ToolBlock): string {
  if (t.kind === "web_search") return "search";
  if (t.kind === "web_browse") return "fetch";
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

/// Chat view backed by the org gateway. Browser and Tauri webview members
/// render frames; the Tauri app process separately executes local tools.
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
  const [compacting, setCompacting] = useState<string | null>(null);
  const compactingRef = useRef<string | null>(null);
  compactingRef.current = compacting;
  // Compaction block keys present when /compact was sent: a sync that adds
  // a new one means the compaction landed. sawBusy tracks the server's
  // generating flag — busy→false while pending means the compaction exited
  // without appending an event.
  const compactKeysRef = useRef<string[]>([]);
  const sawCompactBusyRef = useRef(false);
  const [prompt, setPrompt] = useState("");
  // ---- skill mentions: / opens the autocomplete (skills design §3) ----
  const [skills, setSkills] = useState<ComposerSkill[] | null>(null);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    rpcCall("skills.list", {})
      .then((res) => {
        if (!cancelled) setSkills((res?.result ?? []) as ComposerSkill[]);
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
  // Per-chat rendered-block cache: reopening a thread shows its last
  // rendered content immediately while the fresh thread rows load in place,
  // so switching chats never flashes a skeleton over known content.
  const threadCacheRef = useRef<Map<string, Block[]>>(new Map());
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const pendingSendRef = useRef<Map<string, PendingSend>>(new Map());
  const [busy, setBusy] = useState(false);
  // Latest busy/attaching/threadLoading values for stable-ref consumers (the
  // deploy-freshness poll below must not read stale closure state).
  const loadStateRef = useRef({ busy: false, attaching: false, threadLoading: false });
  const [attaching, setAttaching] = useState(false); // receiving a server-side generation
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
  const loadSeq = useRef(0); // guards against stale chat switches landing last
  const skipLoadRef = useRef<string | null>(null); // chatId whose URL move must not trigger a refetch (first send)

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
      void refreshChats();
    } catch {
      toast.error("Could not archive the chat");
    }
  }, [refreshChats]);
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
  const socketRef = useRef<{ resync: () => void; stop: () => void } | null>(null);
  const syncingChatsRef = useRef(new Map<string, number>());
  const lastSeqRef = useRef(new Map<string, number>());

  const applyHistory = (state: ThreadState) => {
    const cid = state.chat_id;
    if (state.seq <= (lastSeqRef.current.get(cid) ?? -1)) return;
    lastSeqRef.current.set(cid, state.seq);
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
    const events = state.events;
    setBusy(state.generating);
    setAttaching(false);
    const pending = pendingSendRef.current.get(cid) ?? null;
    const rendered = reconcilePendingSend(events, threadStateBlocks(state), pending);
    if (pending && !rendered.some((block) => block.key === pending.key)) {
      pendingSendRef.current.delete(cid);
    }
    threadCacheRef.current.set(cid, rendered);
    setCtx(null);
    setBlocks(rendered);
    // Pending /compact reconciliation: a newly appeared compaction event is
    // the success signal; the server's busy flag dropping back to false
    // without one means the compaction failed (nothing was appended).
    if (compactingRef.current === cid) {
      if (rendered.some((b) => b.kind === "compaction" && !compactKeysRef.current.includes(b.key))) {
        setCompacting(null);
      } else if (state.generating) {
        sawCompactBusyRef.current = true;
      } else if (sawCompactBusyRef.current) {
        setCompacting(null);
      }
    }
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
  // chat's pick never carries over.
  const prevLoadedChatRef = useRef<string | null>(chatId);
  useEffect(() => {
    setPickedProject(null);
    const prev = prevLoadedChatRef.current;
    prevLoadedChatRef.current = chatId;
    if (prev !== null && prev !== chatId && blocksRef.current.length > 0) {
      if (threadCacheRef.current.size >= 20) {
        const oldest = threadCacheRef.current.keys().next().value;
        if (oldest !== undefined) threadCacheRef.current.delete(oldest);
      }
      threadCacheRef.current.set(prev, blocksRef.current);
    }
    loadSeq.current++;
    setBusy(false);
    stick.current = true;
    if (!chatId) {
      setBlocks([]);
      setCtx(null);
      setThreadLoading(false);
    } else if (skipLoadRef.current === chatId) {
      // Keep the optimistic first-send block, but still reconcile the new chat.
      skipLoadRef.current = null;
    } else {
      const cached = threadCacheRef.current.get(chatId) ?? null;
      setThreadLoading(cached === null);
      setBlocks(cached ?? []);
      setCtx(null);
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

  /** Sidebar: new chat inside a project (the project row's hover "+").
   * Pre-picks the project so the composer binds the chat to it on send. */
  const newChatInProject = (project: PickedProject) => {
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
      if (presence.auth_required) onSignOut();
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
        lastSeqRef.current.clear();
        setAttaching(false);
        setBusy(false);
      },
      onThreadList: (nextChats) => {
        setChats(nextChats);
        setChatStatus(statusFromThreads(nextChats));
        setBusy(!!nextChats.find(chat => chat.id === openChatIdRef.current)?.generating);
        setAttaching(false);
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
          setAttaching(false);
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
        } else {
          setThreadLoading(false);
          toast.error(message);
        }
      },
      onDisplaced: () => toast.error("This chat connection was replaced"),
      onAuthRequired: () => onSignOut(),
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

  // mode: "normal" starts a turn (blocked while one runs); "queue" commits
  // the message for the running turn's next pause; "steer" also interrupts
  // the in-flight turn so the message runs immediately.
  const send = async (mode: "normal" | "queue" | "steer" = "normal") => {
    const text = prompt.trim();
    if ((!text && pendingRef.current.length === 0) || !model) return;
    // Composer command: /compact manually compacts this chat instead of
    // sending a turn. Needs an existing chat; while generating the server
    // rejects with its own error, surfaced below.
    if (text.toLowerCase() === "/compact") {
      if (!chatId) {
        toast.error("Compact needs an existing chat — send a message first");
        return;
      }
      setPrompt("");
      compactKeysRef.current = blocksRef.current
        .filter((b) => b.kind === "compaction")
        .map((b) => b.key);
      sawCompactBusyRef.current = false;
      setCompacting(chatId);
      try {
        await compactChat(chatId);
      } catch (e) {
        setCompacting(null);
        toast.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const generating = busy || openGenerating;
    if (mode === "normal" && generating) return;
    const mySeq = loadSeq.current; // ignores results after a chat switch
    const sentAt = Date.now();
    if (mode === "normal") setBusy(true); // queue/steer: the spinner is already on
    setPrompt("");
    if (ta.current) ta.current.style.height = "auto";
    // Focus stays in the composer after send. Scheduled after the pending
    // state commit: disabling the
    // Send button during the same commit would otherwise move focus to
    // body and override a synchronous focus().
    requestAnimationFrame(() => ta.current?.focus());
    const sentKey = crypto.randomUUID();
    setBlocks((b) => [
      ...b,
      {
        kind: "user",
        text,
        pending: true,
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
      cid = await createChat(text.slice(0, 48), pickedProjectRef.current?.id ?? null);
      if (cid && loadSeq.current === mySeq) {
        // Move the URL to the new thread without losing the optimistic
        // pending marker; the chatId effect still requests socket reconcile.
        skipLoadRef.current = cid;
        if (approvalMode !== "default") {
          // The pick was made before the chat existed — persist it now.
          justCreatedApprovalRef.current = cid;
          void setChatApproval(cid, approvalMode).catch(() =>
            toast.error("Could not save approval mode"),
          );
        }
        pushRoute({ chatId: cid, overlay: null });
        void refreshChats();
        ta.current?.focus();
      }
    }
    if (!cid) {
      if (loadSeq.current === mySeq) {
        setBlocks((b) => [...b, { kind: "error", text: "chat create failed", key: liveKey() }]);
        setBusy(false);
      }
      return;
    }
    pendingSendRef.current.set(cid, {
      chatId: cid,
      text,
      key: sentKey,
      sentAt,
      attachments: pendingRef.current.map((a) => ({
        id: `pending-${a.id}`,
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: a.size_bytes,
        modality: a.modality,
        previewUrl: a.previewUrl,
      })),
    });
    // Optimistic sidebar spinner: the server's generating flag lands via
    // the chat-status channel within a second; this makes it instant.
    setChatStatus((prev) => ({ ...prev, [cid]: { ...(prev[cid] ?? { unread: false }), generating: true } }));
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
      for (const a of pendingRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      setPending([]);
      // Request-wins only for an in-session pick: the pick action set the
      // ref. Otherwise the field is omitted and the server falls back to
      // the chat's persisted binding — a stale sidebar row must never win
      // over a re-bind from another device.
      // Skill slash commands: expand `/name` mentions with the full
      // SKILL.md body and carry the skills index (app-process RPC; browser
      // mode has no local skills and sends the prompt through untouched).
      // AGENTS.md (Codex semantics): the bound project's local folder feeds
      // the instruction chain — global config-dir file + git-root→folder
      // docs — riding the additive `agents_md` request field.
      let turnText = text;
      let turnSkillsIndex: string | undefined;
      let turnAgentsMd: string | undefined;
      if (isTauri) {
        try {
          const projectFolder =
            currentProject &&
            (currentProject.folder ??
              projects?.find((p) => p.id === currentProject.id)?.folder);
          const prep = await prepareTurn(text, projectFolder || undefined);
          turnText = prep.prompt;
          if (prep.index) turnSkillsIndex = prep.index;
          if (prep.instructions) turnAgentsMd = prep.instructions;
        } catch {
          /* expansion is sugar — send the typed text */
        }
      }
      await sendChatNoStream(
        cid,
        model,
        turnText,
        attachmentIds,
        outgoingProjectId(pickedProjectRef.current),
        sentKey,
        generating ? (mode === "steer" ? "steer" : "queue") : undefined,
        turnSkillsIndex,
        turnAgentsMd,
      );
      // Submission is not persistence. Only the committed socket echo settles the marker.
      // The member socket delivers every effect. Busy ends on done/error or
      // when a state sync observes that the server is no longer generating.
      keepBusyThroughFinally = true;
    } catch (e) {
      if (pendingSendRef.current.get(cid)?.key === sentKey) pendingSendRef.current.delete(cid);
      threadCacheRef.current.set(
        cid,
        (threadCacheRef.current.get(cid) ?? []).filter((block) => block.key !== sentKey),
      );
      if (loadSeq.current === mySeq) {
        setBlocks((b) => [
          ...b.filter((block) => block.key !== sentKey),
          { kind: "error", text: e instanceof Error ? e.message : String(e), key: liveKey() },
        ]);
        if (mode === "normal") setBusy(false);
      }
    } finally {
      // Queue/steer never own the busy flag — the running turn does.
      if (!keepBusyThroughFinally && mode === "normal") setBusy(false);
    }
  };

  // Stop the chat's in-flight turn. 409 (nothing generating) resolves
  // silently — the turn already ended between the render and the click.
  const requestStop = async () => {
    const cid = chatId;
    if (!cid) return;
    try {
      await stopChat(cid);
    } catch {
      // the turn already ended; the feed's own state settles the spinner
    }
  };

  const activeTitle = chats?.find((c) => c.id === chatId)?.title ?? "New chat";
  const offlineMachineBanner = offlineMachine(chats, chatId, isTauri, isTauri ? machineId() : undefined);
  const streaming = busy || attaching || openGenerating;

  const grouping = useMemo(
    () => sidebarGrouping(chats === null ? null : chats.map((c) => ({ ...c, ...(chatStatus[c.id] ?? {}) }))),
    [chats, chatStatus],
  );

  const sidebar = (
    <SidebarContent
      grouping={grouping}
      projects={projects}
      loadingChats={chats === null}
      chatId={chatId}
      email={email}
      displayName={displayName}
      avatarUrl={avatarUrl}
      onNewChat={newChat}
      onNewChatInProject={newChatInProject}
      onOpenChat={openChat}
      onNewProject={() => openCreateProject("sidebar")}
      onSignOut={onSignOut}
      onOpenSettings={() => pushRoute({ overlay: { kind: "settings", section: null, detail: null } })}
      onOpenDevice={() => pushRoute({ overlay: { kind: "device" } })}
      onCollapse={isMobile ? undefined : () => setCollapsed(true)}
      onRenameChat={(id, title) => void renameChat(id, title)}
      onArchiveChat={(id) => void archiveChat(id)}
      onRenameProject={(id, name) => void renameProject(id, name)}
      onArchiveProject={(id) => void archiveProject(id)}
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
        {machineTakenOver && <div role="status" className="border-b border-border px-4 py-2 text-muted-foreground">Taken over on this machine. Tools run in the other Guild app.</div>}
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
                  "Context compacted" card when the event lands. The explicit
                  non-null check matters: with chatId still null (the chat is
                  being created by the first send) `null === null` would hold
                  and the line would flash on every initial message. */}
              {compacting !== null && compacting === chatId && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Compacting thread…</span>
                </div>
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
            {mentionMatches.length > 0 && (
              <div className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-md">
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
                setPrompt(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                autoGrow();
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
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
                {(() => {
                  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
                  const remoteMachine =
                    row?.machine_id && (!isTauri || row.machine_id !== machineId());
                  return (
                    <>
                      {remoteMachine && row!.machine_id && (
                        <span
                          className="flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 text-muted-foreground"
                          title={`Machine: ${row!.machine_label ?? row!.machine_id}${row!.machine_online ? " (online)" : " (offline)"}`}
                        >
                          <span
                            className={`size-2 shrink-0 rounded-full ${row!.machine_online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                          />
                          <span className="truncate">
                            {row!.machine_label ?? row!.machine_id}
                          </span>
                        </span>
                      )}
                      {(!chatId || currentProject) && (
                      <span
                        className="flex h-7 max-w-52 items-center gap-1 rounded-full bg-secondary px-2 text-muted-foreground"
                        title={
                          currentProject
                            ? `${currentProject.name} — ${currentProject.machine_label ?? "project"}`
                            : "Pick the folder the agent works in"
                        }
                      >
                        {chatId ? (
                          // An existing chat: the binding is fixed at chat
                          // start — a bound project shows as a read-only
                          // label; a projectless existing chat renders no
                          // chip at all (outer guard above).
                          <span className="flex max-w-44 items-center gap-1 px-2">
                            <FolderOpen className="size-3.5 shrink-0" />
                            <FadeTitle text={projectChipLabel(currentProject)} />
                          </span>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 max-w-44 gap-1 rounded-full px-2 text-muted-foreground hover:text-foreground"
                              onClick={() => setProjectPickerOpen(true)}
                            >
                              <FolderOpen className="size-3.5" />
                              <FadeTitle text={projectChipLabel(currentProject)} />
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
                      )}
                    </>
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
                      <ShieldCheck className="size-3.5" />
                      {approvalMode === "default" ? accountDefault : APPROVAL_MODE_LABELS[approvalMode]}
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
                {(() => {
                  // While a turn generates the composer stays usable: with
                  // content the send queues (Ctrl/Cmd+Enter steers); empty,
                  // the button turns into Stop.
                  const generating = busy || openGenerating;
                  const hasContent = !!prompt.trim() || pending.length > 0;
                  const stopMode = generating && !hasContent;
                  return (
                    <Button
                      size="icon"
                      className="size-7 rounded-full"
                      onClick={() =>
                        stopMode ? void requestStop() : void send(generating ? "queue" : "normal")
                      }
                      disabled={stopMode ? false : !model || !hasContent}
                      title={
                        stopMode
                          ? "Stop"
                          : generating
                            ? "Queue (Ctrl+Enter sends immediately)"
                            : "Send"
                      }
                    >
                      {stopMode ? <Square className="size-3.5 fill-current" /> : <ArrowUp />}
                    </Button>
                  );
                })()}
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


/** Sidebar row title that fades out at the right edge when it overflows
 * (instead of an ellipsis) — used by both chat and project rows. */
function FadeTitle({ text }: { text: string }) {
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

/// Inline rename field: Enter or blur commits, Esc cancels; `onDone(null)`
/// means "no change".
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

/// Hover-revealed row menu (Rename / Archive). The trigger is absolutely
/// positioned and shown via opacity, so the row's layout never shifts;
/// stays visible while the menu is open.
function RowActions({
  onRename,
  onArchive,
}: {
  onRename?: () => void;
  onArchive?: () => void;
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
          className="absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-foreground/10 text-muted-foreground opacity-0 outline-none transition-all hover:bg-foreground/20 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
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
            <Archive className="size-3.5" />
            Archive
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
}: {
  title: string;
  active: boolean;
  status: { generating: boolean; unread: boolean };
  onClick: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
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
    <button
      onClick={onClick}
      className={`group/row relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
      title={title}
    >
      <FadeTitle text={title} />
      {status.generating ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : status.unread ? (
        <span className="size-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_4px_1px_rgba(251,191,36,0.6)]" title="unseen replies" />
      ) : null}
      <RowActions
        onRename={onRename ? () => setEditing(true) : undefined}
        onArchive={onArchive}
      />
    </button>
  );
}

/// Project row header: fold-out toggle + shaded title + row menu. While
/// renaming, the whole header is a plain div hosting the inline input.
function ProjectHeader({
  name,
  folder,
  open,
  onToggle,
  onRename,
  onArchive,
  onNewChat,
}: {
  name: string;
  folder: string;
  open: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onNewChat?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm">
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
      className="group/row relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title={folder}
    >
      <ChevronRight
        className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      />
      <FadeTitle text={name} />
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
          className="absolute right-7 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-foreground/10 text-muted-foreground opacity-0 outline-none transition-all hover:bg-foreground/20 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <Plus className="size-4" />
        </span>
      )}
      <RowActions onRename={() => setEditing(true)} onArchive={onArchive} />
    </button>
  );
}

function SidebarContent({
  grouping,
  projects,
  loadingChats,
  chatId,
  email,
  displayName,
  avatarUrl,
  onNewChat,
  onNewChatInProject,
  onOpenChat,
  onNewProject,
  onSignOut,
  onOpenSettings,
  onOpenDevice,
  onCollapse,
  onRenameChat,
  onArchiveChat,
  onRenameProject,
  onArchiveProject,
}: {
  grouping: ReturnType<typeof sidebarGrouping>;
  projects: Project[] | null;
  /** True while the chat list is still loading (skeleton rows). */
  loadingChats: boolean;
  chatId: string | null;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onNewChat: () => void;
  /** New chat with this project pre-picked (project row's hover "+"). */
  onNewChatInProject: (project: PickedProject) => void;
  onOpenChat: (id: string) => void;
  onNewProject: () => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  onOpenDevice: () => void;
  /** Desktop only: collapse the sidebar from within its own header. */
  onCollapse?: () => void;
  /** Row-menu actions; the implementations live with the list refresh. */
  onRenameChat?: (id: string, title: string) => void;
  onArchiveChat?: (id: string) => void;
  onRenameProject?: (id: string, name: string) => void;
  onArchiveProject?: (id: string) => void;
}) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  /** Which project fold-outs are expanded (per-session, all collapsed). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** How many chats each expanded fold-out shows; starts at
   * PROJECT_PAGE_INITIAL, "Show more" adds PROJECT_PAGE_STEP. */
  const [limits, setLimits] = useState<Record<string, number>>({});
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
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {/* Projects: collapsible section; a row folds out that project's
            chats inline (the fold-out keeps its own pagination). */}
        <button
          type="button"
          onClick={() => setProjectsOpen((o) => !o)}
          className="flex w-full items-center justify-between px-1 pb-1 pt-4 font-medium text-muted-foreground outline-none hover:text-foreground"
        >
          <span>Projects</span>
          <span className="flex items-center gap-1">
            <span
              role="button"
              tabIndex={0}
              title="New project"
              className="rounded p-0.5 hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onNewProject();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onNewProject();
                }
              }}
            >
              <Plus className="size-3.5" />
            </span>
            {projectsOpen ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </span>
        </button>
        {projectsOpen && (
          <div className="space-y-0.5 pb-1">
            {projects === null &&
              [0, 1].map((i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
            {projects?.map((p) => {
              const open = !!expanded[p.id];
              const chats = grouping.chatsByProject[p.id] ?? [];
              const limit = limits[p.id] ?? PROJECT_PAGE_INITIAL;
              return (
                <div key={p.id}>
                  <ProjectHeader
                    name={p.name}
                    folder={p.folder}
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
        )}
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
          {!loadingChats && projects !== null && grouping.visible.length === 0 && (
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
            Sign out
          </DropdownMenuItem>
        </UserBadge>
      </div>
    </div>
  );
}
