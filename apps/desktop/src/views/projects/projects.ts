// Pure logic behind the project surfaces (spec docs/specs/2026-09-17-
// projects-wsl-design.md §5): sidebar grouping, composer chip label, and
// the WSL path specifier's state machine. No DOM, no I/O — the components
// drive the effects and feed events into pickerReducer.

import type { ChatSummary, DirEntry, Project } from "../../transport";

// ---- sidebar grouping ----

export interface SidebarGrouping {
  /** The thread rows for the active view: the selected project's chats, or
   * every chat (recency order) when no project is selected. */
  visible: ChatSummary[];
  /** Chat count per project id (badge on the project rows). */
  counts: Record<string, number>;
}

export function sidebarGrouping(
  chats: ChatSummary[] | null,
  selectedProjectId: string | null,
): SidebarGrouping {
  const list = chats ?? [];
  const counts: Record<string, number> = {};
  for (const chat of list) {
    if (chat.project_id) counts[chat.project_id] = (counts[chat.project_id] ?? 0) + 1;
  }
  const visible = selectedProjectId
    ? list.filter((c) => c.project_id === selectedProjectId)
    : list;
  return { visible, counts };
}

// ---- composer chip ----

export interface PickedProject {
  id: string;
  name: string;
  machine_label?: string | null;
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

// ---- the picker dialog's recency ordering ----

/** Projects that have chats, most recently used first (chat list order). */
export function recentProjects(chats: ChatSummary[] | null, projects: Project[]): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen: Project[] = [];
  for (const chat of chats ?? []) {
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

/** Converts the distro's LINUX $HOME into its UNC form. */
export function wslHomeUnc(distro: string, home: string): string {
  return `${wslRoot(distro)}${home.replace(/^\/+/, "").replace(/\//g, "\\")}`;
}

/** Shortens a path under the home to `~…` form (display only). */
export function displayPath(cwd: string, homeUnc: string | null): string {
  if (!homeUnc) return cwd;
  const home = homeUnc.replace(/\\+$/, "");
  if (cwd === `${home}\\`) return "~";
  if (cwd.startsWith(`${home}\\`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/** Expands a typed path: a leading `~` maps onto the home directory; the
 * empty string means no navigation. */
export function expandPath(input: string, homeUnc: string | null): string | null {
  const t = input.trim();
  if (!t) return null;
  if (!homeUnc) return t === "~" ? null : t;
  if (t === "~") return homeUnc;
  if (t.startsWith("~/") || t.startsWith("~\\")) return uncJoin(homeUnc, t.slice(2));
  return t;
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
  /** The absolute path being listed (canonical: trailing backslash). */
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
    case "descend": {
      const entry = state.entries?.[state.highlight];
      if (!state.cwd || !entry?.is_dir) return state;
      return {
        ...state,
        cwd: uncJoin(state.cwd, entry.name),
        entries: null,
        highlight: 0,
        error: null,
      };
    }
    case "up": {
      if (!state.cwd) return state;
      return { ...state, cwd: uncUp(state.cwd), entries: null, highlight: 0, error: null };
    }
    case "go": {
      if (!event.path) return state;
      return {
        ...state,
        cwd: canonicalDir(event.path),
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
