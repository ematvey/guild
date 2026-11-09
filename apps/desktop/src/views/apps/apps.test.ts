import { describe, expect, it } from "vitest";
import { appsRoutePath, parseAppsRoute } from "./apps-route";
import { answerCall, pageResult, parsePageMessage, requestLine, sharedConfirm } from "./bridge";
import type { ConfirmAnswer, ViewerFunction } from "./apps-api";
import { applyRoutePatch, parseChatRoute, SURFACE_BASE } from "../thread/route";
import { routePath } from "../thread/hooks/use-thread-route";

const ID = "0192f3a1-7c2e-7a51-9d1e-3b5c7d9e1f20";

describe("apps route", () => {
  it("round-trips the list and one App", () => {
    expect(appsRoutePath(parseAppsRoute([]))).toBe("/apps");
    expect(appsRoutePath(parseAppsRoute([ID]))).toBe(`/apps/${ID}`);
  });

  it("is a top-level surface: parsed from the address, written back to it", () => {
    const route = parseChatRoute(`/apps/${ID}`);
    expect(route.apps).toEqual({ appId: ID });
    expect(route.chatId).toBeNull();
    expect(routePath(route)).toBe(`/apps/${ID}`);
  });

  it("opening a chat or another surface leaves it, and opening it leaves the others", () => {
    const onApps = parseChatRoute(`/apps/${ID}`);
    expect(applyRoutePatch(onApps, { chatId: "c1" }).apps ?? null).toBeNull();
    expect(
      applyRoutePatch(onApps, { ...SURFACE_BASE, skills: { view: "catalog", slug: null, editor: null } }).apps ?? null,
    ).toBeNull();
    const onSkills = parseChatRoute("/skills");
    const next = applyRoutePatch(onSkills, { ...SURFACE_BASE, apps: { appId: null } });
    expect(next.skills).toBeNull();
    expect(routePath(next)).toBe("/apps");
  });
});

const fn = (over: Partial<ViewerFunction> = {}): ViewerFunction => ({
  name: "deals",
  description: "Deals",
  integration: "hubspot",
  tool: "hubspot_search_deals",
  params: {},
  class: "read",
  available: true,
  confirm: false,
  granted: false,
  args: {},
  reason: null,
  ...over,
});

const call = (name: string, id = 1) => ({ guild: 1 as const, op: "call" as const, id, name, params: {} });

describe("bridge", () => {
  it("reads only well-formed page messages", () => {
    expect(parsePageMessage({ guild: 1, op: "hello" })).toEqual({ guild: 1, op: "hello" });
    expect(parsePageMessage({ guild: 1, op: "call", id: 3, name: "deals" })).toEqual(call("deals", 3));
    expect(parsePageMessage({ op: "call", id: 3, name: "deals" })).toBeNull();
    expect(parsePageMessage("hello")).toBeNull();
  });

  it("parses JSON results and keeps text as text", () => {
    expect(pageResult('[{"a":1}]', null).data).toEqual([{ a: 1 }]);
    expect(pageResult("1. First result", null).data).toBe("1. First result");
  });

  const deps = (functions: ViewerFunction[], answer: ConfirmAnswer) => {
    const seen = { asked: 0, calls: [] as [boolean, boolean][], granted: [] as string[] };
    return {
      seen,
      deps: {
        functions,
        confirm: async () => {
          seen.asked += 1;
          return answer;
        },
        call: async (_n: string, _p: unknown, confirmed: boolean, remember: boolean) => {
          seen.calls.push([confirmed, remember]);
          return { ok: true as const, content: '{"x":1}', meta: null };
        },
        granted: (name: string) => seen.granted.push(name),
      },
    };
  };

  it("calls a read function without asking", async () => {
    const { seen, deps: d } = deps([fn()], "decline");
    expect(await answerCall(call("deals"), d)).toMatchObject({ ok: true, result: { data: { x: 1 } } });
    expect(seen.asked).toBe(0);
    expect(seen.calls).toEqual([[false, false]]);
  });

  it("asks before a write-class function and stops when the viewer declines", async () => {
    const { seen, deps: d } = deps([fn({ confirm: true, class: "write" })], "decline");
    expect(await answerCall(call("deals"), d)).toMatchObject({ ok: false, error: "you declined this action" });
    expect(seen.calls).toEqual([]);
  });

  it("allow once confirms the call; always also records the grant", async () => {
    const once = deps([fn({ confirm: true })], "once");
    await answerCall(call("deals"), once.deps);
    expect(once.seen.calls).toEqual([[true, false]]);
    expect(once.seen.granted).toEqual([]);
    const always = deps([fn({ confirm: true })], "always");
    await answerCall(call("deals"), always.deps);
    expect(always.seen.calls).toEqual([[true, true]]);
    expect(always.seen.granted).toEqual(["deals"]);
  });

  it("does not ask for a function the viewer already granted", async () => {
    const { seen, deps: d } = deps([fn({ confirm: true, granted: true })], "decline");
    expect(await answerCall(call("deals"), d)).toMatchObject({ ok: true });
    expect(seen.asked).toBe(0);
    expect(seen.calls).toEqual([[false, false]]);
  });

  it("refuses unknown and unavailable functions without calling", async () => {
    const { seen, deps: d } = deps([fn({ name: "off", available: false, reason: "no access" })], "always");
    expect(await answerCall(call("nope"), d)).toMatchObject({ ok: false });
    expect(await answerCall(call("off"), d)).toMatchObject({ ok: false, error: "no access" });
    expect(seen.calls).toEqual([]);
  });

  it("concurrent calls of one function share one question", async () => {
    const answers = new Map<string, (a: ConfirmAnswer) => void>();
    const ask = sharedConfirm(
      (f) =>
        new Promise<ConfirmAnswer>((resolve) => {
          answers.set(f.name, resolve);
        }),
    );
    const a = ask(fn(), {});
    const b = ask(fn(), {});
    const other = ask(fn({ name: "other" }), {});
    expect([...answers.keys()]).toEqual(["deals", "other"]);
    answers.get("deals")!("once");
    answers.get("other")!("decline");
    expect(await Promise.all([a, b, other])).toEqual(["once", "once", "decline"]);
    const again = ask(fn(), {});
    answers.get("deals")!("always");
    expect(await again).toBe("always");
  });

  it("shows a raw API function as its method and path", () => {
    expect(requestLine(fn({ args: { method: "POST", path: "/crm/v3/objects/deals/search" } }))).toBe(
      "POST /crm/v3/objects/deals/search",
    );
    expect(requestLine(fn())).toBe("hubspot/hubspot_search_deals");
  });
});
