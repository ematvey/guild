// The thread view's URL model: the pathname is the single source of truth for
// where the user is. Every page, tab, panel and sub-page the user can reach
// has its own fixed address (the AGENTS.md convention). Routes:
//   /chats[/new]               — the Chats tab (default; "/" aliases);
//                                /new is the addressed scratch composer
//   /thread/<id>?preview=<kind>:<id>[&full=1]
//                              — the thread with its preview pane open on
//                                one file (`attachment` or `artifact`); full
//                                screen when full=1. The pane is thread
//                                state, so leaving the thread drops it.
//   /thread/<id>               — open thread (the only thread address; an
//                                agent thread's /agents/<id>/threads/<tid>
//                                form redirects here)
//   /project/<id>              — Chats with the project expanded
//   /project/<id>/new          — scratch composer pre-picked to the project
//   /project/<id>/thread/<cid> — open thread within its project view
//   /install                   — the "Add to Home Screen" guide (the
//                                steps differ per browser; chat-independent
//                                top-level route)
//   /device                    — device-setup dialog, optionally over a
//                                thread: /thread/<id>/device
//   /onboard                   — the onboarding guide dialog (the rail's
//                                Help/Learn button opens it too); chat-
//                                independent top-level route any user can
//                                open. /help deep links alias here.
//   /settings[/<section>[/<detail>]]
//                              — the Settings tab; the section (and sub-
//                                page) always ride in the URL — every
//                                section pick navigates. <detail> addresses
//                                a sub-page inside a section: an
//                                integration slug, a user/team id or "new",
//                                a model route or "add", a registry
//                                kind/slug. A bare /settings normalizes to
//                                /settings/account (replaceState).
//   /skills[/activity|/machine|/<slug>[/edit][/files/<path>] | /new[/files/<path>]][?q=&filter=&sort=]
//                              — the skills page (top-level; replaces the
//                                main pane): tab views, a detail page, the
//                                editor in edit or create mode. See
//                                skills-route.ts for the state contract.
//   /apps[/<id>]               — the Apps page (top-level like skills): the
//                                member's Apps and the open one. See
//                                apps-route.ts.
//   /integrations[/...]        — the integrations page (admin; top-level
//                                like skills): installed integrations, the
//                                catalog and its landing pages. See
//                                integrations-route.ts; old
//                                /settings/integrations links land here.
// Back/forward, reloads and deep links all resolve through parseChatRoute.
import {
  AGENTS_ACTIVITY,
  AGENTS_DIRECTORY,
  agentsRoutePath,
  parseAgentsRoute,
  type AgentsRoute,
} from "../agents/agents-route";
import { clampSkillsRoute, parseSkillsRoute, skillsRoutePath, type SkillsRoute } from "../skills/skills-route";
import {
  fromSettingsDetail,
  integrationsRoutePath,
  parseIntegrationsRoute,
  type IntegrationsRoute,
} from "../integrations/integrations-route";
import { canonicalSettings, isControlSection } from "../settings/section-nav";
import { appsRoutePath, parseAppsRoute, type AppsRoute } from "../apps/apps-route";
import { DEFAULT_USAGE, parseUsageQuery, usageQueryString, type UsageQuery } from "../settings/usage-route";

export { type AuthFragment, consumeAuthFragment, parseAuthFragment } from "./auth-fragment";

/** The one place the app writes the address bar: a new history entry, or a
 *  rewrite of the current one (a normalising redirect, a consumed callback
 *  fragment — nothing the reader can go back to). */
