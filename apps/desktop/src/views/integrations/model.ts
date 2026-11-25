// The integrations page's derived state: the status line of each installed
// integration, the catalog assembled from what the server already holds and
// what the org's catalog sources list, and the updates those sources offer.

import type { CatalogPluginRow, CatalogRow, ShopItem, UsageSummaryRow } from "./integrations-api";

/** The name the panel shows for one instance: the admin's label, else the
 *  catalog item's title. */
/** The instance slug rule, the server's `INSTANCE_SLUG`. */
export const INSTANCE_SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function displayName(item: { label?: string; title: string }): string {
  const label = item.label ?? "";
  return label !== "" ? label : item.title;
}

export type InstalledStatus =
  | { kind: "needs_setup"; missing: string[] }
  | { kind: "disabled" }
  | { kind: "failing"; error: string | null; at: string }
  | { kind: "active"; calls: number }
  | { kind: "idle" };

/** What an installed integration needs from the admin first: setup beats
 *  everything, a disabled row is quiet, and an enabled one reads its last
 *  call (from the last 7 days of usage). */
export function installedStatus(item: ShopItem, usage: UsageSummaryRow | undefined): InstalledStatus {
  if (item.missing.length > 0) return { kind: "needs_setup", missing: item.missing };
  if (!item.enabled) return { kind: "disabled" };
  if (usage !== undefined && !usage.last_ok)
    return { kind: "failing", error: usage.last_error, at: usage.last_call_at };
  if (usage !== undefined && usage.calls > 0) return { kind: "active", calls: usage.calls };
  return { kind: "idle" };
}

export const needsAttention = (s: InstalledStatus) => s.kind === "needs_setup" || s.kind === "failing";

/** Compact call count: 980, 1.2k, 34k. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

/** The status in a word or two, for a table that shows the counts beside it. */
export function statusWord(s: InstalledStatus): string {
  switch (s.kind) {
    case "needs_setup":
      return "Needs setup";
    case "disabled":
      return "Off";
    case "failing":
      return "Last call failed";
    case "active":
      return "Active";
    case "idle":
      return "Idle";
  }
}

export function statusLine(s: InstalledStatus): string {
  switch (s.kind) {
    case "needs_setup":
      return `Needs ${s.missing.join(", ")}`;
    case "disabled":
      return "Turned off";
    case "failing":
      return "Last call failed";
    case "active":
      return `${compactCount(s.calls)} ${s.calls === 1 ? "call" : "calls"} this week`;
    case "idle":
      return "No calls this week";
  }
}

/** Where a catalog entry installs from: the server already holds it (a
 *  built-in, or a plugin or MCP server approved for the org but not set
 *  up), or one of the org's catalog sources lists it. */
export type CatalogEntry =
  | { kind: "local"; slug: string; title: string; summary: string; publisher: string; logo: string; item: ShopItem }
  | {
      kind: "remote";
      slug: string;
      title: string;
      summary: string;
      publisher: string;
      logo: string;
      catalogId: string;
      catalogName: string;
      row: CatalogPluginRow;
    };

export interface CatalogGroup {
  id: string;
  label: string;
  entries: CatalogEntry[];
}

/** The catalog: everything the org can add, grouped by where it comes
 *  from. An installed integration is not listed; a plugin the server
 *  already holds is listed once, as local; a slug several sources list
 *  comes from the first source. */
export function buildCatalog(shop: ShopItem[], catalogs: CatalogRow[]): CatalogGroup[] {
  const installed = new Set(shop.filter((i) => i.configured).map((i) => i.name));
  const local = shop.filter((i) => !i.configured);
  const localSlugs = new Set(local.map((i) => i.name));
  const toLocal = (item: ShopItem): CatalogEntry => ({
    kind: "local",
    slug: item.name,
    title: item.title,
    summary: item.summary,
    publisher: item.publisher,
    logo: item.logo,
    item,
  });
  const groups: CatalogGroup[] = [
    { id: "builtin", label: "Included with Guild", entries: local.filter((i) => i.source === "builtin").map(toLocal) },
    {
      id: "approved",
      label: "Approved for your organization",
      entries: local.filter((i) => i.source !== "builtin").map(toLocal),
    },
  ];
  const seen = new Set<string>();
  for (const catalog of catalogs) {
    const entries: CatalogEntry[] = [];
    for (const row of catalog.plugins) {
      if (row.builtin || installed.has(row.slug) || localSlugs.has(row.slug) || seen.has(row.slug)) continue;
      seen.add(row.slug);
      entries.push({
        kind: "remote",
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        publisher: row.publisher,
        logo: "",
        catalogId: catalog.id,
        catalogName: catalog.name,
        row,
      });
    }
    groups.push({ id: `catalog:${catalog.id}`, label: catalog.name, entries });
  }
  return groups.filter((g) => g.entries.length > 0);
}

export function findCatalogEntry(groups: CatalogGroup[], slug: string, from: string | null): CatalogEntry | null {
  for (const g of groups) {
    for (const e of g.entries) {
      if (e.slug !== slug) continue;
      if (from === null || (e.kind === "remote" && e.catalogId === from)) return e;
    }
  }
  return null;
}

/** A newer version a catalog source lists for an installed plugin. */
export interface AvailableUpdate {
  catalogId: string;
  catalogName: string;
  installed: string;
  latest: string;
}

export function availableUpdates(catalogs: CatalogRow[]): Map<string, AvailableUpdate> {
  const out = new Map<string, AvailableUpdate>();
  for (const catalog of catalogs) {
    for (const p of catalog.plugins) {
      if (!p.update_available || p.installed_version === null || out.has(p.slug)) continue;
      out.set(p.slug, {
        catalogId: catalog.id,
        catalogName: catalog.name,
        installed: p.installed_version,
        latest: p.latest,
      });
    }
  }
  return out;
}

export function matchesQuery(q: string, ...texts: (string | undefined)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  return texts.some((t) => t !== undefined && t.toLowerCase().includes(needle));
}
