import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { Button } from "@guild/ui/components/button";
import { ThemedToaster } from "@guild/ui/components/toaster";
import { WebLogin, type Profile } from "../../desktop/src/components/web-login";
import { ThemeProvider } from "../../desktop/src/theme";
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
      pushRoute({ ...CHAT_ROOT, tab: "settings", settingsSection: admin ? "general" : "gateway" }, { replace: true });
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
      },
    };
  };
  const navStyle = "flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-2 hover:bg-accent aria-[current=page]:bg-accent";
  const viewer = { email: profile.email, displayName: profile.display_name, role };
  const displayAgent = route.agents?.view !== "agent" || !route.agents.personalRoutines;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">Control Center</h1>
          {workspace?.name && <span className="block truncate text-xs text-muted-foreground">{workspace.name}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/chats">Open Work</a>
          </Button>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Control Center"
          className="flex shrink-0 gap-1 overflow-auto border-b p-2 text-sm md:w-52 md:flex-col md:border-b-0 md:border-r"
        >
          <a
            {...nav({ agents: AGENTS_DIRECTORY })}
            className={navStyle}
            aria-current={
              route.agents?.view === "agent" || route.agents?.view === "directory" || route.agents?.view === "new"
                ? "page"
                : undefined
            }
          >
            Agents
          </a>
          <a {...nav({ skills: CATALOG })} className={navStyle} aria-current={route.skills ? "page" : undefined}>
            Skills
          </a>
          {admin && (
            <>
              <a
                {...nav({ integrations: INTEGRATIONS_HOME })}
                className={navStyle}
                aria-current={route.integrations ? "page" : undefined}
              >
                Integrations
              </a>
              <a {...nav({ apps: APPS })} className={navStyle} aria-current={route.apps ? "page" : undefined}>
                Apps
              </a>
              <a
                {...nav({ agents: AGENTS_ACTIVITY })}
                className={navStyle}
                aria-current={route.agents?.view === "activity" ? "page" : undefined}
              >
                Activity
              </a>
            </>
          )}
          {SECTIONS.filter((section) => !section.admin || admin).map(({ id, label }) => (
            <a
              key={id}
              {...nav({ tab: "settings", settingsSection: id })}
              className={navStyle}
              aria-current={route.settingsSection === id ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
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
