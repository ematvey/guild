import { describe, expect, it } from "vitest";
import {
  fromSettingsDetail,
  integrationsRoutePath,
  parseIntegrationsRoute,
  type IntegrationsRoute,
} from "./integrations-route";
import { applyRoutePatch, canonicalRoute, parseChatRoute } from "../thread/route";

const parse = (path: string, search = "") => {
  const parts = path.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  return parseIntegrationsRoute(parts, search);
};

describe("integrations route", () => {
  it("round-trips every page", () => {
    const routes: IntegrationsRoute[] = [
      { view: "installed", slug: null, tab: "overview", q: "" },
      { view: "installed", slug: null, tab: "overview", q: "git hub" },
      { view: "installed", slug: "github", tab: "overview", q: "" },
      { view: "installed", slug: "github", tab: "configuration", q: "gi" },
      { view: "catalog", slug: null, from: null, q: "" },
      { view: "catalog", slug: "superproxy", from: "cat-1", q: "proxy" },
      { view: "catalog", slug: "slack", from: null, q: "" },
      { view: "connect", kind: "mcp" },
      { view: "connect", kind: "file" },
      { view: "sources" },
    ];
    for (const r of routes) {
      const [path, search = ""] = integrationsRoutePath(r).split("?");
      expect(parse(path!, search)).toEqual(r);
    }
  });

  it("reads an unknown tab as the overview", () => {
    expect(parse("/integrations/github/nope")).toEqual({ view: "installed", slug: "github", tab: "overview", q: "" });
  });

  it("sends old settings addresses to their new pages", () => {
    expect(parseChatRoute("/settings/integrations").integrations).toEqual(fromSettingsDetail(null));
    expect(parseChatRoute("/settings/integrations/_add-mcp").integrations).toEqual({ view: "connect", kind: "mcp" });
    expect(parseChatRoute("/settings/integrations/_install").integrations).toEqual({ view: "connect", kind: "file" });
    expect(parseChatRoute("/settings/integrations/_catalogs").integrations?.view).toBe("catalog");
    expect(parseChatRoute("/settings/integrations/github").integrations).toEqual({
      view: "installed",
      slug: "github",
      tab: "overview",
      q: "",
    });
    expect(parseChatRoute("/settings/integrations/github").tab).toBe("chats");
  });

  it("is replaced by a chat or another surface, and replaces them", () => {
    const here = parseChatRoute("/integrations/github/tools");
    expect(applyRoutePatch(here, { chatId: "c1" }).integrations).toBeNull();
    expect(applyRoutePatch(here, { tab: "settings", settingsSection: "account" }).integrations).toBeNull();
    expect(applyRoutePatch(here, { skills: { view: "catalog", slug: null, editor: null } }).integrations).toBeNull();
    const skills = parseChatRoute("/skills");
    const moved = applyRoutePatch(skills, { integrations: { view: "sources" } });
    expect(moved.skills).toBeNull();
    expect(moved.integrations).toEqual({ view: "sources" });
  });

  it("is an admin page", () => {
    const route = parseChatRoute("/integrations/catalog");
    const ctx = { hasEngine: false, pathname: "/integrations/catalog" };
    expect(canonicalRoute(route, { ...ctx, role: "admin" })).toBeNull();
    const member = canonicalRoute(route, { ...ctx, role: "member" });
    expect(member).not.toBeNull();
    expect(applyRoutePatch(route, member!).integrations).toBeNull();
  });
});
