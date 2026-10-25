// The workspace config files: seeding from the templates and reading them
// back for the system prompt.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILES,
  readAgentConfig,
  seedAgentWorkspace,
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
  it("writes AGENTS.md and an empty memories/ directory", async () => {
    const dir = workspace();
    const written = await seedAgentWorkspace(dir);
    expect(written).toEqual(["AGENTS.md"]);
    expect(existsSync(path.join(dir, "memories"))).toBe(true);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("# AGENTS.md");
  });

  it("never overwrites a file the agent already edited", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir);
    writeFileSync(path.join(dir, "AGENTS.md"), "# my own rules\n");
    const written = await seedAgentWorkspace(dir);
    expect(written).toEqual([]);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("# my own rules\n");
  });
});

describe("readAgentConfig", () => {
  it("reads the seeded files and reports nothing missing", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir);
    const config = await readAgentConfig(dir);
    expect(config.missing).toEqual([]);
    expect([...config.files.keys()]).toEqual(CONFIG_FILES.filter((f) => f.required).map((f) => f.name));
  });

  it("lets AGENTS.override.md shadow AGENTS.md", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir);
    writeFileSync(path.join(dir, "AGENTS.override.md"), "# override\n");
    const config = await readAgentConfig(dir);
    expect(config.files.get("AGENTS.override.md")).toBe("# override\n");
    expect(config.files.has("AGENTS.md")).toBe(false);
    expect(config.missing).toEqual([]);
  });

  it("reads MEMORY.md when the agent created it", async () => {
    const dir = workspace();
    await seedAgentWorkspace(dir);
    writeFileSync(path.join(dir, "MEMORY.md"), "# facts\n");
    const config = await readAgentConfig(dir);
    expect(config.files.get("MEMORY.md")).toBe("# facts\n");
  });

  it("treats a missing workspace as every required file missing", async () => {
    const config = await readAgentConfig(path.join(workspace(), "nope"));
    expect(config.missing).toEqual(["AGENTS.md"]);
    expect(config.files.size).toBe(0);
  });
});
