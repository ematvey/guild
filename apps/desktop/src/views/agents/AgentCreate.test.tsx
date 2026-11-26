// @vitest-environment happy-dom
// The create wizard's URL names the step it shows: a deep link or reload
// past an unfinished step renders the first step that needs input and
// replaces the address with it, without adding a history entry.
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./agents-api", async (original) => ({
  ...(await original<typeof import("./agents-api")>()),
  listAgentTools: vi.fn(async () => []),
}));
vi.mock("./agent-model", () => ({
  useModelOptions: () => [{ id: "m1", alias: "Auto" }],
  ModelName: () => null,
}));

import { AgentCreate, reachableStep } from "../../../../control-center/src/agents/AgentCreate";

describe("AgentCreate step address", () => {
  it("replaces a deep link past the empty name step with the name step", async () => {
    const onNavigate = vi.fn();
    render(<AgentCreate step="tools" onNavigate={onNavigate} />);
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        { view: "new", step: "name" },
        { replace: true },
      ),
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("leaves a reachable step's address alone", async () => {
    const onNavigate = vi.fn();
    render(<AgentCreate step="name" onNavigate={onNavigate} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("stops at the first step that still needs input", () => {
    const empty = {
      name: "",
      description: "",
      model: "",
      tools: [],
      toolsMode: "selected" as const,
      visibility: "private" as const,
      teamIds: [],
    };
    expect(reachableStep("model", empty)).toBe("name");
  });
});
