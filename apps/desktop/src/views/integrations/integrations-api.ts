// The integrations page's wire calls and shapes. The integration list,
// catalogs and trait bindings are admin editing lists (read when opened,
// reloaded after the admin's own writes); usage is windowed analytics with
// a Refresh. Neither is live socket state.

import { request } from "../../lib/api/request";
import { pluginCatalogsPath, SETTINGS_PATHS } from "../../lib/api/settings";

/** One manifest-declared settings field — the configuration form is
 *  generated from these. */
export interface FieldSpec {
  name: string;
  kind: string; // string | text | number | boolean | secret
  label?: string | null;
  required?: boolean;
  default?: unknown;
  help?: string | null;
  placeholder?: string | null;
  /** Markdown: where an admin gets this value. */
  obtain?: string | null;
}

export interface DeclaredTool {
  name: string;
  class: string;
  description: string;
}

/** One integration the server can serve: its storefront metadata, plus
 *  this org's row when it is installed. */
export interface ShopItem {
  /** The instance slug: the row key, the secret key and the tool prefix. */
  name: string;
  /** The catalog item this row instantiates. */
  kind: string;
  /** The admin's name for this instance; empty means the item's title. */
  label: string;
  title: string;
  version: string;
  publisher: string;
  summary: string;
  description: string;
  docs_url: string | null;
  logo: string;
  readme: string;
  categories: string[];
  traits: Record<string, string>;
  secret_names: string[];
  settings: { fields?: FieldSpec[] } | null;
  tools: DeclaredTool[];
  /** builtin: ships with the server; registry: an installed plugin; mcp: a
   *  remote MCP server. */
  source: "builtin" | "registry" | "mcp";
  configured: boolean;
  /** Required settings and credentials the row has not filled. */
  missing: string[];
  id: string | null;
  org_id: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface CatalogPluginRow {
  slug: string;
  title: string;
  summary: string;
  publisher: string;
  categories: string[];
  traits: string[];
  docs_url: string | null;
  latest: string;
  installed_version: string | null;
  update_available: boolean;
  builtin: boolean;
  versions: { version: string; published_at: string | null; sha256?: string }[];
}

export type CatalogSource =
  | { kind: "url"; url: string }
  | { kind: "github"; repo: string; ref: string | null; path: string }
  | { kind: "gitlab"; project: string; ref: string | null; path: string };

export interface CatalogRow {
  id: string;
  name: string;
  label: string;
  source: CatalogSource;
  error: string | null;
  plugins: CatalogPluginRow[];
}

/** A catalog plugin's landing page, read from its bundle. */
export interface CatalogLanding {
  catalog: { id: string; name: string; label: string };
  plugin: CatalogPluginRow;
  version: { version: string; sha256: string; published_at: string | null };
  manifest: {
    title?: string;
    summary?: string;
    publisher?: string;
    docs_url?: string | null;
    traits?: Record<string, string>;
    settings?: { fields?: FieldSpec[] } | null;
    tools?: { classes?: Record<string, string>; declared?: DeclaredTool[] } | null;
  };
  readme: string;
  logo: string;
}

export interface UsageSummaryRow {
  slug: string;
  calls: number;
  errors: number;
  last_call_at: string;
  last_ok: boolean;
  last_error: string | null;
}

export interface IntegrationUsage {
  days: number;
  totals: {
    calls: number;
    errors: number;
    people: number;
    p50_ms: number | null;
    p95_ms: number | null;
    last_call_at: string | null;
  };
  by_day: { day: string; calls: number; errors: number }[];
  by_tool: { tool: string; calls: number; errors: number; p95_ms: number | null }[];
  by_person: { user_id: string; name: string; calls: number; errors: number; last_call_at: string }[];
  recent_failures: { at: string; tool: string; error: string; name: string | null; via: string }[];
}

/** One trait: the provider the org bound (null = first enabled wins), the
 *  one actually answering, and every integration that declares it. */
export interface TraitRow {
  name: string;
  description: string;
  provider: string | null;
  active: string | null;
  providers: { slug: string; title: string; enabled: boolean }[];
}

export type TestResult = { ok: true; ms: number } | { ok: false; error: string };

export const INTEGRATIONS_PATH = SETTINGS_PATHS.integrations;
export const USAGE_SUMMARY_PATH = `${SETTINGS_PATHS.integrations}/usage?days=7`;
export const integrationUsagePath = (id: string, days: number) =>
  `${SETTINGS_PATHS.integrations}/${id}/usage?days=${days}`;
export const catalogLandingPath = (catalogId: string, slug: string, version: string | null) =>
  `${pluginCatalogsPath}/${encodeURIComponent(catalogId)}/plugins/${encodeURIComponent(slug)}${
    version !== null ? `?version=${encodeURIComponent(version)}` : ""
  }`;

/** Unsaved form values a connection test lays over the stored row. */
export interface TestDraft {
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export function testIntegration(id: string, draft: TestDraft = {}): Promise<TestResult> {
  return request<TestResult>("POST", `${SETTINGS_PATHS.integrations}/${id}/test`, draft);
}

export type AccessAudience = "org" | "team" | "admins";

/** One Integration's audience as its Access tab edits it. */
export interface IntegrationAccess {
  audience: AccessAudience;
  org_ceiling: "read" | "write";
  grants: { team_id: string; ceiling: "read" | "write" }[];
  teams: { id: string; name: string }[];
}

export const integrationAccessPath = (id: string) => `${SETTINGS_PATHS.integrations}/${id}/access`;

export function putIntegrationAccess(
  id: string,
  body: { audience: AccessAudience; org_ceiling: "read" | "write"; grants: IntegrationAccess["grants"] },
): Promise<IntegrationAccess> {
  return request<IntegrationAccess>("PUT", integrationAccessPath(id), body);
}
