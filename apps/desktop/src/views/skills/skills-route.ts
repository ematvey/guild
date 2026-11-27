// The skills page's URL contract: every page state — catalog / activity /
// machine tab, the catalog's search, filter and sort, open detail, open
// editor, the file shown in either — is one /skills... route the same way a
// thread or the device dialog is, so deep links, reloads and back/forward
// land exactly where the user was.

import type { EditorMode } from "../../../../control-center/src/skills/SkillEditor";
import type { SkillFilterKind, SkillSortKey } from "./SkillsPanel";

/** The catalog list's search, filter and sort (`?q=&filter=&sort=`). */
export interface SkillsCatalogQuery {
  q: string;
  filter: SkillFilterKind;
  sort: SkillSortKey;
}

export const DEFAULT_CATALOG_QUERY: SkillsCatalogQuery = { q: "", filter: "all", sort: "installs" };

/** The file a detail or editor shows when the route names none. */
export const SKILL_ENTRY_FILE = "SKILL.md";

/** One /skills... route. `activity`, `machine` and `new` are reserved
 *  segments: slugs are server-issued identifiers that can never collide
 *  with them, so the parser can tell a tab from a detail page without a
 *  lookup. */
export interface SkillsRoute {
  management?: true;
  view: "catalog" | "activity" | "machine";
  /** Detail page slug; null on the tab views. */
  slug: string | null;
  /** null = closed; "new" = editor in create mode (/skills/new); otherwise
   *  the slug being edited (/skills/<slug>/edit). */
  editor: string | null;
  /** The bundle file the detail or editor shows (/skills/<slug>/files/<path>,
   *  /skills/<slug>/edit/files/<path>, /skills/new/files/<path>); absent =
   *  SKILL.md. */
  file?: string;
  /** The catalog's search, filter and sort; absent = the defaults. It rides
   *  on the catalog's detail and editor addresses too, so their Back
   *  returns to the list as it was. */
  catalog?: SkillsCatalogQuery;
}

export const SKILLS_CATALOG: SkillsRoute = { view: "catalog", slug: null, editor: null };

const FILTERS: readonly SkillFilterKind[] = ["all", "installed", "mine", "approval"];
const SORTS: readonly SkillSortKey[] = ["installs", "updated", "az"];

/** The catalog query a search string names; undefined when it is the
 *  default one. */
export function parseCatalogQuery(search: string): SkillsCatalogQuery | undefined {
  const params = new URLSearchParams(search);
  const filter = params.get("filter");
  const sort = params.get("sort");
  const query: SkillsCatalogQuery = {
    q: params.get("q") ?? "",
    filter: FILTERS.includes(filter as SkillFilterKind) ? (filter as SkillFilterKind) : "all",
    sort: SORTS.includes(sort as SkillSortKey) ? (sort as SkillSortKey) : "installs",
  };
  return isDefaultQuery(query) ? undefined : query;
}

function isDefaultQuery(query: SkillsCatalogQuery | undefined): boolean {
  return query === undefined || (query.q === "" && query.filter === "all" && query.sort === "installs");
}

/** `?q=&filter=&sort=` with defaults omitted; "" for the default query. */
export function catalogQueryString(query: SkillsCatalogQuery | undefined): string {
  if (query === undefined || isDefaultQuery(query)) return "";
  const params = new URLSearchParams();
  if (query.q !== "") params.set("q", query.q);
  if (query.filter !== "all") params.set("filter", query.filter);
  if (query.sort !== "installs") params.set("sort", query.sort);
  return `?${params.toString()}`;
}

/** /skills/<seg...> after the leading "skills": a bare /skills is the
 *  catalog, the reserved segments name the activity/machine tabs and the
 *  create editor, and anything else is a detail slug with an optional /edit
 *  suffix, either followed by /files/<path>. */
export function parseSkillsRoute(parts: string[], search = ""): SkillsRoute {
  const seg = parts[0];
  const catalog = parseCatalogQuery(search);
  const withQuery = (route: SkillsRoute): SkillsRoute => (catalog === undefined ? route : { ...route, catalog });
  const fileAt = (i: number): Pick<SkillsRoute, "file"> => {
    const file = parts[i] === "files" ? parts.slice(i + 1).join("/") : "";
    return file !== "" && file !== SKILL_ENTRY_FILE ? { file } : {};
  };
  if (seg === undefined) return withQuery(SKILLS_CATALOG);
  if (seg === "activity") return { view: "activity", slug: null, editor: null };
  if (seg === "machine") return { view: "machine", slug: null, editor: null };
  if (seg === "new") return withQuery({ view: "catalog", slug: null, editor: "new", ...fileAt(1) });
  if (parts[1] === "edit") return withQuery({ view: "catalog", slug: seg, editor: seg, ...fileAt(2) });
  return withQuery({ view: "catalog", slug: seg, editor: null, ...fileAt(1) });
}

const fileSuffix = (file: string | undefined): string =>
  file === undefined || file === "" || file === SKILL_ENTRY_FILE
    ? ""
    : `/files/${file.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;

/** Canonical address of one skills route. */
export function skillsRoutePath(skills: SkillsRoute): string {
  if (skills.view === "activity") return "/skills/activity";
  if (skills.view === "machine") return "/skills/machine";
  const query = catalogQueryString(skills.catalog);
  if (skills.editor === "new") return `/skills/new${fileSuffix(skills.file)}${query}`;
  if (skills.slug !== null) {
    const base = `/skills/${encodeURIComponent(skills.slug)}`;
    return `${base}${skills.editor !== null ? "/edit" : ""}${fileSuffix(skills.file)}${query}`;
  }
  return `/skills${query}`;
}

/** The skills page state a route renders: the active tab, the open detail
 *  slug (only while the editor is closed — the editor replaces the page
 *  body), the editor target, the file shown and the catalog query. */
export function skillsPageState(route: SkillsRoute): {
  tab: SkillsRoute["view"];
  selected: string | null;
  editor: { mode: EditorMode; slug?: string } | null;
  file: string;
  catalog: SkillsCatalogQuery;
} {
  return {
    tab: route.view,
    selected: route.editor === null ? route.slug : null,
    editor:
      route.editor === null ? null : route.editor === "new" ? { mode: "create" } : { mode: "edit", slug: route.editor },
    file: route.file ?? SKILL_ENTRY_FILE,
    catalog: route.catalog ?? DEFAULT_CATALOG_QUERY,
  };
}

/** The route showing `file` on the same page; SKILL.md is the bare one. */
export function withSkillFile(route: SkillsRoute, file: string): SkillsRoute {
  const { file: _drop, ...rest } = route;
  return file === SKILL_ENTRY_FILE || file === "" ? rest : { ...rest, file };
}

/** The route with a changed catalog query; the default query is the bare
 *  address. */
export function withCatalogQuery(route: SkillsRoute, change: Partial<SkillsCatalogQuery>): SkillsRoute {
  const { catalog: _drop, ...rest } = route;
  const next = { ...(route.catalog ?? DEFAULT_CATALOG_QUERY), ...change };
  return isDefaultQuery(next) ? rest : { ...rest, catalog: next };
}

/** The "machine" tab needs the desktop fs bridge, so a web deep link to
 *  /skills/machine is the catalog view (`canonicalRoute` rewrites the
 *  address). */
export function clampSkillsRoute(route: SkillsRoute, hasEngine: boolean): SkillsRoute {
  return !hasEngine && route.view === "machine" ? { ...route, view: "catalog" } : route;
}
