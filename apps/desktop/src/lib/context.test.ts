//! Context-assembly logic (context.ts): the port of the daemon's Rust
//! skills.rs + agents_md.rs. The fake fs mirrors the bridge contract;
//! expectations come from the Rust implementations' own tests.

import { describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  promptIndex,
  mentionExpansions,
  mentionBlock,
  prepareTurn,
  projectAgentDocs,
  loadGlobalAgentsMd,
  discoverSkills,
  listSkills,
  setSkillDisabled,
  installedOrgSkills,
  type BridgeFs,
  type DirEntry,
  type OrgSkillsApi,
} from "./context";

/** In-memory fs with the bridge's shapes. */
function fakeFs(files: Record<string, string>, dirs: string[] = []): BridgeFs & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  const all = new Set([...Object.keys(files), ...dirs]);
  return {
    written,
    scopes: async () => ({ configDir: "/cfg/guild", home: "/home/u" }),
    exists: async (_p, path) =>
      all.has(path) ||
      [...all].some((f) => f.startsWith(`${path}/`)) ||
      Object.keys(written).includes(path),
    readText: async (_p, path) => files[path] ?? written[path] ?? null,
    listDir: async (_p, path) => {
      const seen = new Map<string, DirEntry>();
      for (const f of [...all, ...Object.keys(written)]) {
        if (f === path || !f.startsWith(`${path}/`)) continue;
        const top = f.slice(path.length + 1).split("/")[0];
        const isDir =
          f.slice(path.length + 1).includes("/") ||
          [...all].some((x) => x.startsWith(`${path}/${top}/`));
        seen.set(top, { name: top, kind: isDir ? "dir" : "file" });
      }
      return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    writeText: async (_p, path, body) => {
      written[path] = body;
      return true;
    },
  };
}

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}`;

describe("parseFrontmatter", () => {
  it("parses name + description, quoted values included", () => {
    const { name, description } = parseFrontmatter(
      '---\nname: "deploy-check"\ndescription: Verify a deploy\n---\n\nSteps.',
      "fallback",
    );
    expect(name).toBe("deploy-check");
    expect(description).toBe("Verify a deploy");
  });
  it("falls back to the file name", () => {
    const { name } = parseFrontmatter("no frontmatter here", "skill-file");
    expect(name).toBe("skill-file");
  });
  it("folds a block scalar description (>- and |)", () => {
    const folded = [
      "---",
      "name: hubspot-investigate",
      "description: >-",
      "  Investigate how OUR HubSpot portal works and how it is structured. Use this",
      "  skill for any question about the CRM.",
      "---",
      "",
      "# body",
    ].join("\n");
    expect(parseFrontmatter(folded, "f").description).toBe(
      "Investigate how OUR HubSpot portal works and how it is structured. Use this " +
        "skill for any question about the CRM.",
    );
    const literal = "---\ndescription: |\n  First line.\n  Second line.\n---\n";
    expect(parseFrontmatter(literal, "f").description).toBe("First line.\nSecond line.");
  });
});

describe("promptIndex", () => {
  it("renders full descriptions under budget", () => {
    const skills = [
      { name: "deploy", description: "Deploy the service", path: "/cfg/skills/deploy/SKILL.md" },
    ];
    const idx = promptIndex(skills);
    expect(idx).toContain("- deploy: Deploy the service (/cfg/skills/deploy/SKILL.md)");
  });
  it("clips descriptions and drops entries over budget with a notice", () => {
    const long = "x".repeat(3000);
    const skills = Array.from({ length: 300 }, (_, i) => ({
      name: `s${i}`,
      description: long,
      path: `/very/long/skills/root${i}/SKILL.md`,
    }));
    const idx = promptIndex(skills);
    expect(byteLengthOf(idx)).toBeLessThanOrEqual(8000);
    expect(idx).toContain("skills omitted");
    expect(idx).toContain("…");
  });
});

function byteLengthOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe("mentionExpansions + mentionBlock", () => {
  const fs = fakeFs({
    "/cfg/skills/deploy/SKILL.md": SKILL("deploy", "Deploy"),
    "/cfg/skills/other/SKILL.md": SKILL("other", "Other"),
  });
  const skills = [
    { name: "deploy", description: "Deploy", path: "/cfg/skills/deploy/SKILL.md" },
    { name: "other", description: "Other", path: "/cfg/skills/other/SKILL.md" },
  ];

  it("expands /name at word start with the full body", async () => {
    const m = await mentionExpansions(fs, "/proj", "run /deploy now", skills);
    expect(m).toHaveLength(1);
    expect(m[0].skill.name).toBe("deploy");
    expect(m[0].body).toContain("body of deploy");
  });
  it("ignores mid-word slashes and unknown names", async () => {
    const m = await mentionExpansions(fs, "/proj", "see a/b and /nope and /deploy", skills);
    expect(m.map((x) => x.skill.name)).toEqual(["deploy"]);
  });
  it("renders the invocation block", () => {
    const block = mentionBlock([{ skill: skills[0], body: "STEPS" }]);
    expect(block).toContain("Invoked skills");
    expect(block).toContain("### Skill: deploy (/cfg/skills/deploy/SKILL.md)");
    // path-less entries (browser org skills) render without the parens
    const orgBlock = mentionBlock([{ skill: { name: "org-skill", description: "", path: "", org: { version: "v1" } }, body: "B" }]);
    expect(orgBlock).toContain("### Skill: org-skill\n");
    expect(orgBlock).not.toContain("()");
    expect(block).toContain("STEPS");
    expect(mentionBlock([])).toBeNull();
  });
});

describe("AGENTS.md chain (Codex semantics)", () => {
  it("assembles override > plain per directory, root → cwd, empty stops the dir", async () => {
    const fs = fakeFs({
      "/cfg/guild/AGENTS.md": "global instructions",
      "/repo/.git/x": "",
      "/repo/AGENTS.override.md": "root override",
      "/repo/AGENTS.md": "root plain (shadowed)",
      "/repo/sub/AGENTS.md": "   ", // empty: the dir contributes nothing
      "/repo/sub/deep/AGENTS.md": "deep guidance",
    });
    const global = await loadGlobalAgentsMd(fs, "/cfg/guild");
    expect(global?.contents).toBe("global instructions");
    const docs = await projectAgentDocs(fs, "/repo/sub/deep");
    expect(docs.map((d) => d.contents)).toEqual([
      "root override",
      "deep guidance",
    ]);
  });
  it("stops the directory walk at the project root (no .git → cwd only)", async () => {
    const fs = fakeFs({
      "/outside/AGENTS.md": "above",
      "/proj/AGENTS.md": "local",
    });
    const docs = await projectAgentDocs(fs, "/proj");
    expect(docs.map((d) => d.contents)).toEqual(["local"]);
  });
  it("truncates against the shared byte budget", async () => {
    const big = "y".repeat(31000);
    const fs = fakeFs({
      "/repo/.git/x": "",
      "/repo/AGENTS.md": big,
      "/repo/sub/AGENTS.md": "tail",
    });
    const docs = await projectAgentDocs(fs, "/repo/sub");
    expect(byteLengthOf(docs[0].contents)).toBeLessThanOrEqual(32 * 1024);
    expect(docs.map((d) => d.contents)[1]).toBe("tail");
  });
});

describe("prepareTurn (end to end over the bridge)", () => {
  it("expands mentions, builds the index, joins global + project docs", async () => {
    const fs = fakeFs({
      "/cfg/guild/AGENTS.md": "global rules",
      "/cfg/guild/skills/deploy/SKILL.md": SKILL("deploy", "Deploy the thing"),
      "/repo/.git/x": "",
      "/repo/AGENTS.md": "repo rules",
      "/home/u/.agents/skills/user-skill/SKILL.md": SKILL("user-skill", "User scope"),
    });
    const scopes = { configDir: "/cfg/guild", home: "/home/u" };
    const prep = await prepareTurn(fs, scopes, "please /deploy", "/repo/sub");
    expect(prep.prompt).toContain("please /deploy");
    expect(prep.prompt).toContain("### Skill: deploy");
    expect(prep.index).toContain("- deploy: Deploy the thing");
    expect(prep.index).toContain("- user-skill: User scope");
    expect(prep.instructions).toBe("global rules\n\n--- project-doc ---\n\nrepo rules");
  });
  it("browser mode (no scopes) passes the prompt through untouched", async () => {
    const prep = await prepareTurn(
      fakeFs({}),
      { configDir: null, home: null },
      "plain prompt",
      undefined,
    );
    expect(prep).toEqual({ prompt: "plain prompt", index: "" });
  });
});

describe("discoverSkills precedence", () => {
  it("later scopes win a name collision (legacy < config < user < repo)", async () => {
    const fs = fakeFs({
      "/cfg/guild/skills/dup/SKILL.md": SKILL("dup", "config desc"),
      "/home/u/.agents/skills/dup/SKILL.md": SKILL("dup", "user desc"),
      "/proj/.git/x": "",
      "/proj/.agents/skills/dup/SKILL.md": SKILL("dup", "repo desc"),
      "/proj/.guild/skills/dup/SKILL.md": SKILL("dup", "legacy desc"),
    });
    const skills = await discoverSkills(fs, "/proj", "/cfg/guild", "/home/u");
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("repo desc");
  });
  it("repo chain scans every level root → cwd", async () => {
    const fs = fakeFs({
      "/repo/.git/x": "",
      "/repo/.agents/skills/root-skill/SKILL.md": SKILL("root-skill", "root"),
      "/repo/sub/.agents/skills/sub-skill/SKILL.md": SKILL("sub-skill", "sub"),
    });
    const skills = await discoverSkills(fs, "/repo/sub", "/cfg/guild", "/home/u");
    expect(skills.map((s) => s.name).sort()).toEqual(["root-skill", "sub-skill"]);
  });
  it("skips dot-entries (install staging / backup dirs)", async () => {
    const fs = fakeFs({
      "/proj/.git/x": "",
      "/proj/.agents/skills/real/SKILL.md": SKILL("real", "live"),
      "/proj/.agents/skills/.real-update-1/SKILL.md": SKILL("staged", "leftover"),
      "/proj/.agents/skills/.real-previous/SKILL.md": SKILL("previous", "backup"),
    });
    const skills = await discoverSkills(fs, "/proj", "/cfg/guild", "/home/u");
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });
});

describe("skills manager listing + toggles", () => {
  it("scopes, provenance, and disabled flags ride one listing", async () => {
    const fs = fakeFs({
      "/cfg/guild/skills/cfg-skill/SKILL.md": SKILL("cfg-skill", "cfg"),
      "/home/u/.agents/skills/usr-skill/SKILL.md": SKILL("usr-skill", "usr"),
      "/home/u/.agents/skills/usr-skill/agents/guild.yaml":
        "source: registry\nslug: usr-skill\nversion: 1.2\npublisher: me\npublished_by_me: false\n",
      "/cfg/guild/settings.json": JSON.stringify({
        skillsDisabled: { "/cfg/guild/skills/cfg-skill/SKILL.md": false },
      }),
    });
    const scopes = { configDir: "/cfg/guild", home: "/home/u" };
    const list = await listSkills(fs, scopes);
    const cfg = list.find((s) => s.name === "cfg-skill")!;
    const usr = list.find((s) => s.name === "usr-skill")!;
    expect(cfg.scope).toBe("legacy");
    expect(cfg.disabled).toBe(true);
    expect(usr.scope).toBe("user");
    expect(usr.installed).toBe(true);
    expect(usr.published_by_me).toBe(false);
  });
  it("setSkillDisabled merges into settings.json", async () => {
    const fs = fakeFs({ "/cfg/guild/settings.json": '{"other": 1}' });
    const scopes = { configDir: "/cfg/guild" };
    expect(
      await setSkillDisabled(fs, scopes, "/cfg/guild/skills/a/SKILL.md", false),
    ).toBe(true);
    const saved = JSON.parse(fs.written["/cfg/guild/settings.json"]);
    expect(saved.other).toBe(1);
    expect(saved.skillsDisabled["/cfg/guild/skills/a/SKILL.md"]).toBe(false);
  });
});


describe("installed org skills (spec §2.3)", () => {
  /** Org api fixture: records every skillBody fetch (slug + version). */
  function fakeOrgApi(installs: Array<{ slug: string; pinned_version: string }> | null, bodies: Record<string, string> = {}) {
    const fetched: Array<{ slug: string; version?: string }> = [];
    const api: OrgSkillsApi = {
      installs: async () => installs,
      skillBody: async (slug, version) => {
        fetched.push({ slug, version });
        return bodies[slug] ?? null;
      },
    };
    return { api, fetched };
  }

  it("machine installs map to the sync path (~/.agents/skills/<slug>/SKILL.md)", async () => {
    const { api } = fakeOrgApi([
      { slug: "deploy-checklist", pinned_version: "v2" },
      { slug: "sql-explorer", pinned_version: "v1" },
    ]);
    const entries = await installedOrgSkills(api, "/home/u");
    expect(entries).toEqual([
      { name: "deploy-checklist", description: "", path: "/home/u/.agents/skills/deploy-checklist/SKILL.md" },
      { name: "sql-explorer", description: "", path: "/home/u/.agents/skills/sql-explorer/SKILL.md" },
    ]);
  });
  it("browser installs carry the source marker instead of a path", async () => {
    const { api } = fakeOrgApi([{ slug: "deploy-checklist", pinned_version: "v2" }]);
    const entries = await installedOrgSkills(api, null);
    expect(entries).toEqual([
      { name: "deploy-checklist", description: "", path: "", org: { version: "v2" } },
    ]);
  });
  it("no api, no installs, or a failed fetch yields nothing", async () => {
    expect(await installedOrgSkills(undefined, "/home/u")).toEqual([]);
    const { api } = fakeOrgApi(null);
    expect(await installedOrgSkills(api, "/home/u")).toEqual([]);
    expect(await installedOrgSkills(api, null)).toEqual([]);
  });
  it("browser mention expansion fetches the source body — once per skill per turn", async () => {
    const { api, fetched } = fakeOrgApi(
      [{ slug: "deploy-checklist", pinned_version: "v2" }],
      { "deploy-checklist": SKILL("deploy-checklist", "Deploy") },
    );
    // duplicate entries share one fetch (the per-assembly cache)
    const entries = await installedOrgSkills(api, null);
    const m = await mentionExpansions(fakeFs({}), "/proj", "run /deploy-checklist twice: /deploy-checklist", [
      ...entries,
      ...entries,
    ], api);
    expect(fetched).toEqual([{ slug: "deploy-checklist", version: "v2" }]); // the pin rides the fetch
    expect(m).toHaveLength(1);
    expect(m[0].body).toContain("body of deploy-checklist");
  });
  it("unmentioned org skills are never fetched; a failed body fetch drops the mention", async () => {
    const { api, fetched } = fakeOrgApi(
      [{ slug: "deploy-checklist", pinned_version: "v2" }, { slug: "quiet", pinned_version: "v1" }],
      {},
    );
    const entries = await installedOrgSkills(api, null);
    const m = await mentionExpansions(fakeFs({}), "/proj", "only /deploy-checklist", entries, api);
    expect(fetched).toEqual([{ slug: "deploy-checklist", version: "v2" }]);
    expect(m).toEqual([]);
  });
  it("prepareTurn (machine): org installs join the index; local discovery wins a collision", async () => {
    const fs = fakeFs({
      "/home/u/.agents/skills/synced/SKILL.md": SKILL("synced", "synced frontmatter"),
    });
    const { api } = fakeOrgApi([
      { slug: "fresh-install", pinned_version: "v1" },
      { slug: "synced", pinned_version: "v2" },
    ]);
    const prep = await prepareTurn(fs, { configDir: "/cfg/guild", home: "/home/u" }, "no mentions", "/proj", api);
    expect(prep.index).toContain("- fresh-install:  (/home/u/.agents/skills/fresh-install/SKILL.md)");
    expect(prep.index).toContain("- synced: synced frontmatter");
    expect(prep.index).not.toContain("org: ");
  });
  it("prepareTurn (machine): org mentions expand from the local file", async () => {
    const fs = fakeFs({
      "/home/u/.agents/skills/deploy-checklist/SKILL.md": SKILL("deploy-checklist", "Deploy"),
    });
    const { api, fetched } = fakeOrgApi([{ slug: "deploy-checklist", pinned_version: "v2" }]);
    const prep = await prepareTurn(fs, { configDir: "/cfg/guild", home: "/home/u" }, "run /deploy-checklist", "/proj", api);
    expect(prep.prompt).toContain("### Skill: deploy-checklist");
    expect(prep.prompt).toContain("body of deploy-checklist");
    expect(fetched).toEqual([]); // the local file path — no HTTP fetch
  });
  it("prepareTurn (browser): index stays empty (the server renders installs) but mentions fetch and inline", async () => {
    const { api, fetched } = fakeOrgApi(
      [{ slug: "deploy-checklist", pinned_version: "v2" }],
      { "deploy-checklist": "BROWSER BODY" },
    );
    const prep = await prepareTurn(fakeFs({}), { configDir: null, home: null }, "run /deploy-checklist", undefined, api);
    expect(prep.index).toBe("");
    expect(prep.prompt).toContain("### Skill: deploy-checklist");
    expect(prep.prompt).toContain("BROWSER BODY");
    expect(fetched).toEqual([{ slug: "deploy-checklist", version: "v2" }]);
  });
});

describe("project skill scope contracts", () => {
  it("prefers the closest repository scope for duplicate names", async () => {
    const fs = fakeFs({
      "/repo/.git/x": "",
      "/repo/.agents/skills/dup/SKILL.md": SKILL("dup", "parent"),
      "/repo/sub/.agents/skills/dup/SKILL.md": SKILL("dup", "child"),
    });
    expect((await discoverSkills(fs, "/repo/sub", "/cfg", "/home/u"))[0].description).toBe("child");
  });
  it("walks native Windows project paths using filesystem-compatible separators", async () => {
    const fs = fakeFs({
      "C:/repo/.git/x": "",
      "C:/repo/.agents/skills/root/SKILL.md": SKILL("root", "root"),
      "C:/repo/AGENTS.md": "root instructions",
    });
    expect((await discoverSkills(fs, "C:\\repo\\sub", "/cfg", "/home/u"))[0].name).toBe("root");
    expect((await projectAgentDocs(fs, "C:\\repo\\sub"))[0].contents).toBe("root instructions");
  });
});
