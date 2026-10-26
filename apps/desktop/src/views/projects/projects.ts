// Pure logic behind the project surfaces (spec docs/specs/2026-09-17-
// projects-wsl-design.md §5): sidebar grouping, composer chip label, and
// the WSL path specifier's state machine. No DOM, no I/O — the components
// drive the effects and feed events into pickerReducer.

import type { ChatSummary } from "../../lib/api/chats";
import type { DirEntry } from "../../lib/api/folders";
import type { Project } from "../../lib/api/projects";

// ---- sidebar grouping ----

export interface SidebarGrouping {
  /** Stateless (projectless) chats, most recently active first — the Recents
   *  list; chats bound to a project live only under that project's row. */
  visible: ChatSummary[];
  /** Each project's chats, most recently active first — the fold-out under
   *  the project row (Recents does not repeat them). */
  chatsByProject: Record<string, ChatSummary[]>;
}

/** The sidebar's sort key in epoch ms: the chat's latest thread activity
 *  (the server computes it — the latest thread event, falling back to the
 *  chat's creation), falling back to created_at for rows without it, and
 *  to 0 when neither parses (tests' placeholder stamps) — a NaN would make
 *  the comparator garbage, 0 keeps the stable server order instead. */
export function chatActivityMs(row: Pick<ChatSummary, "last_activity_at" | "created_at">): number {
  const t = Date.parse(row.last_activity_at ?? row.created_at);
  return Number.isNaN(t) ? 0 : t;
}

/** Most recently active first; the sort is stable, so equal keys keep the
 *  server's order (it tiebreaks by id). The server list arrives in this
 *  order already — the client-side re-sort matters when a live thread-event
 *  push moves a background chat's activity forward between list refreshes. */
export function byRecentActivity(a: ChatSummary, b: ChatSummary): number {
  return chatActivityMs(b) - chatActivityMs(a);
}

export function sidebarGrouping(chats: ChatSummary[] | null): SidebarGrouping {
  const list = chats ?? [];
  const chatsByProject: Record<string, ChatSummary[]> = {};
  const stateless: ChatSummary[] = [];
  for (const chat of list) {
    if (!chat.project_id) {
      stateless.push(chat);
      continue;
    }
    (chatsByProject[chat.project_id] ??= []).push(chat);
  }
  stateless.sort(byRecentActivity);
  for (const chats of Object.values(chatsByProject)) chats.sort(byRecentActivity);
  return { visible: stateless, chatsByProject };
}

/** The project fold-out opens showing this many chats, most recently active
 *  first. */
export const PROJECT_PAGE_INITIAL = 5;
/** Each "Show more" click reveals this many additional chats. */
export const PROJECT_PAGE_STEP = 20;

// ---- composer chip ----

export interface PickedProject {
  id: string;
  name: string;
  machine_label?: string | null;
  /** Local folder path, when the pick carried it (the send path resolves
   * the project's AGENTS.md chain from it — Codex semantics). */
  folder?: string;
}

/** Label on the composer's chip: the project name (plus its machine) when a
 * project is set, "Choose project" in the default projectless state. */
export function projectChipLabel(p: PickedProject | null | undefined): string {
  if (!p?.name) return "Choose project";
  return p.machine_label ? `${p.name} · ${p.machine_label}` : p.name;
}

/** Fallback chip state for an open chat, derived from the sidebar row. */
export function chatProjectOf(row: ChatSummary | undefined): PickedProject | null {
  if (!row?.project_id) return null;
  return {
    id: row.project_id,
    name: row.project_name ?? row.project_id,
    machine_label: row.project_machine_label,
  };
}

/** The project_id a gateway send carries: only a pick made in this session
 * rides on the request (request-wins). Otherwise the field is omitted and
 * the server falls back to the chat's persisted binding — a stale sidebar
 * row must never win over it (another device may have re-bound the chat). */
export function outgoingProjectId(picked: PickedProject | null | undefined): string | null {
  return picked?.id ?? null;
}

// ---- the picker dialog's recency ordering ----

