// The class an MCP tool runs under: the admin's curated class, else the
// manifest's declaration, else the class suggested from the live tool. A
// catalog stub declares no tools, so its tools are classed from discovery.

import { describe, expect, it } from "vitest";
import { mcpToolClass, suggestedToolClass } from "../integrations/policy.js";

describe("suggestedToolClass", () => {
  it("follows the server's hints before the name", () => {
    expect(suggestedToolClass({ name: "stripe_api_write", annotations: { readOnlyHint: true } })).toBe("read");
    expect(suggestedToolClass({ name: "get_balance", annotations: { destructiveHint: true } })).toBe("write");
  });

  it("reads a leading read verb as read and anything else as write", () => {
    expect(suggestedToolClass({ name: "get_stripe_account_info" })).toBe("read");
    expect(suggestedToolClass({ name: "search_stripe_documentation" })).toBe("read");
    expect(suggestedToolClass({ name: "listInvoices" })).toBe("read");
    expect(suggestedToolClass({ name: "stripe_api_write" })).toBe("write");
    expect(suggestedToolClass({ name: "send_money" })).toBe("write");
  });
});

describe("mcpToolClass", () => {
  const tool = { name: "send_money" };

  it("suggests from the live tool when neither the row nor the manifest names it", () => {
    expect(mcpToolClass({}, { kind: "integration", mcp: { url: "https://mcp.example" } }, tool)).toBe("write");
    expect(mcpToolClass({}, null, { name: "list_customers" })).toBe("read");
  });

  it("prefers the manifest's declaration over the suggestion", () => {
    expect(mcpToolClass({}, { tools: { classes: { send_money: "admin" } } }, tool)).toBe("admin");
    expect(mcpToolClass({}, { tools: { classes: { send_money: "read" } } }, tool)).toBe("read");
  });

  it("prefers the admin's curated class over everything", () => {
    const row = { tools: { send_money: { enabled: true, class: "read" } } };
    expect(mcpToolClass(row, { tools: { classes: { send_money: "admin" } } }, tool)).toBe("read");
  });
});
