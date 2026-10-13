// Skills page (Skills rail tab): a full main-column page, not a sidebar
// panel. Catalog | Activity | On this machine tabs. Catalog is the org
// skill catalog as compact rows with filter/sort selects and a search box;
// Activity is the org event feed with the All / Changes pill filter; On
// this machine (Tauri only) manages the local skill folders and the
// signed-in user's org installs. The page is URL-driven: the tab, the open
// detail slug and the editor all come from the /skills... route and every
// user action navigates through onNavigate (see skills-route.ts); only the
// catalog's search/filter/sort stay local component state.

import { useEffect, useRef, useState } from "react";
import { Lock, Search } from "lucide-react";
import { IS_TAURI } from "../../transport";
import { Input } from "@guild/ui/components/input";
import { Button } from "@guild/ui/components/button";
import { Badge } from "@guild/ui/components/badge";
import { Skeleton } from "@guild/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { SkillDetail } from "./SkillDetail";
import { SkillEditor } from "./SkillEditor";
import { ActivityFeed } from "./ActivityFeed";
import LocalSkills from "./LocalSkills";
import {
  skillsPageState,
  skillsRefetch,
  type SkillsRoute,
} from "./skills-route";
import {
  fetchInstalls,
  skillsList,
  type SkillInstall,
  type SkillItem,
  type SkillMe,
} from "./skills-api";

/** One catalog row's view model. */
export interface SkillRow {
  slug: string;
  description: string;
  ownerLabel: string;
  /** "v3 · 12 installs" — versions arrive as "vN" from the server. */
  meta: string;
  gated: boolean;
  /** The viewer's pinned version ("v2"), or null when not installed. */
  pin: string | null;
  /** The latest version when the viewer's pin is behind it, else null. */
  updateTo: string | null;
}

export function skillRow(item: SkillItem, install: SkillInstall | null | undefined): SkillRow {
  const pin = install?.pinned_version ?? null;
  const updateTo =
    pin !== null && item.latest_version !== null && pin !== item.latest_version
      ? item.latest_version
      : null;
  const meta = `${item.latest_version ?? "—"} · ${item.installs} install${item.installs === 1 ? "" : "s"}`;
  return {
    slug: item.slug,
    description: item.description,
    ownerLabel: item.owner?.label ?? "",
    meta,
    gated: item.maintainer_gated,
    pin,
    updateTo,
  };
}

/** First two characters of the owner label, for the initials avatar. */
export function ownerInitials(label: string): string {
  return label.slice(0, 2).toUpperCase();
}

/** True when the skill is owned by the signed-in user (the server's owner
 *  label is display name falling back to email). */
export function isMine(item: SkillItem, me: SkillMe): boolean {
  if (item.owner?.kind !== "user") return false;
  return (
    (me.displayName !== undefined && item.owner.label === me.displayName) ||
    (me.email !== undefined && item.owner.label === me.email)
  );
}

/** The catalog's filter kinds, in Select order. */
export type SkillFilterKind = "all" | "installed" | "mine" | "approval";

export const skillFilterOptions: ReadonlyArray<readonly [SkillFilterKind, string]> = [
  ["all", "All skills"],
  ["installed", "Installed"],
  ["mine", "Mine"],
  ["approval", "Approval required"],
];

/** The catalog's sort keys, in Select order. */
export type SkillSortKey = "installs" | "updated" | "az";

export const skillSortOptions: ReadonlyArray<readonly [SkillSortKey, string]> = [
  ["installs", "Most installed"],
  ["updated", "Recently updated"],
  ["az", "A → Z"],
];

/** Numeric suffix of a "vN" version, 0 for anything else. */
export function versionRank(version: string): number {
  const match = /^v(\d+)$/.exec(version);
  return match === null ? 0 : Number(match[1]);
}

/** Client-side filter over slug, description and owner label
 * (case-insensitive; the server already applied its own `q` when set). */
export function filterSkills(items: SkillItem[], query: string): SkillItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter(
    (s) =>
      s.slug.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle) ||
      (s.owner?.label.toLowerCase().includes(needle) ?? false),
  );
}

/** The filter select's client-side cut. `installedSlugs` carries the
 *  slugs behind the viewer's install records. */
