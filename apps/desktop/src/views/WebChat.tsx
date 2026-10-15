import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ErrorInfo, type ReactNode, type RefObject } from "react";
import { applyMention, detectMention } from "../lib/skill-mention";
import { daemonFs, listSkills } from "../lib/context";
import { fetchInstalls } from "./skills/skills-api";
import { openExternal } from "../lib/open-external";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Client-side tools need the desktop runtime (local files, shell); in a plain
// browser they stay pending until the server-side timeout releases the turn.
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents, WRAP_ANYWHERE } from "./markdown";
import { clampSidebarWidth, saveSidebarWidth, storedSidebarWidth } from "../lib/sidebar-width";
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  ShieldAlert,
  ShieldCheck,
  Brain,
  ChevronDown,
  ChevronUp,
  Check,
  Copy,
  EllipsisVertical,
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
  Pencil,
  Plus,
  Search,
  FolderOpen,
  Square,
  X as XIcon,
  SquareTerminal,
  FileDown,
  TriangleAlert,
  Wrench,
  Trash2,
  CornerDownRight,
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
import { WorkingIndicator } from "@guild/ui/components/working-indicator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Textarea } from "@guild/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@guild/ui/components/tooltip";
import { HotkeyHint } from "../components/hotkey-hint";
import { SettingsSectionPane } from "./settings/settings-sections";
import { CreateProjectDialog } from "./projects/CreateProjectDialog";
import { chatProjectOf, outgoingProjectId, projectChipLabel, sidebarGrouping, type PickedProject } from "./projects/projects";
import { ChatsPanel, FadeTitle, SettingsPanel, WorkPanel } from "./sidebar-contents";
import { SkillsPanel } from "./skills/SkillsPanel";
import {
  clampSkillsRoute,
  SKILLS_CATALOG,
  type SkillsRoute,
} from "./skills/skills-route";
import { SidebarRail, type SidebarTab } from "./sidebar-rail";
import { OnboardingGuide, type OnboardingExit } from "./onboarding";
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
  withdrawQueued,
} from "../transport";
import {
  apiUrl,
  apiOnboarded,
  createChat,
  fetchChatViewMode,
  getChatApproval,
  listArchivedChats,
  listChats,
  listMachines,
  listModels,
  listProjects,
  saveChatViewMode,
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
  type ChatViewMode,
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
 * busy (a second send could race the first). A first send is exempt: its
 * pending state lives in the dedicated pending-submit spinner, and busy
 * here feeds stopMode — a Stop button for a turn that does not exist is a
 * lie. */
export function busyAfterThreadPush(
  chats: ChatSummary[],
  openChatId: string | null,
  sendInFlight: boolean,
): boolean {
  if (sendInFlight && openChatId !== null) return true;
  return !!chats.find((c) => c.id === openChatId)?.generating;
}

/** The composer's send button: the four states it can honestly show.
 * Precedence: the stop click's own state, then a live turn (Stop), then a
 * first-send submit in flight (spinner — the chat does not exist yet, so
 * there is no turn to stop and nothing to send again), then the plain
 * send/queue arrow. */
export type SendButtonMode = "send" | "pending" | "stop" | "stopping";
export function sendButtonState(input: {
  hasContent: boolean;
  hasModel: boolean;
  generating: boolean;
  stopping: boolean;
  submitting: boolean;
}): SendButtonMode {
  if (input.generating && !input.hasContent) return input.stopping ? "stopping" : "stop";
  if (input.submitting) return "pending";
  return "send";
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

/** Layout mode for one sidebar tab (desktop rail). The skills tab is a
 *  full main-column page swap: NO sidebar aside at all — the skills page
 *  replaces the chat thread — so picking it must not touch the persisted
 *  sidebar collapsed state either (leaving the tab restores the sidebar
 *  exactly as it was). Every other tab keeps the resizable panel next to
 *  the chat, and a tab pick re-expands a collapsed panel. Mobile has no
 *  rail aside at all (chats-only drawer) and always shows the chat. */
export function tabPaneLayout(
  tab: SidebarTab,
  isMobile: boolean,
): { aside: boolean; mainPane: "chat" | "skillsPage"; expandsPanel: boolean } {
  if (isMobile) return { aside: false, mainPane: "chat", expandsPanel: false };
  if (tab === "skills") return { aside: false, mainPane: "skillsPage", expandsPanel: false };
  return { aside: true, mainPane: "chat", expandsPanel: true };
}


/// URL-driven navigation: the pathname is the single source of truth for
/// where the user is. Every page, tab, panel and sub-page the user can
/// reach has its own fixed address (the AGENTS.md convention). Routes:
///   /chats[/new]               — the Chats tab (default; "/" aliases);
///                                /new is the addressed scratch composer
///   /work[/new]                — the Work tab, with its scratch composer
///   /thread/<id>               — open thread
///   /project/<id>              — sidebar filtered to one project (Work tab)
///   /project/<id>/new          — scratch composer pre-picked to the project
///   /project/<id>/thread/<cid> — open thread within its project view
///   /device                    — device-setup dialog, optionally over a
///                                thread: /thread/<id>/device
///   /onboard                   — the onboarding guide dialog (the rail's
///                                Help/Learn button opens it too); chat-
///                                independent top-level route any user can
///                                open. /help deep links alias here.
///   /settings[/<section>[/<detail>]]
///                              — the Settings tab; the section (and sub-
///                                page) always ride in the URL — every
///                                section pick navigates. <detail> addresses
///                                a sub-page inside a section: an
///                                integration slug, a user/team id or "new",
///                                a model route or "add", a registry
///                                kind/slug. A bare /settings normalizes to
///                                /settings/account (replaceState).
///   /skills[/activity|/machine|/<slug>[/edit] | /new]
///                              — the skills page (top-level; replaces the
///                                main pane): tab views, a detail page, the
///                                editor in edit or create mode. See
///                                skills-route.ts for the state contract.
/// Back/forward, reloads and deep links all resolve through parseChatRoute.
type ChatOverlay = { kind: "device" } | { kind: "onboard" } | null;
interface ChatRoute {
  chatId: string | null;
  /** Sidebar project filter (deep-linked /project/<id>). */
  projectId: string | null;
  overlay: ChatOverlay;
  /** The skills page route, or null when the URL is not a skills one. */
  skills: SkillsRoute | null;
  /** Which rail panel tab the URL names: /chats, /work or /settings. */
  tab: "chats" | "work" | "settings";
  /** The addressed scratch composer: /chats/new, /work/new or
   *  /project/<id>/new. False on tab roots, open threads and other tabs. */
  newChat: boolean;
  /** Settings-tab section/detail named by the URL (/settings/<section>/
   * [<detail>] deep links); null elsewhere and for bare /settings, whose
   * section lives in pane state. */
  settingsSection: string | null;
  settingsDetail: string | null;
}

export const parseChatRoute = (pathname: string): ChatRoute => {
  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  // The rail's panel tabs own top-level addresses: /chats (the default),
  // /work, and /settings (bare, or with a deep-linked section). Tab picks
  // navigate, so back/forward and reloads restore the tab like any other
  // route state.
  let tab: ChatRoute["tab"] = "chats";
  if (parts[0] === "chats" || parts[0] === "work") {
    tab = parts[0];
    parts.shift();
  }
  let chatId: string | null = null;
  let projectId: string | null = null;
  if (parts[0] === "project" && parts[1]) {
    projectId = parts[1];
    tab = "work";
    parts.splice(0, 2);
  }
  if (parts[0] === "thread" && parts[1]) {
    chatId = parts[1];
    parts.splice(0, 2);
  }
  // The reserved "new" segment addresses the scratch composer — only on a
  // chatless surface (a thread or overlay URL never carries it).
  const newChat = parts[0] === "new" && chatId === null;
  if (newChat) parts.shift();
  if (parts[0] === "device")
    return { chatId, projectId, tab, overlay: { kind: "device" }, skills: null, settingsSection: null, settingsDetail: null, newChat: false };
  if (parts[0] === "onboard" || parts[0] === "help")
    return { chatId: null, projectId: null, tab: "chats", overlay: { kind: "onboard" }, skills: null, settingsSection: null, settingsDetail: null, newChat: false };
  if (parts[0] === "settings") {
    // Bare /settings normalizes to the default section (/settings/account,
    // via the pane effect); a section (and optional sub-page detail)
    // preselects it. Everything after the section is the sub-page id; each
    // segment was encoded separately, so a model id like "a/b" round-trips
    // as one part.
    const section = parts.length > 1 ? parts[1] : null;
    const detail = parts.length > 2 ? parts.slice(2).map(decodeURIComponent).join("/") : null;
    return {
      chatId: null,
      projectId: null,
      tab: "settings",
      overlay: null,
      skills: null,
      settingsSection: section,
      settingsDetail: detail,
      newChat: false,
    };
  }
  // Skills is chat-independent and top-level like settings: the URL drops
  // any thread/project prefix, so the skills page replaces the chat.
  if (parts[0] === "skills") {
    const skills = parseSkillsRoute(parts.slice(1));
    return { chatId: null, projectId: null, overlay: null, skills, tab: "chats", settingsSection: null, settingsDetail: null, newChat: false };
  }
  return { chatId, projectId, tab, overlay: null, skills: null, settingsSection: null, settingsDetail: null, newChat };
};

/// /skills/<seg...> after the leading "skills": a bare /skills is the
/// catalog, the reserved segments name the activity/machine tabs and the
/// create editor, and anything else is a detail slug with an optional
/// /edit suffix. The reserved-segment rule is what disambiguates tabs from
/// slugs — see SkillsRoute.
const parseSkillsRoute = (parts: string[]): SkillsRoute => {
  const seg = parts[0];
  if (seg === undefined) return SKILLS_CATALOG;
  if (seg === "activity") return { view: "activity", slug: null, editor: null };
  if (seg === "machine") return { view: "machine", slug: null, editor: null };
  if (seg === "new") return { view: "catalog", slug: null, editor: "new" };
  return { view: "catalog", slug: seg, editor: parts[1] === "edit" ? seg : null };
};

export const chatRoutePath = (
  chatId: string | null,
  projectId: string | null,
  overlay: ChatOverlay,
  skills: SkillsRoute | null = null,
  tab: ChatRoute["tab"] = "chats",
  settingsSection: string | null = null,
  settingsDetail: string | null = null,
  newChat = false,
): string => {
  // Skills is chat-independent — top-level URL that replaces the chat view.
  if (skills !== null) {
    if (skills.editor === "new") return "/skills/new";
    if (skills.slug !== null)
      return skills.editor !== null
        ? `/skills/${encodeURIComponent(skills.slug)}/edit`
        : `/skills/${encodeURIComponent(skills.slug)}`;
    if (skills.view === "activity") return "/skills/activity";
    if (skills.view === "machine") return "/skills/machine";
    return "/skills";
  }
  // The scratch composer is a chatless surface: the project-bound form
  // implies the Work tab, the bare form rides on /chats/new or /work/new.
  // An overlay URL never carries the segment (the dialog is chatless too).
  if (overlay === null && chatId === null && newChat && tab !== "settings") {
    if (projectId) return `/project/${encodeURIComponent(projectId)}/new`;
    return tab === "work" ? "/work/new" : "/chats/new";
  }
  const base = projectId
    ? `/project/${encodeURIComponent(projectId)}${
        chatId ? `/thread/${encodeURIComponent(chatId)}` : ""
      }`
    : chatId
      ? `/thread/${encodeURIComponent(chatId)}`
      : tab === "work"
        ? "/work"
        : tab === "settings"
          ? "/settings"
          : "/chats";
  if (overlay?.kind === "onboard") {
    // Chat-independent top-level route: any thread/project prefix drops.
    // /help deep links share the address (the guide is the help page).
    return "/onboard";
  }
  if (overlay?.kind === "device") {
    // /settings/<seg> parses as a Settings-tab section, so a device dialog
    // pushed over the Settings tab detours through /chats — the dialog is
    // chat-independent anyway.
    return `${tab === "settings" ? "/chats" : base}/device`;
  }
  // The Settings tab owns /settings; a deep-linked section/detail rides in
  // the path (tab picks navigate to bare /settings and keep the pane-state
  // section instead).
  if (tab === "settings")
    return `/settings${
      settingsSection !== null ? `/${encodeURIComponent(settingsSection)}` : ""
    }${
      settingsDetail !== null
        ? "/" + settingsDetail.split("/").map(encodeURIComponent).join("/")
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

/// Per-chat workspace state lives server-side now: the chat's project
/// (spec §5). No local folder storage — the project binding is the single
/// source of truth.

/// One row of the composer's /-autocomplete pool: a builtin command, a
/// local skill, or an installed org skill (spec §2.3 — uninstalled org
/// skills are the agent's discovery surface and never mentionable).
interface ComposerSkill {
  name: string;
  description: string;
  disabled: boolean;
  /** true for an installed org skill (from the installs endpoint). */
  org?: boolean;
}

/// The composer's skill pool (spec §2.3): the local rows plus the
/// installed org skills; a slug the local list already holds folds into
/// its local row. Pure for tests.
export function composerSkills(
  local: ComposerSkill[] | null,
  installs: Array<{ slug: string; pinned_version?: string }> | null,
): ComposerSkill[] {
  const out = [...(local ?? [])];
  const names = new Set(out.map((s) => s.name));
  for (const install of installs ?? []) {
    if (names.has(install.slug)) continue;
    out.push({ name: install.slug, description: "", disabled: false, org: true });
  }
  return out;
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
): { name: string; description: string; builtin: boolean; org: boolean }[] {
  const pool: { name: string; description: string; builtin: boolean; org: boolean }[] = [
    ...builtins.map((c) => ({ ...c, builtin: true, org: false })),
    ...(skills ?? [])
      .filter((s) => !s.disabled)
      .map((s) => ({ name: s.name, description: s.description, builtin: false, org: s.org === true })),
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

/// Hover-revealed message timestamp: always mounted (absolute within the
/// inter-message gap, hidden via opacity) so showing it never reflows the
/// thread. Locale-aware shortest unambiguous form: time only for today,
/// + month/day within the year, + year for older messages.
function prettyStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

function HoverStamp({ ts, side }: { ts?: string; side: "left" | "right" }) {
  if (!ts) return null;
  const text = prettyStamp(ts);
  if (!text) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute -bottom-4 ${side === "right" ? "right-0" : "left-0"} text-xs leading-none text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100`}
    >
      {text}
    </div>
  );
}

