// The agent's system instructions: identity, workspace, sharing, and the
// agent's own text.

import { describe, expect, it } from "vitest";
import { agentInstructions } from "../../harness/runtime.js";

describe("agentInstructions", () => {
  it("names the agent and its workspace", () => {
    const text = agentInstructions({ name: "Echo", instructions: "", is_personal: false });
    expect(text).toContain("You are Echo, a persistent agent in Guild.");
    expect(text).toContain("/workspace");
    expect(text).toContain("Every thread is private to the user you are talking to.");
    expect(text).toContain("Do not mention workspace paths");
  });

  it("calls a personal agent's workspace private", () => {
    const text = agentInstructions({ name: "Assistant", instructions: "", is_personal: true });
    expect(text).toContain("the workspace is private");
    expect(text).not.toContain("shared with everyone");
  });

  it("appends the agent's own instructions", () => {
    const text = agentInstructions({
      name: "Scout",
      instructions: "You watch the workspace and report changes.",
      is_personal: false,
    });
    expect(text).toContain("Your instructions:");
    expect(text).toContain("You watch the workspace and report changes.");
  });
});
