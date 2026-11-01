// The thread view's URL model: the pathname is the single source of truth for
// where the user is. Every page, tab, panel and sub-page the user can reach
// has its own fixed address (the AGENTS.md convention). Routes:
//   /chats[/new]               — the Chats tab (default; "/" aliases);
//                                /new is the addressed scratch composer
//   /work[/new]                — the Work tab, with its scratch composer
//   /thread/<id>               — open thread (the only thread address; an
//                                agent thread's /agents/<id>/threads/<tid>
//                                form redirects here)
//   /project/<id>              — sidebar filtered to one project (Work tab)
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
//   /skills[/activity|/machine|/<slug>[/edit] | /new]
//                              — the skills page (top-level; replaces the
//                                main pane): tab views, a detail page, the
//                                editor in edit or create mode. See
//                                skills-route.ts for the state contract.
// Back/forward, reloads and deep links all resolve through parseChatRoute.
import {
  AGENTS_ACTIVITY,
  agentsRoutePath,
  parseAgentsRoute,
  type AgentsRoute,
} from "../agents/agents-route";
import { SKILLS_CATALOG, type SkillsRoute } from "../skills/skills-route";
import {
  DEFAULT_USAGE,
  parseUsageQuery,
  usageQueryString,
  type UsageQuery,
} from "../settings/usage-route";

export type ChatOverlay =
  | { kind: "device" }
  | { kind: "onboard" }
  | { kind: "install" }
  | null;
export interface ChatRoute {
  chatId: string | null;
  /** Sidebar project filter (deep-linked /project/<id>). */
  projectId: string | null;
  overlay: ChatOverlay;
  /** The skills page route, or null when the URL is not a skills one. */
  skills: SkillsRoute | null;
  /** The agents surface route, or null when the URL is not an agents one. */
  agents: AgentsRoute | null;
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
  /** The usage section's query state (?period=&group=&metric=); defaults on
   *  every other route. */
  usage: UsageQuery;
  /** Set when the pathname held a malformed escape: the route is the default
   *  one and the caller rewrites the address (a reload must not re-enter it). */
  invalid?: true;
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
export const isImeEnter = (e: {
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean => e.nativeEvent?.isComposing === true || e.keyCode === 229;

export const parseChatRoute = (pathname: string, search = ""): ChatRoute => {
  const usage = parseUsageQuery(search);
  const raw = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
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
      tab: "chats",
      newChat: false,
      settingsSection: null,
      settingsDetail: null,
      usage,
    };
  }
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
    return { chatId, projectId, tab, overlay: { kind: "device" }, skills: null, agents: null, settingsSection: null, settingsDetail: null, usage, newChat: false };
  if (parts[0] === "onboard" || parts[0] === "help")
    return { chatId: null, projectId: null, tab: "chats", overlay: { kind: "onboard" }, skills: null, agents: null, settingsSection: null, settingsDetail: null, usage, newChat: false };
  if (parts[0] === "install")
    return { chatId: null, projectId: null, tab: "chats", overlay: { kind: "install" }, skills: null, agents: null, settingsSection: null, settingsDetail: null, usage, newChat: false };
  if (parts[0] === "settings") {
    // Bare /settings normalizes to the default section (/settings/account,
    // via the pane effect); a section (and optional sub-page detail)
    // preselects it. Everything after the section is the sub-page id; each
    // segment was encoded separately, so a model id like "a/b" round-trips
    // as one part.
    const section = parts.length > 1 ? parts[1] : null;
    // Segments arrive decoded once (each was encoded separately), so a model
    // id containing a literal "%" round-trips; a second decode would throw.
    const detail = parts.length > 2 ? parts.slice(2).join("/") : null;
    return {
      chatId: null,
      projectId: null,
      tab: "settings",
      overlay: null,
      skills: null,
      agents: null,
      settingsSection: section,
      settingsDetail: detail,
      usage,
      newChat: false,
    };
  }
  // Skills is chat-independent and top-level like settings: the URL drops
  // any thread/project prefix, so the skills page replaces the chat.
  if (parts[0] === "skills") {
    const skills = parseSkillsRoute(parts.slice(1));
    return { chatId: null, projectId: null, overlay: null, skills, agents: null, tab: "chats", settingsSection: null, settingsDetail: null, usage, newChat: false };
  }
  return { chatId, projectId, tab, overlay: null, skills: null, agents: null, settingsSection: null, settingsDetail: null, usage, newChat };
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

export interface RoutePatch {
  chatId?: string | null;
  projectId?: string | null;
  overlay?: ChatOverlay;
  skills?: SkillsRoute | null;
  agents?: AgentsRoute | null;
  tab?: ChatRoute["tab"];
  newChat?: boolean;
  settingsSection?: string | null;
  settingsDetail?: string | null;
  usage?: UsageQuery;
}

/** The route a navigation lands on: history and route state move together,
 *  so the URL always reflects what is on screen. Pure for tests. */
export const applyRoutePatch = (route: ChatRoute, next: RoutePatch): ChatRoute => {
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
  // The agents surface is chat-independent too: naming an agents route
  // replaces the chat/skills page; any chat navigation drops it.
  const ag =
    "agents" in next
      ? (next.agents as AgentsRoute | null)
      : "chatId" in next || (next.overlay !== undefined && next.overlay !== null)
        ? null
        : route.agents;
  // The scratch composer is chatless: it drops with any open thread,
  // overlay, skills page or agents page, and never rides on Settings.
  const newChat =
    ("newChat" in next ? !!next.newChat : route.newChat) &&
    chatId === null &&
    ov === null &&
    sk === null &&
    ag === null &&
    tab !== "settings";
  // The Settings tab owns its section in the URL: a navigation naming a
  // section/detail carries it, one leaving the tab drops it, and a
  // section pick resets the sub-page unless the pick names one too. The
  // device dialog keeps the section (an overlay close restores it; the
  // dialog's URL detours through /chats regardless).
  const settingsSection =
    "settingsSection" in next
      ? (next.settingsSection as string | null)
      : tab === "settings" && sk === null && ag === null
        ? route.settingsSection
        : null;
  const settingsDetail =
    "settingsDetail" in next
      ? (next.settingsDetail as string | null)
      : "settingsSection" in next
        ? null
        : tab === "settings" && sk === null && ag === null
          ? route.settingsDetail
          : null;
  return { chatId, projectId, overlay: ov, skills: sk, agents: ag, tab, newChat, settingsSection, settingsDetail, usage: "usage" in next ? (next.usage as UsageQuery) : route.usage };
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
): string => {
  // The agents surface is chat-independent: its route owns the whole URL.
  if (agents !== null) return agentsRoutePath(agents);
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
  if (overlay?.kind === "install") {
    // Chat-independent like /onboard: any thread/project prefix drops.
    return "/install";
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
    }${settingsSection === "usage" ? usageQueryString(usage) : ""}`;
  return base || "/";
};
