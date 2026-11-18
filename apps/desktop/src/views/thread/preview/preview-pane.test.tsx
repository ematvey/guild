// @vitest-environment happy-dom
// A file the address names but this session never opened still shows: the
// pane renders the active ref as a tab of its own. The pane's first row is
// the window's first row on a shell that draws its own title bar.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../../lib/session", () => ({
  HAS_SHELL: true,
  HAS_ENGINE: true,
  apiUrl: (path: string) => path,
  serverUrl: () => "http://localhost:18080",
  serverBase: () => "",
}));

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

  it("drags the window from its header and groups its own controls", async () => {
    // The title bar constants are read once, at module load: the platform
    // must be in place before the module is evaluated.
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    vi.resetModules();
    const { PreviewPane: WindowsPane } = await import("./PreviewPane");
    const html = renderToStaticMarkup(
      <WindowsPane
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
    expect(html).toContain('data-tauri-drag-region="deep"');
    expect(html).toContain('aria-label="Preview controls"');
    expect(html).toContain("pr-[138px]!");
  });
});
