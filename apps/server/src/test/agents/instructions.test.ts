// The agent's system instructions: name, description, workspace, sharing,
// and the workspace config files read at thread start.

import { describe, expect, it } from "vitest";
import { composeAgentInstructions, PROJECT_INSTRUCTIONS_MAX_CHARS } from "../../harness/instructions.js";
import type { AgentConfigFiles } from "../../agents/workspace-config.js";

function config(files: Record<string, string>, missing: string[] = []): AgentConfigFiles {
  return { files: new Map(Object.entries(files)), missing };
}

const FULL = {
  "AGENTS.md": "# AGENTS.md\n\nNever delete without asking.",
  "MEMORY.md": "# MEMORY.md\n\n- The staging host is `dev-1`.",
};

describe("composeAgentInstructions", () => {
  it("teaches Generated UI to an agent that has it on", () => {
    const text = composeAgentInstructions({ name: "Echo", is_personal: false, generative_ui: true }, config(FULL));
    expect(text).toContain("<generated_ui>");
    expect(text).toContain("fenced code block tagged `openui`");
    expect(text).toContain("Metric(label: string");
    expect(text.indexOf("<generated_ui>")).toBeLessThan(text.indexOf("Never delete without asking."));
  });

  it("leaves Generated UI out when off, and for a spawned child", () => {
    expect(composeAgentInstructions({ name: "Echo", is_personal: false }, config(FULL))).not.toContain(
      "<generated_ui>",
    );
    const child = composeAgentInstructions(
      { name: "Echo", is_personal: false, generative_ui: true },
      config(FULL),
      undefined,
      null,
      { parent_name: "Lead", depth: 1, can_spawn: false },
    );
    expect(child).not.toContain("<generated_ui>");
  });

  it("names the agent and its workspace", () => {
    const text = composeAgentInstructions({ name: "Echo", is_personal: false }, config(FULL));
    expect(text).toContain("You are Echo, a persistent agent in Guild.");
    expect(text).toContain("/workspace");
    expect(text).toContain("Every thread is private to the user you are talking to.");
    expect(text).toContain("Do not mention workspace paths");
  });

  it("keeps the workspace out of the package-store role", () => {
    const text = composeAgentInstructions({ name: "Echo", is_personal: false }, config(FULL));
    expect(text).toContain("It is your home, not a package store");
    expect(text).toContain("do not install browsers, desktop apps, models or datasets");
    expect(text).toContain("Egress reaches package registries only");
  });

  it("uses the description as the agent's purpose", () => {
    const text = composeAgentInstructions(
      { name: "Scout", description: "Finds sources and checks claims.", is_personal: false },
      config(FULL),
    );
    expect(text).toContain("You are Scout, Finds sources and checks claims.");
  });

  it("calls a personal agent's workspace private", () => {
    const text = composeAgentInstructions({ name: "Assistant", is_personal: true }, config(FULL));
    expect(text).toContain("the workspace is private");
    expect(text).not.toContain("shared with everyone");
  });

  it("injects the config files in order", () => {
    const text = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL));
    const order = [
      '<agent_workspace_file path="/workspace/AGENTS.md">',
      '<agent_workspace_file path="/workspace/MEMORY.md">',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Never delete without asking.");
    expect(text).toContain("The staging host is `dev-1`.");
    expect(text).toContain("Edit them with write/edit");
    expect(text).toContain('<agent_workspace path="/workspace">');
    expect(text.indexOf("</agent_workspace>")).toBeGreaterThan(
      text.indexOf('<agent_workspace_file path="/workspace/MEMORY.md">'),
    );
  });

  it("marks a missing required file and skips a missing optional one", () => {
    const text = composeAgentInstructions({ name: "Scout", is_personal: false }, config({}, ["AGENTS.md"]));
    expect(text).toContain('path="/workspace/AGENTS.md">\n(missing: AGENTS.md)');
    expect(text).not.toContain('path="/workspace/MEMORY.md"');
  });

  it("truncates a long file with a marker that points at the file", () => {
    const text = composeAgentInstructions(
      { name: "Scout", is_personal: false },
      config({ ...FULL, "AGENTS.md": `# AGENTS.md\n\n${"x".repeat(40 * 1024)}` }),
    );
    expect(text).toContain("(truncated at");
    expect(text).toContain("read the file for the rest");
    expect(text.length).toBeLessThan(36 * 1024);
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

  it("names the machine the message came from and the shell a command runs in", () => {
    const bound = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL), undefined, {
      name: "WORKSTATION-A",
      os: "windows 10.0.19045",
      shell: "cmd.exe",
      projectFolder: "C:\\Users\\alice\\Documents\\Patents",
    });
    expect(bound).toContain("Your file tools act in your own workspace");
    expect(bound).toContain("The user sent this message from WORKSTATION-A (windows 10.0.19045).");
    expect(bound).toContain('pass `machine: "WORKSTATION-A"`');
    expect(bound).toContain("`command` runs in `cmd.exe`");
    expect(bound).toContain("belongs to the project folder `C:\\Users\\alice\\Documents\\Patents`");
    expect(bound).toContain("Edit them with write/edit");
    // A machine that never reported its OS still gets named.
    const bare = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL), undefined, {
      name: "eaa3d4d7-0967-47e4-8865-02658caa6420",
      os: null,
      shell: null,
      projectFolder: null,
    });
    expect(bare).toContain("The user sent this message from eaa3d4d7-0967-47e4-8865-02658caa6420.");
    expect(bare).not.toContain("`command` runs in");
    // No project: the machine is named, but no folder is claimed.
    expect(bare).not.toContain("belongs to the project folder");
    expect(bare).not.toContain("`command` runs in");
    const unbound = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL));
    expect(unbound).not.toContain("The user sent this message from");
    expect(unbound).toContain("Edit them with write/edit");
  });

  it("gives a spawned child its tree context and the reply rule", () => {
    const text = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL), undefined, null, {
      parent_name: "Parent",
      depth: 2,
      can_spawn: true,
    });
    expect(text).toContain('<spawned_by agent="Parent" depth="2">');
    expect(text).toContain("Ending your turn is how you reply to the spawner");
    expect(text).toContain("To ask a question, end your turn with the question.");
    expect(text).toContain("You can spawn further child agents.");
    expect(text).not.toContain("You cannot spawn further child agents.");
    expect(text.indexOf("<spawned_by")).toBeGreaterThan(text.indexOf("</agent_workspace>"));

    const capped = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL), undefined, null, {
      parent_name: "Parent",
      depth: 3,
      can_spawn: false,
    });
    expect(capped).toContain("You cannot spawn further child agents.");

    const root = composeAgentInstructions({ name: "Scout", is_personal: false }, config(FULL));
    expect(root).not.toContain("<spawned_by");
  });

  it("tells a delegating agent not to wait for a child", () => {
    const text = composeAgentInstructions(
      { name: "Echo", is_personal: false },
      config(FULL),
      undefined,
      null,
      undefined,
      true,
    );
    expect(text).toContain("<delegation>");
    expect(text).toContain("Do not wait or poll for the child");
    expect(text).toContain("Read a child with read_thread only when you need its progress");
    expect(text).toContain("the child's result arrives as a new message and wakes you");
  });

  it("omits the delegation block when the agent cannot spawn", () => {
    const text = composeAgentInstructions({ name: "Echo", is_personal: false }, config(FULL));
    expect(text).not.toContain("<delegation>");
  });

  it("tells a routine run to deliver with send_message", () => {
    const text = composeAgentInstructions(
      { name: "Assistant", is_personal: true },
      config(FULL),
      undefined,
      null,
      undefined,
      false,
      { type: "routine", routineName: "Morning email digest", origin: null },
    );
    expect(text).toContain('<routine_run name="Morning email digest">');
    expect(text).toContain("Reach the user with send_message");
    expect(text).toContain("When the run found nothing worth reporting, send nothing");
    expect(text).toContain("its final message is not delivered");
  });

  it("names the run thread a delivered thread was opened from", () => {
    const text = composeAgentInstructions(
      { name: "Assistant", is_personal: true },
      config(FULL),
      undefined,
      null,
      undefined,
      false,
      {
        type: "user",
        routineName: "Morning email digest",
        origin: { thread_id: "thread-1", title: "Morning email digest — 2026-10-26" },
      },
    );
    expect(text).toContain('<opened_by_agent thread="thread-1"');
    expect(text).toContain("conversation_read on thread thread-1");
  });

  it("tells a routine run where its send_message lands", () => {
    const compose = (routineDelivery: "thread" | "new_chat") =>
      composeAgentInstructions(
        { name: "Assistant", is_personal: true },
        config(FULL),
        undefined,
        null,
        undefined,
        false,
        { type: "routine", routineName: "Digest", routineDelivery, origin: null },
      );
    expect(compose("thread")).toContain("send_message posts into this routine's one conversation");
    expect(compose("new_chat")).toContain("Each send_message opens its own conversation");
  });

  it("tells a routine's feed thread to read its deliveries", () => {
    const text = composeAgentInstructions(
      { name: "Assistant", is_personal: true },
      config(FULL),
      undefined,
      null,
      undefined,
      false,
      {
        type: "user",
        routineName: null,
        feedRoutineName: "Morning email digest",
        origin: { thread_id: "thread-2", title: "Morning email digest — run" },
      },
    );
    expect(text).toContain('<routine_thread name="Morning email digest">');
    expect(text).toContain("thread_history");
    expect(text).toContain("run thread thread-2");
    expect(text).not.toContain("<opened_by_agent");
  });

  it("adds no thread block for a plain thread", () => {
    const text = composeAgentInstructions({ name: "Echo", is_personal: false }, config(FULL));
    expect(text).not.toContain("<routine_run");
    expect(text).not.toContain("<opened_by_agent");
  });
});
