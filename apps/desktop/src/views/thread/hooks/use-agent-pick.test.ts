import { describe, expect, it } from "vitest";
import type { Agent } from "../../agents/agents-api";
import { composerAgents } from "./use-agent-pick";

const agent = (id: string, owner: string, more: Partial<Agent> = {}): Agent =>
  ({ id, name: "Assistant", owner_user_id: owner, is_personal: true, status: "active", visibility: "private", ...more }) as Agent;

describe("composerAgents", () => {
  it("offers the member's own personal agent and shared ones, never another member's personal agent", () => {
    const list = [
      agent("theirs", "u-2"),
      agent("mine", "u-1"),
      agent("shared", "u-2", { is_personal: false, visibility: "org", name: "Analyst" }),
      agent("archived", "u-1", { is_personal: false, status: "archived" }),
    ];
    expect(composerAgents(list, "u-1").map((a) => a.id)).toEqual(["mine", "shared"]);
  });
});
