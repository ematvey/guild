// The direct tool surface: coding tools are called by the model, integration
// and thread-history tools stay script-only, and the agent's allowlist
// narrows what is offered.

import { describe, expect, it } from "vitest";
import { directBaseTools } from "../../harness/agent-tools.js";

const base = [{ name: "read" }, { name: "bash" }, { name: "codemode" }, { name: "send_message" }];

describe("directBaseTools", () => {
  it("offers every tool when the agent follows all tools", () => {
    expect(directBaseTools(base, { tools: [], tools_mode: "all" })).toEqual(base);
  });

  it("offers every tool to a plain chat", () => {
    expect(directBaseTools(base, null)).toEqual(base);
  });

  it("keeps codemode and drops unselected tools", () => {
    const picked = directBaseTools(base, { tools: ["bash"], tools_mode: "selected" });
    expect(picked.map((tool) => tool.name)).toEqual(["bash", "codemode"]);
  });
});
