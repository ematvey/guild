// Pure-render tests for the skill detail page's view-model logic (no DOM,
// no server): which actions are visible for a given detail payload + signed-
// in user, the update-pin decision, the fork payload, and the pin summary.
// These run under `npm test` (vitest).

import { describe, expect, it } from "vitest";
import {
  canManageSkill,
  detailActions,
  detailLoadState,
  forkPayload,
  pinSummary,
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
  });

  it("shows the gate toggle and Unpublish only to owner or admin", () => {
    const gated = detailActions({ ...base, maintainer_gated: true }, owner);
    expect(gated).toContain("Remove gate");
    expect(gated).toContain("Unpublish");
    expect(detailActions(base, admin)).toContain("Gate");
    expect(detailActions(base, admin)).toContain("Unpublish");
    const stranger = detailActions(base, other);
    expect(stranger).not.toContain("Gate");
    expect(stranger).not.toContain("Unpublish");
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