/// Casual-view replacement for one contiguous thinking/tool run: pulsing
/// "Agent is working Ns" while the run is the turn's live tail, settling to
/// "Agent worked for S seconds". The small py padding (immune to the list's
/// space-y margins) keeps consecutive runs from stacking without gaps.
/// The worked-for label for one contiguous thinking/tool run, or null when
/// the entry should not render at all: a completed run under one second
/// (and one without stamps at all) carries no information — "worked for 0
/// seconds" is noise. Live states always render.
export function workRunLabel(run: Block[], active: boolean, stopping: boolean, nowMs: number): string | null {
  const start = run[0]?.kind === "tool" ? run[0].tool?.ts : run[0]?.ts;
  const last = run[run.length - 1];
  const end = last.kind === "tool" ? (last.tool?.endTs ?? last.tool?.ts) : last.ts;
  const secs = (() => {
    if (!start) return null;
    const to = active ? nowMs : end ? Date.parse(end) : null;
    if (to === null || isNaN(to)) return null;
    // Floor, not round: a 0.5s run must read as sub-second (hidden), never
    // round up to a fictional "1 seconds".
    return Math.max(0, Math.floor((to - Date.parse(start)) / 1000));
  })();
  if (stopping) return "Agent is stopping";
  if (active) return secs !== null ? `Agent is working ${secs}s` : "Agent is working";
  if (secs === null || secs < 1) return null;
  if (secs < 60) return `Agent worked for ${secs} ${secs === 1 ? "second" : "seconds"}`;
  return `Agent worked for ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function WorkedForBlock({ run, active, stopping, nowMs }: {
  run: Block[];
  active: boolean;
  stopping: boolean;
  nowMs: number;
}) {
  const label = workRunLabel(run, active, stopping, nowMs);
  if (label === null) return null;
  return (
    <div className="-mt-1.5! mb-2.5! py-0 text-sm text-muted-foreground">
      {active ? <span className="animate-pulse">{label}</span> : label}
    </div>
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
  /** Web only: false = the user has not completed the first-run onboarding
   *  wizard yet (server-side onboarded flag). Desktop skips it. */
  onboarded?: boolean;
  /** Flips App-level state once onboarding completes, so the wizard
   *  unmounts without waiting for the next apiMe. */
  onOnboarded?: () => void;
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
function WebChatAccount({ email, role = "member", displayName, avatarUrl, onSignOut, onAddWorkspace, onboarded = true, onOnboarded }: WebChatProps) {
  const outgoingScope = `${apiUrl("")}\n${email}`;
  const draftStorage = useMemo(() => scopedDraftStorage(localStorage, outgoingScope), [outgoingScope]);
  const [fileStore] = useState(() => new BrowserSendStore(outgoingScope));
  const storageWarningRef = useRef(false);
  const [filesReady, setFilesReady] = useState(false);
  const deliveringRef = useRef(new Set<string>());
  const observedUserIdsRef = useRef(new Set<string>());
  // The newest event id whose read-marker POST already fired per chat:
  // thread_state frames arrive per streamed delta batch, and marking read
  // per frame spammed /read hundreds of times over one active turn — the
  // marker only needs to move when the view carries events it hasn't
  // covered yet.
  const lastReadMarkRef = useRef(new Map<string, string>());
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
  // The composer floats over the chat content; the scroll pane needs its
  // live height as bottom padding — a fixed guess breaks as soon as the
  // composer stack grows (queued chips, attachments, a taller textarea).
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(128);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  const chatsRef = useRef<ChatSummary[] | null>(null);
  chatsRef.current = chats;
  // URL-driven navigation state (see parseChatRoute above): everything the
  // user can navigate to — the open thread, the device dialog, the skills
  // page, the Settings tab and its deep-linked section — lives in the
  // pathname, so back/forward, reloads and deep links all land in exactly
  // the right place.
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
  // First-send submit in flight: the id of the outgoing command whose
  // create/prepare/send round trip has not landed yet. The scratch view
  // renders nothing optimistically (the chat does not exist), so this id —
  // not busy — carries the pending state: the send button spins until the
  // create responds and the route moves to the real chat.
  const [pendingSubmitId, setPendingSubmitId] = useState<string | null>(null);
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
    let cancelled = false;
    // The /-autocomplete pool = local + installed org skills (spec §2.3):
    // local rows exist only on Tauri (the fs bridge); org installs come
    // from the server in both modes — uninstalled org skills are never
    // fetched, so they can never be mentioned.
    const fs = isTauri ? daemonFs(rpcCall) : null;
    const local = fs
      ? fs.scopes().then((scopes) => listSkills(fs, scopes)).catch(() => null)
      : Promise.resolve(null);
    Promise.all([local, fetchInstalls().catch(() => null)])
      .then(([rows, installs]) => {
        if (!cancelled) setSkills(composerSkills(rows as ComposerSkill[] | null, installs));
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
  // The chat whose route push should carry the optimistic busy across the
  // open effect's busy reset: the created thread renders as working (the
  // seeded send + busy) until the server's generating flag or a submit
  // failure takes over.
  const justCreatedBusyRef = useRef<string | null>(null);
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
  // and the settings/device surfaces follow the parsed route.
  useEffect(() => {
    const onPop = () => setRoute(parseChatRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Every navigation goes through here: history and route state move
  // together, so the URL always reflects what is on screen.
  const pushRoute = (next: {
    chatId?: string | null;
    projectId?: string | null;
    overlay?: ChatOverlay;
    skills?: SkillsRoute | null;
    tab?: ChatRoute["tab"];
    newChat?: boolean;
    settingsSection?: string | null;
    settingsDetail?: string | null;
  }) => {
    const chatId = "chatId" in next ? (next.chatId as string | null) : route.chatId;
    const projectId = "projectId" in next ? (next.projectId as string | null) : route.projectId;
    const ov = "overlay" in next ? (next.overlay as ChatOverlay) : route.overlay;
    // A project-bound address implies the Work tab (the parse agrees).
    const tab = next.tab ?? (projectId ? "work" : route.tab);
    // The skills page is replaced by anything that names a chat or opens a
    // dialog overlay — those are chat-context surfaces. An overlay close
    // (overlay: null) keeps it: the dialog was rendered over the skills page.
    const sk =
      "skills" in next
        ? (next.skills as SkillsRoute | null)
        : "chatId" in next || (next.overlay !== undefined && next.overlay !== null)
          ? null
          : route.skills;
    // The scratch composer is chatless: it drops with any open thread,
    // overlay or skills page, and never rides on the Settings tab.
    const newChat =
      ("newChat" in next ? !!next.newChat : route.newChat) &&
      chatId === null &&
      ov === null &&
      sk === null &&
      tab !== "settings";
    // The Settings tab owns its section in the URL: a navigation naming a
    // section/detail carries it, one leaving the tab drops it, and a
    // section pick resets the sub-page unless the pick names one too. The
    // device dialog keeps the section (an overlay close restores it; the
    // dialog's URL detours through /chats regardless).
    const settingsSection =
      "settingsSection" in next
        ? (next.settingsSection as string | null)
        : tab === "settings" && sk === null
          ? route.settingsSection
          : null;
    const settingsDetail =
      "settingsDetail" in next
        ? (next.settingsDetail as string | null)
        : "settingsSection" in next
          ? null
          : tab === "settings" && sk === null
            ? route.settingsDetail
            : null;
    const path = chatRoutePath(chatId, projectId, ov, sk, tab, settingsSection, settingsDetail, newChat);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute({ chatId, projectId, overlay: ov, skills: sk, tab, newChat, settingsSection, settingsDetail });
  };

  // A bare /settings arrival (deep link, old bookmark, back/forward)
  // normalizes to the default section — the Settings tab always has a
  // sectioned address. replaceState: the normalization is not a step back.
  useEffect(() => {
    if (route.tab !== "settings" || route.settingsSection !== null) return;
    if (route.overlay !== null || route.skills !== null) return;
    const path = chatRoutePath(null, null, null, null, "settings", "account", null);
    window.history.replaceState(null, "", path);
    setRoute((r) => ({ ...r, settingsSection: "account", settingsDetail: null }));
  }, [route.tab, route.settingsSection, route.overlay, route.skills]);

  // First-run onboarding auto-show: a user the server flags as not yet
  // onboarded is pushed to /onboard, so the wizard owns the URL like any
  // other surface (reload lands back in it). replaceState is wrong here —
  // finishing the wizard navigates forward, and back from /onboard returns
  // to the pre-login view.
  useEffect(() => {
    if (onboarded || route.overlay?.kind === "onboard") return;
    pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: { kind: "onboard" } });
  }, [onboarded, route.overlay, pushRoute]);

  // Layout effect: the correction must land before paint, or the new block
  // shows for a frame at the old scroll offset (the reported 1-frame jump).
  useLayoutEffect(() => {
    if (!stick.current) return;
    const el = pane.current;
    // True max scroll, not scrollIntoView on a bottom sentinel: a sentinel
    // sits above the composer-offset padding, and aligning it with the
    // scrollport bottom leaves the last lines behind the floating composer.
    if (el) el.scrollTop = el.scrollHeight;
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

  // The composer's project binding. The chip renders only when a project
  // is actually bound or pre-picked (project context) — a plain chat-mode
  // chat shows no project affordance at all. On a new (unsent) chat the
  // pick applies when the send creates the chat; an existing chat displays
  // its project read-only — the binding cannot change after it started.
  const [pickedProject, setPickedProject] = useState<PickedProject | null>(null);
  const pickedProjectRef = useRef<PickedProject | null>(pickedProject);
  pickedProjectRef.current = pickedProject;
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const openCreateProject = () => {
    setCreateProjectOpen(true);
  };
  const openRow = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  const currentProject = pickedProject ?? chatProjectOf(openRow);
  // Ref mirror for effects that must read the pick without re-running on
  // every pick change.
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  // The scratch pick is route state: the addressed new-chat surface
  // (/project/<id>/new) pre-picks its project for the first send; every
  // other surface — a tab root, an open thread — starts unbound. The pick
  // never waits for the projects list (a send before it loads must still
  // bind): the name fills in when the list arrives.
  useEffect(() => {
    if (route.chatId !== null || !route.newChat || route.projectId === null) {
      setPickedProject(null);
      return;
    }
    const p = projects?.find((x) => x.id === route.projectId);
    setPickedProject(
      p
        ? { id: p.id, name: p.name, machine_label: p.machine_label }
        : { id: route.projectId, name: "", machine_label: undefined },
    );
  }, [route.chatId, route.newChat, route.projectId, projects]);
  const projectCreated = () => {
    void refreshProjects();
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
  const socketRef = useRef<ReturnType<typeof startSocket> | null>(null);
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
        if (active) { promptRef.current = ""; setPrompt(""); setPending([]); requestAnimationFrame(autoGrow); }
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
    // agree without a reload. It also carries the log through its last row:
    // that row's stamp is the chat's recent-activity sort key (the sidebar
    // fold-outs re-sort on it).
    const activity = state.events[state.events.length - 1]?.created_at;
    setChats(prev =>
      prev?.map(c =>
        c.id === cid
          ? {
              ...c,
              project_id: state.project_id,
              project_name: state.project_name,
              project_machine_label: state.project_machine_label,
              ...(activity !== undefined ? { last_activity_at: activity } : {}),
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
      const lastEventId = state.events[state.events.length - 1]?.id;
      if (lastEventId !== undefined && lastReadMarkRef.current.get(cid) !== lastEventId) {
        lastReadMarkRef.current.set(cid, lastEventId);
        socketRef.current?.markRead(cid);
        setChatStatus((prev) =>
          prev[cid]?.unread ? { ...prev, [cid]: { ...prev[cid], unread: false } } : prev,
        );
        setChats((prev) =>
          prev?.map((c) => (c.id === cid && c.unread ? { ...c, unread: false } : c)) ?? prev,
        );
      }
    }
  };

  // Chat switches keep cached content visible until the socket's History
  // frame overwrites it, then request a fresh sync for the new chat. The
  // composer's project pick is not touched here — it is route state, owned
  // by the pick effect below (an open thread is never pre-picked).
  const prevLoadedChatRef = useRef<string | null>(chatId);
  useEffect(() => {
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
    if (chatId !== null && justCreatedBusyRef.current === chatId) justCreatedBusyRef.current = null;
    else setBusy(false);
    stick.current = true;
    if (!chatId) {
      const opened = reducerRef.current.open(null);
      setBlocks(opened.blocks);
      setThreadLoading(false);
    } else {
      // The reducer's per-chat cache: a switch-back renders its last content
      // immediately, so switching never flashes a skeleton over known blocks.
      // A just-created chat lands here too: its view is empty, so the
      // skeleton holds until the first thread state (the user message and
      // the turn) arrives — the render is pure server truth.
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
    // Navigation only: the route moves to the addressed scratch composer
    // (/chats/new, or /work/new when entered from the Work tab); the
    // chatId effect clears the thread and the pick effect drops any pick.
    pushRoute({
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      newChat: true,
      tab: route.tab === "work" ? "work" : "chats",
    });
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
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  // Global hotkeys (desktop): Cmd/Ctrl+B toggles the sidebar, Cmd/Ctrl+N
  // opens a new thread. No printable key involved, so typing anywhere is
  // unaffected; the browser has no own bindings for these combos.
  useEffect(() => {
    if (isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.code === "KeyB") {
        e.preventDefault();
        setCollapsed((c) => !c);
      } else if (e.code === "KeyN") {
        e.preventDefault();
        newChatRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile]);

  /** Sidebar: new chat inside a project (the project row's hover "+").
   * Navigates to the project's addressed scratch view — the pick effect
   * derives the composer's binding from the route. */
  const newChatInProject = (project: PickedProject) => {
    pushRoute({ chatId: null, projectId: project.id, overlay: null, skills: null, newChat: true });
    setOpen(false);
    ta.current?.focus();
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
      onThreadEvents: (cid, _seq, events) => {
        // Incremental durable-log fan-out: the same rows a refresh replays,
        // applied live. Settles optimistic sends exactly like applyHistory.
        const applied = reducerRef.current.applyThreadEvents(cid, _seq, events);
        for (const row of events) {
          if (row.event.type === "user_message") observedUserIdsRef.current.add(row.id);
          const command = outgoingRef.current.get(row.id);
          if (row.event.type === "user_message" && command && command.chatId === cid) settleOutgoing(command);
        }
        // Recent-activity sort key: a background chat's durable rows move its
        // sidebar row (Recents / its project fold-out) forward between list
        // refreshes. Newer-only — a replayed or stale batch must not regress
        // the stamp the thread-state lane already advanced.
        const activity = events[events.length - 1]?.created_at;
        if (activity !== undefined) {
          setChats(prev => {
            const row = prev?.find((c) => c.id === cid);
            if (!row) return prev;
            if (row.last_activity_at !== undefined
              && Date.parse(row.last_activity_at) >= Date.parse(activity)) return prev;
            return prev!.map((c) => (c.id === cid ? { ...c, last_activity_at: activity } : c));
          });
        }
        if (applied.stale) return;
        if (cid === openChatIdRef.current) setBlocks(applied.blocks);
      },
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
      // Content is replaced by sequenced ThreadState at turn boundaries;
      // within a live turn the cheap frames render the stream (deltas, tool
      // status) through the reducer's frame merge.
      onFrame: (frame) => {
        if (frame.chat_id === openChatIdRef.current) {
          const applied = reducerRef.current.applyFrame(frame.event);
          if (!applied.stale) setBlocks(applied.blocks);
          if (frame.event.type === "error") {
            toast.error(frame.event.message ?? "Model error");
          }
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
        requestAnimationFrame(autoGrow);
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
        // A first send holds the scratch composer as-is (text visible,
        // input blocked) until the create responds and the route moves —
        // clearing here would flash an emptied new-chat screen. The
        // created() handover below empties the composer at navigation.
        if (target !== null && openChatIdRef.current === target) { promptRef.current = ""; setPrompt(""); setPending([]); requestAnimationFrame(autoGrow); }
      },
    });
    if (command.accepted) { deliveringRef.current.delete(command.id); return; }
    const mySeq = loadSeq.current;
    if (target === null) {
      // First send: the chat does not exist yet, so nothing renders
      // optimistically — the composer's pending-submit spinner carries the
      // state until the create responds and the route moves.
      setPendingSubmitId(command.id);
      sendingRef.current = false;
    } else if (openChatIdRef.current === target) {
      setBusy(true);
      setBlocks(reducerRef.current.optimisticSend({ chatId: target, text: command.text,
        key: command.id, sentAt: command.sentAt,
        ...(command.sendMode ? { queued: true, queuedMode: command.sendMode } : {}),
        attachments: command.attachments.map(a => ({ ...a, file: undefined, id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}` })) }).blocks);
      sendingRef.current = true;
    } else {
      sendingRef.current = false;
    }
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
          // The chat exists server-side: from here the turn's submission is
          // an in-flight round trip against a real chat — pushes must keep
          // its busy until the server's generating flag takes over.
          sendingRef.current = true;
          if (loadSeq.current === mySeq && openChatIdRef.current === command.originChatId) {
            // The composer was held (blocked, text visible) on the scratch
            // surface for the whole create, so no follow-up typing exists:
            // the sent content travels as the optimistic send below, and
            // the thread opens with an empty composer.
            writeDraft(draftStorage, cid, "");
            writeDraft(draftStorage, command.originChatId, "");
            pendingDraftsRef.current.set(cid, []);
            pendingDraftsRef.current.set(command.originChatId, []);
            persistFiles(cid, []);
            persistFiles(command.originChatId, []);
            promptRef.current = "";
            setPrompt("");
            setPending([]);
            requestAnimationFrame(autoGrow);
            if (approvalMode !== "default") {
              justCreatedApprovalRef.current = cid;
              void setChatApproval(cid, approvalMode).catch(() => toast.error("Could not save approval mode"));
            }
            // Seed the created chat's view with the sent message so the
            // route push lands straight on the working thread — no
            // skeleton between the scratch surface and the thread state.
            setBlocks(reducerRef.current.optimisticSend({ chatId: cid, text: command.text,
              key: command.id, sentAt: command.sentAt,
              attachments: command.attachments.map(a => ({ ...a, file: undefined, id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}` })) }).blocks);
            justCreatedBusyRef.current = cid;
            setBusy(true);
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
      setPendingSubmitId(cur => cur === command.id ? null : cur);
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
      requestAnimationFrame(autoGrow);
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

  /** Trash on a queued chip: withdraws the not-yet-placed send server-side.
   *  The chip drops on success; 409 means the input was just placed — the
   *  delivery flow converts it to a transcript bubble (refresh incoming). */
  const withdrawChip = useCallback(async (block: Block) => {
    const cid = chatId;
    if (!cid || !block.eventId) return;
    try {
      const ok = await withdrawQueued(cid, block.eventId);
      if (!ok) {
        toast.info("Message was just delivered to the agent");
        return;
      }
      setBlocks(reducerRef.current.dropQueued(cid, block.eventId).blocks);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [chatId]);

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

  const activeChat = chats?.find((c) => c.id === chatId);
  const activeTitle = activeChat?.title ?? "New chat";
  // Archived-chats membership is the only archived flag the client holds
  // (ChatSummary rows don't carry one).
  const chatArchived = !!archivedChats?.some((c) => c.id === chatId);
  // The header menu's rename: a popup dialog around the sidebar's rename
  // transport. Enter or Save commits, Esc/cancel discards.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const commitRename = useCallback(async () => {
    const v = renameValue.trim();
    setRenameOpen(false);
    if (!chatId || !v || v === activeChat?.title) return;
    await renameChat(chatId, v);
  }, [chatId, renameValue, activeChat, renameChat]);
  // The header menu's archive: the open chat navigates back to the chats
  // list after archiving (an archived thread is a dead end for sending).
  const headerArchive = useCallback(async () => {
    if (!chatId) return;
    if (chatArchived) {
      await unarchiveChat(chatId);
      return;
    }
    await archiveChat(chatId);
    pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: null });
  }, [chatId, chatArchived, archiveChat, unarchiveChat, pushRoute]);
  // The chat view mode (casual/technical): per-user server-side (user_kv);
  // the toggle applies locally and PUTs best-effort.
  const [chatView, setChatView] = useState<ChatViewMode>("casual");
  useEffect(() => {
    void fetchChatViewMode().then(setChatView);
  }, []);
  const setChatViewPersist = useCallback((m: ChatViewMode) => {
    setChatView(m);
    void saveChatViewMode(m);
  }, []);
  // Casual's counting "Agent is working Ns" ticks once per second while the
  // turn streams.
  const [nowTick, setNowTick] = useState(() => Date.now());
  // View entries: technical renders the transcript 1:1; casual replaces
  // each contiguous thinking/tool run with one WorkedForBlock and keeps
  // only user messages, agent text, pending approvals and terminal errors
  // (compaction cards and queued-send chips stay out).
  const { entries: displayEntries, finalAgent, lastAgent } = useMemo(() => {
    type Plain = { kind: "plain"; b: Block; i: number };
    type Entry = { kind: "work"; run: Block[] } | Plain;
    const entries: Entry[] = [];
    let run: Block[] = [];
    const flush = () => {
      if (run.length) entries.push({ kind: "work", run });
      run = [];
    };
    blocks.forEach((b, i) => {
      if (chatView !== "casual") {
        entries.push({ kind: "plain", b, i });
        return;
      }
      if (b.kind === "reasoning" || b.kind === "tool") {
        run.push(b);
        return;
      }
      flush();
      if (b.kind === "user" && !b.queued) entries.push({ kind: "plain", b, i });
      else if (b.kind === "text" || b.kind === "error" || (b.kind === "approval" && b.approval)) {
        entries.push({ kind: "plain", b, i });
      }
    });
    flush();
    // Hover stamps under agent text mark only the turn's final message: an
    // intermediate text block between tool runs is context, not the answer,
    // and stamping each one costs hover space under the whole transcript.
    // The last agent text gets no stamp while streaming — more tool runs or
    // text may still follow, so only the turn's end can call it final.
    const finalAgent = new Set<number>();
    let lastAgent: number | null = null;
    let agentSinceUser = false;
    for (let k = entries.length - 1; k >= 0; k--) {
      const e = entries[k];
      if (e.kind === "plain" && e.b.kind === "text") {
        if (!agentSinceUser) finalAgent.add(e.i);
        agentSinceUser = true;
        if (lastAgent === null) lastAgent = e.i;
      } else if (e.kind === "plain" && e.b.kind === "user") {
        agentSinceUser = false;
      }
    }
    return { entries, finalAgent, lastAgent };
  }, [blocks, chatView]);
  const offlineMachineBanner = offlineMachine(chats, chatId, isTauri, isTauri ? machineId() : undefined);
  const streaming = busy || openGenerating;
  useEffect(() => {
    if (chatView !== "casual" || !streaming) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [chatView, streaming]);
  // A first send's create round trip on the scratch surface: the composer
  // freezes with its text until the route moves to the created thread.
  const holdingFirstSend = (() => {
    if (pendingSubmitId === null || chatId !== null) return false;
    const c = outgoingRef.current.get(pendingSubmitId);
    return !!c && c.chatId === null && c.originChatId === null;
  })();

  const grouping = useMemo(
    () => sidebarGrouping(chats === null ? null : chats.map((c) => ({ ...c, ...(chatStatus[c.id] ?? {}) }))),
    [chats, chatStatus],
  );

  // Sidebar tab: one icon rail (desktop) switches the panel between chats,
  // work, skills and settings. The skills tab is not panel state at all —
  // it is the /skills... route (see below), so this state only ever holds
  // the panel-bearing tabs. Every tab owns a top-level URL (/chats, /work,
  // /settings): the state starts from the parsed route and follows it on
  // back/forward, reloads and deep links — the URL is the truth.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(route.tab);
  useEffect(() => setSidebarTab(route.tab), [route.tab]);
  // The rail's active tab: the skills page raises its own tab while a
  // /skills... URL is live (rail pick, deep link, reload, back/forward).
  const railTab: SidebarTab = route.skills !== null ? "skills" : sidebarTab;
  // Settings tab: the section rendered inline in the main pane (the rail's
  // Settings tab is a persistent surface, not an overlay launcher). The
  // section and its sub-page live in the route — every pick navigates.
  const settingsSection = route.settingsSection;
  const switchTab = (tab: SidebarTab) => {
    // The skills tab is a URL route, not persisted panel state: entering it
    // navigates to /skills, leaving it returns to the chat root — so back/
    // forward crosses between the skills page and the chat like any other
    // route pair, and a reload lands back on the skills page.
    if (tab === "skills") {
      pushRoute({ chatId: null, projectId: null, overlay: null, skills: SKILLS_CATALOG });
      return;
    }
    // Panel tabs navigate too: each owns its address, back/forward walks
    // tab history, and the navigation clears the open chat — a tab switch
    // always lands on a fresh composer, never the previously selected chat.
    // Entering Settings lands on the current section, or the default one —
    // the Settings tab always has a sectioned address.
    pushRoute({
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      tab,
      newChat: false,
      ...(tab === "settings"
        ? { settingsSection: route.settingsSection ?? "account", settingsDetail: null }
        : {}),
    });
    // A collapsed panel hides the tab's content — a tab pick is an intent
    // to see it, so the panel re-expands on the newly picked tab.
    if (tabPaneLayout(tab, isMobile).expandsPanel) setCollapsed(false);
  };
  const openSettingsSection = (id: string) => {
    // Navigation: the section pick owns its /settings/<section> address, so
    // back/forward walks the sections and a reload restores the pick.
    pushRoute({ tab: "settings", settingsSection: id, settingsDetail: null });
  };
  const openSettingsDetail = (detail: string | null) => {
    // Navigation: a sub-page opens on /settings/<section>/<detail>; closing
    // it returns to the bare section address.
    pushRoute({ tab: "settings", settingsDetail: detail });
  };

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
        onNewProject={openCreateProject}
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
        onCollapse={sidebarCollapse}
      />
    ) : (
      chatsPanel
    );

  // A /project/<id> route (deep link, reload, or back/forward) parses as
  // the Work tab, so the linked project is visible — no state decision
  // needed beyond the route-tab sync above.
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
  // tab).
  const inlineSettings =
    !isMobile && sidebarTab === "settings" && settingsSection !== null ? (
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <SettingsSectionPane
          sectionId={settingsSection}
          email={email}
          detail={route.settingsDetail}
          onDetailChange={openSettingsDetail}
        />
      </div>
    ) : null;

  // The skills page's URL state clamped to what this session can render
  // (the machine tab needs the desktop fs bridge — a web deep link falls
  // back to the catalog). Every panel state derives from it; user actions
  // navigate through pushRoute, so the URL is always the truth.
  const skillsRoute =
    !isMobile && route.skills !== null ? clampSkillsRoute(route.skills, isTauri) : null;
  // The Skills route's main pane IS the skills page — the whole column right
  // of the rail, no sidebar panel at all (the inlineSettings pattern). The
  // chat thread only comes back when another route is navigated to.
  const inlineSkills = skillsRoute !== null ? (
    <div className="flex min-h-0 flex-1 flex-col" data-scrollable>
      <SkillsPanel
        me={{ email, displayName: displayName ?? undefined, role }}
        route={skillsRoute}
        onNavigate={(next) => pushRoute({ chatId: null, projectId: null, overlay: null, skills: next })}
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
          panel between chats / work / skills / settings and carries the
          account menu */}
      {!isMobile && (
        <SidebarRail
          activeTab={railTab}
          onTabChange={switchTab}
          onOpenHelp={() =>
            pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: { kind: "onboard" } })
          }
          email={email}
          displayName={displayName}
          avatarUrl={avatarUrl}
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
      ) : skillsRoute !== null ? null : (
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
        {inlineSkills ? (
          inlineSkills
        ) : inlineSettings ? (
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="-ml-1.5 size-8 text-muted-foreground"
                    onClick={() => setCollapsed(false)}
                    aria-label="Toggle sidebar"
                  >
                    <PanelLeftOpen />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Toggle sidebar
                  <HotkeyHint combo="mod+B" />
                </TooltipContent>
              </Tooltip>
            )
          )}
          <span className="min-w-0 flex-1 truncate font-medium">
            {threadLoading && blocks.length === 0 ? (
              <Skeleton className="h-4 w-28 rounded-md" />
            ) : (
              activeTitle
            )}
          </span>
          {chatId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-mr-1.5 size-8 shrink-0 text-muted-foreground"
                  title="Chat options"
                >
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem onSelect={() => { setRenameValue(activeChat?.title ?? ""); setRenameOpen(true); }}>
                  <Pencil className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void headerArchive()}>
                  {chatArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                  {chatArchived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setChatViewPersist("casual")}>
                  <Check className={`size-4 ${chatView === "casual" ? "" : "opacity-0"}`} />
                  Casual view
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setChatViewPersist("technical")}>
                  <Check className={`size-4 ${chatView === "technical" ? "" : "opacity-0"}`} />
                  Technical view
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
            className="min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
            onScroll={() => {
              const el = pane.current;
              if (!el) return;
              // near-bottom counts as bottom (sub-pixel/rounding slack)
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
            }}
          >
            <div
              className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-6"
              style={{ paddingBottom: composerH + 20 }}
            >
              {displayEntries.map((e, i) =>
                e.kind === "plain" && e.b.kind === "user" && e.b.queued ? null :
                e.kind === "work" ? (
                  <WorkedForBlock
                    key={`work-${e.run[0]!.key}`}
                    run={e.run}
                    active={streaming && i === displayEntries.length - 1}
                    stopping={!!(chatId && stopping[chatId])}
                    nowMs={nowTick}
                  />
                ) : e.b.kind === "user" ? (
                  <div
                    key={e.b.key}
                    className={`group relative ml-auto w-fit max-w-[80%] ${chatView === "casual" ? "py-2" : ""}`}
                  >
                    <div className={`rounded-2xl bg-secondary px-4 py-2.5 leading-[1.75] ${WRAP_ANYWHERE}`}>
                      {e.b.text && <div className="whitespace-pre-wrap">{e.b.text}</div>}
                      {e.b.attachments && e.b.attachments.length > 0 && (
                        <div className="mt-1 flex max-w-full flex-wrap items-start justify-end gap-2">
                          {e.b.attachments.filter((a) => a.modality === "image").map((a) => (
                            <AttachmentImageThumb key={a.id} att={a} />
                          ))}
                          {e.b.attachments.filter((a) => a.modality !== "image").map((a) => (
                            <AttachmentFileChip key={a.id} att={a} />
                          ))}
                        </div>
                      )}
                    </div>
                    <HoverStamp ts={e.b.ts} side="right" />
                  </div>
                ) : e.b.kind === "reasoning" ? (
                  <ReasoningFrame
                    key={e.b.key}
                    text={e.b.reasoningText ?? ""}
                    live={streaming && e.i === blocks.length - 1}
                  />
                ) : e.b.kind === "tool" && e.b.tool ? (
                  <ToolFrame key={e.b.key} t={e.b.tool} />
                ) : e.b.kind === "approval" && e.b.approval ? (
                  <ApprovalCard key={e.b.key} a={e.b.approval} chatId={chatId} />
                ) : e.b.kind === "compaction" && e.b.compaction ? (
                  <CompactionCard key={e.b.key} c={e.b.compaction} />
                ) : e.b.kind === "error" ? (
                  <div
                    key={e.b.key}
                    className={`w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive ${chatView === "casual" ? "text-sm" : ""}`}
                  >
                    {chatView === "casual" ? "Turn failed" : e.b.text}
                  </div>
                ) : (
                  <div key={e.b.key} className={`group relative ${chatView === "casual" ? "py-2" : ""}`}>
                    <div
                      className={`max-w-none space-y-3 leading-[1.75] ${MD_CLASS} ${MD_TABLE_CLASS}`}
                    >
                      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                        {e.b.text}
                      </Markdown>
                      {e.b.interrupted && !streaming && (
                        <div className="text-xs text-muted-foreground">stopped</div>
                      )}
                    </div>
                    {finalAgent.has(e.i) && !(streaming && e.i === lastAgent) && (
                      <HoverStamp ts={e.b.ts} side="left" />
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
              {/* Working shimmer (technical view only — casual's work runs
                  carry their own live indicator): the turn is generating but
                  the log's tail is not already animating. */}
              {chatView === "technical" &&
                streaming &&
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
            </div>
          </div>
        )}

        {/* composer: floats over the chat content; the scroll pane runs
            full-height behind it and offsets it by its measured height */}
        <div
          ref={composerRef}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:px-4"
        >
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
            {(() => {
              const queuedChips = blocks.filter((b) => b.kind === "user" && b.queued);
              if (queuedChips.length === 0) return null;
              return (
                <div className="space-y-1.5 px-1 pb-2">
                  {queuedChips.map((b) => (
                    <div
                      key={b.key}
                      className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
                    >
                      <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate" title={b.text}>
                        {b.text}
                      </span>
                      {b.attachments && b.attachments.length > 0 && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          +{b.attachments.length}
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {b.queuedMode === "steer" ? "Steer" : "Queued"}
                      </span>
                      <button
                        type="button"
                        aria-label="Remove queued message"
                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => void withdrawChip(b)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })()}
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
                      {sk.builtin
                        ? sk.description
                        : `${sk.description || "Installed org skill"} — the skill's instructions are attached when you send`}
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
              placeholder={
                models === null || model
                  ? "Type / for skills and commands"
                  : "No model available"
              }
              data-scrollable
              // Not disabled while streaming: a disabled focused element
              // blurs to body, and the composer must keep focus/caret
              // during generation (send is guarded by `busy` anyway).
              // readOnly (not disabled) for the held first send too — the
              // screen stays frozen with the sent text until navigation.
              readOnly={holdingFirstSend}
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
                  // One read-only chip for project + machine. The composer
                  // never binds projects: a chat is projectless unless it was
                  // started from a project (the sidebar project row's "+",
                  // which pre-picks the binding). The executing machine is
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
                    currentProject && (
                      <span
                        className="flex h-7 max-w-52 items-center gap-1.5 rounded-full bg-secondary px-2 text-muted-foreground"
                        title={
                          showMachine
                            ? `${currentProject.name} — Machine: ${machineLabel}${machineOnline ? " (online)" : " (offline)"}`
                            : `${currentProject.name} — ${currentProject.machine_label ?? "project"}`
                        }
                      >
                        {showMachine && (
                          <span
                            className={`size-2 shrink-0 rounded-full ${machineOnline ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                          />
                        )}
                        <span className="flex h-7 items-center gap-1 px-2">
                          <FolderOpen className="size-3.5 shrink-0" />
                          <span className="hidden min-w-0 sm:block sm:flex-1">
                            <FadeTitle text={projectChipLabel(currentProject)} />
                          </span>
                        </span>
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
                  // click can honestly get. A first-send submit in flight
                  // (create/prepare/send round trip, the chat not on the
                  // server yet) shows the pending spinner instead: there is
                  // no turn to stop and nothing to send again.
                  const pendingCommand = pendingSubmitId !== null
                    ? outgoingRef.current.get(pendingSubmitId)
                    : undefined;
                  const submitting = !!pendingCommand &&
                    (pendingCommand.chatId ?? pendingCommand.originChatId) === (chatId ?? null);
                  const generating = openGenerating || (busy && !submitting);
                  const hasContent = !!prompt.trim() || pending.length > 0;
                  const mode = sendButtonState({
                    hasContent,
                    hasModel: !!model,
                    generating,
                    stopping: !!chatId && !!stopping[chatId],
                    submitting,
                  });
                  return (
                    <Button
                      size="icon"
                      className="size-7 rounded-full"
                      onClick={() =>
                        mode === "stop" || mode === "stopping"
                          ? void requestStop()
                          : void send(generating ? "queue" : "normal")
                      }
                      disabled={
                        mode === "pending" ||
                        mode === "stopping" ||
                        (mode === "send" && (!model || !hasContent))
                      }
                      title={
                        mode === "stopping"
                          ? "Stopping…"
                          : mode === "stop"
                            ? "Stop"
                            : mode === "pending"
                              ? "Sending…"
                              : generating
                                ? "Queue (Ctrl+Enter sends immediately)"
                                : "Send"
                      }
                    >
                      {mode === "stop" || mode === "stopping" ? (
                        <Square
                          className={`size-3.5 fill-current ${mode === "stopping" ? "animate-pulse" : ""}`}
                        />
                      ) : mode === "pending" ? (
                        <Loader2 className="size-3.5 animate-spin" />
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

      {/* Onboarding guide: the rail's Help/Learn button opens it, it lives
          at /onboard (chat-independent route any user can open, /help deep
          links alias there), and it auto-shows for users the server flags as
          not yet onboarded — the auto-push makes the guide own the URL, so a
          reload lands back in it. It floats over the running UI; closing it
          from any section marks the server-side flag and returns to chats. */}
      {(route.overlay?.kind === "onboard" || !onboarded) && (
        <OnboardingGuide
          onDone={(exit: OnboardingExit) => {
            void apiOnboarded();
            onOnboarded?.();
            if (exit === "device") {
              pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: { kind: "device" } });
            } else if (exit === "gateway") {
              pushRoute({
                chatId: null,
                projectId: null,
                overlay: null,
                skills: null,
                tab: "settings",
                settingsSection: "gateway",
                settingsDetail: null,
                newChat: false,
              });
            } else {
              // Plain close (Got it, skip, Esc, ✕): /onboard itself always
              // renders the guide, so closing must leave the route.
              pushRoute({
                chatId: null,
                projectId: null,
                overlay: null,
                skills: null,
                tab: "chats",
                newChat: false,
              });
            }
          }}
        />
      )}

      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        machines={machines}
        localMachineId={machineId()}
        isTauri={isTauri}
        projects={projects}
        onCreated={projectCreated}
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

