import { describe, expect, it } from "vitest";
import { applyRoutePatch, canonicalRoute, canonicalSurfacePath, parseChatRoute, SURFACE_BASE } from "../route";
import { INTEGRATIONS_HOME } from "../../integrations/integrations-route";
import { canonicalSettings } from "../../settings/section-nav";
import { commitRoute, routePath } from "./use-thread-route";

describe("settings address normalisation", () => {
  it("lands an unknown or absent section on the default one", () => {
    expect(canonicalSettings("machines", null, "admin")).toEqual({ section: "account", detail: null });
    expect(canonicalSettings("machines", "x", "admin")).toEqual({ section: "account", detail: null });
    expect(canonicalSettings(null, null, "admin")).toEqual({ section: "account", detail: null });
  });

  it("keeps a known section and drops a sub-page it does not have", () => {
    expect(canonicalSettings("machine", null, "admin")).toEqual({ section: "machine", detail: null });
    expect(canonicalSettings("account", "bogus", "admin")).toEqual({ section: "account", detail: null });
    expect(canonicalSettings("registry", "bogus", "admin")).toEqual({ section: "registry", detail: null });
    expect(canonicalSettings("registry", "mcp/github", "admin")).toEqual({ section: "registry", detail: "mcp/github" });
    expect(canonicalSettings("users", "new", "admin")).toEqual({ section: "users", detail: "new" });
    expect(canonicalSettings("models", "provider/openai", "admin")).toEqual({
      section: "models",
      detail: "provider/openai",
    });
  });

  it("replaces the entry, so Back skips the bad address", () => {
    const history = fakeHistory("/chats");
    history.pushState(null, "", "/settings/machines");
    const route = parseChatRoute("/settings/machines", "");
    const shown = canonicalSettings(route.settingsSection, route.settingsDetail, "admin");
    commitRoute(
      history,
      history.current,
      applyRoutePatch(route, { tab: "settings", settingsSection: shown.section, settingsDetail: shown.detail }),
      { replace: true },
    );
    expect(history.current).toBe("/settings/account");
    history.back();
    expect(history.current).toBe("/chats");
  });

  it("lands a member on an admin section at the default one; an admin stays", () => {
    for (const section of ["users", "models", "general", "registry", "usage"]) {
      expect(canonicalSettings(section, "new", "member")).toEqual({ section: "account", detail: null });
      expect(canonicalSettings(section, null, "admin").section).toBe(section);
    }
    expect(canonicalSettings("mcp", null, "member")).toEqual({ section: "mcp", detail: null });
    expect(canonicalSettings("machine", null, "member")).toEqual({ section: "machine", detail: null });
  });

  it("replaces a member's admin address, so Back skips it", () => {
    const history = fakeHistory("/chats");
    history.pushState(null, "", "/settings/users");
    const route = parseChatRoute("/settings/users", "");
    const shown = canonicalSettings(route.settingsSection, route.settingsDetail, "member");
    commitRoute(
      history,
      history.current,
      applyRoutePatch(route, { tab: "settings", settingsSection: shown.section, settingsDetail: shown.detail }),
      { replace: true },
    );
    expect(history.current).toBe("/settings/account");
    history.back();
    expect(history.current).toBe("/chats");
  });
});

describe("agents and skills address normalisation", () => {
  const fix = (path: string) => canonicalSurfacePath(parseChatRoute(path, ""), path);

  it("rewrites a segment the parser read past to the page shown", () => {
    expect(fix("/agents/a1/bogus")).toBe("/agents/a1");
    expect(fix("/agents/a1/settings/extra")).toBe("/agents/a1/settings");
    expect(fix("/agents/new/bogus")).toBe("/agents/new");
    expect(fix("/skills/foo/bogus")).toBe("/skills/foo");
    expect(fix("/skills/activity/extra")).toBe("/skills/activity");
    expect(fix("/sessions/c1")).toBe("/chats/c1");
  });

  it("leaves canonical addresses and other surfaces alone", () => {
    expect(fix("/agents/a1")).toBeNull();
    expect(fix("/agents/a1/files/docs/a%20b.md")).toBeNull();
    expect(fix("/agents/new/model")).toBeNull();
    expect(fix("/skills")).toBeNull();
    expect(fix("/skills/foo/edit")).toBeNull();
    expect(fix("/activity")).toBeNull();
    expect(fix("/thread/c1")).toBeNull();
    expect(fix("/settings/machines")).toBeNull();
  });
});