/** Projects that have chats, most recently used first (recent-activity
 *  order — the same key the sidebar folds out by). */
export function recentProjects(chats: ChatSummary[] | null, projects: Project[]): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen: Project[] = [];
  for (const chat of [...(chats ?? [])].sort(byRecentActivity)) {
    if (!chat.project_id) continue;
    const p = byId.get(chat.project_id);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

export function filterProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => p.name.toLowerCase().includes(q));
}

// ---- WSL path specifier paths (UNC, `\\wsl.localhost\<distro>\…`) ----

export const WSL_HOST_PREFIX = "\\\\wsl.localhost\\";

export function wslRoot(distro: string): string {
  return `${WSL_HOST_PREFIX}${distro}\\`;
}

/** Joins a segment onto a canonical UNC path (trailing backslash). */
export function uncJoin(cwd: string, name: string): string {
  return cwd.endsWith("\\") ? `${cwd}${name}\\` : `${cwd}\\${name}\\`;
}

/** One level up; the distro root is the floor. */
export function uncUp(cwd: string): string {
  const body = cwd.replace(/\\+$/, "");
  if (!body.startsWith(WSL_HOST_PREFIX)) return cwd;
  const rest = body.slice(WSL_HOST_PREFIX.length);
  const cut = rest.lastIndexOf("\\");
  if (cut < 0) return `${body}\\`;
  return `${WSL_HOST_PREFIX}${rest.slice(0, cut + 1)}`;
}



/** Joins a segment onto a canonical Linux path (trailing slash). */
export function linuxJoin(cwd: string, name: string): string {
  return cwd.endsWith("/") ? `${cwd}${name}/` : `${cwd}/${name}/`;
}

/** One level up; the distro root `/` is the floor. */
export function linuxUp(cwd: string): string {
  const body = cwd.replace(/\/+$/, "");
  const cut = body.lastIndexOf("/");
  return `${body.slice(0, Math.max(cut, 0))}/` || "/";
}

/** Canonical Linux directory path: exactly one leading and trailing slash,
 * collapsed separators. The distro root is `/`. */
/** Canonical Linux directory path: exactly one leading and trailing slash,
 * collapsed separators. The distro root is `/`. */
export function linuxCanonical(path: string): string {
  const body = `/${path.replace(/^\/+/, "")}`
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  return `${body}/`;
}

/** Breadcrumbs of a canonical Linux path; the root crumb carries the
 * distro name (its label in the UI). */
