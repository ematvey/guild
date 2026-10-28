// The thread view: transcript, composer and sidebar for one chat. State
// lives in the hooks under thread/hooks/, pure derivations in the sibling
// modules, and this file assembles the component tree.
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ErrorInfo, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownRight,
  CornerUpLeft,
  EllipsisVertical,
  FolderOpen,
  Link2,
  Loader2,
  Menu,
  PanelLeftOpen,
  Pencil,
  Plus,
  ShieldCheck,
  Square,
  Trash2,
  Users,
} from "lucide-react";

import { Button } from "@guild/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { toast } from "sonner";
import { WorkingIndicator } from "@guild/ui/components/working-indicator";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Textarea } from "@guild/ui/components/textarea";
import { Skeleton } from "@guild/ui/components/skeleton";

import { MD_CLASS, MD_TABLE_CLASS, mdComponents, WRAP_ANYWHERE } from "../markdown";
import { FrameToggleContext } from "../frame";
import { WorkedForBlock, viewEntries } from "../worked-for-block";
import { clampSidebarWidth, saveSidebarWidth, storedSidebarWidth } from "../../lib/sidebar-width";
import { CHAT_DEFAULT_W, clampChatWidth, saveChatWidth, storedChatWidth } from "../../lib/chat-width";
import { readDraft, writeDraft } from "../../lib/drafts";
import { IS_TAURI } from "../../lib/session";
import { apiUrl } from "../../lib/session";
import { bindChatAgent, chatAgentBinding } from "../../lib/api/chats";
import { listModels, type ModelOption } from "../../lib/api/models";
import { machineId } from "../../lib/machine-rpc";
import { DesktopTooltip } from "../../components/desktop-tooltip";
import { ContextRing } from "../../components/context-ring";
import { SettingsSectionPane } from "../settings/settings-sections";
import {
  chatProjectOf,
  projectChipLabel,
  sidebarGrouping,
  type PickedProject,
} from "../projects/projects";
import { ChatsPanel } from "../sidebar/chats-panel";
import { FadeTitle } from "../sidebar/chrome";
import { SettingsPanel } from "../sidebar/settings-panel";
import { WorkPanel } from "../sidebar/work-panel";
import { SkillsPanel } from "../skills/SkillsPanel";
import { clampSkillsRoute, SKILLS_CATALOG } from "../skills/skills-route";
import { AgentsPanel } from "../agents/AgentsPanel";
import {
  AGENTS_ACTIVITY,
  AGENTS_DIRECTORY,
  agentsRoutePath,
  agentsRailTab,
  type AgentsRoute,
} from "../agents/agents-route";
import { listAgents, type Agent } from "../agents/agents-api";
import { RunningSubagents } from "../agents/RunningSubagents";
import {
  SubagentClosedRecord,
  SubagentResultRecord,
  SubagentSpawnRecord,
} from "../agents/subagent-blocks";
import { ChildThreadHeader } from "../agents/ChildThreadHeader";
import { SidebarRail, type RailTab } from "../sidebar-rail";
import { ThreadSkeleton, ThreadTitle, ThreadProgress, ReasoningFrame, CompactionCard, HoverStamp } from "./blocks";
import { ToolFrame } from "./tool-blocks";
import { ApprovalCard } from "./approval-card";
import { AttachmentImageThumb, AttachmentFileChip } from "./attachments";
import { APPROVAL_MODES } from "./approval";
import { ThreadOverlays } from "./ThreadOverlays";
import { useVisualViewportPin } from "./use-visual-viewport-pin";
import { offlineMachine, pruneStopping, sendButtonState, tabPaneLayout, threadAccess, threadFacts, workingForChat } from "./status";
import { chatRoutePath, isImeEnter } from "./route";
import type { RenderBlock } from "../../lib/thread-reducer";
import { useThreadRoute } from "./hooks/use-thread-route";
import { useChatData } from "./hooks/use-chat-data";
import { useThreadStore } from "./hooks/use-thread-store";
import { useComposer } from "./hooks/use-composer";
import { useOutgoing } from "./hooks/use-outgoing";
import { useMemberSocket } from "./hooks/use-member-socket";
import { useApprovalMode } from "./hooks/use-approval-mode";
import { useChatActions } from "./hooks/use-chat-actions";