export function filterByKind(
  items: SkillItem[],
  kind: SkillFilterKind,
  ctx: { installedSlugs: ReadonlySet<string>; me: SkillMe },
): SkillItem[] {
  switch (kind) {
    case "all":
      return items;
    case "installed":
      return items.filter((s) => ctx.installedSlugs.has(s.slug));
    case "mine":
      return items.filter((s) => isMine(s, ctx.me));
    case "approval":
      return items.filter((s) => s.maintainer_gated);
  }
}

/** The sort select's ordering; sorts are stable copies. */
export function sortSkills(items: SkillItem[], key: SkillSortKey): SkillItem[] {
  const copy = [...items];
  switch (key) {
    case "installs":
      return copy.sort((a, b) => b.installs - a.installs || a.slug.localeCompare(b.slug));
    case "updated":
      // The catalog carries no publish timestamps, so recency is
      // approximated by version order (versions only ever grow).
      return copy.sort((a, b) => versionRank(b.latest_version ?? "") - versionRank(a.latest_version ?? "") || a.slug.localeCompare(b.slug));
    case "az":
      return copy.sort((a, b) => a.slug.localeCompare(b.slug));
  }
}

/** Empty-state text, or null when rows render. `filtered` distinguishes a
 *  genuinely empty catalog from a filter/search that cut everything. */
export function skillsEmptyState(query: string, count: number, filtered = false): string | null {
  if (count > 0) return null;
  const needle = query.trim();
  if (needle !== "") return `No skills match "${needle}".`;
  return filtered ? "No skills match the current filter." : "No skills yet.";
}

/** The panel's tabs: the catalog rows, the activity feed, and the
 *  local-machine group — "machine" exists only in Tauri sessions (it
 *  needs the desktop fs bridge). */
export type SkillsTab = "catalog" | "activity" | "machine";

export function panelTabs(isTauri: boolean): ReadonlyArray<readonly [SkillsTab, string]> {
  const tabs: Array<readonly [SkillsTab, string]> = [
    ["catalog", "Catalog"],
    ["activity", "Activity"],
  ];
  if (isTauri) tabs.push(["machine", "On this machine"]);
  return tabs;
}

/** Declarative contract for the page header, rendered as one row: title,
 *  search input, filter + sort selects, New skill action and the tab bar —
 *  and deliberately no collapse control: this is a full page, not a
 *  sidebar panel. */
export function skillsPageHeader(isTauri: boolean): {
  title: string;
  searchPlaceholder: string;
  newSkill: boolean;
  tabs: ReadonlyArray<readonly [SkillsTab, string]>;
  collapseButton: boolean;
} {
  return {
    title: "Skills",
    searchPlaceholder: "Search skills",
    newSkill: true,
    tabs: panelTabs(isTauri),
    collapseButton: false,
  };
}

