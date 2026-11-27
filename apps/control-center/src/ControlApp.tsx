import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { Button } from "@guild/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@guild/ui/components/sheet";
import { Avatar } from "@guild/ui/components/avatar";
import {
  Activity,
  ArrowUpRight,
  Bot,
  ChevronRight,
  ChevronsUpDown,
  LayoutGrid,
  LogOut,
  Package,
  PanelLeft,
  Plug,
} from "lucide-react";
import { ThemedToaster } from "@guild/ui/components/toaster";
import { WebLogin, type Profile } from "../../desktop/src/components/web-login";
import { ThemeProvider } from "../../desktop/src/theme";
import { avatarChip } from "../../desktop/src/lib/format";
import { apiLogout, apiMe } from "../../desktop/src/lib/api/servers";
import { clearToken, setToken } from "../../desktop/src/lib/session";
import { resetSessionState } from "../../desktop/src/lib/session-reset";
import { startSocket } from "../../desktop/src/lib/socket-client";
import { applyMemberProfile, useMemberProfile } from "../../desktop/src/lib/profile-store";
import { applyWorkspaceIdentity, useWorkspaceIdentity } from "../../desktop/src/lib/workspace-store";
import { applyModelList } from "../../desktop/src/lib/models-store";
import { applyAppList } from "../../desktop/src/views/apps/apps-store";
import { APPS_HOME } from "../../desktop/src/views/apps/apps-route";
import { AGENTS_ACTIVITY, AGENTS_DIRECTORY } from "../../desktop/src/views/agents/agents-route";
import {
  applyActivityConversation,
  applyActivityRun,
  applyAgentCoordination,
  applyAgentList,
  applyAgentRoutines,
  applyAgentRun,
  applyAgentThreads,
  applyIntegrationAccess,
  resetAgentSlices,
  scrubAgentCoordination,
} from "../../desktop/src/views/agents/agents-store";
import { INTEGRATIONS_HOME } from "../../desktop/src/views/integrations/integrations-route";
import { SKILLS_CATALOG } from "../../desktop/src/views/skills/skills-route";
import { applyOrgEvent, applySkillCatalog } from "../../desktop/src/views/skills/skills-store";
import { SETTINGS_SECTIONS } from "../../desktop/src/views/settings/settings-catalog";
import { isControlSection } from "../../desktop/src/views/settings/section-nav";
import { AgentsPage } from "./surfaces/agents-page";
import { IntegrationsSurface } from "./surfaces/integrations-page";
import { SkillsPage } from "../../desktop/src/views/thread/surfaces/skills-page";
import { AppsSurface } from "../../desktop/src/views/thread/surfaces/apps-page";
import {
  CHAT_ROOT,
  applyRoutePatch,
  consumeAuthFragment,
  isControlRoute,
  type RoutePatch,
  writeAddress,
} from "../../desktop/src/views/thread/route";
import { routePath, useThreadRoute } from "../../desktop/src/views/thread/hooks/use-thread-route";
import { ControlSettings } from "./ControlSettings";

const CATALOG = { ...SKILLS_CATALOG, management: true } as const;
const APPS = { ...APPS_HOME, management: true } as const;
const SECTIONS = SETTINGS_SECTIONS.filter(({ id }) => isControlSection(id));

