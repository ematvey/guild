// Pure-render tests for the activity feed's view-model logic (no DOM, no
// server): row text/icon/timestamp per event kind, the all|changes pill
// filter over a mixed event list, and the empty state. These run under
// `npm test` (vitest).

import { describe, expect, it } from "vitest";
import { Download, EyeOff, GitFork, Pin, RefreshCw, Upload } from "lucide-react";
import {
  activityEmptyState,
  activityIcon,
  activityKind,
  activityMatchesFilter,
  activityRows,
  activityText,
  activityTime,
} from "../../../../control-center/src/skills/ActivityFeed";
import type { SkillActivityEvent } from "./skills-api";

const published: SkillActivityEvent = {
  ts: "2026-10-13T10:00:00Z",
  kind: "registry.published",
  // publishBundleBytes emits the publisher's identity too; this fixture
  // stays actorless to pin the fallback rendering.
  payload: { kind: "skill", slug: "sql-explorer", version: "v3" },
};
const publishedByActor: SkillActivityEvent = {
  ts: "2026-10-13T10:00:00Z",
  kind: "registry.published",
  payload: { kind: "skill", slug: "sql-explorer", version: "v3", user_id: "u9", actor: "maya" },
};
const updatedByActor: SkillActivityEvent = {
  ts: "2026-10-13T11:00:00Z",
  kind: "registry.updated",
  payload: { kind: "skill", slug: "sql-explorer", version: "v4", user_id: "u9", actor: "maya" },
};
const installed: SkillActivityEvent = {
  ts: "2026-10-13T09:30:00Z",
  kind: "skill.installed",
  payload: { slug: "sql-explorer", version: "v2", user_id: "u2", actor: "maya" },
};
const pinned: SkillActivityEvent = {
  ts: "2026-10-13T09:00:00Z",
  kind: "skill.pinned",
  payload: { slug: "sql-explorer", version: "v2", user_id: "u2", actor: "maya" },
};
const forked: SkillActivityEvent = {
  ts: "2026-10-12T18:00:00Z",
  kind: "registry.forked",
  payload: { slug: "sql-explorer-fork", version: "v1", forked_from: "sql-explorer@v3", actor: "bob" },
};
const unpublished: SkillActivityEvent = {
  ts: "2026-10-12T17:00:00Z",
  kind: "registry.unpublished",
  payload: { slug: "legacy-tool", user_id: "u1", actor: "ada@example.com" },
};

describe("activityText", () => {
  it("renders publish and install rows from the real payload fields", () => {
    // actorless payloads (legacy rows) still render the current text
    expect(activityText(published)).toBe("Published `sql-explorer` v3");
    expect(activityText(installed)).toBe("maya installed `sql-explorer` v2");
  });

  it("names the actor on publish/update rows when the payload carries one", () => {
    expect(activityText(publishedByActor)).toBe("maya published `sql-explorer` v3");
    expect(activityText(updatedByActor)).toBe("maya updated `sql-explorer` to v4");
  });

  it("renders fork, pin, unpublish and updated rows", () => {
    expect(activityText(forked)).toBe("bob forked `sql-explorer-fork` from sql-explorer@v3");
    expect(activityText(pinned)).toBe("maya pinned `sql-explorer` to v2");
    expect(activityText(unpublished)).toBe("ada@example.com unpublished `legacy-tool`");
    const updated: SkillActivityEvent = {
      ts: "2026-10-13T11:00:00Z",
      kind: "registry.updated",
      payload: { kind: "skill", slug: "sql-explorer", version: "v4" },
    };
    expect(activityText(updated)).toBe("Updated `sql-explorer` to v4");
  });

  it("renders actor-bearing publish/update rows in the row view-model too", () => {
    const rows = activityRows([publishedByActor], "all");
    expect(rows).toEqual([
      { event: publishedByActor, icon: Upload, text: "maya published `sql-explorer` v3", time: "2026-10-13 10:00" },
    ]);
  });

  it("returns null for unknown event kinds", () => {
    expect(activityText({ ts: "2026-10-13T10:00:00Z", kind: "other.thing", payload: {} })).toBeNull();
  });
});

describe("activityKind + activityIcon", () => {
  it("maps each event kind to its row icon", () => {
    expect(activityKind(published)).toBe("publish");
    expect(activityIcon(published)).toBe(Upload);
    expect(
      activityIcon({
        ts: "2026-10-13T10:00:00Z",
        kind: "registry.updated",
        payload: { slug: "s", version: "v2" },
      }),
    ).toBe(RefreshCw);
    expect(activityIcon(forked)).toBe(GitFork);
    expect(activityIcon(installed)).toBe(Download);
    expect(activityIcon(pinned)).toBe(Pin);
    expect(activityIcon(unpublished)).toBe(EyeOff);
  });

  it("is null for unknown kinds", () => {
    expect(activityKind({ ts: "2026-10-13T10:00:00Z", kind: "auth.login", payload: {} })).toBeNull();
  });
});

describe("activityMatchesFilter (the pill filter)", () => {
  const mixed = [published, installed, pinned, forked, unpublished];

  it("shows only authorship events under 'changes'", () => {
    const kinds = mixed.filter((e) => activityMatchesFilter(e, "changes")).map((e) => e.kind);
    expect(kinds).toEqual(["registry.published", "registry.forked"]);
  });

  it("shows everything under 'all'", () => {
    expect(mixed.every((e) => activityMatchesFilter(e, "all"))).toBe(true);
  });
});

describe("activityRows", () => {
  it("drops unknown kinds and applies the filter, newest first", () => {
    const rows = activityRows(
      [installed, { ts: "2026-10-13T10:00:00Z", kind: "auth.login", payload: {} }, published],
      "changes",
    );
    expect(rows).toEqual([
      { event: published, icon: Upload, text: "Published `sql-explorer` v3", time: "2026-10-13 10:00" },
    ]);
  });
});

describe("activityTime", () => {
  it("formats the ISO timestamp as a local-readable wall clock", () => {
    expect(activityTime("2026-10-13T10:05:00Z")).toBe("2026-10-13 10:05");
  });
});

describe("activityEmptyState", () => {
  it("differs per filter", () => {
    expect(activityEmptyState("all")).toBe("No activity yet.");
    expect(activityEmptyState("changes")).toBe("No changes to skills yet.");
  });
});
