// The agent-sandbox tool set: the four coding tools renamed and bound to the
// agent's own env, so a project-bound chat can still reach its workspace.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AGENT_TOOL_NAMES, createAgentWorkspaceTools, createMachineTools } from "../../harness/agent-tools.js";

function env() {
  return new NodeExecutionEnv({ cwd: mkdtempSync(path.join(tmpdir(), "guild-agent-tools-")) });
}

describe("createMachineTools", () => {
  it("keeps the plain names and names the user's machine", () => {
    const tools = createMachineTools();
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
    for (const tool of tools) expect(tool.description).toContain("Runs on the user's machine");
  });
});

describe("createAgentWorkspaceTools", () => {
  it("exposes the four coding tools under agent_ names", () => {
    const tools = createAgentWorkspaceTools(env());
    expect(tools.map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES]);
    for (const tool of tools) expect(tool.description).toContain("your own agent workspace");
  });

  it("runs the tool in the agent env, not the call's env", async () => {
    const agentEnv = env();
    const [read, write] = createAgentWorkspaceTools(agentEnv);
    // The call's env points at a directory that does not exist: the tool must
    // ignore it and use the bound agent env.
    const foreign = { env: { cwd: "/nonexistent-foreign-env" } };
    await write!.execute({ path: "notes.md", content: "hello" }, foreign as never, {} as never);
    const out = await read!.execute({ path: "notes.md" }, foreign as never, {} as never);
    expect(JSON.stringify(out)).toContain("hello");
  });
});
