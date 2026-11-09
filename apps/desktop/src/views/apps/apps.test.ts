import { describe, expect, it } from "vitest";
import { appsRoutePath, parseAppsRoute } from "./apps-route";
import { answerCall, pageResult, parsePageMessage } from "./bridge";
import type { ViewerFunction } from "./apps-api";
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
  reason: null,
  ...over,
});

describe("bridge", () => {
  it("reads only well-formed page messages", () => {
    expect(parsePageMessage({ guild: 1, op: "hello" })).toEqual({ guild: 1, op: "hello" });
    expect(parsePageMessage({ guild: 1, op: "call", id: 3, name: "deals" })).toEqual({
      guild: 1,
      op: "call",
      id: 3,
      name: "deals",
      params: {},
    });
    expect(parsePageMessage({ op: "call", id: 3, name: "deals" })).toBeNull();
    expect(parsePageMessage("hello")).toBeNull();
  });

  it("parses JSON results and keeps text as text", () => {
    expect(pageResult('[{"a":1}]', null).data).toEqual([{ a: 1 }]);
    expect(pageResult("1. First result", null).data).toBe("1. First result");
  });

  it("calls a read function without asking", async () => {
    let asked = false;
    const reply = await answerCall(
      { guild: 1, op: "call", id: 1, name: "deals", params: { stage: "won" } },
      {
        functions: [fn()],
        confirm: async () => {
          asked = true;
          return true;
        },
        call: async (_name, params, confirmed) => ({
          ok: true,
          content: JSON.stringify({ params, confirmed }),
          meta: null,
        }),
      },
    );
    expect(asked).toBe(false);
    expect(reply).toMatchObject({ ok: true, result: { data: { params: { stage: "won" }, confirmed: false } } });
  });

  it("asks before a write and stops when the viewer declines", async () => {
    let called = false;
    const deps = (answer: boolean) => ({
      functions: [fn({ confirm: true, class: "write" })],
      confirm: async () => answer,
      call: async (_n: string, _p: unknown, confirmed: boolean) => {
        called = true;
        return { ok: true as const, content: String(confirmed), meta: null };
      },
    });
    const declined = await answerCall({ guild: 1, op: "call", id: 2, name: "deals", params: {} }, deps(false));
    expect(declined).toMatchObject({ ok: false, error: "you declined this action" });
    expect(called).toBe(false);
    const allowed = await answerCall({ guild: 1, op: "call", id: 3, name: "deals", params: {} }, deps(true));
    expect(allowed).toMatchObject({ ok: true, result: { text: "true" } });
  });

  it("refuses unknown and unavailable functions without calling", async () => {
    const call = async () => {
      throw new Error("must not call");
    };
    const unknown = await answerCall(
      { guild: 1, op: "call", id: 4, name: "nope", params: {} },
      { functions: [fn()], confirm: async () => true, call },
    );
    expect(unknown).toMatchObject({ ok: false });
    const off = await answerCall(
      { guild: 1, op: "call", id: 5, name: "deals", params: {} },
      { functions: [fn({ available: false, reason: "no access" })], confirm: async () => true, call },
    );
    expect(off).toMatchObject({ ok: false, error: "no access" });
  });
});
