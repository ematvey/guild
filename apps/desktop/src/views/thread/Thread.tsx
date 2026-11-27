import { request } from "../../lib/api/request";
// The thread view: transcript, composer and sidebar for one chat. State
// lives in the hooks under thread/hooks/ and the chat stores, pure
// derivations in the sibling modules, the parts in their own components, and
// this file assembles the component tree.
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";

import { Dialog, DialogContent, DialogTitle } from "@guild/ui/components/dialog";
import { SettingsPanel } from "../sidebar/settings-panel";
import { PageHeader } from "../../components/page-header";
import { Button } from "@guild/ui/components/button";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";

import { readDraft, writeDraft } from "../../lib/drafts";
import { HAS_ENGINE, HAS_SHELL } from "../../lib/session";
import { openExternal } from "../../lib/open-external";
import { apiUrl, serverUrl } from "../../lib/session";
import { useModelOptions } from "../agents/agent-model";
import { runningWebBundle, useWorkspaceIdentity, webBundleOutdated } from "../../lib/workspace-store";
import { machineId } from "../../lib/machine-rpc";
import { chatProjectOf, type PickedProject } from "../projects/projects";
import { SKILLS_CATALOG } from "../skills/skills-route";
import { AGENTS_DIRECTORY, agentTabRoute } from "../agents/agents-route";
import { SidebarMenu, WorkNavigation, WorkSidebarHeader, type RailTab } from "../sidebar-rail";
import { TITLE_BAR_INSET, titleBarDrag, titleBarDragDeep } from "../../lib/titlebar";
import { ThreadOverlays } from "./ThreadOverlays";
import {
  agentDeleting,
  busyFrom,
  offlineMachine,
  pruneStopping,
  tabPaneLayout,
  threadAccess,
  threadFacts,
} from "./status";
import { CHAT_ROOT, SURFACE_BASE, applyRoutePatch, isControlRoute, type RoutePatch } from "./route";
import { archivedChatsStore, chatsStore, resetChatStores } from "./chat-stores";
import { ThreadPane } from "./thread-pane";
import { GenuiHostContext, type GenuiHost } from "../genui/actions";
import { ThreadHeader } from "./thread-header";
import { ThreadComposer } from "./thread-composer";
import { NotificationsOffer } from "./notifications-offer";
import { SidebarSurface } from "./surfaces/sidebar-surface";
import { RoutePage } from "./surfaces/route-page";
import { SettingsPage } from "./surfaces/settings-page";
import { SkillsPage } from "./surfaces/skills-page";
import { AgentRoutinesPage } from "../agents/AgentRoutines";
import { AppsSurface } from "./surfaces/apps-page";
import { APPS_HOME } from "../apps/apps-route";
import { routePath, useThreadRoute } from "./hooks/use-thread-route";
import { useChatData } from "./hooks/use-chat-data";
import { useThreadStore } from "./hooks/use-thread-store";
import { useComposer } from "./hooks/use-composer";
import { useOutgoing } from "./hooks/use-outgoing";
import { useMemberSocket } from "./hooks/use-member-socket";
import { useApprovalMode } from "./hooks/use-approval-mode";
import { useAgentPick } from "./hooks/use-agent-pick";
import { useChatActions } from "./hooks/use-chat-actions";
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
  useEffect(() => {
    if (route.chatId === null) return;
    void request("POST", `/api/v1/chats/${route.chatId}/surface`, {}).catch(() => {});
  }, [route.chatId]);
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
  const openRow = viewChatId
    ? chats?.find((c) => c.id === viewChatId) ?? archivedChats?.find((c) => c.id === viewChatId)
    : undefined;
  // The visible chat's subtree, from the per-chat map the socket fills. It
  // survives navigation, so returning to a chat renders its tree at once.
  const subagentNodes = viewChatId ? (subagentTrees[viewChatId] ?? []) : [];
  const currentProject = pickedProject ?? chatProjectOf(openRow);
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
  const shell = useRef<HTMLDivElement>(null);
  const openDrawer = useCallback(() => setOpen(true), []);
  useMobileGestures({ isMobile, shell, onEdgeSwipe: openDrawer });

  // A browser tab reloads into the bundle the server serves, once nothing
  // is in flight: the identity frame names the served bundle on connect and
  // after every deploy. The desktop shell runs its own local bundle.
  const workspace = useWorkspaceIdentity();
  const servedBundle = workspace?.web_bundle;
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
  }, [chatId]);
  useEffect(() => {
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
      const row = chatsStore.get()?.find((c) => c.id === id) ?? archivedChatsStore.get()?.find((c) => c.id === id);
      setOpen(false);
      pushRoute({ chatId: id, projectId: row?.project_id ?? null, overlay: null, tab: "chats" });
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
    // (/chats/new); the
    // chatId effect clears the thread and the pick effect drops any pick.
    pushRoute({
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      newChat: true,
      tab: "chats",
    });
    setOpen(false);
    ta.current?.focus();
  }, [pushRoute, ta]);

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
  const assistantInbox = listedChat?.shared_agent_inbox === true;
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

  const railTab: RailTab = route.skills ? "skills" : route.apps ? "apps" : route.tab;
  const controlRoute = isControlRoute(route);
  const paneLayout = tabPaneLayout(route, isMobile);
  const settingsSection = route.settingsSection;
  const projectsDestination = route.projectsPage || (
    route.projectId !== null && route.chatId === null && !route.newChat && paneLayout.mainPane === "chat"
  );
  const lastChat = useRef<{ chatId: string | null; projectId: string | null }>({ chatId: null, projectId: null });
  useEffect(() => {
    if (paneLayout.mainPane === "chat" && !projectsDestination && route.overlay === null) {
      lastChat.current = { chatId: route.chatId, projectId: route.projectId };
    }
  }, [paneLayout.mainPane, projectsDestination, route.chatId, route.projectId, route.overlay]);
  const switchTab = (tab: RailTab) => {
    if (tab === "chats") {
      if (paneLayout.mainPane !== "chat" || projectsDestination) {
        pushRoute({ ...CHAT_ROOT, ...lastChat.current, tab: "chats", agents: null, settingsSection: null, settingsDetail: null });
        sidebarState.setCollapsed(false);
      }
      return;
    }
    const target = tabPaneLayout(
      {
        ...route,
        tab: tab === "settings" ? tab : "chats",
        skills: tab === "skills" ? SKILLS_CATALOG : null,
        agents: null,
        integrations: null,
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
    pushRoute({ ...CHAT_ROOT, tab: "settings", settingsSection: route.settingsSection ?? "account" });
  };
  // Mobile drawer picks: a panel tab keeps the sheet open on its panel; the
  // route tabs (agents / activity) render in the main column, so the
  // sheet gets out of the way. Picking the already-active panel tab does
  // nothing — it must not clear the open chat.
  const mobileSwitchTab = (tab: RailTab) => {
    if (tab === "skills" || tab === "apps") {
      switchTab(tab);
      setOpen(false);
      return;
    }
    if (tab === railTab && route.agents === null) {
      setOpen(false);
      return;
    }
    switchTab(tab);
    setOpen(false);
  };
  const openControl = (destination: RoutePatch) => {
    openExternal(serverUrl() + routePath(applyRoutePatch(route, { ...CHAT_ROOT, ...destination })), { link: true });
  };
  const manageAgent = agent.shownAgent?.can_manage ? agent.shownAgent : null;
  const agentModel = agent.shownAgent?.model;
  const agentModelUnavailable = !!agentModel && models !== null && !models.some((option) => option.id === agentModel);
  const configureModels =
    models?.length === 0 && role === "admin"
      ? () => openControl({ tab: "settings", settingsSection: "models" })
      : agentModelUnavailable && manageAgent
        ? () => openControl({ agents: agentTabRoute(manageAgent.id, "settings") })
        : agentModelUnavailable && role === "admin"
          ? () => openControl({ tab: "settings", settingsSection: "models" })
          : undefined;
  const openSettingsSection = useCallback(
    (id: string) => {
      // Navigation: the section pick owns its /settings/<section> address, so
      // back/forward walks the sections and a reload restores the pick.
      pushRoute({ ...CHAT_ROOT, tab: "settings", settingsSection: id, settingsDetail: null });
      // Close the mobile drawer before showing the Settings dialog.
      if (isMobile) setOpen(false);
    },
    [pushRoute, isMobile],
  );

  const sidebarClose = useCallback(() => setOpen(false), []);
  // The mobile drawer carries the rail too, so every panel tab renders there;
  // its header X closes the sheet (the built-in corner close is suppressed:
  // it would sit on top of the header's new-thread plus).
  const renderSidebar = (mode: "history" | "projects" | "search") => (
    <SidebarSurface
      mode={mode}
      historyFilter={route.historyFilter}
      onHistoryFilter={(historyFilter) => pushRoute({ historyFilter })}
      chatId={chatId}
      projectId={route.projectId}
      onOpenChat={openChat}
      onNewChatInProject={newChatInProject}
      onNewProject={openCreateProject}
      onOpenProject={(projectId) => pushRoute({ ...CHAT_ROOT, tab: "chats", projectId })}
      onBackToProjects={() => pushRoute({ ...CHAT_ROOT, tab: "chats", projectsPage: true })}
      onOpenChatDeleted={leaveDeletedChat}
    />
  );

  // A project-bound chat owns the project route — its URL is
  // /project/<id>/thread/<cid>, so the project context survives reload and
  // back/forward. A bare /thread/<id> for a project chat is rewritten in
  // place (replace: the bare address is not a step back) once the chat list
  // identifies its project.
  const routeTabDecidedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!route.chatId || route.projectId !== null) {
      routeTabDecidedRef.current = null;
      return;
    }
    if (routeTabDecidedRef.current === route.chatId) return;
    if (chats === null || archivedChats === null) return;
    const row = chats.find((c) => c.id === route.chatId) ?? archivedChats.find((c) => c.id === route.chatId);
    if (!row) return;
    routeTabDecidedRef.current = route.chatId;
    const projectId = row.project_id;
    if (projectId) pushRoute({ projectId }, { replace: true });
  }, [route.chatId, route.projectId, chats, archivedChats, pushRoute]);

  // The main column: a route page (agents, skills, settings) owns the whole
  // column right of the rail; the chat comes back on any chat route.
  const routePage =
    controlRoute ? (
      <RoutePage isMobile={isMobile} onOpenDrawer={openDrawer}>
        <div className="m-auto flex flex-col items-center gap-4 p-4">
          <Button onClick={() => openExternal(serverUrl() + routePath(route), { link: true })}>Open Control Center</Button>
          <Button variant="ghost" onClick={() => switchTab("chats")}>Back to chats</Button>
        </div>
      </RoutePage>
    ) : projectsDestination ? (
      <RoutePage isMobile={isMobile} title="Projects" onOpenDrawer={openDrawer}>
        {renderSidebar("projects")}
      </RoutePage>
    ) : route.agents?.view === "agent" && route.agents.personalRoutines ? (
      <RoutePage isMobile={isMobile} title="Scheduled" onOpenDrawer={openDrawer}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!route.agents.routineId && <PageHeader variant="work" title="Scheduled" />}
          <div className="work-page-content pb-8 pt-3">
          {agent.agentsList === null ? <p>Loading routines…</p> :
            agent.personalAgent?.id !== route.agents.agentId ? <p>This personal agent is unavailable.</p> :
              <AgentRoutinesPage agentId={route.agents.agentId} routineId={route.agents.routineId}
                canManage={agent.personalAgent.can_manage} onOpenChat={openChat}
                onNavigate={(next) => {
                  if (next.view === "agent" && next.tab === "routines") {
                    pushRoute({ ...CHAT_ROOT, agents: { ...next, personalRoutines: true } });
                  }
                }} />}
          </div>
        </div>
      </RoutePage>
    ) : paneLayout.mainPane === "appsPage" && route.apps !== undefined && route.apps !== null ? (
      <RoutePage isMobile={isMobile} title="Apps" onOpenDrawer={openDrawer}>
        <AppsSurface route={route.apps} isMobile={isMobile} pushRoute={pushRoute} onOpenChat={openChat} />
      </RoutePage>
    ) : paneLayout.mainPane === "skillsPage" && route.skills !== null ? (
      <RoutePage isMobile={isMobile} title="Customize" onOpenDrawer={openDrawer}>
        <SkillsPage
          route={route.skills}
          me={{ email, displayName: displayName ?? undefined, role }}
          pushRoute={pushRoute}
        />
      </RoutePage>
    ) : null;

  const openRoutines = agent.personalAgent ? () => {
    if (!agent.personalAgent) return;
    if (isMobile) setOpen(false);
    pushRoute({ ...CHAT_ROOT, agents: {
      view: "agent", agentId: agent.personalAgent.id, tab: "routines", personalRoutines: true,
    } });
  } : undefined;
  const openSearch = () => {
    if (isMobile) setOpen(false);
    pushRoute({ searchOpen: true });
  };
  const openProjects = () => {
    if (isMobile) setOpen(false);
    pushRoute({ ...CHAT_ROOT, tab: "chats", agents: null, projectsPage: true });
  };
  const workNavigation = (
    <WorkNavigation
      active={projectsDestination ? "projects" : route.agents?.view === "agent" && route.agents.personalRoutines ? "routines" : railTab}
      onNewChat={newChat}
      onSearch={openSearch}
      onProjects={openProjects}
      onTabChange={isMobile ? mobileSwitchTab : switchTab}
      onOpenRoutines={openRoutines}
    />
  );
  const sidebarBody = (
    <div className="work-sidebar-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      {workNavigation}
      {renderSidebar("history")}
    </div>
  );
  const menu = (
    <SidebarMenu
      onOpenSettings={openSettingsSection}
      onOpenControl={() => {
        if (isMobile) setOpen(false);
        pushRoute({ ...CHAT_ROOT, tab: "settings", settingsSection: role === "admin" ? "general" : "gateway" });
      }}
      onOpenHelp={() => {
        if (isMobile) setOpen(false);
        pushRoute({ ...CHAT_ROOT, overlay: { kind: "onboard" } });
      }}
      email={email}
      displayName={displayName}
      avatarUrl={avatarUrl}
      onSignOut={signOut}
      onAddWorkspace={onAddWorkspace}
      workspaceName={workspace?.name}
    />
  );

  return (
    <div ref={shell} data-shell className="guild-sidebar-theme fixed inset-0 flex flex-col bg-background text-foreground">
      {!isMobile && (
        <header {...titleBarDragDeep} className={`relative shrink-0 ${TITLE_BAR_INSET}`}>
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-0 bg-sidebar shadow-[inset_-1px_0_var(--border)] ${sidebarState.resizing ? "" : "transition-[width] duration-150 motion-reduce:transition-none"}`}
            style={{ width: sidebarState.collapsed ? 0 : sidebarState.width }}
          />
          <div className="relative">
            <WorkSidebarHeader onToggle={sidebarState.toggleCollapsed} expanded={!sidebarState.collapsed} />
          </div>
        </header>
      )}
      <div className="flex min-h-0 flex-1">
        {isMobile ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
              side="left"
              className="guild-sidebar-theme w-72 gap-0 bg-sidebar p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
              hideClose
            >
              <SheetTitle className="sr-only">Work sidebar</SheetTitle>
              <WorkSidebarHeader onClose={sidebarClose} />
              {sidebarBody}
              {menu}
            </SheetContent>
          </Sheet>
        ) : (
          <Sidebar {...sidebarState}>
            {sidebarBody}
            {menu}
          </Sidebar>
        )}

        {/* main column */}
        <div
          {...titleBarDrag}
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
          {routePage ?? (
            <div className="flex min-h-0 min-w-0 flex-1">
              {/* The chat column takes the rest of the row and sets no minimum
                  of its own; the preview pane carries the minimum width. It is
                  the positioning box for the composer, so the card stays under
                  the chat and not under the pane. */}
              <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${!isMobile && !sidebarState.collapsed ? "[--chat-column-width:64rem]" : ""}`}>
                <ThreadHeader
                  isMobile={isMobile}
                  onOpenDrawer={openDrawer}
                  chatId={viewChatId}
                  title={activeTitle}
                  project={viewChatId !== null ? currentProject : null}
                  onOpenProject={(projectId) => {
                    pushRoute({ ...CHAT_ROOT, projectId });
                    if (!isMobile) sidebarState.setCollapsed(false);
                  }}
                  titleLoading={threadLoading && blocks.length === 0}
                  childTree={childTree}
                  isSubagent={facts.type === "subagent"}
                  showMenu={
                    !!viewChatId && (listedChat !== undefined || foreignChat) &&
                    facts.type === "user" && !facts.deleted && !assistantInbox
                  }
                  foreign={foreignChat}
                  archived={chatArchived}
                  renameSeed={activeChat?.title ?? ""}
                  onOpenChat={openChat}
                  onRename={renameOpenChat}
                  onArchiveToggle={headerArchive}
                  onMakeRecurring={
                    viewChatId !== null && access === "writable" && facts.type === "user" && agent.shownAgent?.id === agent.personalAgent?.id && agent.personalAgent
                      ? () => {
                        const request = "Help me turn the work in this conversation into a routine. Ask me to confirm what it should do, when it should run, and the timezone before creating it.";
                        const draft = composer.promptRef.current;
                        composer.setPrompt(draft ? `${draft}\n\n${request}` : request);
                        ta.current?.focus();
                      }
                      : undefined
                  }
                  onDelete={headerDelete}
                />

                {offlineMachineBanner && (
                  <div role="status" className="border-b border-amber-700/60 bg-amber-900/30 px-4 py-2 text-amber-300">
                    {offlineMachineBanner.label} is offline. Tools can run once it reconnects.
                    <button type="button" className="ml-2 underline" onClick={() => openSettingsSection("machine")}>
                      Open Machines
                    </button>
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
                    />
                  </GenuiHostContext.Provider>
                </PreviewProvider>

                <ThreadComposer
                  assistantInbox={assistantInbox}
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
                  setComposerEl={scroll.setComposerEl}
                  agentModelUnavailable={agentModelUnavailable}
                  onConfigureModels={configureModels}
                  onManageAgents={() => openControl({
                    agents: manageAgent
                      ? agentTabRoute(manageAgent.id, "settings")
                      : AGENTS_DIRECTORY,
                  })}
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

      </div>

      <Dialog open={route.searchOpen === true} onOpenChange={(open) => {
        if (!open) pushRoute({ searchOpen: false });
      }}>
        <DialogContent className="max-w-xl" aria-describedby={undefined}>
          <DialogTitle className="text-base">Search</DialogTitle>
          {renderSidebar("search")}
        </DialogContent>
      </Dialog>
      <Dialog open={route.tab === "settings" && !controlRoute && settingsSection !== null} onOpenChange={(open) => {
        if (!open && route.overlay === null) switchTab("chats");
      }}>
        <DialogContent className="flex h-[min(42rem,90dvh)] w-[calc(100%-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0" aria-describedby={undefined}>
          <DialogTitle className="border-b border-border px-5 py-3 text-base">{settingsSection === "machine" ? "Devices" : "Settings"}</DialogTitle>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <div className="max-h-[30dvh] shrink-0 overflow-y-auto border-b border-border sm:max-h-none sm:w-44 sm:border-b-0 sm:border-r">
              <SettingsPanel role={role} activeSection={settingsSection} onSelectSection={openSettingsSection} />
            </div>
            {settingsSection !== null && <SettingsPage section={settingsSection} email={email} role={role}
              onSetupDevice={() => pushRoute({ overlay: { kind: "device" } })} />}
          </div>
        </DialogContent>
      </Dialog>
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
