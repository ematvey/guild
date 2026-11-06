// A file the address names but this session never opened still shows: the
// pane renders the active ref as a tab of its own.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewPane } from "./PreviewPane";

const ID = "018f2c4e-0000-7000-8000-000000000001";

describe("PreviewPane", () => {
  it("renders the addressed file with no tabs in the session", () => {
    const html = renderToStaticMarkup(
      <PreviewPane
        tabs={[]}
        active={{ kind: "attachment", id: ID }}
        full={false}
        isMobile={false}
        onSelect={() => {}}
        onClose={() => {}}
        onCloseAll={() => {}}
        onToggleFull={() => {}}
      />,
    );
    expect(html).toContain("Preview");
    expect(html).toContain('title="Close preview"');
  });

  it("stays out of the layout with nothing addressed", () => {
    const html = renderToStaticMarkup(
      <PreviewPane
        tabs={[]}
        active={null}
        full={false}
        isMobile={false}
        onSelect={() => {}}
        onClose={() => {}}
        onCloseAll={() => {}}
        onToggleFull={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
