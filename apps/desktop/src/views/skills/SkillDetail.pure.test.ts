// Pure-render tests for the skill detail page's view-model logic (no DOM,
// no server): which actions are visible for a given detail payload + signed-
// in user, the update-pin decision, the fork payload, and the pin summary.
// These run under `npm test` (vitest).

import { describe, expect, it } from "vitest";
import {
  actionVariant,
  buildFileTree,
  bundleFilePaths,
  canManageSkill,
  detailActions,
  detailLoadState,
  editAccess,
  editAccessLabel,
  forkPayload,
  pinSummary,
  publishedLabel,
  readBars,
  readSummary,
  shaPrefix,
  initialsOf,
  sparkRects,
  updateAvailable,
} from "./SkillDetail";
import type { SkillDetail as SkillDetailData, SkillMe } from "./skills-api";

const base: SkillDetailData = {
  slug: "code-review",
  description: "Reviews diffs against repo standards",
  latest_version: "v3",
  versions: [
    { version: "v3", published_at: "2026-10-13T10:00:00Z", publisher: "ada@example.com", bundle_sha256: "c3" },
    { version: "v2", published_at: "2026-10-12T10:00:00Z", publisher: "ada@example.com", bundle_sha256: "c2" },
    { version: "v1", published_at: "2026-10-11T10:00:00Z", publisher: null, bundle_sha256: null },
  ],
  forked_from: null,
  maintainer_gated: false,
  owner: { kind: "user", id: "u1", label: "Ada" },
  installs: 12,
  pin_counts: [{ version: "v2", count: 4 }],
  my_install: null,
  tombstoned: false,
};

const owner: SkillMe = { role: "member", email: "ada@example.com", displayName: "Ada" };
const admin: SkillMe = { role: "admin", email: "root@example.com" };
const other: SkillMe = { role: "member", email: "bob@example.com", displayName: "Bob" };

const installedBehind: SkillDetailData = {
  ...base,
  my_install: { slug: "code-review", pinned_version: "v2", installed_at: "2026-10-12T11:00:00Z" },
};

describe("updateAvailable", () => {
  it("is true when installed at a version behind latest", () => {
    expect(updateAvailable(installedBehind)).toBe(true);
  });

  it("is false when pinned at the latest version or not installed", () => {
    const current: SkillDetailData = {
      ...base,
      my_install: { slug: "code-review", pinned_version: "v3", installed_at: "2026-10-13T11:00:00Z" },
    };
    expect(updateAvailable(current)).toBe(false);
    expect(updateAvailable(base)).toBe(false);
  });
});

describe("detailActions", () => {
  it("offers Install when not installed, regardless of session kind", () => {
    // Installs are server-side records (Task 6-C): browser sessions install
    // exactly like the Tauri app — no IS_TAURI special-casing exists here.
    const actions = detailActions(base, other);
    expect(actions).toContain("Install");
    expect(actions).not.toContain("Update pin to latest");
    expect(actions).not.toContain("Uninstall");
  });

  it("shows Update pin to latest (not Install) for an install behind latest", () => {
    const actions = detailActions(installedBehind, other);
    expect(actions).toContain("Update pin to latest");
    expect(actions).not.toContain("Install");
    expect(actions).toContain("Uninstall");
  });

  it("hides Update pin and keeps Uninstall when pinned at latest", () => {
    const actions = detailActions(
      { ...base, my_install: { slug: "code-review", pinned_version: "v3", installed_at: "2026-10-13T11:00:00Z" } },
      other,
    );
    expect(actions).not.toContain("Update pin to latest");
    expect(actions).toContain("Uninstall");
  });

  it("offers Edit and Fork for a live skill", () => {
    const actions = detailActions(base, other);
    expect(actions).toContain("Edit");
    expect(actions).toContain("Fork");
    // prototype order: Fork before Edit
    expect(actions.indexOf("Fork")).toBeLessThan(actions.indexOf("Edit"));
  });

  it("shows the editing toggle and Unpublish only to owner or admin", () => {
    const gated = detailActions({ ...base, maintainer_gated: true }, owner);
    expect(gated).toContain("Allow anyone to edit");
    expect(gated).toContain("Unpublish");
    expect(detailActions(base, admin)).toContain("Restrict editing");
    expect(detailActions(base, admin)).toContain("Unpublish");
    const stranger = detailActions(base, other);
    expect(stranger).not.toContain("Restrict editing");
    expect(stranger).not.toContain("Unpublish");
  });

  it("editAccess maps the gate flag plus owner kind to a user-facing label", () => {
    const open = { maintainer_gated: false, owner: { kind: "team" as const, id: "t1", label: "Platform" } };
    const team = { ...open, maintainer_gated: true };
    const user = { ...open, maintainer_gated: true, owner: { kind: "user" as const, id: "u1", label: "dmitri" } };
    expect(editAccessLabel(editAccess(open), open.owner.label)).toBe("Anyone can edit");
    expect(editAccessLabel(editAccess(team), team.owner.label)).toBe("Team Platform can edit");
    expect(editAccessLabel(editAccess(user), user.owner.label)).toBe("Owner can edit");
  });

  it("limits actions on a tombstoned skill to uninstall-if-installed", () => {
    expect(detailActions({ ...base, tombstoned: true }, admin)).toEqual([]);
    expect(detailActions({ ...installedBehind, tombstoned: true }, other)).toEqual(["Uninstall"]);
  });
});

