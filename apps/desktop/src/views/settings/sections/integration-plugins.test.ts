import { describe, expect, it } from "vitest";
import { canonicalSettings } from "../section-nav";
import {
  CATALOGS_DETAIL,
  INSTALL_PLUGIN_DETAIL,
  TRAITS_DETAIL,
  catalogAction,
  catalogSourceBody,
  type CatalogPluginRow,
} from "./integration-plugins";

function row(p: Partial<CatalogPluginRow>): CatalogPluginRow {
  return {
    slug: "acme",
    title: "Acme",
    summary: "",
    publisher: "",
    categories: [],
    traits: [],
    docs_url: null,
    latest: "1.1.0",
    installed_version: null,
    update_available: false,
    builtin: false,
    versions: [],
    ...p,
  };
}

describe("plugin pages", () => {
  it("keep their own addresses under the integrations section", () => {
    for (const detail of [CATALOGS_DETAIL, INSTALL_PLUGIN_DETAIL, TRAITS_DETAIL]) {
      expect(canonicalSettings("integrations", detail, "admin")).toEqual({ section: "integrations", detail });
    }
  });

  it("offer install, update, or nothing per catalog plugin", () => {
    expect(catalogAction(row({}))).toBe("Install 1.1.0");
    expect(catalogAction(row({ installed_version: "1.0.0", update_available: true }))).toBe("Update to 1.1.0");
    expect(catalogAction(row({ installed_version: "1.1.0" }))).toBeNull();
    expect(catalogAction(row({ builtin: true }))).toBeNull();
  });

  it("submit the source the chosen kind needs", () => {
    const fields = { url: " https://x.test/index.json ", repo: " acme/plugins ", ref: "", path: "" };
    expect(catalogSourceBody("url", fields)).toEqual({ kind: "url", url: "https://x.test/index.json" });
    expect(catalogSourceBody("github", fields)).toEqual({
      kind: "github",
      repo: "acme/plugins",
      ref: "",
      path: "index.json",
    });
    expect(catalogSourceBody("gitlab", fields)).toEqual({
      kind: "gitlab",
      project: "acme/plugins",
      ref: "",
      path: "index.json",
    });
  });
});
