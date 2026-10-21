import { describe, expect, it } from "vitest";
import {
  agentTabRoute,
  agentsRailTab,
  agentsRoutePath,
  agentsRouteTab,
  fileBreadcrumbs,
  fileExtension,
  formatFileSize,
  joinPath,
  parentPath,
  parseAgentsRoute,
  previewKindOf,
  type AgentsRoute,
} from "./agents-route";

const routes: AgentsRoute[] = [
  { view: "directory" },
  { view: "new" },
  { view: "agent", agentId: "a1", tab: "overview" },
  { view: "agent", agentId: "a1", tab: "threads" },
  { view: "agent", agentId: "a1", tab: "routines" },
  { view: "agent", agentId: "a1", tab: "routines", routineId: "r1" },
  { view: "agent", agentId: "a1", tab: "files" },
  { view: "agent", agentId: "a1", tab: "files", filePath: "notes/today.md" },
  { view: "agent", agentId: "a1", tab: "activity" },
  { view: "agent", agentId: "a1", tab: "settings" },
  { view: "activity" },
  { view: "inbox" },
  { view: "run", runId: "run-1" },
];

describe("agents route contract", () => {
  it("round-trips every route through its canonical URL", () => {
    for (const route of routes) {
      const path = agentsRoutePath(route);
      expect(parseAgentsRoute(path), path).toEqual(route);
    }
  });

  it("maps every route to exactly one rail tab", () => {
    expect(agentsRailTab({ view: "inbox" })).toBe("inbox");
    expect(agentsRailTab({ view: "activity" })).toBe("activity");
    expect(agentsRailTab({ view: "run", runId: "r" })).toBe("activity");
    expect(agentsRailTab({ view: "directory" })).toBe("agents");
    expect(agentsRailTab({ view: "agent", agentId: "a", tab: "files" })).toBe("agents");
  });

  it("keeps the agent tab from the URL", () => {
    expect(agentsRouteTab(parseAgentsRoute("/agents/a1/settings")!)).toBe("settings");
    expect(agentsRouteTab({ view: "directory" })).toBeNull();
  });

  it("defaults unknown tabs to the overview, not a dead URL", () => {
    expect(parseAgentsRoute("/agents/a1/unknown")).toEqual({
      view: "agent",
      agentId: "a1",
      tab: "overview",
    });
  });

  it("returns null for paths owned by other surfaces", () => {
    expect(parseAgentsRoute("/chats")).toBeNull();
    expect(parseAgentsRoute("/thread/x")).toBeNull();
    expect(parseAgentsRoute("/skills")).toBeNull();
    expect(parseAgentsRoute("/")).toBeNull();
  });

  it("decodes ids and file segments with reserved characters", () => {
    const route = parseAgentsRoute("/agents/a%2Fb/files/my%20notes/a%3Fb.md");
    expect(route).toEqual({
      view: "agent",
      agentId: "a/b",
      tab: "files",
      filePath: "my notes/a?b.md",
    });
    expect(agentsRoutePath(route!)).toBe(
      "/agents/a%2Fb/files/my%20notes/a%3Fb.md",
    );
  });

  it("keeps the canonical agent tab URL free of stale sub-page ids", () => {
    expect(agentsRoutePath(agentTabRoute("a1", "threads"))).toBe("/agents/a1/threads");
    expect(agentsRoutePath(agentTabRoute("a1", "overview"))).toBe("/agents/a1");
  });
});

describe("file path helpers", () => {
  it("builds breadcrumbs from the workspace root", () => {
    expect(fileBreadcrumbs("notes/2026/today.md")).toEqual([
      { label: "Workspace", path: "" },
      { label: "notes", path: "notes" },
      { label: "2026", path: "notes/2026" },
      { label: "today.md", path: "notes/2026/today.md" },
    ]);
    expect(fileBreadcrumbs("")).toEqual([{ label: "Workspace", path: "" }]);
  });

  it("moves to the parent and joins children without a leading slash", () => {
    expect(parentPath("notes/2026/today.md")).toBe("notes/2026");
    expect(parentPath("today.md")).toBe("");
    expect(joinPath("notes", "today.md")).toBe("notes/today.md");
    expect(joinPath("", "today.md")).toBe("today.md");
  });

  it("classifies preview kinds by extension", () => {
    expect(previewKindOf("notes.md")).toBe("text");
    expect(previewKindOf("photo.PNG")).toBe("image");
    expect(previewKindOf("report.pdf")).toBe("pdf");
    expect(previewKindOf("table.csv")).toBe("csv");
    expect(previewKindOf("archive.zip")).toBe("binary");
    expect(fileExtension("Makefile")).toBe("");
  });

  it("formats sizes for file rows", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatFileSize(null)).toBe("—");
  });
});

describe("thread routes", () => {
  it("has no per-thread sub-route under the agent", () => {
    expect(parseAgentsRoute("/agents/a1/threads/t1")).toEqual({
      view: "agent",
      agentId: "a1",
      tab: "threads",
    });
  });
});
