// The thread view: transcript, composer and sidebar for one chat. State
// lives in the hooks under thread/hooks/ and the chat stores, pure
// derivations in the sibling modules, the parts in their own components, and
// this file assembles the component tree.
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@guild/ui/components/button";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";

import { readDraft, writeDraft } from "../../lib/drafts";
import { HAS_ENGINE, HAS_SHELL } from "../../lib/session";
import { apiUrl } from "../../lib/session";
import { useModelOptions } from "../agents/agent-model";
import { runningWebBundle, useWorkspaceIdentity, webBundleOutdated } from "../../lib/workspace-store";
import { machineId } from "../../lib/machine-rpc";
import { chatProjectOf, type PickedProject } from "../projects/projects";
import { SKILLS_CATALOG } from "../skills/skills-route";
import { AGENTS_ACTIVITY, AGENTS_DIRECTORY, agentsRailTab } from "../agents/agents-route";
import { SidebarRail, type RailTab } from "../sidebar-rail";
import { HAS_TITLE_BAR, TITLE_BAR_INSET, TOP_ROW, titleBarDrag, titleBarDragDeep } from "../../lib/titlebar";
import { ThreadOverlays } from "./ThreadOverlays";
import {
  agentDeleting,
  busyFrom,
  offlineMachine,
  pruneStopping,
  tabPaneLayout,
  threadAccess,
  threadFacts,
  workingForChat,
} from "./status";
import { CHAT_ROOT, SURFACE_BASE } from "./route";
import { chatsStore, resetChatStores, useSidebarRows } from "./chat-stores";
import { ThreadPane } from "./thread-pane";
import { GenuiHostContext, type GenuiHost } from "../genui/actions";
import { ThreadHeader } from "./thread-header";
import { ThreadComposer } from "./thread-composer";
import { NotificationsOffer } from "./notifications-offer";
import { SidebarSurface } from "./surfaces/sidebar-surface";
import { RoutePage } from "./surfaces/route-page";
import { SettingsPage } from "./surfaces/settings-page";
import { SkillsPage } from "./surfaces/skills-page";
import { AgentsPage } from "./surfaces/agents-page";
import { IntegrationsSurface } from "./surfaces/integrations-page";
import { INTEGRATIONS_HOME } from "../integrations/integrations-route";
import { AppsSurface } from "./surfaces/apps-page";
import { APPS_HOME } from "../apps/apps-route";
import { useThreadRoute } from "./hooks/use-thread-route";
import { useChatData } from "./hooks/use-chat-data";
import { useThreadStore } from "./hooks/use-thread-store";
import { useComposer } from "./hooks/use-composer";
import { useOutgoing } from "./hooks/use-outgoing";
import { useMemberSocket } from "./hooks/use-member-socket";
import { useApprovalMode } from "./hooks/use-approval-mode";
import { useAgentPick } from "./hooks/use-agent-pick";
import { useChatActions } from "./hooks/use-chat-actions";
import { useChatColumnWidth } from "./hooks/use-column-resize";
import { Sidebar, useSidebar } from "../sidebar/sidebar";
import { useMobileGestures } from "./hooks/use-mobile-gestures";
import { useScrollPin } from "./hooks/use-scroll-pin";
import { useMemberProfile } from "../../lib/profile-store";
import { PreviewPane, type PreviewTab } from "./preview/PreviewPane";
import { PreviewProvider, type OpenPreview } from "./preview/PreviewContext";
import type { PreviewRef } from "./route";

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
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Chat view crashed:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <p className="font-medium">The chat view crashed.</p>
        <p className="max-w-md text-sm text-muted-foreground">{String(this.state.error.message || this.state.error)}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}

export default function Thread(props: ThreadProps) {
  const scope = `${apiUrl("")}\n${props.email}`;
  return (
    <ChatErrorBoundary key={scope}>
      <ThreadView key={scope} {...props} />
    </ChatErrorBoundary>
  );
}

