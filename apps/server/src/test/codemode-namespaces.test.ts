import { describe, expect, it } from "vitest";
import { codemodeNamespaces } from "../harness/codemode-namespaces.js";

describe("codemodeNamespaces", () => {
  it("pins each member by its full name and skips tools that are not callable", () => {
    const entries = codemodeNamespaces(
      [{ name: "skills", description: "catalog", tools: ["read_skill", "push_skill"] }],
      ["read_skill", "bash"],
    );
    expect(entries).toEqual([{ name: "skills", prefix: "read_skill", description: "catalog" }]);
  });

  it("keeps a tool in its first group and suffixes a taken group name", () => {
    const entries = codemodeNamespaces(
      [
        { name: "a", tools: ["x"] },
        { name: "a", tools: ["x", "y"] },
      ],
      ["x", "y"],
    );
    expect(entries.map((entry) => [entry.name, entry.prefix])).toEqual([
      ["a", "x"],
      ["a_2", "y"],
    ]);
  });

  it("drops an entry whose prefix would capture a tool outside its group", () => {
    const entries = codemodeNamespaces([{ name: "subagents", tools: ["send", "list"] }], ["send", "send_message", "list"]);
    expect(entries.map((entry) => entry.prefix)).toEqual(["list"]);
  });

  it("lets a longer member prefix win inside its own group", () => {
    const entries = codemodeNamespaces(
      [
        { name: "subagents", tools: ["send"] },
        { name: "conversations", tools: ["send_message"] },
      ],
      ["send", "send_message"],
    );
    expect(entries.map((entry) => [entry.name, entry.prefix])).toEqual([
      ["subagents", "send"],
      ["conversations", "send_message"],
    ]);
  });
});
