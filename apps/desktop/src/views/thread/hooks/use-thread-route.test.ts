import { describe, expect, it } from "vitest";
import { applyRoutePatch, canonicalSurfacePath, parseChatRoute } from "../route";
import { canonicalSettings } from "../../settings/section-nav";
import { commitRoute } from "./use-thread-route";

describe("settings address normalisation", () => {
  it("lands an unknown or absent section on the default one", () => {
    expect(canonicalSettings("machines", null)).toEqual({ section: "account", detail: null });
    expect(canonicalSettings("machines", "x")).toEqual({ section: "account", detail: null });
    expect(canonicalSettings(null, null)).toEqual({ section: "account", detail: null });
  });

  it("keeps a known section and drops a sub-page it does not have", () => {
    expect(canonicalSettings("machine", null)).toEqual({ section: "machine", detail: null });
    expect(canonicalSettings("account", "bogus")).toEqual({ section: "account", detail: null });
    expect(canonicalSettings("registry", "bogus")).toEqual({ section: "registry", detail: null });
    expect(canonicalSettings("registry", "mcp/github")).toEqual({ section: "registry", detail: "mcp/github" });
    expect(canonicalSettings("users", "new")).toEqual({ section: "users", detail: "new" });
    expect(canonicalSettings("models", "provider/openai")).toEqual({ section: "models", detail: "provider/openai" });
  });

  it("replaces the entry, so Back skips the bad address", () => {
    const history = fakeHistory("/chats");
    history.pushState(null, "", "/settings/machines");
    const route = parseChatRoute("/settings/machines", "");
    const shown = canonicalSettings(route.settingsSection, route.settingsDetail);
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

/** A history stack with one cursor, enough to replay Back. */
function fakeHistory(start: string) {
  const entries = [start];
  let index = 0;
  return {
    get current() { return entries[index]!; },
    get length() { return entries.length; },
    pushState(_d: unknown, _t: string, url?: string | URL | null) {
      entries.splice(index + 1);
      entries.push(String(url));
      index = entries.length - 1;
    },
    replaceState(_d: unknown, _t: string, url?: string | URL | null) {
      entries[index] = String(url);
    },
    back() { index = Math.max(0, index - 1); },
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
