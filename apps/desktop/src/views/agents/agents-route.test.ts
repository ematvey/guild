import { describe, expect, it } from "vitest";
import {
  AGENTS_ACTIVITY,
  DEFAULT_ACTIVITY_FILTERS,
  agentTabRoute,
  agentsRailTab,
  agentsRoutePath,
  agentsRouteTab,
  fileBreadcrumbs,
  fileExtension,
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
  {
    view: "agent",
    agentId: "a1",
    tab: "activity",
    filters: DEFAULT_ACTIVITY_FILTERS,
  },
  { view: "agent", agentId: "a1", tab: "settings" },
  AGENTS_ACTIVITY,
  {
    view: "activity",
    filters: {
      ...DEFAULT_ACTIVITY_FILTERS,
      tab: "calls",
      period: "30d",
      q: "deploy",
    },
  },
  { view: "run", runId: "run-1" },
  { view: "trace", traceId: "trace-1" },
  { view: "chat", chatId: "chat-1" },
  { view: "new", step: "model" },
  { view: "new", step: "tools" },
  { view: "run", runId: "run-1", traceView: "tree" },
  { view: "trace", traceId: "trace-1", traceView: "timeline" },
];

describe("trace view and create step addresses", () => {
  it("puts the trace view in the query, transcript being the bare URL", () => {
    expect(agentsRoutePath({ view: "run", runId: "r" })).toBe("/runs/r");
    expect(
      agentsRoutePath({ view: "run", runId: "r", traceView: "tree" }),
    ).toBe("/runs/r?view=tree");
    expect(parseAgentsRoute("/traces/t?view=bogus")).toEqual({
      view: "trace",
      traceId: "t",
    });
  });

  it("gives each wizard step its own path; unknown steps start over", () => {
    expect(agentsRoutePath({ view: "new" })).toBe("/agents/new");
    expect(agentsRoutePath({ view: "new", step: "tools" })).toBe(
      "/agents/new/tools",
    );
    expect(parseAgentsRoute("/agents/new/bogus")).toEqual({ view: "new" });
  });
});

describe("agents route contract", () => {
  it("round-trips every route through its canonical URL", () => {
    for (const route of routes) {
      const path = agentsRoutePath(route);
      expect(parseAgentsRoute(path), path).toEqual(route);
    }
  });

  it("maps every route to exactly one rail tab", () => {
    expect(agentsRailTab(AGENTS_ACTIVITY)).toBe("activity");
    expect(agentsRailTab({ view: "run", runId: "r" })).toBe("activity");
    expect(agentsRailTab({ view: "trace", traceId: "t" })).toBe("activity");
    expect(agentsRailTab({ view: "chat", chatId: "c" })).toBe("activity");
    expect(agentsRailTab({ view: "directory" })).toBe("agents");
    expect(agentsRailTab({ view: "agent", agentId: "a", tab: "files" })).toBe(
      "agents",
    );
    expect(
      agentsRailTab({ view: "agent", agentId: "a", tab: "activity" }),
    ).toBe("agents");
  });

  it("keeps the agent tab from the URL", () => {
    expect(agentsRouteTab(parseAgentsRoute("/agents/a1/settings")!)).toBe(
      "settings",
    );
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
    expect(parseAgentsRoute("/sessions/old")).toEqual({
      view: "chat",
      chatId: "old",
    });
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
    expect(agentsRoutePath(agentTabRoute("a1", "threads"))).toBe(
      "/agents/a1/threads",
    );
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
