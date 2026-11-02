// Pure-render tests for the Skills panel's catalog logic (no DOM, no
// server): row view models from fixture skills (install pin, update
// badge), the search / filter / sort pipeline, and the empty-state
// decision. These run under `npm test` (vitest); see package.json.

import { describe, expect, it } from "vitest";
import { filterByKind, filterSkills, skillsPageHeader, skillRow, skillsEmptyState, sortSkills } from "./SkillsPanel";
import { clampSkillsRoute, SKILLS_CATALOG, skillsPageState, type SkillsRoute } from "./skills-route";
import { avatarChip } from "../../lib/format";
import { versionRank } from "./version";
import type { SkillInstall, SkillItem, SkillMe } from "./skills-api";

const fixtures: SkillItem[] = [
  {
    slug: "code-review",
    description: "Reviews diffs against repo standards",
    latest_version: "v3",
    owner: { kind: "user", id: "u1", label: "Ada", avatar_url: null },
    maintainer_gated: false,
    installs: 12,
    installs_latest: 9,
    tombstoned: false,
  },
  {
    slug: "deploy-runbook",
    description: "Compose rebuild and live-bundle check",
    latest_version: "v2",
    owner: { kind: "team", id: "t1", label: "Platform", avatar_url: null },
    maintainer_gated: true,
    installs: 3,
    installs_latest: 1,
    tombstoned: false,
  },
  {
    slug: "triage",
    description: "Sorts new issues by severity",
    latest_version: "v10",
    owner: null,
    maintainer_gated: false,
    installs: 0,
    installs_latest: 0,
    tombstoned: false,
  },
];

const me: SkillMe = { role: "member", email: "ada@example.com", displayName: "Ada" };
const pin: SkillInstall = { slug: "code-review", pinned_version: "v2", installed_at: "2026-10-12T11:00:00Z" };

describe("skillRow", () => {
  it("renders every fixture skill as a row view model", () => {
    const rows = fixtures.map((f) => skillRow(f, null));
    expect(rows.map((r) => r.slug)).toEqual(["code-review", "deploy-runbook", "triage"]);
  });

  it("carries the display fields each row renders", () => {
    const row = skillRow(fixtures[0]!, null);
    expect(row.slug).toBe("code-review");
    expect(row.description).toBe("Reviews diffs against repo standards");
    expect(row.ownerLabel).toBe("Ada");
    expect(row.meta).toContain("v3");
    expect(row.meta).toContain("12");
    expect(row.gated).toBe(false);
  });

  it("falls back to no owner without one and marks approval-gated skills", () => {
    expect(skillRow(fixtures[2]!, null).ownerLabel).toBe("");
    expect(skillRow(fixtures[1]!, null).gated).toBe(true);
  });

  it("carries the viewer's pin and the update badge target when behind latest", () => {
    expect(skillRow(fixtures[0]!, pin)).toMatchObject({ pin: "v2", updateTo: "v3" });
    expect(skillRow(fixtures[0]!, null)).toMatchObject({ pin: null, updateTo: null });
  });

  it("splits the version and install count out for the row's emphasized meta", () => {
    expect(skillRow(fixtures[0]!, null)).toMatchObject({ latestVersion: "v3", installsCount: 12 });
    expect(skillRow(fixtures[2]!, null)).toMatchObject({ latestVersion: "v10", installsCount: 0 });
  });

  it("shows no update badge when pinned at the latest version", () => {
    const current: SkillInstall = { ...pin, pinned_version: "v3" };
    expect(skillRow(fixtures[0]!, current)).toMatchObject({ pin: "v3", updateTo: null });
  });
});

describe("avatarChip (the row's avatar chip)", () => {
  it("takes the first two characters, uppercased", () => {
    expect(avatarChip("Ada")).toBe("AD");
    expect(avatarChip("platform-team")).toBe("PL");
  });
});

describe("filterSkills (the search box's client-side filter)", () => {
  it("matches slug, description and owner label, case-insensitively", () => {
    expect(filterSkills(fixtures, "code").map((s) => s.slug)).toEqual(["code-review"]);
    expect(filterSkills(fixtures, "runbook").map((s) => s.slug)).toEqual(["deploy-runbook"]);
    expect(filterSkills(fixtures, "platform").map((s) => s.slug)).toEqual(["deploy-runbook"]);
    // upper-case query against a lower-case slug still matches
    expect(filterSkills(fixtures, "TRIAGE").map((s) => s.slug)).toEqual(["triage"]);
  });

  it("returns everything for a blank query and nothing for a miss", () => {
    expect(filterSkills(fixtures, "")).toHaveLength(3);
    expect(filterSkills(fixtures, "   ")).toHaveLength(3);
    expect(filterSkills(fixtures, "zzz-not-here")).toEqual([]);
  });
});

describe("versionRank (the recently-updated sort's version order)", () => {
  it("parses the numeric suffix of a vN version", () => {
    expect(versionRank("v3")).toBe(3);
    expect(versionRank("v10")).toBe(10);
    expect(versionRank("1.2.0")).toBe(1);
  });
});

