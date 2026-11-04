/// Props sections accept when their sub-pages are URL-addressed
/// (/settings/<section>/<detail>): the open sub-page id (null = list page)
/// and the navigation callback that pushes the new URL. The usage section
/// also reads and writes its query state through the route.
import type { UsageQuery } from "./usage-route";

export interface SectionDetailProps {
  detail?: string | null;
  onDetailChange: (detail: string | null) => void;
  usage?: UsageQuery;
  onUsageChange?: (usage: UsageQuery) => void;
}

/** One section's sub-page grammar: the wire stays an opaque string, and the
 *  codec is the only place that reads or writes it. */
export interface DetailCodec<View> {
  parse(detail: string | null): View;
  format(view: View): string | null;
}

/** A section whose sub-pages are a create form ("new") or one row id. */
export type EntityDetail = { kind: "list" } | { kind: "new" } | { kind: "row"; id: string };

export const entityDetailCodec: DetailCodec<EntityDetail> = {
  parse: (detail) =>
    detail === null ? { kind: "list" } : detail === "new" ? { kind: "new" } : { kind: "row", id: detail },
  format: (view) => (view.kind === "list" ? null : view.kind === "new" ? "new" : view.id),
};

/** A section whose sub-pages are one row id (no create form). */
export const rowDetailCodec: DetailCodec<string | null> = {
  parse: (detail) => detail,
  format: (view) => view,
};

export const REGISTRY_KINDS = ["mcp", "integration"] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export type RegistryDetail = { kind: "list" } | { kind: "item"; itemKind: RegistryKind; slug: string };

/** The registry section's sub-page grammar: "<kind>/<slug>" or the list. */
export const registryDetailCodec: DetailCodec<RegistryDetail> = {
  parse(detail) {
    const [itemKind, slug] = (detail ?? "").split("/");
    if (detail && (REGISTRY_KINDS as readonly string[]).includes(itemKind) && slug) {
      return { kind: "item", itemKind: itemKind as RegistryKind, slug };
    }
    return { kind: "list" };
  },
  format(view) {
    return view.kind === "list" ? null : `${view.itemKind}/${view.slug}`;
  },
};

/** Every settings section the pane renders, with its sub-page grammar: a
 *  codec for a section with addressed sub-pages, null for a single page. */
const SECTION_DETAILS = {
  account: null,
  appearance: null,
  notifications: null,
  machine: null,
  gateway: null,
  general: null,
  usage: null,
  assistant: null,
  users: entityDetailCodec,
  teams: entityDetailCodec,
  models: rowDetailCodec,
  mcp: rowDetailCodec,
  sso: null,
  registry: registryDetailCodec,
  about: null,
} as const;

export type SettingsSectionId = keyof typeof SECTION_DETAILS;

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "account";

export function isSettingsSection(id: string): id is SettingsSectionId {
  return Object.hasOwn(SECTION_DETAILS, id);
}

/** The workspace sections only an admin may open. */
const ADMIN_SECTIONS: ReadonlySet<SettingsSectionId> = new Set<SettingsSectionId>([
  "general",
  "usage",
  "assistant",
  "users",
  "teams",
  "models",
  "sso",
  "registry",
]);

export function isAdminSection(id: SettingsSectionId): boolean {
  return ADMIN_SECTIONS.has(id);
}

/** Whether a viewer with this workspace role may open the section. */
export function sectionAllowed(id: SettingsSectionId, role: string): boolean {
  return role === "admin" || !ADMIN_SECTIONS.has(id);
}

/** The settings address the pane shows for a section/detail pair: an absent
 *  or unknown section, or an admin section for a non-admin viewer, is the
 *  default one; a single-page section has no sub-page, and a sub-page id
 *  reads back through its section's codec (a malformed one is the
 *  section's list page). */
export function canonicalSettings(
  section: string | null,
  detail: string | null,
  role: string,
): { section: SettingsSectionId; detail: string | null } {
  if (section === null || !isSettingsSection(section) || !sectionAllowed(section, role)) {
    return { section: DEFAULT_SETTINGS_SECTION, detail: null };
  }
  const codec = SECTION_DETAILS[section] as DetailCodec<unknown> | null;
  return { section, detail: codec === null ? null : codec.format(codec.parse(detail)) };
}
