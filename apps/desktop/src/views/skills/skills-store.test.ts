// @vitest-environment happy-dom
// The skill catalog frame replaces the catalog and installs; skill org
// events reach the activity listeners, other kinds do not.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillActivityEvent } from "./skills-api";
import {
  applyOrgEvent,
  applySkillCatalog,
  clearSkillCatalog,
  useSkillActivityEvents,
  useSkillCatalog,
} from "./skills-store";

afterEach(() => clearSkillCatalog());

describe("skills store", () => {
  it("replaces the catalog and the member's installs on every frame", () => {
    const { result } = renderHook(() => useSkillCatalog());
    expect(result.current).toBeNull();
    act(() =>
      applySkillCatalog({
        items: [{ slug: "pdf", description: "", latest_version: "1.0.0", owner: null, maintainer_gated: false, installs: 1, installs_latest: 1, tombstoned: false }],
        installs: [{ slug: "pdf", pinned_version: null, installed_at: "2026-11-01T00:00:00Z" }],
      }),
    );
    expect(result.current?.items.map((i) => i.slug)).toEqual(["pdf"]);
    expect(result.current?.installs.map((i) => i.slug)).toEqual(["pdf"]);
  });

  it("hands skill org events to the activity listeners and drops the rest", () => {
    const heard: SkillActivityEvent[] = [];
    renderHook(() => useSkillActivityEvents((event) => heard.push(event)));
    const base = { id: "e", org_id: "o", created_at: "2026-11-01T00:00:00Z" };
    act(() => {
      applyOrgEvent({ ...base, kind: "registry.published", payload: { slug: "pdf" } });
      applyOrgEvent({ ...base, kind: "integration.tool_called", payload: {} });
      applyOrgEvent({ ...base, kind: "skill.installed", payload: { slug: "pdf" } });
    });
    expect(heard.map((e) => e.kind)).toEqual(["registry.published", "skill.installed"]);
    expect(heard[0]).toMatchObject({ ts: base.created_at, payload: { slug: "pdf" } });
  });
});
