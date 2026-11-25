import { describe, expect, it } from "vitest";
import type { CatalogRow, ShopItem, UsageSummaryRow } from "./integrations-api";
import { availableUpdates, buildCatalog, compactCount, findCatalogEntry, installedStatus, statusLine } from "./model";

function item(p: Partial<ShopItem>): ShopItem {
  return {
    name: "acme",
    kind: "acme",
    label: "",
    title: "Acme",
    version: "1.0.0",
    publisher: "Acme",
    summary: "",
    description: "",
    docs_url: null,
    logo: "",
    readme: "",
    categories: [],
    traits: {},
    secret_names: [],
    settings: null,
    tools: [],
    source: "builtin",
    configured: true,
    missing: [],
    id: "id-1",
    org_id: "org",
    config: {},
    enabled: true,
    ...p,
  };
}

const usage = (p: Partial<UsageSummaryRow>): UsageSummaryRow => ({
  slug: "acme",
  calls: 10,
  errors: 0,
  last_call_at: "2026-11-04T10:00:00Z",
  last_ok: true,
  last_error: null,
  ...p,
});

function catalog(id: string, plugins: Partial<CatalogRow["plugins"][number]>[]): CatalogRow {
  return {
    id,
    name: `Catalog ${id}`,
    label: id,
    source: { kind: "url", url: `https://${id}.test/index.json` },
    error: null,
    plugins: plugins.map((p) => ({
      slug: "x",
      title: "X",
      summary: "",
      publisher: "",
      categories: [],
      traits: [],
      docs_url: null,
      latest: "1.0.0",
      installed_version: null,
      update_available: false,
      builtin: false,
      versions: [],
      ...p,
    })),
  };
}

describe("installed status", () => {
  it("puts setup first, then off, then the last call", () => {
    expect(installedStatus(item({ missing: ["API key"], enabled: false }), undefined)).toEqual({
      kind: "needs_setup",
      missing: ["API key"],
    });
    expect(installedStatus(item({ enabled: false }), usage({ last_ok: false })).kind).toBe("disabled");
    expect(installedStatus(item({}), usage({ last_ok: false, last_error: "401" }))).toMatchObject({
      kind: "failing",
      error: "401",
    });
    expect(installedStatus(item({}), usage({ calls: 1200 }))).toEqual({ kind: "active", calls: 1200 });
    expect(installedStatus(item({}), undefined).kind).toBe("idle");
  });

  it("says it in a line", () => {
    expect(statusLine({ kind: "active", calls: 1200 })).toBe("1.2k calls this week");
    expect(statusLine({ kind: "active", calls: 1 })).toBe("1 call this week");
    expect(statusLine({ kind: "needs_setup", missing: ["Token", "Site"] })).toBe("Needs Token, Site");
    expect(compactCount(980)).toBe("980");
    expect(compactCount(34_500)).toBe("35k");
  });
});

describe("catalog", () => {
  it("lists what is not installed, once, from where it comes", () => {
    const shop = [
      item({ name: "github", configured: true }),
      item({ name: "slack", configured: false, id: null }),
      item({ name: "superproxy", source: "registry", configured: false, id: null }),
    ];
    const groups = buildCatalog(shop, [
      catalog("a", [
        { slug: "superproxy" },
        { slug: "github", installed_version: "1.0.0" },
        { slug: "fetchy" },
        { slug: "searxng", builtin: true },
      ]),
      catalog("b", [{ slug: "fetchy" }, { slug: "other" }]),
    ]);
    expect(groups.map((g) => [g.id, g.entries.map((e) => e.slug)])).toEqual([
      ["builtin", ["slack"]],
      ["approved", ["superproxy"]],
      ["catalog:a", ["fetchy"]],
      ["catalog:b", ["other"]],
    ]);
    expect(findCatalogEntry(groups, "fetchy", "a")?.kind).toBe("remote");
    expect(findCatalogEntry(groups, "fetchy", "b")).toBeNull();
    expect(findCatalogEntry(groups, "slack", null)?.kind).toBe("local");
  });

  it("offers each update once", () => {
    const updates = availableUpdates([
      catalog("a", [{ slug: "p", installed_version: "1.0.0", latest: "1.2.0", update_available: true }]),
      catalog("b", [{ slug: "p", installed_version: "1.0.0", latest: "1.3.0", update_available: true }]),
    ]);
    expect(updates.get("p")).toMatchObject({ catalogId: "a", latest: "1.2.0" });
    expect(updates.size).toBe(1);
  });
});
