// The skills page's URL contract: every page state — catalog / activity /
// machine tab, open detail, open editor — is one /skills... route the same
// way a thread or the device dialog is, so deep links, reloads and
// back/forward land exactly where the user was.

import type { EditorMode } from "./SkillEditor";

/** One /skills... route. `activity`, `machine` and `new` are reserved
 *  segments: slugs are server-issued identifiers that can never collide
 *  with them, so the parser can tell a tab from a detail page without a
 *  lookup. */
export interface SkillsRoute {
  view: "catalog" | "activity" | "machine";
  /** Detail page slug; null on the tab views. */
  slug: string | null;
  /** null = closed; "new" = editor in create mode (/skills/new); otherwise
   *  the slug being edited (/skills/<slug>/edit). */
  editor: string | null;
}

export const SKILLS_CATALOG: SkillsRoute = { view: "catalog", slug: null, editor: null };

/** The skills page state a route renders: the active tab, the open detail
 *  slug (only while the editor is closed — the editor replaces the page
 *  body), and the editor target. */
export function skillsPageState(route: SkillsRoute): {
  tab: SkillsRoute["view"];
  selected: string | null;
  editor: { mode: EditorMode; slug?: string } | null;
} {
  return {
    tab: route.view,
    selected: route.editor === null ? route.slug : null,
    editor:
      route.editor === null
        ? null
        : route.editor === "new"
          ? { mode: "create" }
          : { mode: "edit", slug: route.editor },
  };
}

/** The "machine" tab needs the desktop fs bridge, so a web deep link to
 *  /skills/machine falls back to the catalog view (the URL follows on the
 *  next navigation). */
export function clampSkillsRoute(route: SkillsRoute, isTauri: boolean): SkillsRoute {
  return !isTauri && route.view === "machine" ? { ...route, view: "catalog" } : route;
}
