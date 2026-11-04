// The integrations page's URL contract. Every state the page can show is
// one /integrations... address, so deep links, reloads and back/forward land
// exactly where the admin was:
//   /integrations[?q=]                       — installed list, nothing open
//   /integrations/<slug>[/<tab>][?q=]        — one installed integration
//   /integrations/catalog[?q=]               — the catalog
//   /integrations/catalog/<slug>[?from=&q=]  — a catalog landing page; from
//                                              names the catalog source when
//                                              the plugin is not on the server
//   /integrations/connect/mcp                — connect a remote MCP server
//   /integrations/connect/file               — install a bundle (file or URL)
//   /integrations/sources                    — the org's catalog sources
// "catalog", "connect" and "sources" are reserved: no integration slug can
// take them (the server refuses them).

export const INSTALLED_TABS = ["overview", "configuration", "access", "tools", "usage", "about"] as const;
export type InstalledTab = (typeof INSTALLED_TABS)[number];

export const RESERVED_SEGMENTS = ["catalog", "connect", "sources"] as const;

export type IntegrationsRoute =
  | { view: "installed"; slug: string | null; tab: InstalledTab; q: string }
  | { view: "catalog"; slug: string | null; from: string | null; q: string }
  | { view: "connect"; kind: "mcp" | "file" }
  | { view: "sources" };

export const INTEGRATIONS_HOME = {
  view: "installed",
  slug: null,
  tab: "overview",
  q: "",
} as const satisfies IntegrationsRoute;
export const INTEGRATIONS_CATALOG = {
  view: "catalog",
  slug: null,
  from: null,
  q: "",
} as const satisfies IntegrationsRoute;

const isTab = (s: string | undefined): s is InstalledTab => INSTALLED_TABS.includes(s as InstalledTab);

/** Parses the segments after /integrations and the query string. */
export function parseIntegrationsRoute(parts: string[], search: string): IntegrationsRoute {
  const params = new URLSearchParams(search);
  const q = params.get("q") ?? "";
  const [first, second] = parts;
  if (first === undefined) return { ...INTEGRATIONS_HOME, q };
  if (first === "catalog") {
    return { view: "catalog", slug: second ?? null, from: second ? (params.get("from") ?? null) : null, q };
  }
  if (first === "connect") return { view: "connect", kind: second === "file" ? "file" : "mcp" };
  if (first === "sources") return { view: "sources" };
  return { view: "installed", slug: first, tab: isTab(second) ? second : "overview", q };
}

/** The address of a route; the inverse of parseIntegrationsRoute. */
export function integrationsRoutePath(route: IntegrationsRoute): string {
  const enc = encodeURIComponent;
  switch (route.view) {
    case "connect":
      return `/integrations/connect/${route.kind}`;
    case "sources":
      return "/integrations/sources";
    case "catalog": {
      const params = new URLSearchParams();
      if (route.slug !== null && route.from !== null) params.set("from", route.from);
      if (route.q !== "") params.set("q", route.q);
      const query = params.toString();
      return `/integrations/catalog${route.slug !== null ? `/${enc(route.slug)}` : ""}${query ? `?${query}` : ""}`;
    }
    case "installed": {
      const query = route.q !== "" ? `?${new URLSearchParams({ q: route.q }).toString()}` : "";
      if (route.slug === null) return `/integrations${query}`;
      const tab = route.tab === "overview" ? "" : `/${route.tab}`;
      return `/integrations/${enc(route.slug)}${tab}${query}`;
    }
  }
}

/** Settings → Integrations addresses from before the page moved: each old
 *  sub-page lands on its counterpart. */
export function fromSettingsDetail(detail: string | null): IntegrationsRoute {
  switch (detail) {
    case null:
      return INTEGRATIONS_HOME;
    case "_add-mcp":
      return { view: "connect", kind: "mcp" };
    case "_install":
      return { view: "connect", kind: "file" };
    case "_catalogs":
      return INTEGRATIONS_CATALOG;
    case "_traits":
      return INTEGRATIONS_HOME;
    default:
      return { view: "installed", slug: detail, tab: "overview", q: "" };
  }
}
