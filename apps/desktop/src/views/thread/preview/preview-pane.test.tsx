// @vitest-environment happy-dom
// A file the address names but this session never opened still shows: the
// pane renders the active ref as a tab of its own. The pane's first row is
// the window's first row on a shell that draws its own title bar.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { PREVIEW_WIDTH_KEY } from "../../../lib/preview";

const ID = "018f2c4e-0000-7000-8000-000000000001";

// Node ships a `localStorage` global that stays undefined without its own
// flag, and it shadows the one happy-dom would give the window.
function store(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

beforeEach(() => vi.stubGlobal("localStorage", store()));

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
    // The row stops short of the caption box, which the window draws over it.
    // This reads the class the header carries, not the emitted CSS: the rule
    // itself is exercised by every page header that uses the same constant.
    expect(row.className).toContain("pr-[138px]!");
  });

  it("draws no drag region in the web build", async () => {
    shell.has = false;
    vi.resetModules();
    const { PreviewPane: WebPane } = await import("./PreviewPane");
    const doc = parse(WebPane);
    expect(doc.querySelector("[data-tauri-drag-region]")).toBeNull();
    expect(doc.querySelectorAll('[role="group"]')).toHaveLength(1);
  });

  it("carries its persisted width and a resize handle on the side pane", () => {
    localStorage.setItem(PREVIEW_WIDTH_KEY, "700");
    const doc = parse(PreviewPane);
    const aside = doc.querySelector("aside");
    expect(aside).not.toBeNull();
    expect((aside as HTMLElement).style.width).toBe("700px");

    const handle = aside?.querySelector('[title="Drag to resize · double-click to reset"]');
    expect(handle).not.toBeNull();
    expect(handle?.className).toContain("cursor-col-resize");
  });

  it("draws no width and no handle in full screen", () => {
    localStorage.setItem(PREVIEW_WIDTH_KEY, "700");
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(<PreviewPane {...PROPS} full />), "text/html");
    expect(doc.querySelector('[title="Drag to resize · double-click to reset"]')).toBeNull();
  });
});
