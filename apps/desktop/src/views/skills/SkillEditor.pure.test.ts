// Pure tests for the skill editor's view-model logic (no DOM, no server):
// slug validation mirroring the server's manifest rules, the save request
// each mode builds (POST create / PUT edit), and the owner selector's
// options (me + my teams).

import { describe, expect, it } from "vitest";
import { canSave, ownerOptions, saveRequest, slugError, type EditorForm } from "./SkillEditor";

const base: EditorForm = {
  slug: "code-review",
  description: "Reviews diffs against repo standards",
  body: "# Code review\n\nReviews diffs.",
  ownerTeamId: null,
};

describe("slugError (mirrors the server's manifest validation)", () => {
  it("accepts lowercase letters, digits, dashes and underscores", () => {
    expect(slugError("code-review")).toBeNull();
    expect(slugError("deploy_runbook_2")).toBeNull();
  });

  it("rejects an empty slug", () => {
    expect(slugError("")).not.toBeNull();
  });

  it("rejects slugs over 64 characters", () => {
    expect(slugError("a".repeat(64))).toBeNull();
    expect(slugError("a".repeat(65))).not.toBeNull();
  });

  it("rejects characters outside [a-z0-9_-]", () => {
    expect(slugError("Code-Review")).not.toBeNull();
    expect(slugError("has space")).not.toBeNull();
    expect(slugError("slash/slug")).not.toBeNull();
    expect(slugError("dot.dot")).not.toBeNull();
  });
});

describe("saveRequest", () => {
  it("create mode POSTs the full payload to /api/v1/skills", () => {
    const req = saveRequest("create", base);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/skills");
    expect(req.body).toEqual({
      slug: "code-review",
      description: "Reviews diffs against repo standards",
      body: "# Code review\n\nReviews diffs.",
    });
  });

  it("create mode carries owner_team_id only when a team is picked", () => {
    const req = saveRequest("create", { ...base, ownerTeamId: "t1" });
    expect(req.body).toMatchObject({ slug: "code-review", owner_team_id: "t1" });
    expect(saveRequest("create", base).body).not.toHaveProperty("owner_team_id");
  });

  it("edit mode PUTs description + body to /api/v1/skills/:slug", () => {
    const req = saveRequest("edit", base);
    expect(req.method).toBe("PUT");
    expect(req.path).toBe(`/api/v1/skills/${encodeURIComponent("code-review")}`);
    expect(req.body).toEqual({
      description: "Reviews diffs against repo standards",
      body: "# Code review\n\nReviews diffs.",
    });
  });

  it("edit mode never sends the slug or owner fields", () => {
    const req = saveRequest("edit", { ...base, ownerTeamId: "t1" });
    expect(req.body).not.toHaveProperty("slug");
    expect(req.body).not.toHaveProperty("owner_team_id");
  });
});

describe("ownerOptions (the owner selector: me + my teams)", () => {
  it("always offers Me first, then one option per team", () => {
    expect(ownerOptions([])).toEqual([{ value: "", label: "Me" }]);
    expect(ownerOptions([{ id: "t1", name: "Platform" }, { id: "t2", name: "Research" }])).toEqual([
      { value: "", label: "Me" },
      { value: "t1", label: "Platform" },
      { value: "t2", label: "Research" },
    ]);
  });
});

describe("canSave", () => {
  it("create mode requires a valid slug", () => {
    expect(canSave(base, "create")).toBe(true);
    expect(canSave({ ...base, slug: "Bad Slug" }, "create")).toBe(false);
  });

  it("edit mode has no slug gate (the slug is fixed)", () => {
    expect(canSave({ ...base, slug: "" }, "edit")).toBe(true);
  });
});
