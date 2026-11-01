// The agents surface URL contract. Every page, tab and sub-page has one
// fixed address so deep links, reloads and back/forward land exactly where
// the user was. Pure parse/format functions only — the view never keeps
// navigation in local state.

export type AgentTab =
  | "overview"
  | "threads"
  | "routines"
  | "files"
  | "activity"
  | "settings";

export type ActivityTab = "traces" | "calls" | "chats";
export type ActivityPeriod = "24h" | "7d" | "30d";

/** The activity list's filters. They live in the route, never in view
 *  state, so a filter change is a history entry and reload restores it. */
export interface ActivityFilters {
  tab: ActivityTab;
  period: ActivityPeriod;
  status: string;
  trigger: string;
  q: string;
  caller: string;
  model: string;
}

export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
  tab: "traces",
  period: "7d",
  status: "all",
  trigger: "all",
  q: "",
  caller: "all",
  model: "",
};

/** The reading a trace page shows its spans in. */
export type TraceView = "transcript" | "tree" | "timeline";

/** The agent-create wizard's steps, in order. */
export type CreateStep = "name" | "model" | "tools" | "visibility";
export const CREATE_STEPS: readonly CreateStep[] = ["name", "model", "tools", "visibility"];

export type AgentsRoute =
  | { view: "directory" }
  /** `step` absent = the first step. */
  | { view: "new"; step?: CreateStep }
  | {
      view: "agent";
      agentId: string;
      tab: AgentTab;
      routineId?: string;
      filePath?: string;
      filters?: ActivityFilters;
    }
  | { view: "activity"; filters: ActivityFilters }
  /** `traceView` absent = the transcript. */
  | { view: "run"; runId: string; traceView?: TraceView }
  | { view: "trace"; traceId: string; traceView?: TraceView }
  | { view: "chat"; chatId: string };

export const AGENTS_DIRECTORY: AgentsRoute = { view: "directory" };
export const AGENTS_ACTIVITY: AgentsRoute = {
  view: "activity",
  filters: DEFAULT_ACTIVITY_FILTERS,
};

/** The non-default trace view a query names, as route fields. */
function traceViewFrom(search: string): { traceView?: TraceView } {
  const value = new URLSearchParams(search).get("view");
  return value === "tree" || value === "timeline" ? { traceView: value } : {};
}

function traceViewSearch(view: TraceView | undefined): string {
  return view === undefined || view === "transcript" ? "" : `?view=${view}`;
}

function filtersFrom(search: string): ActivityFilters {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const period = params.get("period");
  return {
    tab:
      tab === "calls" || tab === "chats" || tab === "sessions"
        ? tab === "sessions"
          ? "chats"
          : tab
        : DEFAULT_ACTIVITY_FILTERS.tab,
    period: period === "24h" || period === "30d" ? period : DEFAULT_ACTIVITY_FILTERS.period,
    status: params.get("status") ?? DEFAULT_ACTIVITY_FILTERS.status,
    trigger: params.get("trigger") ?? DEFAULT_ACTIVITY_FILTERS.trigger,
    q: params.get("q") ?? DEFAULT_ACTIVITY_FILTERS.q,
    caller: params.get("caller") ?? DEFAULT_ACTIVITY_FILTERS.caller,
    model: params.get("model") ?? DEFAULT_ACTIVITY_FILTERS.model,
  };
}

