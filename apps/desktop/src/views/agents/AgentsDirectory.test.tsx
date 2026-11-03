// @vitest-environment happy-dom
// The directory marks a private agent at a glance: the row badge says who
// can see it, not just the meta line.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRow } from "./AgentsDirectory";
import { makeAgent } from "./test-fixtures";

afterEach(cleanup);

describe("agent row", () => {
  it("marks a private agent with a badge", () => {
    render(<AgentRow agent={makeAgent({ name: "Scout", visibility: "private" })} onNavigate={() => {}} />);
    expect(screen.getByText("Private")).toBeTruthy();
  });

  it("leaves the badge off an org agent", () => {
    render(<AgentRow agent={makeAgent({ name: "Echo", visibility: "org" })} onNavigate={() => {}} />);
    expect(screen.queryByText("Private")).toBeNull();
    expect(screen.getByText("Organization")).toBeTruthy();
  });
});