describe("canonicalRoute", () => {
  const ctx = (role = "admin", hasEngine = true) => ({ role, hasEngine });
  const fix = (path: string, role = "admin", hasEngine = true) => {
    const route = parseChatRoute(path.split("?")[0]!, path.includes("?") ? path.slice(path.indexOf("?")) : "");
    const patch = canonicalRoute(route, { ...ctx(role, hasEngine), pathname: path.split("?")[0]! });
    return patch === null ? null : routePath(applyRoutePatch(route, patch));
  };

  it("leaves canonical addresses alone", () => {
    for (const path of ["/chats", "/thread/c1", "/settings/account", "/agents/a1", "/activity", "/skills/machine"]) {
      expect(fix(path)).toBeNull();
    }
    expect(fix("/agents/a1", "member")).toBeNull();
  });

  it("lands a malformed address on the default route", () => {
    expect(fix("/thread/%E0%A4%A")).toBe("/chats");
  });

  it("moves a member off the admin activity surfaces", () => {
    expect(fix("/activity", "member")).toBe("/agents");
    expect(fix("/runs/r1", "member")).toBe("/agents");
    expect(fix("/sessions/c1", "member")).toBe("/agents");
    expect(fix("/agents/a1/activity", "member")).toBe("/agents/a1");
  });

  it("keeps the settings address while a surface opened from it owns the URL", () => {
    // The rail opens Integrations from the Settings tab: the patch leaves
    // `tab` on settings while /integrations is the address. Settings
    // normalisation must not rewrite that route back to /settings/<section>.
    const route = applyRoutePatch(parseChatRoute("/settings/account", ""), {
      ...SURFACE_BASE,
      skills: null,
      agents: null,
      integrations: INTEGRATIONS_HOME,
    });
    expect(canonicalRoute(route, { role: "admin", hasEngine: true, pathname: "/integrations" })).toBeNull();
  });

  it("lands settings on a section the role may open", () => {
    expect(fix("/settings")).toBe("/settings/account");
    expect(fix("/settings/users", "member")).toBe("/settings/account");
    expect(fix("/settings/account/bogus")).toBe("/settings/account");
  });

  it("clamps the machine tab without an engine", () => {
    expect(fix("/skills/machine", "admin", false)).toBe("/skills");
  });

  it("rewrites a surface address the parser read past, and the old chat alias", () => {
    expect(fix("/agents/a1/bogus")).toBe("/agents/a1");
    expect(fix("/sessions/c1")).toBe("/chats/c1");
  });

  it("is stable: a canonical result needs no second pass", () => {
    for (const [path, role] of [
      ["/settings", "member"],
      ["/activity", "member"],
      ["/agents/a1/bogus", "admin"],
    ] as const) {
      const once = fix(path, role)!;
      expect(fix(once, role)).toBeNull();
    }
  });
});

/** A history stack with one cursor, enough to replay Back. */
function fakeHistory(start: string) {
  const entries = [start];
  let index = 0;
  return {
    get current() {
      return entries[index]!;
    },
    get length() {
      return entries.length;
    },
    pushState(_d: unknown, _t: string, url?: string | URL | null) {
      entries.splice(index + 1);
      entries.push(String(url));
      index = entries.length - 1;
    },
    replaceState(_d: unknown, _t: string, url?: string | URL | null) {
      entries[index] = String(url);
    },
    back() {
      index = Math.max(0, index - 1);
    },
  };
}

describe("commitRoute (history entries per navigation)", () => {
  it("a normalising rewrite replaces the entry, so Back leaves the thread", () => {
    const history = fakeHistory("/chats");
    const bare = parseChatRoute("/thread/c1", "");
    commitRoute(history, history.current, applyRoutePatch(parseChatRoute("/chats", ""), { chatId: "c1" }));
    expect(history.current).toBe("/thread/c1");
    commitRoute(history, history.current, applyRoutePatch(bare, { projectId: "p1" }), { replace: true });
    expect(history.current).toBe("/project/p1/thread/c1");
    expect(history.length).toBe(2);
    history.back();
    expect(history.current).toBe("/chats");
  });

  it("a plain navigation adds an entry", () => {
    const history = fakeHistory("/chats");
    commitRoute(history, history.current, applyRoutePatch(parseChatRoute("/chats", ""), { chatId: "c1" }));
    expect(history.length).toBe(2);
  });

  it("an unchanged address writes nothing", () => {
    const history = fakeHistory("/thread/c1");
    commitRoute(history, history.current, parseChatRoute("/thread/c1", ""));
    expect(history.length).toBe(1);
  });
});
