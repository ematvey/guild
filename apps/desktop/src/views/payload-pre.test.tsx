// Raw payloads (subagent request/result, thinking) use the same monospace
// block as tool output, never unstyled body text.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PayloadPre } from "./payload-pre";

describe("PayloadPre", () => {
  it("renders the text inside a monospace pre block", () => {
    const html = renderToStaticMarkup(<PayloadPre text={"| a | b |\n|---|---|"} />);
    expect(html).toContain("<pre");
    expect(html).toContain("font-mono");
    expect(html).toContain("| a | b |");
  });
});