type ThreadProps = {
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
   *  app; the login activates the new workspace. The base_url argument is
   *  set when a dead-token row asks to sign in again. Absent on the web. */
  onAddWorkspace?: (baseUrl?: string) => void;
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

/** A settled agent text block. Markdown parsing dominates a long transcript,
 *  and the reducer keeps earlier block objects identical across live deltas
 *  and state publishes, so this memo hits for every settled block. */
const TextBlock = memo(function TextBlock({
  b,
  showStamp,
  showInterrupted,
  origin,
  onOpenOrigin,
}: {
  b: RenderBlock;
  showStamp: boolean;
  showInterrupted: boolean;
  /** The run this message was delivered from. Rendered in the body so the
   *  timestamp stays under the link. */
  origin?: { chat_id: string; title: string } | null;
  onOpenOrigin?: (chatId: string) => void;
}) {
  return (
    <div className="group relative">
      <div className={`max-w-none space-y-3 leading-[1.75] ${MD_CLASS} ${MD_TABLE_CLASS}`}>
        <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {b.text}
        </Markdown>
        {b.attachments && b.attachments.length > 0 && (
          <div className="flex max-w-full flex-wrap items-start gap-2">
            {b.attachments.filter((a) => a.modality === "image").map((a) => (
              <AttachmentImageThumb key={a.id} att={a} />
            ))}
            {b.attachments.filter((a) => a.modality !== "image").map((a) => (
              <AttachmentFileChip key={a.id} att={a} />
            ))}
          </div>
        )}
        {origin != null && (
          <button
            type="button"
            onClick={() => onOpenOrigin?.(origin.chat_id)}
            className="flex w-fit items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CornerUpLeft className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Opened by the agent run</span>
            <span className="max-w-56 truncate text-foreground">{origin.title}</span>
          </button>
        )}
        {b.interrupted && showInterrupted && (
          <div className="text-xs text-muted-foreground">stopped</div>
        )}
      </div>
      {showStamp && <HoverStamp ts={b.ts} side="left" />}
    </div>
  );
});

export default function Thread(props: ThreadProps) {
  const scope = `${apiUrl("")}\n${props.email}`;
  return (
    <ChatErrorBoundary key={scope}>
      <ThreadView key={scope} {...props} />
    </ChatErrorBoundary>
  );
}

function ThreadView({ email, role = "member", displayName, avatarUrl, onSignOut, onAddWorkspace, onboarded = true, onOnboarded }: ThreadProps) {
  const {
    chats, setChats, chatsRef, chatStatus, setChatStatus, subagentTrees, setSubagentTree,
    resetSubagentTrees, archivedChats, setArchivedChats, projects, setProjects, machines,
    archivedProjects, setArchivedProjects,
  } = useChatData();
  const { route, setRoute, pushRoute } = useThreadRoute();
  const chatId = route.chatId;
  const overlay = route.overlay;
  const thread = useThreadStore(chatId);
  const {
    blocks, setBlocks, threadLoading, setThreadLoading, compacting, setCompacting,
    hasMore, setHasMore, hasMoreRef, loadingEarlier, loadingEarlierRef, oldestSeqRef, earlierAnchor, reducerRef,
    contextRevision, updateContextRevision, onThreadStateApplied,
    childTree, stopping, setStopping, busy, busyRef, markBusy, sendingRef,
    loadStateRef, pane, stick, atBottom, setAtBottom, loadSeq, openChatIdRef,
    scrollRestoreRef, displayedChatId, displayedSynced, displayedSyncedRef,
    childTreeFailed, navigating, loadEarlier, openForChat, cancelPending,
  } = thread;
  // What the screen shows: the old thread while a swap is pending, the cold
  // deep-link target while its skeleton is up, and the route chat otherwise.
  const viewChatId = displayedChatId ?? chatId;
  const displayedChatIdRef = useRef<string | null>(null);
  displayedChatIdRef.current = displayedChatId;
  const composer = useComposer({ email, chatId, onSignOut, openChatIdRef });
  const {
    draftStorage, fileStore, filesReady, mountedRef, storageFailure, persistCommand,
    persistFiles, signOut, prompt, setPrompt, promptRef, outgoingRef, restoredCommandRef,
    refreshOutgoing, setCaret, setMentionDismissed, mentionIndex, setMentionIndex,
    mentionMatches, acceptMention, ta, autoGrow, pending, setPending, pendingRef,
    pendingDraftsRef, fileInput, dragOver, setDragOver, addFiles, restoreForChat,
    gcDraftKeys, deliveringRef, observedUserIdsRef,
  } = composer;
  const [models, setModels] = useState<ModelOption[] | null>(null);
  // The agents the caller can use. Every chat runs with one of them; the
  // composer picks which, and the choice binds the chat.
  const [agentsList, setAgentsList] = useState<Agent[] | null>(null);
  const [pickedAgent, setPickedAgent] = useState<Agent | null>(null);
  const [agentLocked, setAgentLocked] = useState(false);
  const pickedAgentRef = useRef<Agent | null>(null);
  const personalAgent = agentsList?.find((a) => a.is_personal) ?? null;
  const [model, setModel] = useState("");
  const openGenerating =
    !!viewChatId &&
    (chatStatus[viewChatId]?.generating ??
      (chats?.find((c) => c.id === viewChatId)?.generating ?? false));
  // The chat a pre-send pick belongs to: the first send creates the chat and
  // persists the picked mode; the load effect below skips that chat once so
  // the pick survives instead of being refetched back to "default".
  const justCreatedApprovalRef = useRef<string | null>(null);
  // The chat whose route push should carry the optimistic busy across the
  // open effect's busy reset: the created thread renders as working (the
  // seeded send + busy) until the server's generating flag or a submit
  // failure takes over.
  const justCreatedBusyRef = useRef<string | null>(null);
  const { approvalMode, accountDefault, pickApprovalMode } =
    useApprovalMode({ chatId: viewChatId, justCreatedApprovalRef });
  // The composer's project binding. The chip renders only when a project
  // is actually bound or pre-picked (project context) — a plain chat-mode
  // chat shows no project affordance at all. On a new (unsent) chat the
  // pick applies when the send creates the chat; an existing chat displays
  // its project read-only — the binding cannot change after it started.
  const [pickedProject, setPickedProject] = useState<PickedProject | null>(null);
  const pickedProjectRef = useRef<PickedProject | null>(pickedProject);
  pickedProjectRef.current = pickedProject;
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const openRow = viewChatId ? chats?.find((c) => c.id === viewChatId) : undefined;
  // The visible chat's subtree, from the per-chat map the socket fills. It
  // survives navigation, so returning to a chat renders its tree at once.
  const subagentNodes = viewChatId ? subagentTrees[viewChatId] ?? [] : [];
  const openWorking = workingForChat(
    {
      generating: openGenerating,
      working: !!(chatStatus[viewChatId ?? ""]?.working || openRow?.working),
    },
    viewChatId ? subagentTrees[viewChatId] : undefined,
  );
  const currentProject = pickedProject ?? chatProjectOf(openRow);
  // Ref mirror for effects that must read the pick without re-running on
  // every pick change.
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const outgoingScope = `${apiUrl("")}\n${email}`;
  const {
    pendingSubmitId, steeringMessage, settleOutgoing, deliverOutgoing, send,
    steerChip, withdrawChip, requestStop,
  } = useOutgoing({
    chatId, model, busy, openGenerating, compacting, setCompacting, filesReady,
    promptRef, setPrompt, pendingRef, setPending, autoGrow, outgoingRef, pendingDraftsRef,
    draftStorage, fileStore, storageFailure, persistCommand, persistFiles, mountedRef,
    deliveringRef, restoredCommandRef, refreshOutgoing, outgoingScope, reducerRef,
    setBlocks, markBusy, openChatIdRef, loadSeq, sendingRef, projects,
    openRow, currentProject, pickedProjectRef, pickedAgentRef, approvalMode, stopping,
    setStopping, justCreatedApprovalRef, justCreatedBusyRef, pushRoute,
  });
  const recoverMissingChatRef = useRef<() => void>(() => {});
  const { socketRef, machineTakenOver } = useMemberSocket({
    signOut, chatsRef, setChats, setChatStatus, setArchivedChats, setProjects,
    setArchivedProjects, reducerRef, setBlocks,
    markBusy, busyRef, sendingRef, openChatIdRef, displayedChatIdRef, displayedSyncedRef,
    onThreadStateApplied, updateContextRevision, hasMoreRef,
    oldestSeqRef, setHasMore, setThreadLoading, setCompacting, setSubagentTree,
    resetSubagentTrees, cancelPending,
    outgoingRef, observedUserIdsRef, settleOutgoing, recoverMissingChatRef,
  });
  // The composer floats over the chat content; the scroll pane needs its
  // live height as bottom padding — a fixed guess breaks as soon as the
  // composer stack grows (queued chips, attachments, a taller textarea).
  // The element arrives via callback ref: the Skills/Settings routes swap
  // the whole chat column out, so the composer remounts and an
  // observe-once effect would keep watching the detached node while the
  // padding froze at a stale height (the reported clipped-last-line bug).
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  const [composerH, setComposerH] = useState(128);
  // The content column is observed together with the pane: any change in
  // either height re-pins the bottom while the reader is at the bottom.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const anchorGuard = useRef(false);
  useEffect(() => {
    if (!composerEl) return;
    const ro = new ResizeObserver(() => setComposerH(composerEl.offsetHeight));
    ro.observe(composerEl);
    setComposerH(composerEl.offsetHeight);
    return () => ro.disconnect();
  }, [composerEl]);
  // Central column width (drag handle on its right edge).
  const [chatWidth, setChatWidth] = useState<number>(() => storedChatWidth());
  const [chatResizing, setChatResizing] = useState(false);
  useEffect(() => {
    const resync = () => setChatWidth(storedChatWidth());
    window.addEventListener("guild:chat-width-changed", resync);
    return () => window.removeEventListener("guild:chat-width-changed", resync);
  }, []);
  // The agents the caller can use. Every chat runs with one of them; the
  // composer picks which, and the choice binds the chat.
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
    void listAgents()
      .then((rows) => {
        setAgentsList(rows);
        setPickedAgent((cur) => cur ?? rows.find((a) => a.is_personal) ?? rows[0] ?? null);
      })
      .catch(() => setAgentsList([]));
  }, []);

  useEffect(() => {
    pickedAgentRef.current = pickedAgent;
  }, [pickedAgent]);

  // A bound chat shows its own agent; a new chat keeps the pick. A thread
  // that belongs to its agent is not switchable.
  useEffect(() => {
    if (viewChatId === null) {
      setAgentLocked(false);
      return;
    }
    let live = true;
    void chatAgentBinding(viewChatId)
      .then(({ agent, switcheable }) => {
        if (!live) return;
        setAgentLocked(!switcheable);
        if (agent === null) return;
        const bound = agent as Agent;
        setPickedAgent(bound);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [viewChatId]);


  useEffect(() => {
    listModels().then((m) => {
      if (m === null) {
        toast.error("Could not load models");
        return;
      }
      setModels(m);
      if (m.length > 0) setModel((cur) => cur || m[0].id);
    });
  }, []);


  // The folded Observability deep link is served as Activity; make the URL
  // say so (replaceState: the redirect is not a step back).
  useEffect(() => {
    if (route.agents === null) return;
    if (!window.location.pathname.startsWith("/settings/observability")) return;
    window.history.replaceState(null, "", `/activity${window.location.search}`);
  }, [route.agents]);

  // Activity is an admin surface. A member who lands on one of its
  // addresses (deep link, old history entry) is moved to the agents
  // directory without adding a history step.
  useEffect(() => {
    if (role === "admin") return;
    const a = route.agents;
    if (a === null) return;
    const next: AgentsRoute | null =
      a.view === "activity" || a.view === "run" || a.view === "trace" || a.view === "chat"
        ? AGENTS_DIRECTORY
        : a.view === "agent" && a.tab === "activity"
          ? { view: "agent", agentId: a.agentId, tab: "overview" }
          : null;
    if (next === null) return;
    const path = agentsRoutePath(next);
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
    setRoute((current) => ({ ...current, agents: next }));
  }, [role, route.agents]);

  // A bare /settings arrival (deep link, old bookmark, back/forward)
  // normalizes to the default section — the Settings tab always has a
  // sectioned address. replaceState: the normalization is not a step back.
  useEffect(() => {
    if (route.tab !== "settings" || route.settingsSection !== null) return;
    if (route.overlay !== null || route.skills !== null || route.agents !== null) return;
    const path = chatRoutePath(null, null, null, null, "settings", "account", null);
    window.history.replaceState(null, "", path);
    setRoute((r) => ({ ...r, settingsSection: "account", settingsDetail: null }));
  }, [route.tab, route.settingsSection, route.overlay, route.skills, route.agents]);

  // First-run onboarding auto-show: a user the server flags as not yet
  // onboarded is pushed to /onboard, so the wizard owns the URL like any
  // other surface (reload lands back in it). replaceState is wrong here —
  // finishing the wizard navigates forward, and back from /onboard returns
  // to the pre-login view.
  useEffect(() => {
    if (onboarded || route.overlay?.kind === "onboard") return;
    pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: { kind: "onboard" } });
  }, [onboarded, route.overlay, pushRoute]);



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

  // Draft GC: per-chat draft keys would otherwise accumulate forever and
  // outlive their chats. Drop the keys whose chat left the sidebar lists
  // (archived or deleted); the scratch draft ("new") and the open chat's
  // key always stay, and unloaded lists prune nothing. A live activity
  // stamp rebuilds the chat array without changing the id set, so the
  // expensive localStorage walk runs only when membership changes.
  const draftGcSignature = useRef<string | null>(null);
  useEffect(() => {
    if (chats === null) return;
    const signature =
      chats.map((c) => c.id).sort().join(",") +
      "|" +
      (archivedChats ?? []).map((c) => c.id).sort().join(",");
    if (draftGcSignature.current === signature) return;
    draftGcSignature.current = signature;
    gcDraftKeys(chats, archivedChats);
    // Unresolved sends own their draft keys; the helper reads the live map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, archivedChats]);

  const {
    renameChat, archiveChat, unarchiveChat, deleteChat, renameProject, archiveProject, unarchiveProject,
  } = useChatActions();
  const renameChatRow = useCallback((id: string, title: string) => { void renameChat(id, title); }, [renameChat]);
  const archiveChatRow = useCallback((id: string) => { void archiveChat(id); }, [archiveChat]);
  const unarchiveChatRow = useCallback((id: string) => { void unarchiveChat(id); }, [unarchiveChat]);
  const deleteChatRow = useCallback((id: string) => {
    void deleteChat(id);
    if (viewChatId === id) {
      pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: null });
    }
  }, [deleteChat, pushRoute, viewChatId]);
  const openCreateProject = useCallback(() => setCreateProjectOpen(true), []);
  const renameProjectRow = useCallback((id: string, name: string) => { void renameProject(id, name); }, [renameProject]);
  const archiveProjectRow = useCallback((id: string) => { void archiveProject(id); }, [archiveProject]);
  const unarchiveProjectRow = useCallback((id: string) => { void unarchiveProject(id); }, [unarchiveProject]);

  // Chat switches keep cached content visible until the socket's History
  // frame overwrites it, then request a fresh sync for the new chat. The
  // composer's project pick is not touched here — it is route state, owned
  // by the pick effect below (an open thread is never pre-picked).
  useEffect(() => {
    const skipBusyReset = chatId !== null && justCreatedBusyRef.current === chatId;
    openForChat(chatId, skipBusyReset);
    socketRef.current?.resync();
    // One load per chat id; the helpers are recreated per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // The composer belongs to the displayed chat, not the route target: a
  // pending swap keeps the old transcript and its draft until the one
  // committed swap. On first mount a non-null route with no display yet is
  // still pending, so its draft waits for the swap.
  const restoredDraftChatRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (restoredDraftChatRef.current === displayedChatId) return;
    if (restoredDraftChatRef.current === undefined && chatId !== null && displayedChatId === null) return;
    restoredDraftChatRef.current = displayedChatId;
    restoreForChat(displayedChatId);
  }, [displayedChatId, chatId]);

  // A just-created chat keeps its editable composer until its sidebar row
  // lands; the marker then clears so a later visit is not treated as new.
  useEffect(() => {
    const cid = justCreatedBusyRef.current;
    if (cid !== null && chats?.some((c) => c.id === cid)) justCreatedBusyRef.current = null;
  }, [chats]);

  const openChat = useCallback((id: string) => {
    // Navigation only: the chatId effect performs the actual load, so back/
    // forward, deep links and sidebar picks all share one code path. The
    // chat's project rides along so the sidebar's project filter stays in
    // step with the URL.
    const row = chatsRef.current?.find((c) => c.id === id);
    setOpen(false);
    pushRoute({ chatId: id, projectId: row?.project_id ?? null, overlay: null });
  }, [chatsRef, pushRoute]);

  // A stable opener for the pinned child list: the chevron must not rebuild
  // the rows on every composer key.
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  const openChildChat = useCallback((id: string) => openChatRef.current(id), []);

  const newChat = useCallback(() => {
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
  }, [pushRoute, route.tab, ta]);

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
  recoverMissingChatRef.current = recoverMissingChat;
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  // Global hotkeys (desktop client + browser): Cmd/Ctrl+B toggles the
  // sidebar; Cmd/Ctrl+N opens a new thread on the desktop client, while
  // browsers hear only Ctrl+Alt+N — Chrome and friends reserve plain
  // Ctrl+N at the browser level and never deliver it to the page.
  useEffect(() => {
    if (isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (e.code === "KeyB" && !e.altKey) {
        e.preventDefault();
        setCollapsed((c) => !c);
      } else if (e.code === "KeyN" && (IS_TAURI ? true : e.altKey)) {
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
  const newChatInProject = useCallback((project: PickedProject) => {
    pushRoute({ chatId: null, projectId: project.id, overlay: null, skills: null, newChat: true });
    setOpen(false);
    ta.current?.focus();
  }, [pushRoute, ta]);





  // Cancellation flags resolve into server truth: every push that moves a
  // chat's generating state gets a chance to lift its stopping flag.
  useEffect(() => {
    setStopping((prev) => pruneStopping(prev, chatStatus, chats) ?? prev);
  }, [chats, chatStatus]);

  const activeChat = chats?.find((c) => c.id === viewChatId);
  // An archived thread is in the archived list, not the active one; its row
  // still supplies the title.
  const listedChat = activeChat ?? archivedChats?.find((c) => c.id === viewChatId);
  // A child chat is an execution transcript, not a sidebar chat: the lists
  // omit it, so it reads as read-only and never falls back to "New chat".
  // The tree node is checked first because it survives a state sync: a
  // sync's begin/done bracket must never flash a composer into a child
  // thread. An unknown thread hides the composer instead of showing an
  // editable one that would flip a moment later.
  const justCreatedChat = viewChatId !== null && justCreatedBusyRef.current === viewChatId;
  const facts = threadFacts({ chatId: viewChatId, chats, archivedChats, childTree });
  const access = threadAccess({
    chatId: viewChatId,
    chats,
    facts,
    treeFailed: childTreeFailed,
    synced: displayedSynced,
    justCreated: justCreatedChat,
  });
  const readOnlyThread = access === "readonly";
  const composerUnknown = access === "unknown";
  // A non-user thread's own title comes from its tree node: its chat row is
  // never in the sidebar, so the list has no title to show.
  const activeTitle = facts.type === "user"
    ? listedChat?.title ?? childTree?.title ?? (viewChatId === null ? "New chat" : "")
    : childTree?.title ?? (facts.type === "routine" ? "Routine run" : "Subagent thread");
  const chatArchived = facts.archived;
  const chatDeleted = facts.deleted;
  // The header menu's rename: a popup dialog around the sidebar's rename
  // transport. Enter or Save commits, Esc/cancel discards.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const commitRename = useCallback(async () => {
    const v = renameValue.trim();
    setRenameOpen(false);
    const current = activeChat?.title;
    if (!v || v === current) return;
    if (!viewChatId) return;
    await renameChat(viewChatId, v);
  }, [viewChatId, renameValue, activeChat, renameChat]);
  // The header menu's archive: the open chat navigates back to the chats
  // list after archiving (an archived thread is a dead end for sending).
  const headerArchive = useCallback(async () => {
    if (!viewChatId) return;
    if (chatArchived) {
      await unarchiveChat(viewChatId);
      return;
    }
    await archiveChat(viewChatId);
    pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: null });
  }, [viewChatId, chatArchived, archiveChat, unarchiveChat, pushRoute]);
  // Deletion is not archiving: the thread leaves every list, so the view
  // navigates away. A confirmation gates the click.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const headerDelete = useCallback(async () => {
    setDeleteOpen(false);
    if (!viewChatId) return;
    await deleteChat(viewChatId);
    pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: null });
  }, [viewChatId, deleteChat, pushRoute]);
  // View entries: each contiguous thinking/tool run becomes one
  // WorkedForBlock; everything else (user, text, errors, compaction cards,
  // queued-send chips, approvals) stays 1:1.
  const { entries: displayEntries, finalAgent, lastAgent } = useMemo(() => {
    const entries = viewEntries(blocks);
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
  }, [blocks]);
  const offlineMachineBanner = offlineMachine(
    chats,
    machines,
    viewChatId,
    IS_TAURI,
    IS_TAURI ? machineId() : undefined,
  );
  const streaming = busy || openGenerating;

  // Restore the visible chat's saved reading position once per swap. A chat
  // that was at the bottom (or was never opened) pins to the bottom; one
  // that was scrolled up returns to the same offset.
  useLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    if (!restore) return;
    const el = pane.current;
    if (!el) return;
    scrollRestoreRef.current = null;
    if (restore.atBottom) {
      stick.current = true;
      setAtBottom(true);
      el.scrollTop = el.scrollHeight;
    } else {
      stick.current = false;
      setAtBottom(false);
      el.scrollTop = restore.top;
    }
  }, [displayedChatId, blocks, scrollRestoreRef]);

  // Scroll anchor for the older-page prepend: keep the reader on the same
  // content after blocks are inserted above the viewport. The guard keeps
  // the observer's bottom pin from running over this restore in the same
  // frame.
  useLayoutEffect(() => {
    const anchor = earlierAnchor.current;
    const el = pane.current;
    if (!anchor || !el) return;
    earlierAnchor.current = null;
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    anchorGuard.current = true;
    requestAnimationFrame(() => { anchorGuard.current = false; });
  }, [blocks]);

  // State-only height changes (the subagent tree, compaction line, working
  // indicator, banners, hasMore, streaming) have no block change to trigger
  // the observer. Re-pin them explicitly; the observer covers the rest.
  useLayoutEffect(() => {
    if (!stick.current || anchorGuard.current) return;
    const el = pane.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [subagentNodes, compacting, streaming, hasMore, offlineMachineBanner?.label, composerH, displayedChatId]);

  // Geometry pin: observe the content column and the pane. The observer
  // catches late blocks, removed tail blocks, window/sidebar/column resizes
  // and the mobile keyboard's visual-viewport shrink. One rAF coalesces a
  // burst of resize callbacks into one scroll write.
  useEffect(() => {
    const paneEl = pane.current;
    if (!paneEl || !contentEl) return;
    let raf = 0;
    const pin = () => {
      if (!stick.current || anchorGuard.current) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!stick.current || anchorGuard.current) return;
        paneEl.scrollTop = paneEl.scrollHeight;
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    observer.observe(paneEl);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [contentEl, displayedChatId, blocks.length === 0]);
  // The transcript is the expensive subtree: every keystroke in the
  // composer re-renders the whole view, and a long thread holds thousands
  // of markdown blocks. Memoizing the element list keeps those elements
  // identical across prompt edits, so React bails out of the transcript
  // and typing costs only the composer.
  const lastBlockIndex = blocks.length - 1;
  // A delivered message names the run thread it came from; the link sits
  // under that message so a reader can open the work behind it.
  const originLink = childTree?.origin ?? null;
  const firstTextIndex = displayEntries.findIndex((e) => e.kind === "plain" && e.b.kind === "text");
  const transcriptEntries = useMemo(
    () =>
      displayEntries.map((e, i) => {
        const entry = (
          e.kind === "plain" && e.b.kind === "user" && e.b.queued ? null :
          e.kind === "work" ? (
            <WorkedForBlock
              key={`work-${e.run[0]!.key}`}
              run={e.run}
              active={streaming && i === displayEntries.length - 1}
              stopping={!!(viewChatId && stopping[viewChatId])}
              turnStart={e.turnStart}
            >
              {e.run.map((b) =>
                b.kind === "reasoning" ? (
                  <ReasoningFrame
                    key={b.key}
                    text={b.reasoningText ?? ""}
                    live={streaming && b.key === blocks[lastBlockIndex]?.key}
                  />
                ) : b.kind === "tool" && b.tool ? (
                  <ToolFrame key={b.key} t={b.tool} />
                ) : b.kind === "child_spawn" && b.childSpawn ? (
                  <SubagentSpawnRecord key={b.key} block={b.childSpawn} onOpen={openChildChat} />
                ) : b.kind === "child_result" && b.childResult ? (
                  <SubagentResultRecord key={b.key} block={b.childResult} onOpen={openChildChat} />
                ) : b.kind === "child_closed" && b.childClosed ? (
                  <SubagentClosedRecord key={b.key} block={b.childClosed} onOpen={openChildChat} />
                ) : null,
              )}
            </WorkedForBlock>
          ) : e.b.kind === "user" ? (
            <div key={e.b.key} className="group relative ml-auto w-fit max-w-[80%]">
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
          ) : e.b.kind === "approval" && e.b.approval ? (
            <ApprovalCard key={e.b.key} a={e.b.approval} chatId={viewChatId} />
          ) : e.b.kind === "compaction" && e.b.compaction ? (
            <CompactionCard key={e.b.key} c={e.b.compaction} />
          ) : e.b.kind === "error" ? (
            <div
              key={e.b.key}
              className="w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
            >
              {e.b.text}
            </div>
          ) : (
            <TextBlock
              key={e.b.key}
              b={e.b}
              showStamp={finalAgent.has(e.i) && !(streaming && e.i === lastAgent)}
              showInterrupted={!streaming}
              origin={i === firstTextIndex ? originLink : null}
              onOpenOrigin={openChat}
            />
          )
        );
        return entry;
      }),
    [displayEntries, finalAgent, lastAgent, streaming, viewChatId, stopping, lastBlockIndex, blocks, openChildChat, openChat, originLink, firstTextIndex],
  );
  // The running part of the chat's thread subtree, rendered at the end of
  // the transcript. The nodes arrive on the member socket, never by polling.
  // A first send's create round trip on the scratch surface: the composer
  // freezes with its text until the route moves to the created thread.
  const holdingFirstSend = (() => {
    if (pendingSubmitId === null || chatId !== null) return false;
    const c = outgoingRef.current.get(pendingSubmitId);
    return !!c && c.chatId === null && c.originChatId === null;
  })();

  const enrichChat = useCallback((c: NonNullable<typeof chats>[number]) => {
    const status = chatStatus[c.id];
    return {
      ...c,
      ...(status ?? {}),
      working: workingForChat(
        { generating: status?.generating ?? c.generating, working: !!(status?.working || c.working) },
        subagentTrees[c.id],
      ),
    };
  }, [chatStatus, subagentTrees]);
  const grouping = useMemo(
    () => sidebarGrouping(chats === null ? null : chats.map(enrichChat)),
    [chats, enrichChat],
  );
  const archivedRows = useMemo(
    () => archivedChats?.map(enrichChat) ?? null,
    [archivedChats, enrichChat],
  );
  // Rail badges: unseen chats per panel — folderless chats under Chats, the
  // project-bound ones under Projects.
  const unreadChats = grouping.visible.filter((c) => c.unread).length;
  const unreadProjects = Object.values(grouping.chatsByProject)
    .reduce((sum, rows) => sum + rows.filter((c) => c.unread).length, 0);

  // Sidebar tab: one icon rail (desktop) switches the panel between chats,
  // work, settings and the full-page surfaces. The rail entry is a
  // projection of the route — the route is the truth, so back/forward,
  // reloads and deep links restore the tab like any other route state.
  // The skills and agents pages raise their own rail entry while their URL
  // is live.
  const railTab: RailTab =
    route.skills !== null
      ? "skills"
      : route.agents !== null
        ? agentsRailTab(route.agents)
        : route.tab;
  const paneLayout = tabPaneLayout(route, isMobile);
  // Settings tab: the section rendered inline in the main pane (the rail's
  // Settings tab is a persistent surface, not an overlay launcher). The
  // section and its sub-page live in the route — every pick navigates.
  const settingsSection = route.settingsSection;
  const switchTab = (tab: RailTab) => {
    // The skills and agents tabs are URL routes, not persisted panel state:
    // entering them navigates to their root, leaving returns to the chat
    // root — so back/forward crosses surfaces like any other route pair,
    // and a reload lands back on the page.
    const target = tabPaneLayout(
      {
        ...route,
        tab: tab === "settings" || tab === "work" ? tab : "chats",
        skills: tab === "skills" ? SKILLS_CATALOG : null,
        agents:
          tab === "agents"
            ? AGENTS_DIRECTORY
            : tab === "activity"
              ? AGENTS_ACTIVITY
              : null,
      },
      isMobile,
    );
    if (tab === "skills") {
      pushRoute({ chatId: null, projectId: null, overlay: null, skills: SKILLS_CATALOG });
      return;
    }
    if (tab === "agents") {
      pushRoute({ chatId: null, projectId: null, overlay: null, skills: null, agents: AGENTS_DIRECTORY });
      return;
    }
    if (tab === "activity") {
      pushRoute({ chatId: null, projectId: null, overlay: null, skills: null, agents: AGENTS_ACTIVITY });
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
      agents: null,
      tab,
      newChat: false,
      ...(tab === "settings"
        ? { settingsSection: route.settingsSection ?? "account", settingsDetail: null }
        : {}),
    });
    // A collapsed panel hides the tab's content — a tab pick is an intent
    // to see it, so the panel re-expands on the newly picked tab.
    if (target.expandsPanel) setCollapsed(false);
  };
  // Mobile drawer picks: a panel tab keeps the sheet open on its panel; the
  // route tabs (agents / activity) render in the main column, so the
  // sheet gets out of the way. Picking the already-active panel tab does
  // nothing — it must not clear the open chat.
  const mobileSwitchTab = (tab: RailTab) => {
    if (tab === "agents" || tab === "activity") {
      switchTab(tab);
      setOpen(false);
      return;
    }
    if (tab === railTab) return;
    switchTab(tab);
  };
  const openSettingsSection = (id: string) => {
    // Navigation: the section pick owns its /settings/<section> address, so
    // back/forward walks the sections and a reload restores the pick.
    pushRoute({ tab: "settings", settingsSection: id, settingsDetail: null });
    // The section renders in the main column, behind the drawer.
    if (isMobile) setOpen(false);
  };
  const openSettingsDetail = (detail: string | null) => {
    // Navigation: a sub-page opens on /settings/<section>/<detail>; closing
    // it returns to the bare section address.
    pushRoute({ tab: "settings", settingsDetail: detail });
  };

  const sidebarCollapse = isMobile ? undefined : () => setCollapsed(true);
  // The mobile drawer carries the rail too, so every panel tab renders there;
  // its header X closes the sheet (the built-in corner close is suppressed:
  // it would sit on top of the header's new-thread plus).
  const sidebarClose = isMobile ? () => setOpen(false) : undefined;
  const chatsPanel = (
    <ChatsPanel
      grouping={grouping}
      loadingChats={chats === null}
      chatId={viewChatId}
      archivedChats={archivedRows}
      onNewChat={newChat}
      onOpenChat={openChat}
      onCollapse={sidebarCollapse}
      onClose={sidebarClose}
      onRenameChat={renameChatRow}
      onArchiveChat={archiveChatRow}
      onUnarchiveChat={unarchiveChatRow}
      onDeleteChat={deleteChatRow}
    />
  );
  const sidebar =
    route.tab === "work" ? (
      <WorkPanel
        loadingChats={chats === null}
        grouping={grouping}
        projects={projects}
        archivedProjects={archivedProjects}
        machines={machines}
        chatId={viewChatId}
        onOpenChat={openChat}
        onCollapse={sidebarCollapse}
        onClose={sidebarClose}
        onNewChatInProject={newChatInProject}
        onNewProject={openCreateProject}
        onRenameChat={renameChatRow}
        onArchiveChat={archiveChatRow}
        onRenameProject={renameProjectRow}
        onArchiveProject={archiveProjectRow}
        onUnarchiveProject={unarchiveProjectRow}
      />
    ) : route.tab === "settings" ? (
      <SettingsPanel
        role={role}
        activeSection={settingsSection}
        onSelectSection={openSettingsSection}
        onCollapse={sidebarCollapse}
        onClose={sidebarClose}
      />
    ) : (
      chatsPanel
    );

  // A /project/<id> route (deep link, reload, or back/forward) parses as
  // the Work tab, so the linked project is visible — no state decision
  // needed beyond the route parse.
  // Chat routes: a project-bound chat owns the project route — its URL is
  // /project/<id>/thread/<cid>, so the Work tab survives reload and
  // back/forward. A bare /thread/<id> for a project chat is rewritten once
  // the chat list names its project; a chat not yet listed (just sent)
  // counts as bound while the composer still carries a project pick.
  const routeTabDecidedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!route.chatId || route.projectId !== null) {
      routeTabDecidedRef.current = null;
      return;
    }
    if (routeTabDecidedRef.current === route.chatId) return;
    if (chats === null) return;
    const row = chats.find((c) => c.id === route.chatId);
    const projectId = row?.project_id ?? currentProjectRef.current?.id ?? null;
    routeTabDecidedRef.current = route.chatId;
    if (projectId) pushRoute({ projectId });
  }, [route.chatId, route.projectId, chats, pushRoute]);

  // Mobile: a route page (agents, skills, settings) replaces the whole main
  // column and has no drawer control of its own, so it gets this bar. The
  // chat view already carries the drawer button in its header.
  const mobileNavBar = (title?: string) =>
    isMobile ? (
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <Button variant="ghost" size="icon" className="-ml-1.5 size-8" onClick={() => setOpen(true)}>
          <Menu />
        </Button>
        {title !== undefined && <span className="min-w-0 flex-1 truncate font-medium">{title}</span>}
      </header>
    ) : null;

  // The Settings tab's main pane renders the picked section inline instead
  // of the chat thread — on mobile too, so the drawer's Settings tab leads
  // to a page (the drawer closes on the section pick).
  const inlineSettings =
    route.tab === "settings" && settingsSection !== null ? (
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <SettingsSectionPane
          sectionId={settingsSection}
          email={email}
          detail={route.settingsDetail}
          onDetailChange={openSettingsDetail}
          usage={route.usage}
          onUsageChange={(usage) => pushRoute({ usage })}
        />
      </div>
    ) : null;

  // The skills page's URL state clamped to what this session can render
  // (the machine tab needs the desktop fs bridge — a web deep link falls
  // back to the catalog). Every panel state derives from it; user actions
  // navigate through pushRoute, so the URL is always the truth.
  const skillsRoute =
    !isMobile && route.skills !== null ? clampSkillsRoute(route.skills, IS_TAURI) : null;
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

  // The agents surface is another full main-column page. Its route owns the
  // whole column right of the rail; the chat comes back on any chat route.
  const agentsRoute = route.agents;
  const inlineAgents = agentsRoute !== null ? (
    <div className="flex min-h-0 flex-1 flex-col" data-scrollable>
      <AgentsPanel
        route={agentsRoute}
        viewer={{ email, displayName, role }}
        onNavigate={(next) =>
          pushRoute({ chatId: null, projectId: null, overlay: null, skills: null, agents: next })
        }
        onOpenChat={openChat}
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

  // Chat column drag handles (one per edge): the column is centered, so one
  // pixel of cursor travel moves both edges — the width follows the doubled
  // delta, outward for the handle being dragged. Dragging stops at the pane
  // edge, not at the stored maximum, so a handle never runs away.
  const startChatDrag = useCallback(
    (e: React.MouseEvent, side: "left" | "right") => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chatWidth;
      const paneW = pane.current?.clientWidth ?? window.innerWidth;
      const dir = side === "right" ? 1 : -1;
      setChatResizing(true);
      const move = (ev: MouseEvent) => {
        const w = startW + (ev.clientX - startX) * 2 * dir;
        setChatWidth(clampChatWidth(Math.min(w, paneW)));
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        setChatResizing(false);
        setChatWidth((w) => {
          saveChatWidth(w);
          return w;
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [chatWidth],
  );
  const resetChatWidth = useCallback(() => {
    setChatWidth(CHAT_DEFAULT_W);
    saveChatWidth(CHAT_DEFAULT_W);
  }, []);
  // Keyboard nudge: the key that moves a handle outward grows the column.
  const nudgeChatWidth = useCallback((key: string, side: "left" | "right") => {
    const outward = side === "right" ? key === "ArrowRight" : key === "ArrowLeft";
    setChatWidth((w) => {
      const next = clampChatWidth(w + (outward ? 64 : -64));
      saveChatWidth(next);
      return next;
    });
  }, []);
  const scrollToBottom = useCallback(() => {
    const el = pane.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  // A frame toggle grows the content under the reader. Stop following the
  // bottom, or the pin scrolls the row that was just clicked out from under
  // the pointer one frame after the click.
  const onFrameToggle = useCallback(() => {
    stick.current = false;
    setAtBottom(false);
  }, []);

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
          role={role}
          unreadChats={unreadChats}
          unreadProjects={unreadProjects}
        />
      )}
      {/* desktop sidebar: resizable + collapsible; mobile: drawer */}
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 p-0" hideClose>
            <SheetTitle className="sr-only">Sidebar</SheetTitle>
            <div className="flex min-h-0 flex-1">
              <SidebarRail
                activeTab={railTab}
                onTabChange={mobileSwitchTab}
                onOpenHelp={() =>
                  pushRoute({
                    chatId: null,
                    projectId: null,
                    skills: null,
                    newChat: false,
                    overlay: { kind: "onboard" },
                  })
                }
                email={email}
                displayName={displayName}
                avatarUrl={avatarUrl}
                onOpenDevice={() => pushRoute({ overlay: { kind: "device" } })}
                onSignOut={signOut}
                onAddWorkspace={onAddWorkspace}
                role={role}
                unreadChats={unreadChats}
                unreadProjects={unreadProjects}
                isMobile
              />
              <div className="flex min-w-0 flex-1 flex-col">{sidebar}</div>
            </div>
          </SheetContent>
        </Sheet>
      ) : !paneLayout.aside ? null : (
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
        {inlineAgents ? (
          <>
            {mobileNavBar()}
            {inlineAgents}
          </>
        ) : inlineSkills ? (
          <>
            {mobileNavBar("Skills")}
            {inlineSkills}
          </>
        ) : inlineSettings ? (
          <>
            {mobileNavBar("Settings")}
            {inlineSettings}
          </>
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
              <DesktopTooltip label="Toggle sidebar" hotkey="mod+B">
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-1.5 size-8 text-muted-foreground"
                  onClick={() => setCollapsed(false)}
                  aria-label="Toggle sidebar"
                >
                  <PanelLeftOpen />
                </Button>
              </DesktopTooltip>
            )
          )}
          {facts.type === "subagent" && childTree?.parent ? (
            <ChildThreadHeader tree={childTree} onBack={openChat} />
          ) : (
            <ThreadTitle
              chatId={viewChatId}
              title={activeTitle}
              loading={threadLoading && blocks.length === 0}
            />
          )}
          {viewChatId && openWorking && !openGenerating && (
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
          {viewChatId && facts.type === "user" && !chatDeleted && (
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
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameValue(activeChat?.title ?? "");
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void headerArchive()}>
                  {chatArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                  {chatArchived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(window.location.href).then(() => toast("Thread URL copied"))}>
                  <Link2 className="size-4" />
                  Copy thread URL
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this thread?</AlertDialogTitle>
                <AlertDialogDescription>
                  The thread leaves your lists and its runs stop. Its transcript is kept.
                  This cannot be undone in the app.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction className="bg-destructive text-white" onClick={() => void headerDelete()}>
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

        {offlineMachineBanner && (
          <div role="status" className="border-b border-amber-700/60 bg-amber-900/30 px-4 py-2 text-amber-300">
            {offlineMachineBanner.label} is offline — tools won't run until it reconnects.
          </div>
        )}

        {blocks.length === 0 ? (
          threadLoading ? (
            <ThreadSkeleton width={chatWidth} />
          ) : !viewChatId ? (
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
          <div className="relative flex min-h-0 flex-1 flex-col">
          {navigating && <ThreadProgress />}
          <FrameToggleContext.Provider value={onFrameToggle}>
          <div
            ref={pane}
            data-scrollable
            className="min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable]"
            onScroll={() => {
              const el = pane.current;
              if (!el) return;
              // near-bottom counts as bottom (sub-pixel/rounding slack)
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
              stick.current = near;
              setAtBottom(near);
              // Scroll-to-top loads the page before the loaded window.
              if (el.scrollTop < 120 && hasMoreRef.current && !loadingEarlierRef.current) {
                void loadEarlier();
              }
            }}
          >
            <div
              ref={setContentEl}
              className={`mx-auto w-full space-y-5 px-4 pt-6 text-[var(--chat-foreground)] [&_strong]:text-foreground [&_b]:text-foreground ${
                chatResizing ? "" : "transition-[max-width] duration-150"
              }`}
              style={{ paddingBottom: composerH + 48, maxWidth: chatWidth }}
            >
              {hasMore && (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={loadingEarlier}
                    onClick={() => void loadEarlier()}
                  >
                    {loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
                  </Button>
                </div>
              )}
              {transcriptEntries}
              <RunningSubagents nodes={subagentNodes} onOpen={openChildChat} />
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
              {/* Working shimmer: the turn is generating but the displayed
                  tail is not already animating — the last text block streams,
                  an active work run pulses its label, a live reasoning frame
                  sits inside that run. */}
              {streaming &&
                !(
                  blocks.length > 0 &&
                  (blocks[blocks.length - 1].kind === "text" ||
                    blocks[blocks.length - 1].kind === "reasoning")
                ) &&
                displayEntries[displayEntries.length - 1]?.kind !== "work" && (
                  <div className="max-w-none py-1">
                    <WorkingIndicator
                      label={viewChatId && stopping[viewChatId] ? "Stopping" : "Working"}
                    />
                  </div>
                )}
            </div>
          </div>
          </FrameToggleContext.Provider>
            {/* Column resize handles: one on each edge, so either side can
                be dragged. Each sits at 50% ± half the width, capped at the
                pane edge when the column fills it. */}
            {!isMobile &&
              (["left", "right"] as const).map((side) => (
                <div
                  key={side}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize conversation column (${side} edge)`}
                  aria-valuenow={chatWidth}
                  tabIndex={0}
                  title="Drag to resize · double-click to reset"
                  className="group absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-col-resize focus:outline-none"
                  style={{
                    left:
                      side === "right"
                        ? `min(calc(50% + ${chatWidth / 2}px), calc(100% - 4px))`
                        : `max(calc(50% - ${chatWidth / 2}px), 4px)`,
                  }}
                  onMouseDown={(e) => startChatDrag(e, side)}
                  onDoubleClick={resetChatWidth}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    nudgeChatWidth(e.key, side);
                  }}
                >
                  <div
                    className={`mx-auto h-full w-px transition-colors ${
                      chatResizing ? "bg-ring" : "bg-transparent group-hover:bg-ring group-focus-visible:bg-ring"
                    }`}
                  />
                </div>
              ))}
            {/* Floating jump-to-bottom: only while the user reads above the
                tail, above the composer so it never covers it. */}
            {!atBottom && (
              <div
                className="pointer-events-none absolute inset-x-0 z-20 px-3 sm:px-4"
                style={{ bottom: composerH - 12 }}
              >
                <div
                  className="mx-auto flex w-full justify-end"
                  style={{ maxWidth: chatWidth }}
                >
                  <button
                    type="button"
                    onClick={scrollToBottom}
                    aria-label="Scroll to the bottom"
                    title="Scroll to the bottom"
                    className="pointer-events-auto flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <ArrowDown className="size-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* composer: floats over the chat content; the scroll pane runs
            full-height behind it and offsets it by its measured height */}
        <div
          ref={setComposerEl}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:px-4"
        >
          {readOnlyThread ? (
            <div
              className="pointer-events-auto mx-auto flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-lg"
              style={{ maxWidth: chatWidth }}
            >
              <span className="min-w-0 flex-1">
                {facts.deleted
                  ? "Deleted. This thread is out of your lists and its runs have stopped."
                  : facts.type === "routine"
                    ? "Routine run. Read-only — the agent wrote this transcript on a schedule."
                    : facts.type === "subagent"
                      ? "Subagent thread. Read-only — the parent agent drives this conversation."
                      : "Archived. Unarchive this thread to send a message."}
              </span>
              {facts.type === "user" && facts.archived && !facts.deleted && (
                <Button variant="secondary" size="sm" onClick={() => void headerArchive()}>
                  Unarchive
                </Button>
              )}
            </div>
          ) : composerUnknown ? (
            <div
              aria-label="Loading thread composer"
              className="pointer-events-auto mx-auto w-full rounded-2xl border border-border bg-card p-2 shadow-lg backdrop-blur-sm"
              style={{ maxWidth: chatWidth }}
            >
              <div className="px-2 py-1.5">
                <Skeleton className="h-5 w-2/5" />
              </div>
              <div className="flex items-center justify-between px-1 pt-1">
                <Skeleton className="h-7 w-24 rounded-full" />
                <Skeleton className="size-7 rounded-full" />
              </div>
            </div>
          ) : (
          <div
            className={`pointer-events-auto mx-auto w-full rounded-2xl border border-border bg-card p-2 shadow-lg backdrop-blur-sm ${
              chatResizing ? "" : "transition-[max-width] duration-150"
            }`}
            style={{ maxWidth: chatWidth }}
          >
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
                      {b.queuedMode !== "steer" && b.eventId && (
                        <button
                          type="button"
                          disabled={steeringMessage === b.eventId}
                          className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          onClick={() => void steerChip(b)}
                          title="Send as guidance during the current response"
                        >
                          {steeringMessage === b.eventId ? "Steering…" : "Steer now"}
                        </button>
                      )}
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
            {[...outgoingRef.current.values()].filter(c => c.error && (c.chatId ?? c.originChatId) === viewChatId).map(command => (
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
                fileStore.touchDraft(viewChatId);
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
                if (navigating) return;
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
                  // An IME commits a candidate with Enter; that keystroke is
                  // the commit, not a submit.
                  if (isImeEnter(e)) return;
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
              readOnly={holdingFirstSend || navigating}
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
                  disabled={busy || navigating}
                  title="Attach images, audio, or files"
                >
                  <Plus className="size-4" />
                </Button>
                {(() => {
                  const row = viewChatId ? chats?.find((c) => c.id === viewChatId) : undefined;
                  // One read-only chip for project + machine. The composer
                  // never binds projects: a chat is projectless unless it was
                  // started from a project (the sidebar project row's "+",
                  // which pre-picks the binding). The executing machine is
                  // project-derived: an existing chat inherits its bound
                  // project's machine, a new chat the picked project's. The
                  // dot renders only for a remote machine (on desktop the
                  // local machine executes its own tools) whose live socket
                  // state is known in the machines store (hidden while
                  // unknown).
                  const chipMachineId =
                    row?.machine_id && row.project_id
                      ? row.machine_id
                      : projects?.find((p) => p.id === currentProject?.id)?.machine_id;
                  const remoteMachine =
                    !!chipMachineId && (!IS_TAURI || chipMachineId !== machineId());
                  // The chat row may be absent right after a create (route
                  // pushed before the refetched list lands) — the chip then
                  // renders without a live socket state instead of crashing.
                  const machineOnline: boolean | undefined = remoteMachine
                    ? machines?.find((m) => m.machine_id === chipMachineId)?.connected
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
                        {approvalMode === "default" ? accountDefault : APPROVAL_MODES[approvalMode].label}
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
                <ContextRing chatId={viewChatId} model={model}
                  revision={contextRevision?.chatId === viewChatId ? contextRevision.seq : null} />
                {(() => {
                  const chipAgent = pickedAgent;
                  return agentLocked ? (
                  // An agent thread, or a chat whose thread belongs to a
                  // shared agent, names its agent and keeps it.
                  <span
                    className="flex min-w-0 items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground"
                    title={
                      chipAgent?.visibility === "private"
                        ? "Your private agent"
                        : "Shared agent: your threads are private, its files are shared"
                    }
                  >
                    <span className="truncate">{chipAgent?.name ?? "Assistant"}</span>
                    {chipAgent !== null && chipAgent !== undefined && chipAgent.visibility !== "private" && (
                      <Users className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                    )}
                  </span>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground"
                        title="Choose the agent for this chat"
                      >
                        <span className="truncate">{pickedAgent?.name ?? personalAgent?.name ?? "Assistant"}</span>
                        {pickedAgent !== null && pickedAgent.visibility !== "private" && (
                          <Users className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                        )}
                        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>Agent</DropdownMenuLabel>
                      {(agentsList ?? []).map((agent) => (
                        <DropdownMenuItem
                          key={agent.id}
                          onSelect={() => {
                            setPickedAgent(agent);
                            pickedAgentRef.current = agent;
                            if (viewChatId !== null) {
                              void bindChatAgent(viewChatId, agent.id).then((ok) => {
                                if (!ok) toast.error("Could not switch the agent for this chat");
                              });
                            }
                          }}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{agent.name}</span>
                              {agent.visibility !== "private" && (
                                <Users className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                              )}
                            </span>
                            {agent.description ? (
                              <span className="line-clamp-1 text-3xs text-muted-foreground">
                                {agent.description}
                              </span>
                            ) : null}
                          </span>
                          {agent.id === pickedAgent?.id && <Check className="size-3.5" />}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          pushRoute({
                            chatId: null,
                            projectId: null,
                            overlay: null,
                            skills: null,
                            agents: AGENTS_DIRECTORY,
                          })
                        }
                      >
                        Manage agents
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  );
                })()}
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
                    stopping: !!viewChatId && !!stopping[viewChatId],
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
                        navigating ||
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
          )}
        </div>
          </>
        )}
      </div>

      <ThreadOverlays
        deviceOpen={overlay?.kind === "device"}
        onboardOpen={route.overlay?.kind === "onboard"}
        createProjectOpen={createProjectOpen}
        onCloseCreateProject={setCreateProjectOpen}
        onboarded={onboarded}
        onOnboarded={onOnboarded}
        machines={machines}
        projects={projects}
        pushRoute={pushRoute}
      />
    </div>
  );
}
