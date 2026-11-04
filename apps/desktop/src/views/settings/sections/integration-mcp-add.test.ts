import { describe, expect, it } from "vitest";
import { canonicalSettings } from "../section-nav";
import { ADD_MCP_DETAIL, slugFromTitle } from "./integration-mcp-add";

describe("add MCP server page", () => {
  it("derives a slug from the display name", () => {
    expect(slugFromTitle("Internal Docs (v2)")).toBe("internal-docs-v2");
    expect(slugFromTitle("  ")).toBe("");
    expect(slugFromTitle("x".repeat(60))).toHaveLength(48);
  });

  it("keeps its own address under the integrations section", () => {
    expect(canonicalSettings("integrations", ADD_MCP_DETAIL, "admin")).toEqual({
      section: "integrations",
      detail: ADD_MCP_DETAIL,
    });
  });
});
