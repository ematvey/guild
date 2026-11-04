import { describe, expect, it } from "vitest";
import { catalogSourceBody } from "./sources";

describe("catalog sources", () => {
  it("submit the source the chosen kind needs", () => {
    const fields = { url: " https://x.test/index.json ", repo: " acme/plugins ", ref: "", path: "" };
    expect(catalogSourceBody("url", fields)).toEqual({ kind: "url", url: "https://x.test/index.json" });
    expect(catalogSourceBody("github", fields)).toEqual({
      kind: "github",
      repo: "acme/plugins",
      ref: "",
      path: "index.json",
    });
    expect(catalogSourceBody("gitlab", fields)).toEqual({
      kind: "gitlab",
      project: "acme/plugins",
      ref: "",
      path: "index.json",
    });
  });
});