describe("canManageSkill", () => {
  it("matches the owner label (display name, then email) or the admin role", () => {
    expect(canManageSkill(base, owner)).toBe(true);
    // Server owner label = display name falling back to email; an owner
    // without a display name matches by email alone.
    const emailOwned: SkillDetailData = {
      ...base,
      owner: { kind: "user", id: "u1", label: "ada@example.com" },
    };
    expect(canManageSkill(emailOwned, { role: "member", email: "ada@example.com" })).toBe(true);
    expect(canManageSkill(base, admin)).toBe(true);
    expect(canManageSkill(base, other)).toBe(false);
  });

  it("does not grant user-owner buttons over a team-owned skill", () => {
    const team: SkillDetailData = { ...base, owner: { kind: "team", id: "t1", label: "Platform" } };
    expect(canManageSkill(team, owner)).toBe(false);
    expect(canManageSkill(team, admin)).toBe(true);
  });
});

describe("forkPayload", () => {
  it("targets the source slug at latest when unpinned", () => {
    expect(forkPayload(base, "code-review-fork")).toEqual({
      slug: "code-review-fork",
      forked_from: "code-review",
      from_version: "v3",
    });
  });

  it("forks from the pinned version when installed", () => {
    const payload = forkPayload(installedBehind, "my-review");
    expect(payload.from_version).toBe("v2");
    expect(payload.forked_from).toBe("code-review");
  });
});

describe("detailLoadState", () => {
  it("is loading until the detail resolves, missing when it resolves null", () => {
    expect(detailLoadState(null, false)).toBe("loading");
    expect(detailLoadState(null, true)).toBe("missing");
    expect(detailLoadState(base, true)).toBe("ready");
    expect(detailLoadState(base, false)).toBe("ready");
  });
});

describe("pinSummary", () => {
  it("lists version × count pairs, or the no-pins text", () => {
    expect(pinSummary([{ version: "v2", count: 4 }, { version: "v3", count: 1 }])).toBe("v2 × 4 · v3 × 1");
    expect(pinSummary([])).toBe("No pins yet.");
  });
});

describe("readSummary", () => {
  it("counts reads over the 30-day window, or the no-reads text", () => {
    expect(readSummary({ total: 0, series: [] })).toBe("No reads yet.");
    expect(readSummary({ total: 1, series: [{ day: "2026-10-13", reads: 1 }] })).toBe("1 read in the last 30 days");
    expect(readSummary({ total: 12, series: [] })).toBe("12 reads in the last 30 days");
  });
});

describe("readBars", () => {
  it("normalizes the series against its peak into bar heights", () => {
    const series = [
      { day: "2026-10-11", reads: 2 },
      { day: "2026-10-12", reads: 8 },
      { day: "2026-10-13", reads: 4 },
    ];
    expect(readBars(series)).toEqual([10, 40, 20]);
  });

  it("is empty for an empty series and bottoms out at the minimum height", () => {
    expect(readBars([])).toEqual([]);
    // A lone entry is its own peak (full height); a near-zero entry against
    // a high peak clamps to the 2px floor.
    expect(readBars([{ day: "2026-10-13", reads: 1 }])).toEqual([40]);
    expect(readBars([{ day: "2026-10-12", reads: 1 }, { day: "2026-10-13", reads: 32 }])).toEqual([2, 40]);
  });
});