function ThreadView(props: ThreadProps) {
  const { email, onSignOut, onAddWorkspace, onOnboarded } = props;
  // The pushed profile is the live source; the props seed it from the login
  // or me response until the first push lands. Onboarding only moves to
  // done, so either source saying done is done.
  const pushed = useMemberProfile();
  const role = pushed?.role ?? props.role ?? "member";
  const displayName = pushed !== null ? pushed.display_name : props.displayName;
  const avatarUrl = pushed !== null ? pushed.avatar_url : props.avatarUrl;
  const onboarded = (props.onboarded ?? true) || pushed?.onboarded === true;
  // The chat stores outlive a view; a new workspace scope (a remount) starts
  // from an empty sidebar.
  useEffect(() => resetChatStores, []);
  const { chats, chatStatus, subagentTrees, archivedChats, projects, machines } = useChatData();
  const { route, pushRoute } = useThreadRoute({ role });
  // The preview pane: the open files (per session), the one the address
  // names, and whether it fills the window. The address is the source of
  // truth for what is on screen; the tab list is the reader's session.
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const previewRef = route.preview ?? null;
  const openPreview = useCallback<OpenPreview>(
    (ref, meta) => {
      setPreviewTabs((tabs) => {
        const rest = tabs.filter((t) => !(t.ref.kind === ref.kind && t.ref.id === ref.id));
        return [...rest, meta === undefined ? { ref } : { ref, meta }];
      });
      pushRoute({ preview: ref, previewFull: false });
    },
    [pushRoute],
  );
  const selectPreview = useCallback((ref: PreviewRef) => pushRoute({ preview: ref }), [pushRoute]);
  const closePreviewTab = useCallback(
    (ref: PreviewRef) => {
      const rest = previewTabs.filter((t) => !(t.ref.kind === ref.kind && t.ref.id === ref.id));
      setPreviewTabs(rest);
      const wasActive = previewRef !== null && previewRef.kind === ref.kind && previewRef.id === ref.id;
      if (wasActive) pushRoute({ preview: rest.length === 0 ? null : rest[rest.length - 1]!.ref, previewFull: false });
    },
    [previewTabs, previewRef, pushRoute],
  );
  const closePreview = useCallback(() => {
    setPreviewTabs([]);
    pushRoute({ preview: null, previewFull: false });
  }, [pushRoute]);
  const togglePreviewFull = useCallback(
    () => pushRoute({ preview: previewRef, previewFull: !(route.previewFull === true) }),
    [pushRoute, previewRef, route.previewFull],
  );
  const chatId = route.chatId;
  const overlay = route.overlay;
  const thread = useThreadStore(chatId);
  const {
    view,
    loadingEarlier,
    earlierAnchor,
    childTree,
    stopping,
    setStopping,
    pendingSend,
    pane,
    stick,
    atBottom,
    setAtBottom,
    openChatIdRef,
    scrollRestoreRef,
    loadEarlier,
    openForChat,
  } = thread;
  const { blocks, loading: threadLoading, displayedChatId, navigating, compacting, hasMore } = view;
  // What the screen shows: the old thread while a swap is pending, the cold
  // deep-link target while its skeleton is up, and the route chat otherwise.
  const viewChatId = displayedChatId ?? chatId;
  const composer = useComposer({ email, chatId, onSignOut, openChatIdRef });
  const {
    signOut,
    outgoingRef,
    pendingDraftsRef,
    ta,
    setDragOver,
    dragOver,
    addFiles,
    restoreForChat,
    gcDraftKeys,
    draftStorage,
  } = composer;
  const models = useModelOptions();
  const agent = useAgentPick(viewChatId, childTree);
  const [model, setModel] = useState("");
  // The open chat's server-side turn flag, from its status entry — the same
  // truth the sidebar spinner shows.
  const openStatus = viewChatId ? chatStatus[viewChatId] : undefined;
  const openGenerating = !!openStatus?.generating;
  // The composer's live turn, derived and never stored: the server's flag for
  // the open chat, plus the one local fact — a send this client made whose
  // own frame has not arrived yet. A reconnect cannot leave it stuck: the
  // resync's frame retires the pending send and `generating` takes over.
  const busy = busyFrom(openGenerating, pendingSend, viewChatId);
  // The chat a pre-send pick belongs to: the first send creates the chat and
  // persists the picked mode; the load effect below skips that chat once so
  // the pick survives instead of being refetched back to "default".
  const justCreatedApprovalRef = useRef<string | null>(null);
  // The chat this client just created: it has no sidebar row yet, so it
  // reads as an unknown thread rather than a read-only one until the row
  // lands.
  const justCreatedChatRef = useRef<string | null>(null);
  const approval = useApprovalMode({ chatId: viewChatId, justCreatedApprovalRef });
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
  const subagentNodes = viewChatId ? (subagentTrees[viewChatId] ?? []) : [];
  const openWorking = workingForChat(openStatus, viewChatId ? subagentTrees[viewChatId] : undefined);
  const currentProject = pickedProject ?? chatProjectOf(openRow);
  // Ref mirror for effects that must read the pick without re-running on
  // every pick change.
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  // This client's own engine: its machine runs its own tools, so it is never
  // a remote machine with presence to show.
  const localMachineId = HAS_ENGINE ? machineId() : undefined;
  const outgoing = useOutgoing({
    composer,
    thread,
    chatId,
    model,
    busy,
    outgoingScope: `${apiUrl("")}\n${email}`,
    target: {
      openRow,
      currentProject,
      pickedProjectRef,
      pickedAgentRef: agent.pickedAgentRef,
      approvalMode: approval.approvalMode,
    },
    justCreatedApprovalRef,
    justCreatedChatRef,
    pushRoute,
  });
  // Generated UI buttons send through the same path as the composer. The
  // host stays one object for the view's life; it reaches the current
  // send through a ref.
  const sendRef = useRef(outgoing.send);
  sendRef.current = outgoing.send;
  const genuiHost = useMemo<GenuiHost>(() => ({ send: (text) => void sendRef.current("normal", text) }), []);
  const recoverMissingChatRef = useRef<() => void>(() => {});
  const { socketRef } = useMemberSocket({
    signOut,
    thread,
    outgoing: { outgoingRef, observedUserIdsRef: composer.observedUserIdsRef, settleOutgoing: outgoing.settleOutgoing },
    recoverMissingChatRef,
  });
  // A thread open that outlives the first wait asks the socket for one more
  // sync (see use-thread-store's state wait).
  thread.resyncRef.current = () => socketRef.current?.resync();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false); // mobile drawer
  // Desktop sidebar: one shared width and collapse flag, persisted, so the
  // chat, project, settings, apps and integrations lists behave alike.
  const sidebarState = useSidebar();
  const column = useChatColumnWidth(pane);
  const shell = useRef<HTMLDivElement>(null);
  const openDrawer = useCallback(() => setOpen(true), []);
  useMobileGestures({ isMobile, shell, onEdgeSwipe: openDrawer });

  // A browser tab reloads into the bundle the server serves, once nothing
  // is in flight: the identity frame names the served bundle on connect and
  // after every deploy. The desktop shell runs its own local bundle.
  const servedBundle = useWorkspaceIdentity()?.web_bundle;
  useEffect(() => {
    if (HAS_SHELL || !webBundleOutdated(servedBundle, runningWebBundle())) return;
    if (busy || threadLoading || outgoingRef.current.size > 0) return;
    if ([...pendingDraftsRef.current.values()].some((files) => files.length > 0)) return;
    window.location.reload();
  });

  // The pick follows the pushed list: it keeps a model that is still
  // offered and falls back to the first one when an admin removes it.
  useEffect(() => {
    if (models === null) return;
    setModel((cur) => (models.some((m) => m.id === cur) ? cur : (models[0]?.id ?? "")));
  }, [models]);

  // First-run onboarding auto-show: a user the server flags as not yet
  // onboarded is pushed to /onboard, so the wizard owns the URL like any
  // other surface (reload lands back in it). A push, not a rewrite —
  // finishing the wizard navigates forward, and back from /onboard returns
  // to the pre-login view.
  useEffect(() => {
    if (onboarded || route.overlay?.kind === "onboard") return;
    pushRoute({ ...CHAT_ROOT, overlay: { kind: "onboard" } });
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
  const gcDraftKeysRef = useRef(gcDraftKeys);
  gcDraftKeysRef.current = gcDraftKeys;
  useEffect(() => {
    if (chats === null) return;
    const signature =
      chats
        .map((c) => c.id)
        .sort()
        .join(",") +
      "|" +
      (archivedChats ?? [])
        .map((c) => c.id)
        .sort()
        .join(",");
    if (draftGcSignature.current === signature) return;
    draftGcSignature.current = signature;
    gcDraftKeysRef.current(chats, archivedChats);
  }, [chats, archivedChats]);

  const { renameChat, archiveChat, unarchiveChat, deleteChat } = useChatActions();

  // Chat switches keep cached content visible until the socket's History
  // frame overwrites it, then request a fresh sync for the new chat. The
  // composer's project pick is not touched here — it is route state, owned
  // by the pick effect above (an open thread is never pre-picked).
  const openForChatRef = useRef(openForChat);
  openForChatRef.current = openForChat;
  useEffect(() => {
    openForChatRef.current(chatId);
    socketRef.current?.resync();
  }, [chatId, socketRef]);

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
    const cid = justCreatedChatRef.current;
    if (cid !== null && chats?.some((c) => c.id === cid)) justCreatedChatRef.current = null;
  }, [chats]);

  const openChat = useCallback(
    (id: string) => {
      // Navigation only: the chatId effect performs the actual load, so back/
      // forward, deep links and sidebar picks all share one code path. The
      // chat's project rides along so the sidebar's project filter stays in
      // step with the URL.
      const row = chatsStore.get()?.find((c) => c.id === id);
      setOpen(false);
      pushRoute({ chatId: id, projectId: row?.project_id ?? null, overlay: null });
    },
    [pushRoute],
  );

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
  recoverMissingChatRef.current = () => {
    const dead = openChatIdRef.current;
    if (dead) {
      const text = readDraft(draftStorage, dead);
      if (text) writeDraft(draftStorage, null, text);
      writeDraft(draftStorage, dead, "");
    }
    newChat();
  };
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
        sidebarState.toggleCollapsed();
      } else if (e.code === "KeyN" && (HAS_SHELL ? true : e.altKey)) {
        e.preventDefault();
        newChatRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, sidebarState.toggleCollapsed]);

  /** Sidebar: new chat inside a project (the project row's hover "+").
   * Navigates to the project's addressed scratch view — the pick effect
   * derives the composer's binding from the route. */
  const newChatInProject = useCallback(
    (project: PickedProject) => {
      pushRoute({ chatId: null, projectId: project.id, overlay: null, skills: null, newChat: true });
      setOpen(false);
      ta.current?.focus();
    },
    [pushRoute, ta],
  );
  const openCreateProject = useCallback(() => setCreateProjectOpen(true), []);
  const leaveDeletedChat = useCallback(() => pushRoute(CHAT_ROOT), [pushRoute]);

  // Cancellation flags resolve into server truth: every push that moves a
  // chat's generating state gets a chance to lift its stopping flag.
  useEffect(() => {
    setStopping((prev) => pruneStopping(prev, chatStatus) ?? prev);
  }, [chatStatus, setStopping]);

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
  const justCreatedChat = viewChatId !== null && justCreatedChatRef.current === viewChatId;
  const facts = threadFacts({ chatId: viewChatId, chats, archivedChats, childTree });
  // The chat's agent as the pushed tree binds it and the pushed list
  // describes it: an agent being deleted leaves its threads read-only.
  const deletingAgent = agentDeleting(viewChatId !== null ? (childTree?.agent_id ?? null) : null, agent.allAgents);
  const access = threadAccess({
    chatId: viewChatId,
    chats,
    facts,
    justCreated: justCreatedChat,
    agentDeleting: deletingAgent !== null,
  });
  // A non-user thread's own title comes from its tree node: its chat row is
  // never in the sidebar, so the list has no title to show.
  const activeTitle =
    facts.type === "user"
      ? (listedChat?.title ?? childTree?.title ?? (viewChatId === null ? "New chat" : ""))
      : (childTree?.title ?? (facts.type === "routine" ? "Routine run" : "Subagent thread"));
  const chatArchived = facts.archived;
  // Another member's chat an admin reads: every write is the owner's.
  const foreignChat = facts.owned === false;
  const renameOpenChat = useCallback(
    async (title: string) => {
      if (!title || title === activeChat?.title || !viewChatId) return;
      await renameChat(viewChatId, title);
    },
    [viewChatId, activeChat, renameChat],
  );
  // The header menu's archive: the open chat navigates back to the chats
  // list after archiving (an archived thread is a dead end for sending).
  const headerArchive = useCallback(async () => {
    if (!viewChatId) return;
    if (chatArchived) {
      await unarchiveChat(viewChatId);
      return;
    }
    await archiveChat(viewChatId);
    pushRoute(CHAT_ROOT);
  }, [viewChatId, chatArchived, archiveChat, unarchiveChat, pushRoute]);
  // Deletion is not archiving: the thread leaves every list, so the view
  // navigates away.
  const headerDelete = useCallback(async () => {
    if (!viewChatId) return;
    await deleteChat(viewChatId);
    pushRoute(CHAT_ROOT);
  }, [viewChatId, deleteChat, pushRoute]);
  const offlineMachineBanner = offlineMachine(chats, machines, viewChatId, localMachineId);

  const loadEarlierNearTop = useCallback(() => {
    void loadEarlier();
  }, [loadEarlier]);
  const scroll = useScrollPin({
    pane,
    stick,
    setAtBottom,
    scrollRestoreRef,
    earlierAnchor,
    displayedChatId,
    blocks,
    repinKeys: [subagentNodes, compacting, busy, hasMore, offlineMachineBanner?.label],
    onNearTop: loadEarlierNearTop,
  });
  // A first send on the scratch surface, from the click until the server
  // accepts it: the composer freezes with its text until the route moves to
  // the created thread.
  const holdingFirstSend = outgoing.pendingSubmitId !== null && chatId === null;

  // Rail badges: unseen chats per panel — folderless chats under Chats, the
  // project-bound ones under Projects.
  const { grouping } = useSidebarRows();
  const unreadChats = grouping.visible.filter((c) => c.unread).length;
  const unreadProjects = Object.values(grouping.chatsByProject).reduce(
    (sum, rows) => sum + rows.filter((c) => c.unread).length,
    0,
  );

  // Sidebar tab: one icon rail (desktop) switches the panel between chats,
  // work, settings and the full-page surfaces. The rail entry is a
  // projection of the route — the route is the truth, so back/forward,
  // reloads and deep links restore the tab like any other route state.
  // The skills and agents pages raise their own rail entry while their URL
  // is live.
  const railTab: RailTab =
    route.skills !== null
      ? "skills"
      : route.integrations !== null
        ? "integrations"
        : (route.apps ?? null) !== null
          ? "apps"
          : route.agents !== null
            ? agentsRailTab(route.agents)
            : route.tab;
  const paneLayout = tabPaneLayout(route, isMobile);
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
        agents: tab === "agents" ? AGENTS_DIRECTORY : tab === "activity" ? AGENTS_ACTIVITY : null,
        integrations: tab === "integrations" ? INTEGRATIONS_HOME : null,
        apps: tab === "apps" ? APPS_HOME : null,
      },
      isMobile,
    );
    // A collapsed sidebar hides the target's list — a tab pick is an intent
    // to see it, so the pick re-expands the sidebar.
    if (target.expandsPanel) sidebarState.setCollapsed(false);
    if (tab === "apps") {
      pushRoute({ ...SURFACE_BASE, skills: null, agents: null, integrations: null, apps: APPS_HOME });
      return;
    }
    if (tab === "skills") {
      pushRoute({ ...SURFACE_BASE, skills: SKILLS_CATALOG, agents: null, integrations: null });
      return;
    }
    if (tab === "integrations") {
      pushRoute({ ...SURFACE_BASE, skills: null, agents: null, integrations: INTEGRATIONS_HOME });
      return;
    }
    if (tab === "agents") {
      pushRoute({ ...SURFACE_BASE, skills: null, integrations: null, agents: AGENTS_DIRECTORY });
      return;
    }
    if (tab === "activity") {
      pushRoute({ ...SURFACE_BASE, skills: null, integrations: null, agents: AGENTS_ACTIVITY });
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
      apps: null,
      tab,
      newChat: false,
      ...(tab === "settings" ? { settingsSection: route.settingsSection ?? "account", settingsDetail: null } : {}),
    });
  };
  // Mobile drawer picks: a panel tab keeps the sheet open on its panel; the
  // route tabs (agents / activity) render in the main column, so the
  // sheet gets out of the way. Picking the already-active panel tab does
  // nothing — it must not clear the open chat.
  const mobileSwitchTab = (tab: RailTab) => {
    if (tab === "agents" || tab === "activity" || tab === "skills" || tab === "integrations" || tab === "apps") {
      switchTab(tab);
      setOpen(false);
      return;
    }
    if (tab === railTab) return;
    switchTab(tab);
  };
  const openSettingsSection = useCallback(
    (id: string) => {
      // Navigation: the section pick owns its /settings/<section> address, so
      // back/forward walks the sections and a reload restores the pick.
      pushRoute({ tab: "settings", settingsSection: id, settingsDetail: null });
      // The section renders in the main column, behind the drawer.
      if (isMobile) setOpen(false);
    },
    [pushRoute, isMobile],
  );

  const sidebarCollapse = useCallback(() => sidebarState.setCollapsed(true), [sidebarState.setCollapsed]);
  const sidebarClose = useCallback(() => setOpen(false), []);
  // The mobile drawer carries the rail too, so every panel tab renders there;
  // its header X closes the sheet (the built-in corner close is suppressed:
  // it would sit on top of the header's new-thread plus).
  const sidebar = (
    <SidebarSurface
      tab={route.tab}
      role={role}
      chatId={viewChatId}
      settingsSection={settingsSection}
      onNewChat={newChat}
      onOpenChat={openChat}
      onNewChatInProject={newChatInProject}
      onNewProject={openCreateProject}
      onSelectSection={openSettingsSection}
      onOpenChatDeleted={leaveDeletedChat}
      onCollapse={isMobile ? undefined : sidebarCollapse}
      onClose={isMobile ? sidebarClose : undefined}
    />
  );

  // A project-bound chat owns the project route — its URL is
  // /project/<id>/thread/<cid>, so the Work tab survives reload and
  // back/forward. A bare /thread/<id> for a project chat is rewritten in
  // place (replace: the bare address is not a step back) once the chat list
  // names its project; a chat not yet listed (just sent) counts as bound
  // while the composer still carries a project pick.
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
    if (projectId) pushRoute({ projectId }, { replace: true });
  }, [route.chatId, route.projectId, chats, pushRoute]);

  // The main column: a route page (agents, skills, settings) owns the whole
  // column right of the rail; the chat comes back on any chat route.
  const routePage =
    route.agents !== null ? (
      <RoutePage isMobile={isMobile} onOpenDrawer={openDrawer}>
        <AgentsPage
          route={route.agents}
          viewer={{ email, displayName, role }}
          pushRoute={pushRoute}
          onOpenChat={openChat}
        />
      </RoutePage>
    ) : paneLayout.mainPane === "integrationsPage" && route.integrations !== null ? (
      <RoutePage isMobile={isMobile} title="Integrations" onOpenDrawer={openDrawer}>
        <IntegrationsSurface route={route.integrations} isMobile={isMobile} pushRoute={pushRoute} />
      </RoutePage>
    ) : paneLayout.mainPane === "appsPage" && route.apps !== undefined && route.apps !== null ? (
      <RoutePage isMobile={isMobile} title="Apps" onOpenDrawer={openDrawer}>
        <AppsSurface route={route.apps} isMobile={isMobile} pushRoute={pushRoute} onOpenChat={openChat} />
      </RoutePage>
    ) : paneLayout.mainPane === "skillsPage" && route.skills !== null ? (
      <RoutePage isMobile={isMobile} title="Skills" onOpenDrawer={openDrawer}>
        <SkillsPage
          route={route.skills}
          me={{ email, displayName: displayName ?? undefined, role }}
          pushRoute={pushRoute}
        />
      </RoutePage>
    ) : route.tab === "settings" && settingsSection !== null ? (
      <RoutePage isMobile={isMobile} title="Settings" onOpenDrawer={openDrawer}>
        <SettingsPage
          section={settingsSection}
          detail={route.settingsDetail}
          usage={route.usage}
          email={email}
          role={role}
          pushRoute={pushRoute}
        />
      </RoutePage>
    ) : null;

  const railProps = {
    activeTab: railTab,
    collapsed: sidebarState.collapsed,
    onToggleCollapse: sidebarState.toggleCollapsed,
    email,
    displayName,
    avatarUrl,
    onOpenDevice: () => pushRoute({ overlay: { kind: "device" } }),
    onSignOut: signOut,
    onAddWorkspace,
    role,
    unreadChats,
    unreadProjects,
  };

  return (
    <div ref={shell} data-shell className="fixed inset-0 flex bg-background text-foreground">
      {/* icon rail: desktop only, always visible — it switches the sidebar
          panel between chats / work / skills / settings and carries the
          account menu */}
      {!isMobile && (
        <SidebarRail
          {...railProps}
          onTabChange={switchTab}
          onOpenHelp={() => pushRoute({ ...CHAT_ROOT, overlay: { kind: "onboard" } })}
        />
      )}
      {/* desktop sidebar: resizable + collapsible; mobile: drawer */}
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="left"
            className="w-72 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            hideClose
          >
            <SheetTitle className="sr-only">Sidebar</SheetTitle>
            <div className="flex min-h-0 flex-1">
              <SidebarRail
                {...railProps}
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
                isMobile
              />
              <div className="flex min-w-0 flex-1 flex-col">{sidebar}</div>
            </div>
          </SheetContent>
        </Sheet>
      ) : !paneLayout.aside ? null : (
        // Collapsed = the column is gone (the icon rail stays and offers
        // the expand button); the central pane reflows on toggle.
        <Sidebar collapsed={sidebarState.collapsed}>{sidebar}</Sidebar>
      )}

      {/* main column */}
      <div
        {...titleBarDrag}
        className={`relative flex min-w-0 flex-1 flex-col ${TITLE_BAR_INSET}`}
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
        {routePage !== null ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* A route page has no header of its own, so the first row of the
                column is the drag band: the same row the thread header fills. */}
            {HAS_TITLE_BAR && !isMobile && <div {...titleBarDragDeep} className={`shrink-0 ${TOP_ROW}`} />}
            {routePage}
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <ThreadHeader
                isMobile={isMobile}
                onOpenDrawer={openDrawer}
                chatId={viewChatId}
                title={activeTitle}
                titleLoading={threadLoading && blocks.length === 0}
                childTree={childTree}
                isSubagent={facts.type === "subagent"}
                showWorking={!!viewChatId && openWorking && !openGenerating}
                showMenu={!!viewChatId && facts.type === "user" && !facts.deleted}
                foreign={foreignChat}
                archived={chatArchived}
                renameSeed={activeChat?.title ?? ""}
                onOpenChat={openChat}
                onRename={renameOpenChat}
                onArchiveToggle={headerArchive}
                onDelete={headerDelete}
              />

              {offlineMachineBanner && (
                <div role="status" className="border-b border-amber-700/60 bg-amber-900/30 px-4 py-2 text-amber-300">
                  {offlineMachineBanner.label} is offline — tools won't run until it reconnects.
                </div>
              )}

              <NotificationsOffer />

              <PreviewProvider value={openPreview}>
                <GenuiHostContext.Provider value={genuiHost}>
                  <ThreadPane
                    blocks={blocks}
                    loading={threadLoading}
                    viewChatId={viewChatId}
                    noModels={models !== null && models.length === 0}
                    navigating={navigating}
                    hasMore={hasMore}
                    loadingEarlier={loadingEarlier}
                    onLoadEarlier={loadEarlierNearTop}
                    compacting={compacting}
                    busy={busy}
                    stopping={stopping}
                    subagentNodes={subagentNodes}
                    originLink={childTree?.origin ?? null}
                    onOpenChat={openChat}
                    onOpenChildChat={openChildChat}
                    scroll={{
                      pane,
                      onScroll: scroll.onScroll,
                      setContentEl: scroll.setContentEl,
                      composerH: scroll.composerH,
                      onFrameToggle: scroll.onFrameToggle,
                      atBottom,
                      scrollToBottom: scroll.scrollToBottom,
                    }}
                    column={column}
                    isMobile={isMobile}
                  />
                </GenuiHostContext.Provider>
              </PreviewProvider>

              <ThreadComposer
                composer={composer}
                sending={outgoing}
                agent={agent}
                approval={approval}
                viewChatId={viewChatId}
                blocks={blocks}
                busy={busy}
                navigating={navigating}
                holdingFirstSend={holdingFirstSend}
                openGenerating={openGenerating}
                stopping={stopping}
                models={models}
                model={model}
                access={{
                  readOnly: access === "readonly",
                  unknown: access === "unknown",
                  facts,
                  foreign: foreignChat,
                  deletingAgent,
                  onUnarchive: () => void headerArchive(),
                }}
                currentProject={currentProject}
                localMachineId={localMachineId}
                chatWidth={column.chatWidth}
                chatResizing={column.chatResizing}
                setComposerEl={scroll.setComposerEl}
                onManageAgents={() =>
                  pushRoute({ chatId: null, projectId: null, overlay: null, skills: null, agents: AGENTS_DIRECTORY })
                }
              />
            </div>
            {previewRef !== null && (
              <PreviewPane
                tabs={previewTabs}
                active={previewRef}
                full={route.previewFull === true}
                isMobile={isMobile}
                onSelect={selectPreview}
                onClose={closePreviewTab}
                onCloseAll={closePreview}
                onToggleFull={togglePreviewFull}
              />
            )}
          </div>
        )}
      </div>

      <ThreadOverlays
        deviceOpen={overlay?.kind === "device"}
        onboardOpen={route.overlay?.kind === "onboard"}
        installOpen={overlay?.kind === "install"}
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