export function linuxBreadcrumbs(
  distro: string,
  cwd: string,
): { label: string; path: string }[] {
  const segs = cwd.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  const out = [{ label: distro, path: "/" }];
  let acc = "/";
  for (const seg of segs) {
    acc = `${acc}${seg}/`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** The project folder (UNC) for a confirmed inner Linux path — the boundary
 * where the specifier's Linux view meets the server's stored form. */
export function wslFolder(distro: string, inner: string): string {
  return `${wslRoot(distro)}${inner.replace(/^\/+/, "").replace(/\//g, "\\")}`;
}

/** Shortens a path under the home to `~…` form (display only). */
export function displayPath(cwd: string, home: string | null): string {
  if (!home) return cwd;
  const h = home.replace(/\/+$/, "");
  if (cwd === `${h}/`) return "~";
  if (cwd.startsWith(`${h}/`)) return `~${cwd.slice(h.length)}`;
  return cwd;
}

/** Expands a typed path: a leading `~` maps onto the home directory; the
 * empty string means no navigation. */
export function expandPath(input: string, home: string | null): string | null {
  const t = input.trim();
  if (!t) return null;
  if (!home) return t === "~" ? null : t;
  if (t === "~") return `${home.replace(/\/+$/, "")}/`;
  if (t.startsWith("~/")) return linuxJoin(`${home.replace(/\/+$/, "")}/`, t.slice(2));
  return t;
}

/** The commit-time error for a typed path: a bare `~` needs the distro's
 * home directory. When the home lookup failed, the specifier shows this
 * inline error instead of silently descending into the current folder. */
export function expandError(input: string, homeUnc: string | null): string | null {
  const t = input.trim();
  if (t === "~" && !homeUnc) return "home directory unknown for this distro";
  return null;
}

/** Canonical directory path: one separator per boundary, exactly one
 * trailing backslash (the UNC \\server lead is preserved). */
export function canonicalDir(path: string): string {
  const trimmed = path.replace(/\\+$/, "");
  const unc = trimmed.startsWith("\\\\");
  const body = trimmed.slice(unc ? 2 : 0).replace(/\\+/g, "\\");
  return `${unc ? "\\\\" : ""}${body}\\`;
}

/** Breadcrumb segments of a canonical path, each with the (canonical) path
 * it jumps to. */
export function breadcrumbs(cwd: string): { label: string; path: string }[] {
  const body = cwd.replace(/\\+$/, "");
  const unc = body.startsWith("\\\\");
  const segs = body.split("\\").filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = unc ? "\\\\" : "";
  segs.forEach((seg, i) => {
    if (i === 0 && unc) acc += seg;
    else if (seg.endsWith(":")) acc += `${seg}\\`;
    else acc += `\\${seg}`;
    out.push({ label: seg, path: canonicalDir(acc) });
  });
  return out;
}

// ---- specifier state machine: sources → browse → confirm ----

export interface PickerState {
  /** The chosen folder source: the distro name for a WSL row, null while
   * the source list shows. */
  source: string | null;
  /** The absolute inner path being listed (canonical Linux: trailing slash). */
  cwd: string | null;
  /** The listing of `cwd`; null while loading or after a failed listing. */
  entries: DirEntry[] | null;
  /** Highlighted row index within `entries`. */
  highlight: number;
  error: string | null;
  /** Set by `confirm`: the folder the dialog returns. */
  confirmed: string | null;
}

export type PickerEvent =
  | { type: "choose_source"; source: string; root: string }
  | { type: "loading"; path: string }
  | { type: "loaded"; path: string; entries: DirEntry[] }
  | { type: "failed"; path: string; error: string }
  | { type: "error"; message: string }
  | { type: "descend" }
  | { type: "up" }
  | { type: "go"; path: string }
  | { type: "highlight"; index: number }
  | { type: "confirm" };

/** A fresh state machine, pointed at one source's root (loading starts on
 * the first `loading` event). */
export function pickerFor(source: string, root: string): PickerState {
  return {
    source,
    cwd: root,
    entries: null,
    highlight: 0,
    error: null,
    confirmed: null,
  };
}

/** Pure browse state machine: path moves reset the listing; events for a
 * stale path are dropped so a slow listing never lands on the wrong cwd. */
export function pickerReducer(state: PickerState, event: PickerEvent): PickerState {
  switch (event.type) {
    case "choose_source":
      return pickerFor(event.source, event.root);
    case "loading":
      return state.cwd === event.path
        ? { ...state, entries: null, error: null }
        : state;
    case "loaded":
      return state.cwd === event.path
        ? { ...state, entries: event.entries, highlight: 0, error: null }
        : state;
    case "failed":
      return state.cwd === event.path
        ? { ...state, entries: null, error: event.error }
        : state;
    case "error":
      return { ...state, error: event.message };
    case "descend": {
      const entry = state.entries?.[state.highlight];
      if (!state.cwd || !entry?.is_dir) return state;
      return {
        ...state,
        cwd: linuxJoin(state.cwd, entry.name),
        entries: null,
        highlight: 0,
        error: null,
      };
    }
    case "up": {
      if (!state.cwd) return state;
      return { ...state, cwd: linuxUp(state.cwd), entries: null, highlight: 0, error: null };
    }
    case "go": {
      if (!event.path) return state;
      return {
        ...state,
        cwd: linuxCanonical(event.path),
        entries: null,
        highlight: 0,
        error: null,
      };
    }
    case "highlight":
      return { ...state, highlight: Math.max(0, event.index) };
    case "confirm":
      return state.entries === null ? state : { ...state, confirmed: state.cwd };
  }
}
