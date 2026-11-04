import { describe, expect, it } from "vitest";
import { slugFromTitle } from "./connect-mcp";

describe("connect MCP server page", () => {
  it("derives a slug from the display name", () => {
    expect(slugFromTitle("Internal Docs (v2)")).toBe("internal-docs-v2");
    expect(slugFromTitle("  ")).toBe("");
    expect(slugFromTitle("x".repeat(60))).toHaveLength(48);
  });
});