function Management({ profile, signOut }: { profile: Profile; signOut: () => void }) {
  const member = useMemberProfile();
  const role = member?.role ?? profile.role;
  const admin = role === "admin";
  const workspace = useWorkspaceIdentity();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { route, pushRoute } = useThreadRoute({ role });
  const routeRef = useRef(route);
  routeRef.current = route;
  const roleRef = useRef(role);
  roleRef.current = role;
  const socketRef = useRef<ReturnType<typeof startSocket> | null>(null);
  const refresh = useCallback(() => socketRef.current?.resync(), []);
  const openChat = (id: string) => window.location.assign(`/thread/${encodeURIComponent(id)}`);

  useEffect(() => {
    const connection = startSocket({
      onConnect: resetAgentSlices,
      getOpenChatId: () => null,
      getOpenRunId: () => (routeRef.current.agents?.view === "run" ? routeRef.current.agents.runId : null),
      getOpenActivityChatId: () => (routeRef.current.agents?.view === "chat" ? routeRef.current.agents.chatId : null),
      getOpenCoordinationAgentId: () => {
        const agent = routeRef.current.agents;
        return agent?.view === "agent" && agent.tab === "activity" ? agent.agentId : null;
      },
      onAuthRequired: signOut,
      onWorkspaceIdentity: applyWorkspaceIdentity,
      onMemberProfile: (user) => {
        roleRef.current = user.role;
        if (user.role !== "admin") scrubAgentCoordination();
        applyMemberProfile(user);
      },
      onModelList: applyModelList,
      onAgentList: applyAgentList,
      onAgentCoordination: (frame) =>
        applyAgentCoordination(
          roleRef.current === "admin"
            ? frame
            : {
                ...frame,
                snapshot: { ...frame.snapshot, outcomes: frame.snapshot.outcomes.filter((outcome) => outcome.owned) },
              },
        ),
      onAgentThreads: applyAgentThreads,
      onAgentRoutines: applyAgentRoutines,
      onAgentRun: applyAgentRun,
      onIntegrationAccess: applyIntegrationAccess,
      onActivityConversation: applyActivityConversation,
      onActivityRun: applyActivityRun,
      onSkillCatalog: (items, installs) => applySkillCatalog({ items, installs }),
      onOrgEvent: applyOrgEvent,
      onAppList: applyAppList,
      onThreadList: () => {},
      onChatStatus: () => {},
      onFrame: () => {},
      onSync: () => {},
    });
    socketRef.current = connection;
    return () => {
      socketRef.current = null;
      connection.stop();
    };
  }, [signOut]);

  useEffect(refresh, [route.agents, refresh]);

  useEffect(() => {
    if (!isControlRoute(route)) {
      pushRoute({ ...CHAT_ROOT, tab: "settings", settingsSection: admin ? "general" : "gateway", gatewayInControl: !admin }, { replace: true });
    }
  }, [admin, pushRoute, route]);

  const nav = (destination: RoutePatch) => {
    const patch = { ...CHAT_ROOT, ...destination };
    return {
      href: routePath(applyRoutePatch(route, patch)),
      onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        pushRoute(patch);
        setDrawerOpen(false);
      },
    };
  };
  const viewer = { email: profile.email, displayName: profile.display_name, role };
  const displayAgent = route.agents?.view !== "agent" || !route.agents.personalRoutines;
  const settings = (ids: string[]) =>
    SECTIONS.filter(({ id, admin: restricted }) => ids.includes(id) && (!restricted || admin)).map(
      ({ id, label, icon }) => ({
        label,
        icon,
        active: route.settingsSection === id,
        destination: { tab: "settings", settingsSection: id, gatewayInControl: id === "gateway" } satisfies RoutePatch,
      }),
    );
  const groups = [
    {
      label: "Workspace",
      items: [
        ...settings(["general"]),
        {
          label: "Agents",
          icon: <Bot />,
          active: route.agents !== null && !["activity", "run", "trace", "chat"].includes(route.agents.view),
          destination: { agents: AGENTS_DIRECTORY },
        },
        { label: "Skills", icon: <Package />, active: !!route.skills, destination: { skills: CATALOG } },
        ...(admin ? [{ label: "Apps", icon: <LayoutGrid />, active: !!route.apps, destination: { apps: APPS } }] : []),
      ],
    },
    {
      label: "Configuration",
      items: [
        ...(admin
          ? [
              {
                label: "Integrations",
                icon: <Plug />,
                active: !!route.integrations,
                destination: { integrations: INTEGRATIONS_HOME },
              },
            ]
          : []),
        ...settings(["models", "mcp", "assistant", "gateway", "registry"]),
      ],
    },
    { label: "Access", items: settings(["users", "teams", "sso", "security"]) },
    {
      label: "Monitoring",
      items: admin
        ? [
            {
              label: "Activity",
              icon: <Activity />,
              active: route.agents !== null && ["activity", "run", "trace", "chat"].includes(route.agents.view),
              destination: { agents: AGENTS_ACTIVITY },
            },
            ...settings(["usage"]),
          ]
        : [],
    },
  ];
  const activeGroup = groups.find(({ items }) => items.some(({ active }) => active));
  const activePage = activeGroup?.items.find(({ active }) => active)?.label;
  const accountLabel = member?.display_name ?? profile.display_name ?? profile.email;

  const sidebar = (
    <>
      <div className="flex h-16 shrink-0 items-center gap-3 px-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
          <img src="/brand/guild-icon-light.svg" alt="" className="size-5 dark:hidden" />
          <img src="/brand/guild-icon-dark.svg" alt="" className="hidden size-5 dark:block" />
        </span>
        <div className="min-w-0">
          <span className="block truncate text-sm font-semibold">Guild Control Center</span>
          {workspace?.name && <span className="block truncate text-xs text-muted-foreground">{workspace.name}</span>}
        </div>
      </div>
      <nav aria-label="Guild Control Center navigation" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {groups
          .filter(({ items }) => items.length > 0)
          .map(({ label, items }) => (
            <section key={label} aria-label={label}>
              <h2 className="mb-1 px-2 text-xs font-medium text-muted-foreground">{label}</h2>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.label}>
                    <a
                      {...nav(item.destination)}
                      aria-current={item.active ? "page" : undefined}
                      className="guild-sidebar-current flex min-h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-medium [&>svg]:size-4 [&>svg]:shrink-0"
                    >
                      {item.icon}
                      <span className="truncate">{item.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </nav>
      <div className="shrink-0 space-y-2 border-t border-border p-3">
        <Button asChild variant="ghost" size="sm" className="w-full justify-between px-2 text-muted-foreground">
          <a href="/chats">
            Open Work <ArrowUpRight />
          </a>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-1.5" aria-label="Account menu">
              <Avatar
                src={member?.avatar_url ?? profile.avatar_url}
                fallback={avatarChip(accountLabel)}
                className="size-7"
              />
              <span className="min-w-0 flex-1 truncate text-left text-sm">{accountLabel}</span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel className="truncate">{profile.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut className="size-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );

  return (
    <div className="guild-sidebar-theme flex h-dvh bg-sidebar text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col text-sidebar-foreground md:flex">{sidebar}</aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background md:my-2 md:mr-2 md:rounded-xl md:border md:border-border md:shadow-sm">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
          <Sheet open={isMobile && drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 md:hidden" aria-label="Open navigation">
                <PanelLeft />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              aria-describedby={undefined}
              className="guild-sidebar-theme max-w-[calc(100vw-2rem)] gap-0 bg-sidebar text-sidebar-foreground"
            >
              <SheetTitle className="sr-only">Guild Control Center navigation</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate text-muted-foreground">{activeGroup?.label ?? "Guild Control Center"}</span>
            {activePage && (
              <>
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{activePage}</span>
              </>
            )}
          </div>
        </header>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {route.agents && displayAgent && (
            <AgentsPage
              route={route.agents}
              viewer={viewer}
              pushRoute={pushRoute}
              onOpenChat={openChat}
              onRefreshConversation={refresh}
            />
          )}
          {admin && route.integrations && (
            <IntegrationsSurface route={route.integrations} isMobile={isMobile} pushRoute={pushRoute} />
          )}
          {route.skills?.management && <SkillsPage route={route.skills} me={viewer} pushRoute={pushRoute} />}
          {admin && route.apps?.management && (
            <AppsSurface route={route.apps} isMobile={isMobile} pushRoute={pushRoute} onOpenChat={openChat} />
          )}
          {route.tab === "settings" &&
            isControlSection(route.settingsSection) &&
            SECTIONS.some((section) => section.id === route.settingsSection && (!section.admin || admin)) && (
              <ControlSettings route={route} pushRoute={pushRoute} />
            )}
        </main>
      </div>
    </div>
  );
}

export default function ControlApp() {
  const [profile, setProfile] = useState<Profile | null>();
  useEffect(() => {
    let live = true;
    const callback = consumeAuthFragment(window.location);
    if (callback) {
      writeAddress(callback.canonicalUrl, { replace: true });
      if (callback.token) setToken(callback.token);
    }
    void apiMe()
      .catch(() => null)
      .then((value) => {
        if (live) setProfile(value);
      });
    return () => {
      live = false;
    };
  }, []);
  const signOut = useCallback(() => {
    void apiLogout().finally(() => {
      clearToken();
      resetSessionState();
      setProfile(null);
    });
  }, []);
  return (
    <ThemeProvider>
      {profile === undefined ? null : profile ? (
        <Management profile={profile} signOut={signOut} />
      ) : (
        <WebLogin title="Guild Control Center" onLoggedIn={setProfile} />
      )}
      <ThemedToaster />
    </ThemeProvider>
  );
}