describe("sparkRects (the insights sparkline's SVG geometry)", () => {
  it("lays one bar per day across the 260×44 viewBox, peak at full height", () => {
    const rects = sparkRects([
      { day: "2026-10-12", reads: 0 },
      { day: "2026-10-13", reads: 8 },
    ]);
    expect(rects).toHaveLength(2);
    // bar width = 260/2 - 2, first bar flat at the 2px floor, second full
    expect(rects[0]).toMatchObject({ x: 1, w: 128, h: 2, y: 42 });
    expect(rects[1]).toMatchObject({ x: 131, w: 128, h: 40, y: 4 });
  });

  it("is empty for an empty series", () => {
    expect(sparkRects([])).toEqual([]);
  });
});

describe("shaPrefix (the versions table's Bundle cell)", () => {
  it("takes the first 12 characters", () => {
    expect(shaPrefix("a1b2c3d4e5f6g7h8")).toBe("a1b2c3d4e5f6");
  });

  it("falls back to — for a missing sha", () => {
    expect(shaPrefix(null)).toBe("—");
    expect(shaPrefix("")).toBe("—");
  });
});

describe("bundleFilePaths (the Files section's manifest list)", () => {
  it("lists SKILL.md first, then the bundle's extra files sorted", () => {
    expect(
      bundleFilePaths({
        skill_md: "# hi",
        files: [
          { path: "scripts/run.sh", size: 10, sha256: "a" },
          { path: "refs/api.md", size: 5, sha256: "b" },
        ],
      }),
    ).toEqual(["SKILL.md", "refs/api.md", "scripts/run.sh"]);
  });

  it("skips SKILL.md duplicates and the manifest sidecar", () => {
    expect(
      bundleFilePaths({
        skill_md: "# hi",
        files: [
          { path: "SKILL.md", size: 3, sha256: "x" },
          { path: "manifest.json", size: 9, sha256: "y" },
        ],
      }),
    ).toEqual(["SKILL.md"]);
  });
});

describe("buildFileTree (the file tree from the manifest paths)", () => {
  it("nests paths under dirs, dirs before files, alphabetical", () => {
    const tree = buildFileTree([
      "SKILL.md",
      "scripts/run.sh",
      "refs/api.md",
      "refs/intro.md",
      "scripts/check.sh",
    ]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:refs", "dir:scripts", "file:SKILL.md"]);
    const scripts = tree.find((n) => n.name === "scripts")!;
    expect(scripts.path).toBe("scripts");
    expect(scripts.children.map((n) => n.name)).toEqual(["check.sh", "run.sh"]);
    expect(scripts.children[0]).toMatchObject({ kind: "file", path: "scripts/check.sh" });
  });

  it("merges shared directory prefixes across files", () => {
    const tree = buildFileTree(["a/b/one.md", "a/b/two.md", "a/top.md"]);
    const a = tree[0]!;
    expect(a.children.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:b", "file:top.md"]);
  });

  it("returns a flat list for single-segment paths", () => {
    expect(buildFileTree(["SKILL.md"]).map((n) => n.name)).toEqual(["SKILL.md"]);
  });
});

describe("publishedLabel (the versions table's Published cell)", () => {
  it("formats the calendar date and a relative label", () => {
    const label = publishedLabel(new Date(Date.now() - 3 * 86_400_000).toISOString());
    expect(label.rel).toBe("3d ago");
    expect(label.date).toMatch(/\d{4}/); // month name, day and year present
  });

  it("calls same-day publishes today", () => {
    expect(publishedLabel(new Date().toISOString()).rel).toBe("today");
  });
});

describe("initialsOf (the avatar chips)", () => {
  it("takes the first two characters, uppercased", () => {
    expect(initialsOf("Ada")).toBe("AD");
  });
});

describe("actionVariant (the top bar's per-action button style)", () => {
  it("installs and pin updates are primary, unpublish is ghost, the rest outline", () => {
    expect(actionVariant("Install")).toBe("default");
    expect(actionVariant("Update pin to latest")).toBe("default");
    expect(actionVariant("Unpublish")).toBe("ghost");
    expect(actionVariant("Uninstall")).toBe("outline");
    expect(actionVariant("Fork")).toBe("outline");
    expect(actionVariant("Edit")).toBe("outline");
    expect(actionVariant("Require approval")).toBe("outline");
    expect(actionVariant("Remove approval")).toBe("outline");
  });
});
