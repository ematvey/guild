// Skills page (Skills rail tab): a full main-column page, not a sidebar
// panel. Catalog | Activity | On this machine tabs. Catalog is the org
// skill catalog as compact rows with filter/sort selects and a search box;
// Activity is the org event feed with the All / Changes pill filter; On
// this machine (Tauri only) manages the local skill folders and the
// signed-in user's org installs. The page is URL-driven: the tab, the open
// detail slug and the editor all come from the /skills... route and every
// user action navigates through onNavigate (see skills-route.ts); only the
// catalog's search/filter/sort stay local component state.

import { Lock, Plus, Search } from "lucide-react";
import { HAS_ENGINE } from "../../lib/session";
import { Input } from "@guild/ui/components/input";
import { Button } from "@guild/ui/components/button";
import { Avatar } from "@guild/ui/components/avatar";
import { Badge } from "@guild/ui/components/badge";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { SkillDetail, editAccess, editAccessLabel } from "./SkillDetail";
import { avatarChip } from "../../lib/format";
import { compareVersions } from "./version";
import { count } from "../../lib/format";
import { SkillEditor } from "../../../../control-center/src/skills/SkillEditor";
import { ActivityFeed } from "../../../../control-center/src/skills/ActivityFeed";
import LocalSkills from "./LocalSkills";
import { skillsPageState, withCatalogQuery, withSkillFile, type SkillsRoute } from "./skills-route";
import type { SkillInstall, SkillItem, SkillMe } from "./skills-api";
import { useSkillCatalog } from "./skills-store";
import { PageHeader } from "../../components/page-header";

/** One catalog row's view model. */
export interface SkillRow {
  slug: string;
  description: string;
  ownerLabel: string;
  /** The owner user's avatar URL, or null (initials chip fallback). */
  ownerAvatar: string | null;
  /** "v3 · 12 installs" — versions arrive as "vN" from the server. */
  meta: string;
  /** Latest version on its own (the row renders it emphasized). */
  latestVersion: string;
  /** Org-wide install count on its own (the row renders the label). */
  installsCount: number;
  gated: boolean;
  /** The access label shown in the row's lock badge when gated
   *  ("Team Platform can edit" / "Owner can edit"), null when open. */
  gatedLabel: string | null;
  /** True when the viewer has this skill installed. */
  installed: boolean;
  /** The viewer's pinned version ("v2"); null when unpinned (follows the
   *  latest) or not installed. */
  pin: string | null;
  /** The latest version when the viewer's pin is behind it, else null. */
  updateTo: string | null;
}

export function skillRow(item: SkillItem, install: SkillInstall | null | undefined): SkillRow {
  const installed = install != null;
  const pin = install?.pinned_version ?? null;
  const updateTo =
    pin !== null && item.latest_version !== null && pin !== item.latest_version ? item.latest_version : null;
  const meta = `${item.latest_version ?? "—"} · ${count(item.installs, "install")}`;
  return {
    slug: item.slug,
    description: item.description,
    ownerLabel: item.owner?.label ?? "",
    ownerAvatar: item.owner?.avatar_url ?? null,
    meta,
    latestVersion: item.latest_version ?? "—",
    installsCount: item.installs,
    gated: item.maintainer_gated,
    gatedLabel: item.maintainer_gated ? editAccessLabel(editAccess(item), item.owner?.label) : null,
    installed,
    pin,
    updateTo,
  };
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
  ["approval", "Restricted editing"],
];

/** The catalog's sort keys, in Select order. */
export type SkillSortKey = "installs" | "updated" | "az";

export const skillSortOptions: ReadonlyArray<readonly [SkillSortKey, string]> = [
  ["installs", "Most installed"],
  ["updated", "Recently updated"],
  ["az", "A → Z"],
];

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
      return copy.sort(
        (a, b) => compareVersions(b.latest_version ?? "", a.latest_version ?? "") || a.slug.localeCompare(b.slug),
      );
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