export function SkillsPanel({
  me,
  route,
  onNavigate,
}: {
  me: SkillMe;
  /** The /skills... route this page renders (already clamped to what this
   *  session can show — see clampSkillsRoute). Tab, detail slug and editor
   *  all derive from it; search/filter/sort stay local (not URL state). */
  route: SkillsRoute;
  /** User navigation: replaces the /skills... route (pushState + route
   *  state move together in WebChat, like every other navigation). */
  onNavigate: (next: SkillsRoute) => void;
}) {
  const { tab, selected, editor } = skillsPageState(route);
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [installs, setInstalls] = useState<SkillInstall[] | null>(null);
  const [query, setQuery] = useState("");
  const [filterKind, setFilterKind] = useState<SkillFilterKind>("all");
  const [sortKey, setSortKey] = useState<SkillSortKey>("installs");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([skillsList(), fetchInstalls()]).then(([items, myInstalls]) => {
      if (!live) return;
      setSkills(items);
      setInstalls(myInstalls);
    });
    return () => {
      live = false;
    };
  }, [tick]);

  // Arriving at the catalog from a detail page or the editor refetches:
  // actions that change visibility or versions (unpublish, save) must not
  // leave a stale row in the list. Route-driven, so the browser's back
  // button refetches exactly like the page's own Back control.
  const prevRouteRef = useRef(route);
  useEffect(() => {
    const prev = prevRouteRef.current;
    prevRouteRef.current = route;
    if (skillsRefetch(prev, route)) setTick((t) => t + 1);
  }, [route]);

  const installedSlugs = new Set((installs ?? []).map((i) => i.slug));
  const search = filterSkills(skills ?? [], query);
  const kind = filterByKind(search, filterKind, { installedSlugs, me });
  const filtered = sortSkills(kind, sortKey);
  const empty =
    skills === null
      ? null
      : skillsEmptyState(query, filtered.length, filterKind !== "all" || query.trim() !== "");

  if (editor !== null) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        <SkillEditor
          mode={editor.mode}
          slug={editor.slug}
          // Cancel returns to the owning catalog URL; the save below is the
          // one editor exit that carries the saved slug forward.
          onBack={() => onNavigate({ view: "catalog", slug: null, editor: null })}
          onSaved={(slug) => onNavigate({ view: "catalog", slug, editor: null })}
        />
      </div>
    );
  }

  if (selected !== null) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        <SkillDetail
          slug={selected}
          me={me}
          // Back refetches the catalog (the route transition drives it):
          // actions that change visibility (unpublish) must not leave a
          // stale row in the list.
          onBack={() => onNavigate({ view: "catalog", slug: null, editor: null })}
          onOpenSkill={(slug) => onNavigate({ view: "catalog", slug, editor: null })}
          onEdit={(slug) => onNavigate({ view: "catalog", slug, editor: slug })}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {/* page header: title, search, filter + sort, New skill and the tab
          bar in one wrapping row */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <span className="font-semibold">Skills</span>
        <div className="w-full max-w-64 sm:w-auto sm:flex-1 sm:max-w-sm">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              placeholder="Search skills"
              aria-label="Search skills"
              className="pl-8"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <Select
          value={filterKind}
          onValueChange={(v) => setFilterKind(v as SkillFilterKind)}
        >
          <SelectTrigger aria-label="Filter skills" className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {skillFilterOptions.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SkillSortKey)}>
          <SelectTrigger aria-label="Sort skills" className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {skillSortOptions.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          {panelTabs(IS_TAURI).map(([value, label]) => (
            <Button
              key={value}
              variant={tab === value ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === value}
              aria-label={`${label} tab`}
              onClick={() => onNavigate({ view: value, slug: null, editor: null })}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="flex flex-1 items-center justify-end">
          <Button
            variant="outline"
            size="sm"
            aria-label="New skill"
            onClick={() => onNavigate({ view: "catalog", slug: null, editor: "new" })}
          >
            New skill
          </Button>
        </span>
      </div>
      {/* page body: full-width background fill, content capped so the row
          list and detail panes don't stretch absurdly on wide monitors */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <div className="mx-auto w-full max-w-5xl px-4 py-4">
          {tab === "activity" && <ActivityFeed />}
          {tab === "machine" && IS_TAURI && <LocalSkills />}
          {tab === "catalog" && (
            <div className="flex flex-col gap-1.5">
              {skills === null &&
                [0, 1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-md" style={{ opacity: 1 - (i % 3) * 0.15 }} />
                ))}
              {skills !== null &&
                filtered.map((item) => {
                  const row = skillRow(
                    item,
                    installs?.find((i) => i.slug === item.slug) ?? null,
                  );
                  return (
                    <div
                      key={row.slug}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open skill ${row.slug}`}
                      className="cursor-pointer rounded-md border border-border px-3 py-2.5 hover:bg-muted/50"
                      onClick={() => onNavigate({ view: "catalog", slug: row.slug, editor: null })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onNavigate({ view: "catalog", slug: row.slug, editor: null });
                        }
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{row.slug}</span>
                            {row.gated && (
                              <Badge
                                variant="outline"
                                className="gap-1 text-muted-foreground"
                                title="Installing requires maintainer approval"
                              >
                                <Lock className="size-3" /> approval
                              </Badge>
                            )}
                            {row.pin !== null && (
                              <Badge
                                variant="outline"
                                className="text-muted-foreground"
                                title="You have this installed"
                              >
                                ✓ {row.pin}
                              </Badge>
                            )}
                            {row.updateTo !== null && (
                              <Badge variant="outline" className="text-muted-foreground">
                                update → {row.updateTo}
                              </Badge>
                            )}
                          </div>
                          <p className="line-clamp-3 text-sm text-muted-foreground">{row.description}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
                          {row.ownerLabel !== "" && (
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
                                {ownerInitials(row.ownerLabel)}
                              </span>
                              <span className="hidden max-w-32 truncate md:inline">{row.ownerLabel}</span>
                            </span>
                          )}
                          <span className="whitespace-nowrap">{row.meta}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
          {empty !== null && <p className="py-1.5 text-muted-foreground">{empty}</p>}
        </div>
      </div>
    </div>
  );
}