export function writeAddress(
  url: string,
  options?: { replace?: boolean },
  history: Pick<History, "pushState" | "replaceState"> = window.history,
): void {
  if (options?.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

export type ChatOverlay = { kind: "device" } | { kind: "onboard" } | { kind: "install" } | null;
export interface ChatRoute {
  chatId: string | null;
  /** Project context (deep-linked /project/<id>). */
  projectId: string | null;
  overlay: ChatOverlay;
  /** The skills page route, or null when the URL is not a skills one. */
  skills: SkillsRoute | null;
  /** The agents surface route, or null when the URL is not an agents one. */
  agents: AgentsRoute | null;
  /** The integrations page route, or null when the URL is not one. */
  integrations: IntegrationsRoute | null;
  /** The Apps page route; absent or null when the URL is not one. */
  apps?: AppsRoute | null;
  /** Which rail panel tab the URL names: /chats or /settings. */
  tab: "chats" | "settings";
  /** The addressed scratch composer: /chats/new or
   *  /project/<id>/new. False on tab roots, open threads and other tabs. */
  newChat: boolean;
  /** Settings-tab section/detail named by the URL (/settings/<section>/
   * [<detail>] deep links); null elsewhere and for bare /settings, whose
   * section lives in pane state. */
  settingsSection: string | null;
  settingsDetail: string | null;
  /** The usage section's query state (?period=&group=&metric=); defaults on
   *  every other route. */
  usage: UsageQuery;
  /** Set when the pathname held a malformed escape: the route is the default
   *  one and the caller rewrites the address (a reload must not re-enter it). */
  invalid?: true;
  /** The thread's preview pane: the file it shows, named in the address
   *  (`?preview=<kind>:<id>`). Absent or null when the pane is closed. */
  preview?: PreviewRef | null;
  /** The preview pane fills the window (`?preview=…&full=1`). */
  previewFull?: boolean;
}

/** One file in the thread's preview pane. */
export interface PreviewRef {
  kind: "attachment" | "artifact";
  id: string;
}

/** Decodes one path segment; null when the escape is malformed. */
const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** True when a keystroke is an IME committing a candidate rather than a
 *  submit: `isComposing` on the native event, or the legacy 229 keyCode that
 *  Safari reports for the same thing. */
export const isImeEnter = (e: { keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean =>
  e.nativeEvent?.isComposing === true || e.keyCode === 229;

export const CONTROL_PREFIX = "/control";

export function isControlRoute(route: ChatRoute): boolean {
  const agent = route.agents;
  return (agent !== null && !(agent.view === "agent" && agent.personalRoutines)) ||
    route.integrations !== null || route.skills?.management === true || route.apps?.management === true ||
    (route.tab === "settings" && isControlSection(route.settingsSection));
}

export function withoutControlPrefix(pathname: string): string {
  if (pathname === CONTROL_PREFIX || pathname === CONTROL_PREFIX + "/") return "/settings/gateway";
  return pathname.startsWith(CONTROL_PREFIX + "/") ? pathname.slice(CONTROL_PREFIX.length) : pathname;
}

export const parseChatRoute = (pathname: string, search = ""): ChatRoute => {
  const control = pathname.startsWith(CONTROL_PREFIX + "/");
  pathname = withoutControlPrefix(pathname);
  const usage = parseUsageQuery(search);
  const raw = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  const decoded = raw.map(decodeSegment);
  // A malformed escape cannot name anything: fall back to the default route
  // instead of throwing from a render-time initializer (an error boundary
  // that only offers Reload would loop on the same URL forever).
  if (decoded.some((segment) => segment === null)) {
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      integrations: null,
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
      invalid: true,
    };
  }
  const parts = decoded as string[];
  // Settings → Observability folded into Activity: old deep links (and the
  // period/filter query they carried) land on the Activity page.
  if (parts[0] === "settings" && parts[1] === "observability") {
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: AGENTS_ACTIVITY,
      integrations: null,
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
  // The inbox surface is gone: agent-initiated threads live in the chat
  // list. Old /inbox links land on Chats.
  if (parts[0] === "inbox") {
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      integrations: null,
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
  // The agents surface owns its whole address space (/agents, /activity,
  // /runs/<id>): parse it before the chat prefixes.
  const query = search.replace(/^\?/, "");
  const agents = parseAgentsRoute(query === "" ? pathname : `${pathname}?${query}`);
  if (agents !== null) {
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents,
      integrations: null,
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
  // Both chat entry paths resolve to the Chats panel.
  const tab = "chats" as const;
  if (parts[0] === "chats" || parts[0] === "work") parts.shift();
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
  // The reserved "new" segment addresses the scratch composer — only on a
  // chatless surface (a thread or overlay URL never carries it).
  const newChat = parts[0] === "new" && chatId === null;
  if (newChat) parts.shift();
  if (parts[0] === "device")
    return {
      chatId,
      projectId,
      tab,
      overlay: { kind: "device" },
      skills: null,
      agents: null,
      integrations: null,
      settingsSection: null,
      settingsDetail: null,
      usage,
      newChat: false,
    };
  if (parts[0] === "onboard" || parts[0] === "help")
    return {
      chatId: null,
      projectId: null,
      tab: "chats",
      overlay: { kind: "onboard" },
      skills: null,
      agents: null,
      integrations: null,
      settingsSection: null,
      settingsDetail: null,
      usage,
      newChat: false,
    };
  if (parts[0] === "install")
    return {
      chatId: null,
      projectId: null,
      tab: "chats",
      overlay: { kind: "install" },
      skills: null,
      agents: null,
      integrations: null,
      settingsSection: null,
      settingsDetail: null,
      usage,
      newChat: false,
    };
  // Integrations moved out of Settings into their own page: old deep links
  // land on the matching integrations address.
  if (parts[0] === "settings" && parts[1] === "integrations") {
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      integrations: fromSettingsDetail(parts.length > 2 ? parts.slice(2).join("/") : null),
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
  if (parts[0] === "apps") {
    const apps = parseAppsRoute(parts.slice(1));
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      integrations: null,
      apps: control ? { ...apps, management: true } : apps,
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
  if (parts[0] === "integrations") {
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      integrations: parseIntegrationsRoute(parts.slice(1), search),
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
  if (parts[0] === "settings") {
    // Bare /settings normalizes to the default section (/settings/account,
    // via the pane effect); a section (and optional sub-page detail)
    // preselects it. Everything after the section is the sub-page id; each
    // segment was encoded separately, so a model id like "a/b" round-trips
    // as one part.
    const section = parts.length > 1 ? parts[1] : null;
    // Segments arrive decoded once (each was encoded separately), so a model
    // id containing a literal "%" round-trips; a second decode would throw.
    const setup = section === "machine" && parts.length === 3 && parts[2] === "device";
    const detail = !setup && parts.length > 2 ? parts.slice(2).join("/") : null;
    return {
      chatId: null,
      projectId: null,
      tab: "settings",
      overlay: setup ? { kind: "device" } : null,
      skills: null,
      agents: null,
      integrations: null,
      settingsSection: section,
      settingsDetail: detail,
      usage,
      newChat: false,
    };
  }
  // Skills is chat-independent and top-level like settings: the URL drops
  // any thread/project prefix, so the skills page replaces the chat.
  if (parts[0] === "skills") {
    const skills = parseSkillsRoute(parts.slice(1), search);
    const management = skills.view !== "machine" && (control || skills.editor !== null || skills.view === "activity");
    return {
      chatId: null,
      projectId: null,
      overlay: null,
      skills: management ? { ...skills, management: true } : skills,
      agents: null,
      integrations: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage,
      newChat: false,
    };
  }
  const preview = parsePreview(search);
  return {
    chatId,
    projectId,
    tab,
    overlay: null,
    skills: null,
    agents: null,
    integrations: null,
    settingsSection: null,
    settingsDetail: null,
    usage,
    newChat,
    // The pane shows a thread's file, so it exists only with an open thread.
    ...(chatId === null || preview === null ? {} : { preview, previewFull: previewFullOf(search) }),
  };
};

const PREVIEW_KINDS = new Set(["attachment", "artifact"]);

/** `?preview=<kind>:<id>`: the file the preview pane shows. A malformed value
 *  is no preview, not an error — the pane simply stays closed. */
export function parsePreview(search: string): PreviewRef | null {
  const value = new URLSearchParams(search).get("preview");
  if (value === null) return null;
  const sep = value.indexOf(":");
  if (sep === -1) return null;
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (!PREVIEW_KINDS.has(kind) || !UUID_SHAPE.test(id)) return null;
  return { kind: kind as PreviewRef["kind"], id };
}

const previewFullOf = (search: string): boolean => new URLSearchParams(search).get("full") === "1";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The preview query for an address: the pane's file, and whether it fills
 *  the window. */
export function previewQuery(route: ChatRoute): string {
  if (route.chatId === null || route.preview === undefined || route.preview === null) return "";
  const params = new URLSearchParams();
  params.set("preview", `${route.preview.kind}:${route.preview.id}`);
  if (route.previewFull === true) params.set("full", "1");
  return params.toString();
}

export interface RoutePatch {
  chatId?: string | null;
  projectId?: string | null;
  overlay?: ChatOverlay;
  skills?: SkillsRoute | null;
  agents?: AgentsRoute | null;
  integrations?: IntegrationsRoute | null;
  apps?: AppsRoute | null;
  tab?: ChatRoute["tab"];
  newChat?: boolean;
  settingsSection?: string | null;
  settingsDetail?: string | null;
  usage?: UsageQuery;
  preview?: PreviewRef | null;
  previewFull?: boolean;
}

/** Leaves any chat, project and overlay: the base a top-level surface
 *  (skills, agents) patches onto. */
export const SURFACE_BASE = {
  chatId: null,
  projectId: null,
  overlay: null,
} as const satisfies RoutePatch;

/** The chat root: no chat, project, page or overlay open. */
export const CHAT_ROOT = {
  ...SURFACE_BASE,
  skills: null,
  integrations: null,
  apps: null,
  newChat: false,
} as const satisfies RoutePatch;

/** The route a navigation lands on: history and route state move together,
 *  so the URL always reflects what is on screen. Pure for tests. */
export const applyRoutePatch = (route: ChatRoute, next: RoutePatch): ChatRoute => {
  const chatId = "chatId" in next ? (next.chatId as string | null) : route.chatId;
  const projectId = "projectId" in next ? (next.projectId as string | null) : route.projectId;
  const ov = "overlay" in next ? (next.overlay as ChatOverlay) : route.overlay;
  // The skills page is replaced by anything that names a chat or opens a
  // dialog overlay — those are chat-context surfaces. An overlay close
  // (overlay: null) keeps it: the dialog was rendered over the skills page.
  // A surface the patch opens replaces the others it does not name.
  const opensApps = next.apps !== undefined && next.apps !== null;
  const opensIntegrations = (next.integrations !== undefined && next.integrations !== null) || opensApps;
  const opensOther =
    (next.skills !== undefined && next.skills !== null) || (next.agents !== undefined && next.agents !== null);
  const sk =
    "skills" in next
      ? (next.skills as SkillsRoute | null)
      : "chatId" in next || (next.overlay !== undefined && next.overlay !== null) || opensIntegrations
        ? null
        : route.skills;
  // The agents surface is chat-independent too: naming an agents route
  // replaces the chat/skills page; any chat navigation drops it.
  const ag =
    "agents" in next
      ? (next.agents as AgentsRoute | null)
      : "chatId" in next || (next.overlay !== undefined && next.overlay !== null) || opensIntegrations
        ? null
        : route.agents;
  // The integrations page is chat-independent like skills and agents.
  const ig =
    "integrations" in next
      ? (next.integrations as IntegrationsRoute | null)
      : "chatId" in next || (next.overlay !== undefined && next.overlay !== null) || opensOther || "tab" in next
        ? null
        : route.integrations;
  // The Apps page is chat-independent like the others.
  const ap =
    "apps" in next
      ? (next.apps as AppsRoute | null)
      : "chatId" in next ||
          (next.overlay !== undefined && next.overlay !== null) ||
          opensOther ||
          (next.integrations !== undefined && next.integrations !== null) ||
          "tab" in next
        ? null
        : (route.apps ?? null);
  // A surface owns the whole address, so the tab is the chat root's — the
  // parse of a surface URL agrees. Keeping the tab the surface was opened
  // from would leave route state that the URL does not spell.
  const onSurface = sk !== null || ag !== null || ig !== null || ap !== null;
  const tab = onSurface ? "chats" : (next.tab ?? (projectId ? "chats" : route.tab));
  // The scratch composer is chatless: it drops with any open thread,
  // overlay, skills page or agents page, and never rides on Settings.
  const newChat =
    ("newChat" in next ? !!next.newChat : route.newChat) &&
    chatId === null &&
    ov === null &&
    sk === null &&
    ag === null &&
    ig === null &&
    ap === null &&
    tab !== "settings";
  // The Settings tab owns its section in the URL: a navigation naming a
  // section/detail carries it, one leaving the tab drops it, and a
  // section pick resets the sub-page unless the pick names one too. The
  // device dialog keeps the section (an overlay close restores it; the
  // dialog's URL detours through /chats regardless).
  const settingsSection =
    "settingsSection" in next
      ? (next.settingsSection as string | null)
      : tab === "settings" && sk === null && ag === null && ig === null && ap === null
        ? route.settingsSection
        : null;
  const settingsDetail =
    "settingsDetail" in next
      ? (next.settingsDetail as string | null)
      : "settingsSection" in next
        ? null
        : tab === "settings" && sk === null && ag === null && ig === null && ap === null
          ? route.settingsDetail
          : null;
  // The preview pane belongs to a thread: naming another chat closes it, and
  // a patch that does not mention it keeps the one that is open.
  const preview =
    chatId === null
      ? null
      : "preview" in next
        ? (next.preview as PreviewRef | null)
        : "chatId" in next && next.chatId !== route.chatId
          ? null
          : (route.preview ?? null);
  const previewFull = preview !== null && ("previewFull" in next ? !!next.previewFull : route.previewFull === true);
  return {
    chatId,
    projectId,
    overlay: ov,
    skills: sk,
    agents: ag,
    integrations: ig,
    ...(ap === null ? {} : { apps: ap }),
    tab,
    newChat,
    settingsSection,
    settingsDetail,
    usage: "usage" in next ? (next.usage as UsageQuery) : route.usage,
    preview,
    previewFull,
  };
};

/** Path segments, decoded, with empty segments dropped; null when an escape
 *  is malformed. */
const pathSegments = (pathname: string): string[] | null => {
  const decoded = pathname.split("/").filter(Boolean).map(decodeSegment);
  return decoded.some((s) => s === null) ? null : (decoded as string[]);
};

/** The canonical pathname of an agents or skills route when the address
 *  spells it differently — an unknown tab, a trailing segment the parser
 *  read past, or an old alias. Null when the address already is the
 *  canonical one, or the route is neither surface. */
export const canonicalSurfacePath = (route: ChatRoute, pathname: string): string | null => {
  if (route.agents === null && route.skills === null && route.integrations === null && (route.apps ?? null) === null)
    return null;
  const canonical = chatRoutePath(
    null,
    null,
    null,
    route.skills,
    "chats",
    null,
    null,
    false,
    route.agents,
    DEFAULT_USAGE,
    route.integrations,
    route.apps ?? null,
  ).split("?")[0];
  const want = pathSegments(canonical);
  const have = pathSegments(pathname);
  if (want === null || have === null) return null;
  return want.length === have.length && want.every((s, i) => s === have[i]) ? null : canonical;
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
  agents: AgentsRoute | null = null,
  usage: UsageQuery = DEFAULT_USAGE,
  integrations: IntegrationsRoute | null = null,
  apps: AppsRoute | null = null,
): string => {
  // The agents surface is chat-independent: its route owns the whole URL.
  if (agents !== null) return agentsRoutePath(agents);
  if (integrations !== null) return integrationsRoutePath(integrations);
  if (apps !== null) return appsRoutePath(apps);
  // Skills is chat-independent — top-level URL that replaces the chat view.
  if (skills !== null) return skillsRoutePath(skills);
  // The scratch composer can carry an explicit project binding.
  if (overlay === null && chatId === null && newChat && tab !== "settings") {
    if (projectId) return `/project/${encodeURIComponent(projectId)}/new`;
    return "/chats/new";
  }
  const base = projectId
    ? `/project/${encodeURIComponent(projectId)}${chatId ? `/thread/${encodeURIComponent(chatId)}` : ""}`
    : chatId
      ? `/thread/${encodeURIComponent(chatId)}`
      : tab === "settings"
        ? "/settings"
        : "/chats";
  if (overlay?.kind === "onboard") {
    // Chat-independent top-level route: any thread/project prefix drops.
    // /help deep links share the address (the guide is the help page).
    return "/onboard";
  }
  if (overlay?.kind === "install") {
    // Chat-independent like /onboard: any thread/project prefix drops.
    return "/install";
  }
  if (overlay?.kind === "device") {
    if (tab === "settings" && settingsSection === "machine") return "/settings/machine/device";
    // /settings/<seg> parses as a Settings-tab section, so a device dialog
    // pushed over the Settings tab detours through /chats — the dialog is
    // chat-independent anyway.
    return `${tab === "settings" ? "/chats" : base}/device`;
  }
  // The Settings tab owns /settings; a deep-linked section/detail rides in
  // the path (tab picks navigate to bare /settings and keep the pane-state
  // section instead).
  if (tab === "settings")
    return `/settings${settingsSection !== null ? `/${encodeURIComponent(settingsSection)}` : ""}${
      settingsDetail !== null ? `/${settingsDetail.split("/").map(encodeURIComponent).join("/")}` : ""
    }${settingsSection === "usage" ? usageQueryString(usage) : ""}`;
  return base || "/";
};

/** What decides an address's canonical form besides the route itself. */
export interface RouteContext {
  /** The signed-in user's workspace role. */
  role: string;
  /** The desktop engine (the fs bridge) is present. */
  hasEngine: boolean;
  /** The address the route was parsed from. */
  pathname: string;
}

/** The patch that moves a route to the address of the page it shows, or
 *  null when it already is there. An empty patch keeps the route and
 *  rewrites only the address. Applied with `replace`: a normalisation is
 *  not a step back.
 *  - A malformed address is the default route's.
 *  - Activity is an admin surface: a member lands on the agents directory
 *    (or the agent's overview for its activity tab).
 *  - A settings address names a section the role may open and a sub-page
 *    that section has; anything else is the default section.
 *  - The skills machine tab needs the engine; without one it is the catalog.
 *  - An agents or skills address the parser read past (an unknown tab, a
 *    trailing segment, an old alias) is the page it shows. */
export function canonicalRoute(route: ChatRoute, ctx: RouteContext): RoutePatch | null {
  if (route.invalid) return {};
  const a = route.agents;
  if (a !== null && ctx.role !== "admin") {
    if (a.view === "activity" || a.view === "run" || a.view === "trace" || a.view === "chat") {
      return { agents: AGENTS_DIRECTORY };
    }
    if (a.view === "agent" && a.tab === "activity") {
      return { agents: { view: "agent", agentId: a.agentId, tab: "overview" } };
    }
  }
  if (route.integrations !== null && ctx.role !== "admin") return { ...CHAT_ROOT, tab: "chats" };
  if (route.apps?.management && ctx.role !== "admin") return { apps: { appId: route.apps.appId } };
  if (
    route.tab === "settings" &&
    route.overlay === null &&
    route.skills === null &&
    a === null &&
    route.integrations === null &&
    (route.apps ?? null) === null
  ) {
    const shown = canonicalSettings(route.settingsSection, route.settingsDetail, ctx.role);
    if (shown.section !== route.settingsSection || shown.detail !== route.settingsDetail) {
      return { tab: "settings", settingsSection: shown.section, settingsDetail: shown.detail };
    }
  }
  if (route.skills !== null) {
    const clamped = clampSkillsRoute(route.skills, ctx.hasEngine);
    if (clamped !== route.skills) return { skills: clamped };
  }
  return canonicalSurfacePath(route, ctx.pathname) === null ? null : {};
}
