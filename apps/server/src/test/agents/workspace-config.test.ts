// The workspace config files: seeding from the templates, reading them
// back, and parsing the one-line identity.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILES,
  parseIdentity,
  readAgentConfig,
  seedAgentWorkspace,
  writeAgentsFile,
} from "../../agents/workspace-config.js";

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "guild-agent-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("seedAgentWorkspace", () => {
  it("writes the template files and an empty memories/ directory", async () => {
    const dir = workspace();
    const written = await seedAgentWorkspace(dir, { name: "Scout", instructions: "" });
    expect(written.sort()).toEqual(["AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "SOUL.md", "USER.md"]);
    expect(existsSync(path.join(dir, "memories"))).toBe(true);
    expect(readFileSync(path.join(dir, "IDENTITY.md"), "utf8")).toBe("- Name: Scout | Vibe: | Emoji: | Avatar:\n");
    expect(readFileSync(path.join(dir, "BOOTSTRAP.md"), "utf8")).toContain("Birth Sequence");
  });

  it("never overwrites a file the agent already edited", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir, { name: "Scout", instructions: "" });
    writeFileSync(path.join(dir, "SOUL.md"), "# my own soul\n");
    const written = await seedAgentWorkspace(dir, { name: "Scout", instructions: "" });
    expect(written).toEqual([]);
    expect(readFileSync(path.join(dir, "SOUL.md"), "utf8")).toBe("# my own soul\n");
  });

  it("carries the creation instructions into AGENTS.md", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir, { name: "Scout", instructions: "Watch the deploy queue." });
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("Watch the deploy queue.");
  });
});

describe("readAgentConfig", () => {
  it("reads the seeded files and reports nothing missing", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir, { name: "Scout", instructions: "" });
    const config = await readAgentConfig(dir);
    expect(config.missing).toEqual([]);
    expect([...config.files.keys()]).toEqual(CONFIG_FILES.filter((f) => f.name !== "MEMORY.md").map((f) => f.name));
    expect(config.identity.name).toBe("Scout");
  });

  it("treats a missing workspace as every required file missing", async () => {
    const config = await readAgentConfig(path.join(workspace(), "nope"));
    expect(config.missing).toEqual(["IDENTITY.md", "SOUL.md", "AGENTS.md"]);
    expect(config.files.size).toBe(0);
    expect(config.identity.name).toBeNull();
  });
});

describe("parseIdentity", () => {
  it("parses the one-line form", () => {
    expect(parseIdentity("- Name: Scout | Vibe: direct and calm | Emoji: 🧭 | Avatar: avatars/a.png")).toEqual({
      name: "Scout",
      vibe: "direct and calm",
      emoji: "🧭",
      avatar: "avatars/a.png",
    });
  });

  it("ignores placeholders and blank values", () => {
    expect(parseIdentity("- Name: Scout | Vibe: (pick something) | Emoji: ")).toEqual({
      name: "Scout",
      vibe: null,
      emoji: null,
      avatar: null,
    });
  });

  it("accepts the multi-line label form", () => {
    const text = "- **Name:** Echo\n- Vibe: warm\n- Emoji: 🌙\n";
    expect(parseIdentity(text)).toMatchObject({ name: "Echo", vibe: "warm", emoji: "🌙" });
  });
});

describe("writeAgentsFile", () => {
  it("replaces AGENTS.md wholesale", async () => {
    const dir = workspace();
    await writeAgentsFile(dir, "# AGENTS.md\n\nnew rules\n");
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("new rules");
  });
});
