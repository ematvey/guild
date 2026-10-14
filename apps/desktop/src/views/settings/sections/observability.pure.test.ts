// Pure tests for the Observability settings section: the URL contract
// (/settings/observability, the row sub-page, period/filter query params)
// and the section catalog registration. No DOM, no server.

import { describe, expect, it } from "vitest";
import { parseChatRoute, chatRoutePath } from "../../WebChat";
import { SETTINGS_SECTIONS } from "../settings-sections";
import { filtersToQuery, readFiltersOf } from "./observability-route";

describe("observability section routing", () => {
  it("is a registered non-admin section (members see their own calls)", () => {
    const def = SETTINGS_SECTIONS.find((s) => s.id === "observability");
    expect(def).toBeDefined();
    expect(def!.admin).toBeUndefined();
  });

  it("the section URL parses and round-trips", () => {
    const r = parseChatRoute("/settings/observability");
    expect(r).toMatchObject({ tab: "settings", settingsSection: "observability", settingsDetail: null });
    expect(
      chatRoutePath(r.chatId, r.projectId, r.overlay, r.skills, r.tab, r.settingsSection, r.settingsDetail, r.newChat),
    ).toBe("/settings/observability");
  });

  it("the row detail is the section's <detail> segment and round-trips", () => {
    const id = "018f3c2e-8c73-7c00-8000-000000000000";
    const r = parseChatRoute(`/settings/observability/${id}`);
    expect(r).toMatchObject({ tab: "settings", settingsSection: "observability", settingsDetail: id });
    expect(
      chatRoutePath(r.chatId, r.projectId, r.overlay, r.skills, r.tab, r.settingsSection, r.settingsDetail, r.newChat),
    ).toBe(`/settings/observability/${id}`);
    // An open row is one back-step from the section root.
    expect(
      parseChatRoute(chatRoutePath(null, null, null, null, "settings", "observability", null, false)),
    ).toMatchObject({ settingsDetail: null });
  });
});

describe("observability query params", () => {
  it("period + filters round-trip through the URL query", () => {
    const url = new URL("https://guild.local/settings/observability?period=24h&caller=judge&model=m1&chat=abc");
    expect(readFiltersOf(url)).toEqual({ period: "24h", caller: "judge", model: "m1", chat: "abc" });
    const out = new URL("https://guild.local/settings/observability");
    filtersToQuery({ period: "30d", caller: "model", model: "m2", chat: "" }, out);
    expect(out.search).toBe("?period=30d&caller=model&model=m2");
  });

  it("unknown values fall back to the defaults", () => {
    const filters = readFiltersOf(new URL("https://guild.local/settings/observability?period=year&caller=everyone"));
    expect(filters).toEqual({ period: "7d", caller: "all", model: "", chat: "" });
  });
});