describe("filterByKind (the filter select's client-side cut)", () => {
  const installedSlugs = new Set(["code-review"]);
  const ctx = { installedSlugs, me };

  it("all keeps everything; installed keeps only the viewer's installs", () => {
    expect(filterByKind(fixtures, "all", ctx)).toHaveLength(3);
    expect(filterByKind(fixtures, "installed", ctx).map((s) => s.slug)).toEqual(["code-review"]);
  });

  it("mine keeps user-owned skills whose label is the viewer's name or email", () => {
    expect(filterByKind(fixtures, "mine", ctx).map((s) => s.slug)).toEqual(["code-review"]);
    const other: SkillMe = { role: "member", email: "bob@example.com", displayName: "Bob" };
    expect(filterByKind(fixtures, "mine", { installedSlugs, me: other })).toEqual([]);
  });

  it("approval keeps only maintainer-gated skills", () => {
    expect(filterByKind(fixtures, "approval", ctx).map((s) => s.slug)).toEqual(["deploy-runbook"]);
  });
});

describe("sortSkills (the sort select's ordering)", () => {
  it("most installed sorts by install count descending", () => {
    expect(sortSkills(fixtures, "installs").map((s) => s.slug)).toEqual(["code-review", "deploy-runbook", "triage"]);
  });

  it("recently updated sorts by version rank descending (the catalog has no timestamps)", () => {
    expect(sortSkills(fixtures, "updated").map((s) => s.slug)).toEqual(["triage", "code-review", "deploy-runbook"]);
  });

  it("A → Z sorts by slug ascending", () => {
    expect(sortSkills(fixtures, "az").map((s) => s.slug)).toEqual(["code-review", "deploy-runbook", "triage"]);
  });
});

describe("skillsEmptyState", () => {
  it("returns the right message for an empty catalog vs a fruitless search", () => {
    expect(skillsEmptyState("", 0)).toBe("No skills yet.");
    expect(skillsEmptyState("deploy", 0)).toBe('No skills match "deploy".');
  });

  it("distinguishes a filter that cut everything from an empty catalog", () => {
    expect(skillsEmptyState("", 0, true)).toBe("No skills match the current filter.");
    expect(skillsEmptyState("", 3, true)).toBeNull();
    expect(skillsEmptyState("deploy", 0, true)).toBe('No skills match "deploy".');
  });

  it("is null whenever the (filtered) catalog has rows to render", () => {
    expect(skillsEmptyState("", 3)).toBeNull();
    expect(skillsEmptyState("code", 1)).toBeNull();
  });
});

describe("skills-route (the page's URL contract)", () => {
  it("skillsPageState derives tab, detail slug and editor from the route", () => {
    expect(skillsPageState(SKILLS_CATALOG)).toMatchObject({
      tab: "catalog",
      selected: null,
      editor: null,
    });
    expect(skillsPageState({ view: "activity", slug: null, editor: null })).toMatchObject({
      tab: "activity",
      selected: null,
    });
    expect(skillsPageState({ view: "catalog", slug: "code-review", editor: null })).toMatchObject({
      tab: "catalog",
      selected: "code-review",
      editor: null,
    });
    // the editor replaces the page body: no detail renders under it
    expect(skillsPageState({ view: "catalog", slug: null, editor: "new" })).toMatchObject({
      tab: "catalog",
      selected: null,
      editor: { mode: "create" },
    });
    expect(skillsPageState({ view: "catalog", slug: "code-review", editor: "code-review" })).toMatchObject({
      tab: "catalog",
      selected: null,
      editor: { mode: "edit", slug: "code-review" },
    });
  });

  it("clampSkillsRoute falls back from the machine tab off-Tauri and passes everything else through", () => {
    const machine: SkillsRoute = { view: "machine", slug: null, editor: null };
    expect(clampSkillsRoute(machine, false)).toEqual({ view: "catalog", slug: null, editor: null });
    expect(clampSkillsRoute(machine, true)).toBe(machine);
    const detail: SkillsRoute = { view: "catalog", slug: "x", editor: null };
    expect(clampSkillsRoute(detail, false)).toBe(detail);
  });
});

describe("skillsPageHeader (the full-page header contract)", () => {
  it("carries title, search and the New skill action in one row", () => {
    const header = skillsPageHeader(false);
    expect(header.title).toBe("Skills");
    expect(header.searchPlaceholder).toBe("Search skills");
    expect(header.newSkill).toBe(true);
  });

  it("renders the Catalog/Activity tab bar, machine tab only in Tauri", () => {
    expect(skillsPageHeader(false).tabs.map(([value]) => value)).toEqual(["catalog", "activity"]);
    expect(skillsPageHeader(true).tabs.map(([value]) => value)).toEqual(["catalog", "activity", "machine"]);
  });

  it("has no collapse button — a full page, not a sidebar panel", () => {
    expect(skillsPageHeader(false).collapseButton).toBe(false);
    expect(skillsPageHeader(true).collapseButton).toBe(false);
  });
});
