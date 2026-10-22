// The agent's system instructions: identity, workspace, sharing, and the
// workspace config files read at thread start.

import { describe, expect, it } from "vitest";
import { composeAgentInstructions, PROJECT_INSTRUCTIONS_MAX_CHARS } from "../../harness/runtime.js";
import type { AgentConfigFiles } from "../../agents/workspace-config.js";

function config(files: Record<string, string>, missing: string[] = []): AgentConfigFiles {
  return {
    files: new Map(Object.entries(files)),
    missing,
    identity: { name: null, vibe: null, emoji: null, avatar: null },
  };
}

const FULL = {
  "IDENTITY.md": "- Name: Scout | Vibe: direct | Emoji: 🧭",
  "SOUL.md": "# SOUL.md\n\nBe useful.",
  "AGENTS.md": "# AGENTS.md\n\nNever delete without asking.",
  "USER.md": "# USER.md\n\n- Prefer short answers.",
  "MEMORY.md": "# MEMORY.md\n\n- The staging host is `dev-1`.",
};

describe("composeAgentInstructions", () => {
  it("names the agent and its workspace", () => {
    const text = composeAgentInstructions({ name: "Echo", is_personal: false }, config(FULL));
    expect(text).toContain("You are Echo, a persistent agent in Guild.");
    expect(text).toContain("/workspace");
    expect(text).toContain("Every thread is private to the user you are talking to.");
    expect(text).toContain("Do not mention workspace paths");
  });

  it("calls a personal agent's workspace private", () => {
    const text = composeAgentInstructions({ name: "Assistant", is_personal: true }, config(FULL));
    expect(text).toContain("the workspace is private");
    expect(text).not.toContain("shared with everyone");
  });

  it("injects the config files in order, identity first", () => {
    const text = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL));
    const order = [
      '<agent_workspace_file path="/workspace/IDENTITY.md">',
      '<agent_workspace_file path="/workspace/SOUL.md">',
      '<agent_workspace_file path="/workspace/AGENTS.md">',
      '<agent_workspace_file path="/workspace/USER.md">',
      '<agent_workspace_file path="/workspace/MEMORY.md">',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Never delete without asking.");
    expect(text).toContain("The staging host is `dev-1`.");
    expect(text).toContain("Edit them with write/edit");
    expect(text).toContain('<agent_workspace path="/workspace">');
    expect(text.indexOf("</agent_workspace>")).toBeGreaterThan(text.indexOf('<agent_workspace_file path="/workspace/MEMORY.md">'));
  });

  it("marks a missing required file and skips a missing optional one", () => {
    const text = composeAgentInstructions(
      { name: "Scout", is_personal: false },
      config({ "IDENTITY.md": "- Name: Scout" }, ["SOUL.md", "AGENTS.md"]),
    );
    expect(text).toContain('path="/workspace/SOUL.md">\n(missing: SOUL.md)');
    expect(text).toContain('path="/workspace/AGENTS.md">\n(missing: AGENTS.md)');
    expect(text).not.toContain('path="/workspace/USER.md"');
    expect(text).not.toContain('path="/workspace/MEMORY.md"');
  });

  it("truncates a long file with a marker that points at the file", () => {
    const text = composeAgentInstructions(
      { name: "Scout", is_personal: false },
      config({ ...FULL, "AGENTS.md": `# AGENTS.md\n\n${"x".repeat(9 * 1024)}` }),
    );
    expect(text).toContain("(truncated at");
    expect(text).toContain("read the file for the rest");
    expect(text.length).toBeLessThan(40 * 1024);
  });

  it("appends the desktop project chain after the workspace files", () => {
    const text = composeAgentInstructions(
      { name: "Scout", is_personal: false },
      config(FULL),
      '<project_instructions path="/repo/AGENTS.md">\n# AGENTS.md\n\nUse pnpm, never npm.\n</project_instructions>',
    );
    expect(text.indexOf("<project_context>")).toBeGreaterThan(text.indexOf("</agent_workspace>"));
    expect(text).toContain('<project_instructions path="/repo/AGENTS.md">');
    expect(text).toContain("Project-specific instructions and guidelines:");
    expect(text).toContain("From the user's desktop project, not your workspace.");
    expect(text).toContain("Use pnpm, never npm.");
  });

  it("ignores an empty or whitespace-only project chain", () => {
    for (const value of ["", "   \n\t "]) {
      const text = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL), value);
      expect(text).not.toContain("<project_context>");
    }
  });

  it("cuts a client-sent chain at the server cap", () => {
    const huge = "z".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 5000);
    const text = composeAgentInstructions({ name: "Scout", is_personal: false }, config({}), huge);
    expect(text).toContain("(truncated)");
    const block = text.slice(text.indexOf("<project_context>"));
    expect(block.length).toBeLessThan(PROJECT_INSTRUCTIONS_MAX_CHARS + 1000);
  });

  it("names the agent tool set when the chat is bound to a machine", () => {
    const bound = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL), undefined, true);
    expect(bound).toContain("agent_write/agent_edit");
    expect(bound).toContain("`read`, `write`, `edit` and `bash` act on their machine");
    expect(bound).toContain("`agent_bash` act in your own workspace sandbox");
    const unbound = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL));
    expect(unbound).not.toContain("agent_bash");
    expect(unbound).toContain("Edit them with write/edit");
  });

  it("stops adding files once the total budget is spent", () => {
    const big = `# big\n\n${"y".repeat(8 * 1024)}`;
    const text = composeAgentInstructions(
      { name: "Scout", is_personal: false },
      config({ "IDENTITY.md": big, "SOUL.md": big, "AGENTS.md": big, "USER.md": big, "MEMORY.md": big }),
    );
    // 24 KiB total: the last files cannot fit.
    expect(text).not.toContain('path="/workspace/MEMORY.md"');
    expect(text.length).toBeLessThan(30 * 1024);
  });
});
