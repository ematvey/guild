// Pure-render tests for the Skills panel's catalog logic (no DOM, no
// server): card view models from fixture skills, client-side search
// filtering, and the empty-state decision. These run under `npm test`
// (vitest); see package.json.

import { describe, expect, it } from "vitest";
import { filterSkills, skillsPageHeader, skillCard, skillsEmptyState } from "./SkillsPanel";
import type { SkillItem } from "./skills-api";

const fixtures: SkillItem[] = [
  {
    slug: "code-review",
    description: "Reviews diffs against repo standards",
    latest_version: "1.2.0",
    owner: { kind: "user", id: "u1", label: "Ada" },
    maintainer_gated: false,
    installs: 12,
    installs_latest: 9,
  },
  {
    slug: "deploy-runbook",
    description: "Compose rebuild and live-bundle check",
    latest_version: "0.9.1",
    owner: { kind: "team", id: "t1", label: "Platform" },
    maintainer_gated: true,
    installs: 3,
    installs_latest: 1,
  },
  {
    slug: "triage",
    description: "Sorts new issues by severity",
    latest_version: "2.0.0",
    owner: null,
    maintainer_gated: false,
    installs: 0,
  },
];

describe("skillCard", () => {
  it("renders every fixture skill as a card view model", () => {
    const cards = fixtures.map(skillCard);
    expect(cards.map((c) => c.slug)).toEqual(["code-review", "deploy-runbook", "triage"]);
  });

  it("carries the display fields each card renders", () => {
    const card = skillCard(fixtures[0]);
    expect(card.title).toBe("code-review");
    expect(card.description).toBe("Reviews diffs against repo standards");
    expect(card.subtitle).toBe("Ada");
    expect(card.meta).toContain("1.2.0");
    expect(card.meta).toContain("12");
    expect(card.gated).toBe(false);
  });

  it("falls back to no subtitle without an owner and marks gated skills", () => {
    expect(skillCard(fixtures[2]).subtitle).toBe("");
    const gated = skillCard(fixtures[1]);
    expect(gated.gated).toBe(true);
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

describe("skillsEmptyState", () => {
  it("returns the right message for an empty catalog vs a fruitless search", () => {
    expect(skillsEmptyState("", 0)).toBe("No skills yet.");
    expect(skillsEmptyState("deploy", 0)).toBe('No skills match "deploy".');
  });

  it("is null whenever the (filtered) catalog has cards to render", () => {
    expect(skillsEmptyState("", 3)).toBeNull();
    expect(skillsEmptyState("code", 1)).toBeNull();
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
    expect(skillsPageHeader(true).tabs.map(([value]) => value)).toEqual([
      "catalog",
      "activity",
      "machine",
    ]);
  });

  it("has no collapse button — a full page, not a sidebar panel", () => {
    expect(skillsPageHeader(false).collapseButton).toBe(false);
    expect(skillsPageHeader(true).collapseButton).toBe(false);
  });
});