function filtersSearch(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const fallback = DEFAULT_ACTIVITY_FILTERS[key as keyof ActivityFilters];
    if (value === "" || value === "all" || value === fallback) continue;
    params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export const AGENT_TABS: ReadonlyArray<readonly [AgentTab, string]> = [
  ["overview", "Overview"],
  ["threads", "Threads"],
  ["routines", "Routines"],
  ["files", "Files"],
  ["activity", "Activity"],
  ["settings", "Settings"],
];


const decode = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** One path segment encoded for the URL. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Parses any pathname owned by the agents surface. Null when the pathname
 *  is not an agents route (the chat router then keeps its own route). */
export function parseAgentsRoute(url: string): AgentsRoute | null {
  const [pathname, search = ""] = url.split("?");
  const raw = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const decoded = raw.map(decode);
  if (decoded.some((part) => part === null)) return null;
  const parts = decoded as string[];
  if (parts.length === 0) return null;

  if (parts[0] === "activity" && parts.length === 1)
    return { view: "activity", filters: filtersFrom(search) };
  if (parts[0] === "runs" && parts[1])
    return { view: "run", runId: parts[1], ...traceViewFrom(search) };
  // A turn with no agent run has no run id; its trace id owns its own route.
  if (parts[0] === "traces" && parts[1])
    return { view: "trace", traceId: parts[1], ...traceViewFrom(search) };
  // Old activity chat links used /sessions/<id>; they now resolve to the
  // canonical /chats/<id> address.
  if ((parts[0] === "chats" || parts[0] === "sessions") && parts[1] && parts[1] !== "new" && parts[1] !== "device")
    return { view: "chat", chatId: parts[1] };
  if (parts[0] !== "agents") return null;
  if (parts.length === 1) return AGENTS_DIRECTORY;
  if (parts[1] === "new" && parts.length <= 3) {
    const step = CREATE_STEPS.find((s) => s === parts[2] && s !== "name");
    return step === undefined ? { view: "new" } : { view: "new", step };
  }

  const agentId = parts[1];
  if (!agentId) return AGENTS_DIRECTORY;
  const rest = parts.slice(2);
  if (rest.length === 0) return { view: "agent", agentId, tab: "overview" };
  const head = rest[0];
  // Threads have one address: /thread/<chatId>. The tab has no per-thread
  // sub-route; an old /threads/<tid> link lands on the list.
  if (head === "threads") return { view: "agent", agentId, tab: "threads" };
  if (head === "routines") {
    return rest[1]
      ? { view: "agent", agentId, tab: "routines", routineId: rest[1] }
      : { view: "agent", agentId, tab: "routines" };
  }
  if (head === "files") {
    const filePath = rest.slice(1).join("/");
    return filePath
      ? { view: "agent", agentId, tab: "files", filePath }
      : { view: "agent", agentId, tab: "files" };
  }
  if (head === "activity")
    return { view: "agent", agentId, tab: "activity", filters: filtersFrom(search) };
  if (head === "settings") return { view: "agent", agentId, tab: "settings" };
  // An unknown tab segment is the agent root, not a dead URL.
  return { view: "agent", agentId, tab: "overview" };
}

/** Canonical pathname for one agents route. */
export function agentsRoutePath(route: AgentsRoute): string {
  switch (route.view) {
    case "directory":
      return "/agents";
    case "new":
      return route.step === undefined || route.step === "name"
        ? "/agents/new"
        : `/agents/new/${route.step}`;
    case "activity":
      return `/activity${filtersSearch(route.filters)}`;
    case "run":
      return `/runs/${segment(route.runId)}${traceViewSearch(route.traceView)}`;
    case "trace":
      return `/traces/${segment(route.traceId)}${traceViewSearch(route.traceView)}`;
    case "chat":
      return `/chats/${segment(route.chatId)}`;
    case "agent": {
      const base = `/agents/${segment(route.agentId)}`;
      if (route.tab === "overview") return base;
      if (route.tab === "routines" && route.routineId)
        return `${base}/routines/${segment(route.routineId)}`;
      if (route.tab === "files" && route.filePath)
        return `${base}/files/${route.filePath
          .split("/")
          .filter(Boolean)
          .map(segment)
          .join("/")}`;
      if (route.tab === "activity")
        return `${base}/activity${filtersSearch(route.filters ?? DEFAULT_ACTIVITY_FILTERS)}`;
      return `${base}/${route.tab}`;
    }
  }
}

/** The agent tab a route renders; directory/new/global views have none. */
export function agentsRouteTab(route: AgentsRoute): AgentTab | null {
  return route.view === "agent" ? route.tab : null;
}

/** The rail tab that owns an agents route. */
export function agentsRailTab(
  route: AgentsRoute,
): "agents" | "activity" {
  if (route.view === "activity" || route.view === "run" || route.view === "trace" || route.view === "chat")
    return "activity";
  return "agents";
}

/** A route for one agent tab, dropping sub-page ids that do not belong. */
export function agentTabRoute(agentId: string, tab: AgentTab): AgentsRoute {
  return tab === "activity"
    ? { view: "agent", agentId, tab, filters: DEFAULT_ACTIVITY_FILTERS }
    : { view: "agent", agentId, tab };
}

/** Breadcrumbs for a workspace path. The root crumb is the workspace. */
export function fileBreadcrumbs(
  path: string,
): { label: string; path: string }[] {
  const clean = path.replace(/^\/+|\/+$/g, "");
  const out = [{ label: "Workspace", path: "" }];
  if (clean === "") return out;
  let acc = "";
  for (const part of clean.split("/").filter(Boolean)) {
    acc = acc === "" ? part : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** Parent directory of a workspace path ("" is the root). */
export function parentPath(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  const cut = clean.lastIndexOf("/");
  return cut < 0 ? "" : clean.slice(0, cut);
}

/** Joins a child onto a workspace path without a leading slash. */
export function joinPath(parent: string, child: string): string {
  const clean = parent.replace(/^\/+|\/+$/g, "");
  return clean === "" ? child : `${clean}/${child}`;
}

/** File extension in lowercase, without the dot; "" for no extension. */
export function fileExtension(name: string): string {
  const cut = name.lastIndexOf(".");
  return cut <= 0 ? "" : name.slice(cut + 1).toLowerCase();
}

/** How the file preview renders a name. */
export type FilePreviewKind =
  | "text"
  | "image"
  | "pdf"
  | "csv"
  | "audio"
  | "video"
  | "binary";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "toml", "ini",
  "cfg", "conf", "log", "csv", "tsv", "js", "jsx", "ts", "tsx", "css",
  "html", "htm", "xml", "svg", "sh", "bash", "zsh", "fish", "py", "rb",
  "go", "rs", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sql", "graphql", "gql", "vue", "svelte", "lua", "r", "swift", "m",
  "dockerfile", "makefile", "gitignore", "env", "lock",
]);

/** Preview kind from a file name. Unknown extensions are binary downloads. */
export function previewKindOf(name: string): FilePreviewKind {
  const ext = fileExtension(name);
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].includes(ext))
    return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "csv";
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv", "ogv"].includes(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "silent"
  | "skipped"
  | "cancelled";

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  silent: "Silent",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export type RunTrigger = "message" | "routine" | "manual" | "delegation";

export const RUN_TRIGGER_LABEL: Record<RunTrigger, string> = {
  message: "Message",
  routine: "Routine",
  manual: "Manual",
  delegation: "Delegation",
};

/** Semantic tone used by status badges. */
export type Tone = "neutral" | "success" | "warning" | "danger" | "info";


export type AgentStatus = "active" | "archived" | "deleting" | "deleted";
export type AgentVisibility = "private" | "team" | "org";

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  active: "Active",
  archived: "Archived",
  deleting: "Deleting",
  deleted: "Deleted",
};

export const VISIBILITY_LABEL: Record<AgentVisibility, string> = {
  private: "Private",
  team: "Team",
  org: "Organization",
};