export function panelTabs(hasEngine: boolean): ReadonlyArray<readonly [SkillsTab, string]> {
  const tabs: Array<readonly [SkillsTab, string]> = [
    ["catalog", "Catalog"],
    ["activity", "Activity"],
  ];
  if (hasEngine) tabs.push(["machine", "On this machine"]);
  return tabs;
}

/** Declarative contract for the page header, rendered as one row: title,
 *  search input, filter + sort selects, New skill action and the tab bar —
 *  and deliberately no collapse control: this is a full page, not a
 *  sidebar panel. */
export function skillsPageHeader(hasEngine: boolean): {
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
    tabs: panelTabs(hasEngine),
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
  /** `replace` rewrites the current entry: typing a search is one edit. */
  onNavigate: (next: SkillsRoute, options?: { replace?: boolean }) => void;
}) {
  const { tab, selected, editor, file, catalog: listQuery } = skillsPageState(route);
  // The catalog and the member's installs are live: the skill_catalog frame
  // lands on connect and after every publish, gate, unpublish, install,
  // uninstall or pin, so returning from a detail or the editor shows the
  // current list without a read.
  const catalog = useSkillCatalog();
  const skills: SkillItem[] | null = catalog?.items ?? null;
  const installs: SkillInstall[] | null = catalog?.installs ?? null;
  // The list's search, filter and sort are route state; a detail or editor
  // opened from the list keeps them, so its Back lands on the same list.
  const { q: query, filter: filterKind, sort: sortKey } = listQuery;
  const setQuery = (q: string) => onNavigate(withCatalogQuery(route, { q }), { replace: true });
  const setFilterKind = (filter: SkillFilterKind) => onNavigate(withCatalogQuery(route, { filter }));
  const setSortKey = (sort: SkillSortKey) => onNavigate(withCatalogQuery(route, { sort }));
  const toCatalog = (next: Omit<SkillsRoute, "catalog" | "file">): SkillsRoute =>
    route.catalog === undefined ? next : { ...next, catalog: route.catalog };
  const installedSlugs = new Set((installs ?? []).map((i) => i.slug));
  const search = filterSkills(skills ?? [], query);
  const kind = filterByKind(search, filterKind, { installedSlugs, me });
  const filtered = sortSkills(kind, sortKey);
  const empty =
    skills === null ? null : skillsEmptyState(query, filtered.length, filterKind !== "all" || query.trim() !== "");

  if (import.meta.env.MODE === "control" && editor !== null) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        <SkillEditor
          mode={editor.mode}
          slug={editor.slug}
          // Cancel returns to the owning catalog URL; the save below is the
          // one editor exit that carries the saved slug forward.
          onBack={() => onNavigate(toCatalog({ view: "catalog", slug: null, editor: null }))}
          onSaved={(slug) => onNavigate(toCatalog({ view: "catalog", slug, editor: null }))}
          file={file}
          onSelectFile={(path, options) => onNavigate(withSkillFile(route, path), options)}
        />
      </div>
    );
  }

  if (selected !== null) {
    return (
      // Full column width: the detail's top bar spans the page and caps its
      // own body, like the prototype's topbar over the 56rem inner column.
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <SkillDetail
          slug={selected}
          me={me}
          management={route.management === true}
          onManage={() => onNavigate({ ...route, management: true })}
          onBack={() => onNavigate(toCatalog({ view: "catalog", slug: null, editor: null }))}
          onOpenSkill={(slug) => onNavigate(toCatalog({ view: "catalog", slug, editor: null }))}
          onEdit={(slug) => onNavigate(toCatalog({ view: "catalog", slug, editor: slug }))}
          file={file}
          onSelectFile={(path) => onNavigate(withSkillFile(route, path))}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {/* Row 1: title, search and New skill; row 2: the underline tabs and
          the catalog's filter and sort. */}
      <PageHeader
        variant={route.management ? "bar" : "work"}
        title="Skills"
        actions={
          <>
            <div className="relative w-full sm:w-[280px]">
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
            <Button
              size="sm"
              aria-label={import.meta.env.MODE === "control" ? "New skill" : "Publish a skill"}
              onClick={() => onNavigate(toCatalog({ view: "catalog", slug: null, editor: "new", management: true }))}
            >
              <Plus />
              {import.meta.env.MODE === "control" ? "New skill" : "Publish a skill"}
            </Button>
          </>
        }
        tabs={
          <>
            <div role="tablist" aria-label="Skills sections" className="flex gap-0.5">
              {panelTabs(HAS_ENGINE && !route.management).filter(([value]) => value !== "activity" || route.management).map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  aria-label={`${label} tab`}
                  onClick={() => onNavigate({ view: value, slug: null, editor: null })}
                  className={`-mb-px border-b-2 px-3 pb-2 pt-2 text-sm outline-none transition-colors ${
                    tab === value
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            {tab === "catalog" && (
              <>
                <Select value={filterKind} onValueChange={(v) => setFilterKind(v as SkillFilterKind)}>
                  <SelectTrigger aria-label="Filter skills" className="h-8 w-40 text-xs">
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
                  <SelectTrigger aria-label="Sort skills" className="h-8 w-40 text-xs">
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
              </>
            )}
          </>
        }
      />
      {/* page body: full-width background fill, content capped so the row
          list and detail panes don't stretch absurdly on wide monitors */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <div className={route.management ? "mx-auto w-full max-w-[56rem] px-5 pt-4 pb-12" : "work-page-content pb-8 pt-3"}>
          {import.meta.env.MODE === "control" && tab === "activity" && <ActivityFeed />}
          {tab === "machine" && HAS_ENGINE && <LocalSkills />}
          {tab === "catalog" && (
            <div className={route.management ? "flex flex-col gap-1.5" : "grid gap-3 lg:grid-cols-2"}>
              {skills === null && [0, 1, 2, 3, 4, 5].map((i) => <SkeletonRows key={i} rows={1} />)}
              {skills !== null &&
                filtered.map((item) => {
                  const row = skillRow(item, installs?.find((i) => i.slug === item.slug) ?? null);
                  return (
                    <div
                      key={row.slug}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open skill ${row.slug}`}
                      className="cursor-pointer rounded-xl border border-border bg-card p-4 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onNavigate({ view: "catalog", slug: row.slug, editor: null })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onNavigate({ view: "catalog", slug: row.slug, editor: null });
                        }
                      }}
                    >
                      <div className={route.management ? "flex items-start justify-between gap-3" : "flex flex-col gap-3"}>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-semibold">{row.slug}</span>
                            {row.gated && (
                              <Badge
                                variant="outline"
                                className="gap-1 text-muted-foreground"
                                title="Publishing updates is limited to the owner/team and admins"
                              >
                                <Lock className="size-3" /> {row.gatedLabel}
                              </Badge>
                            )}
                            {row.installed && (
                              <Badge
                                variant="outline"
                                className="text-muted-foreground"
                                title="You have this installed"
                              >
                                ✓ {row.pin ?? "latest"}
                              </Badge>
                            )}
                            {row.updateTo !== null && (
                              <Badge variant="outline" className="text-muted-foreground">
                                update → {row.updateTo}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-0.5 line-clamp-3 text-sm text-muted-foreground">{row.description}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
                          {row.ownerLabel !== "" && (
                            <span className="flex min-w-0 items-center gap-1.5">
                              <Avatar
                                src={row.ownerAvatar}
                                fallback={avatarChip(row.ownerLabel)}
                                className="size-5 border border-border"
                                fallbackClassName="bg-secondary text-3xs font-semibold"
                              />
                              <span className="hidden max-w-32 truncate md:inline">{row.ownerLabel}</span>
                            </span>
                          )}
                          <span className="min-w-[90px] whitespace-nowrap text-right">
                            <span className="font-medium text-foreground">{row.latestVersion}</span>
                            {" · "}
                            {count(row.installsCount, "install")}
                          </span>
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
