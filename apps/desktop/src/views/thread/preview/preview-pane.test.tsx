// @vitest-environment happy-dom
// A file the address names but this session never opened still shows: the
// pane renders the active ref as a tab of its own. The pane's first row is
// the window's first row on a shell that draws its own title bar.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The title bar constants are read once, at module load, so the shell flag is
// a getter the cases switch before importing the pane again.
const shell = vi.hoisted(() => ({ has: true }));

vi.mock("../../../lib/session", () => ({
  get HAS_SHELL() {
    return shell.has;
  },
  get HAS_ENGINE() {
    return shell.has;
  },
  apiUrl: (path: string) => path,
  serverUrl: () => "http://localhost:18080",
  serverBase: () => "",
}));

import { PreviewPane } from "./PreviewPane";

const ID = "018f2c4e-0000-7000-8000-000000000001";

const PROPS = {
  tabs: [],
  active: { kind: "attachment" as const, id: ID },
  full: false,
  isMobile: false,
  onSelect: () => {},
  onClose: () => {},
  onCloseAll: () => {},
  onToggleFull: () => {},
};

function parse(Pane: typeof PreviewPane): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(<Pane {...PROPS} />), "text/html");
}

describe("PreviewPane", () => {
  it("renders the addressed file with no tabs in the session", () => {
    const html = renderToStaticMarkup(<PreviewPane {...PROPS} />);
    expect(html).toContain("Preview");
    expect(html).toContain('title="Close preview"');
  });

  it("stays out of the layout with nothing addressed", () => {
    const html = renderToStaticMarkup(<PreviewPane {...PROPS} active={null} />);
    expect(html).toBe("");
  });

  it("drags the window from its header and groups its own controls", async () => {
    shell.has = true;
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    vi.resetModules();
    const { PreviewPane: WindowsPane } = await import("./PreviewPane");
    const doc = parse(WindowsPane);

    const rows = doc.querySelectorAll('[data-tauri-drag-region="deep"]');
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(doc.querySelectorAll('[role="group"]')).toHaveLength(1);
    const groups = row.querySelectorAll('[role="group"]');
    expect(groups).toHaveLength(1);
    const titles = [...groups[0].querySelectorAll("button")].map((b) => b.getAttribute("title"));
    expect(titles).toEqual(["Download", "Open in a new window", "Full screen", "Close preview"]);
  });

  it("draws no drag region in the web build", async () => {
    shell.has = false;
    vi.resetModules();
    const { PreviewPane: WebPane } = await import("./PreviewPane");
    const doc = parse(WebPane);
    expect(doc.querySelector("[data-tauri-drag-region]")).toBeNull();
    expect(doc.querySelectorAll('[role="group"]')).toHaveLength(1);
  });
});
