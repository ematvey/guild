// The composer's `/`-trigger made deterministic: parseSkillInvocation reads
// the leading `/slug` out of a user text, skillInvocationDirective renders
// the read-and-follow directive, and SkillRuntime.invocationDirective
// resolves the slug — machine-local (from the client index stash) first,
// then the org catalog, null for unknown slugs so ordinary `/`-prefixed
// text passes through untouched.

import { describe, expect, it } from "vitest";
import {
  parseSkillInvocation,
  skillInvocationDirective,
  SkillRuntime,
  type SkillRuntimeDeps,
} from "../../harness/skills.js";

describe("parseSkillInvocation", () => {
  it("parses /slug with and without args", () => {
    expect(parseSkillInvocation("/hubspot-investigate investigate")).toEqual({
      slug: "hubspot-investigate",
      args: "investigate",
    });
    expect(parseSkillInvocation("/deploy  ")).toEqual({ slug: "deploy", args: "" });
    expect(parseSkillInvocation("  /report weekly numbers ")).toEqual({
      slug: "report",
      args: "weekly numbers",
    });
  });

  it("rejects non-invocation text", () => {
    expect(parseSkillInvocation("plain message")).toBeNull();
    expect(parseSkillInvocation("/")).toBeNull();
    expect(parseSkillInvocation("/UPPER-CASE")).toBeNull();
    expect(parseSkillInvocation("see /slash mid-sentence")).toBeNull();
  });

  it("never claims the builtin compact command", () => {
    expect(parseSkillInvocation("/compact")).toBeNull();
  });
});

describe("skillInvocationDirective", () => {
  it("renders the org (read_skill) form with args", () => {
    const d = skillInvocationDirective({ slug: "sql-explorer", args: "count users" }, false);
    expect(d).toContain('read_skill with slug "sql-explorer"');
    expect(d).toContain("count users");
    expect(d).not.toContain("No arguments");
  });

  it("renders the local (skills/<slug> tree) form and the no-args tail", () => {
    const d = skillInvocationDirective({ slug: "deploy", args: "" }, true);
    expect(d).toContain("local skill on this machine");
    expect(d).toContain("skills/deploy/SKILL.md");
    expect(d).toContain("No arguments were given.");
  });
});

describe("SkillRuntime.invocationDirective", () => {
  const SEARCH = [
    { slug: "sql-explorer", description: "d", latest_version: "v1", review_status: "approved" },
    { slug: "backup-tool", description: "d", latest_version: "v1", review_status: "approved" },
  ];

  function runtime(search = SEARCH): SkillRuntime {
    return new SkillRuntime({
      log: { warn: () => {} },
      registry: { searchSkills: async () => search },
    } as unknown as SkillRuntimeDeps);
  }

  it("resolves an org catalog slug to the read_skill directive", async () => {
    const d = await runtime().invocationDirective("org-1", "/sql-explorer run counts");
    expect(d).toContain('read_skill with slug "sql-explorer"');
  });

  it("prefers the machine-local slug from the stash", async () => {
    const index = "# Available skills\n- backup-tool: local copy";
    const d = await runtime().invocationDirective("org-1", "/backup-tool", index);
    expect(d).toContain("local skill on this machine");
  });

  it("returns null for unknown slugs (text passes through)", async () => {
    await expect(runtime().invocationDirective("org-1", "/no-such-skill")).resolves.toBeNull();
    await expect(runtime().invocationDirective("org-1", "just a normal message")).resolves.toBeNull();
  });

  it("returns null (never throws) when the registry read fails", async () => {
    const broken = runtime(() => {
      throw new Error("down");
    });
    await expect(broken.invocationDirective("org-1", "/sql-explorer")).resolves.toBeNull();
  });
});
