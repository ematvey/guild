import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createAgentPayload, reachableStep, validateAgentStep } from "./AgentCreate";
import { AgentRow } from "./AgentsDirectory";
import type { Agent } from "./agents-api";

const draft = {
  name: "Researcher",
  description: "Finds primary sources and summarizes them.",
  model: "m1",
  tools: ["read_file"],
  toolsMode: "selected" as const,
  visibility: "private" as const,
  teamIds: [],
};

const agent: Agent = {
  id: "a1",
  org_id: "o1",
  owner_user_id: "u1",
  owner_label: "Owner",
  name: "Researcher",
  description: "Finds primary sources and summarizes them.",
  model: "m1",
  model_alias: "Auto",
  tools: ["read_file"],
  tools_mode: "selected",
  visibility: "private",
  status: "active",
  created_at: "2026-10-22T10:00:00.000Z",
  updated_at: "2026-10-22T10:00:00.000Z",
};

describe("agent description", () => {
  it("carries the description in the create payload", () => {
    expect(createAgentPayload(draft)).toMatchObject({
      name: "Researcher",
      description: "Finds primary sources and summarizes them.",
    });
    expect(createAgentPayload({ ...draft, description: "  " }).description).toBe("");
  });

  it("rejects a description over 500 characters on the name step", () => {
    expect(validateAgentStep("name", { ...draft, description: "x".repeat(500) })).toBeNull();
    expect(validateAgentStep("name", { ...draft, description: "x".repeat(501) })).toBe(
      "Use 500 characters or fewer.",
    );
  });

  it("renders the description on the directory row", () => {
    const html = renderToStaticMarkup(<AgentRow agent={agent} onNavigate={() => {}} />);
    expect(html).toContain("Finds primary sources and summarizes them.");
  });

  it("renders no description element when the description is empty", () => {
    const html = renderToStaticMarkup(
      <AgentRow agent={{ ...agent, description: "" }} onNavigate={() => {}} />,
    );
    expect(html).not.toContain("line-clamp-2");
  });
});

describe("agent-create wizard steps", () => {
  it("shows the URL's step when every earlier step is complete", () => {
    expect(reachableStep("visibility", draft)).toBe("visibility");
  });

  it("lands a deep link past an unfinished step on that step", () => {
    expect(reachableStep("tools", { ...draft, name: "" })).toBe("name");
    expect(reachableStep("visibility", { ...draft, model: "" })).toBe("model");
  });
});
