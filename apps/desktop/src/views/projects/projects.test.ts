// Pure tests for the project surfaces (spec 2026-09-17 §5): sidebar
// grouping, chip label, picker recency, and the WSL path specifier state
// machine (sources → browse → confirm). No DOM, no I/O.

import { describe, expect, it } from "vitest";
import type { ChatSummary, Project } from "../../transport";
import {
  breadcrumbs,
  canonicalDir,
  chatProjectOf,
  displayPath,
  expandPath,
  filterProjects,
  pickerFor,
  pickerReducer,
  projectChipLabel,
  recentProjects,
  sidebarGrouping,
  uncJoin,
  uncUp,
  wslHomeUnc,
  wslRoot,
} from "./projects";

const chat = (id: string, project_id?: string, created_at = "t"): ChatSummary =>
  ({ id, title: id, created_at, project_id } as ChatSummary);

const project = (id: string, name = id, machine_label?: string): Project =>
  ({ id, name, folder: "C:\\x", machine_id: "m1", machine_label, created_at: "t" });

describe("sidebarGrouping", () => {
  const chats = [chat("c1", "p1"), chat("c2"), chat("c3", "p2"), chat("c4", "p1")];

  it("recents view shows every chat in list order and counts per project", () => {
    const g = sidebarGrouping(chats, null);
    expect(g.visible.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(g.counts).toEqual({ p1: 2, p2: 1 });
  });

  it("a selected project shows only its chats", () => {
    expect(sidebarGrouping(chats, "p1").visible.map((c) => c.id)).toEqual(["c1", "c4"]);
    expect(sidebarGrouping(chats, "p2").visible.map((c) => c.id)).toEqual(["c3"]);
  });

  it("projectless chats never appear under any project", () => {
    expect(sidebarGrouping(chats, "p1").visible.every((c) => c.project_id === "p1")).toBe(true);
    expect(sidebarGrouping(chats, "missing").visible).toEqual([]);
  });

  it("tolerates a null list (still loading)", () => {
    expect(sidebarGrouping(null, null)).toEqual({ visible: [], counts: {} });
  });
});

describe("projectChipLabel", () => {
  it("projectless default reads 'Choose project'", () => {
    expect(projectChipLabel(null)).toBe("Choose project");
    expect(projectChipLabel(undefined)).toBe("Choose project");
    expect(projectChipLabel({ id: "x", name: "" })).toBe("Choose project");
  });

  it("a project shows its name, plus the machine when known", () => {
    expect(projectChipLabel({ id: "p", name: "web" })).toBe("web");
    expect(projectChipLabel({ id: "p", name: "web", machine_label: "devbox" })).toBe("web · devbox");
  });
});

describe("chatProjectOf (fallback chip state from the sidebar row)", () => {
  it("derives the pick from the row's project fields", () => {
    expect(chatProjectOf(chat("c1"))).toBeNull();
    const row = { ...chat("c1", "p1"), project_name: "web", project_machine_label: "devbox" } as ChatSummary;
    expect(chatProjectOf(row)).toEqual({ id: "p1", name: "web", machine_label: "devbox" });
  });
});

describe("recentProjects", () => {
  it("orders projects by their most recent chat and dedupes", () => {
    const chats = [chat("c1", "p2"), chat("c2", "p1"), chat("c3", "p2"), chat("c4", "p1")];
    expect(recentProjects(chats, [project("p1"), project("p2"), project("p3")]).map((p) => p.id)).toEqual([
      "p2",
      "p1",
    ]);
  });

  it("skips chats whose project is unknown", () => {
    expect(recentProjects([chat("c1", "ghost")], [project("p1")])).toEqual([]);
  });
});

describe("filterProjects", () => {
  it("matches case-insensitively on the name; empty query passes all", () => {
    const ps = [project("p1", "Web API"), project("p2", "cli")];
    expect(filterProjects(ps, "")).toHaveLength(2);
    expect(filterProjects(ps, "web").map((p) => p.id)).toEqual(["p1"]);
    expect(filterProjects(ps, "CLI")).toEqual([ps[1]]);
  });
});

describe("specifier paths", () => {
  it("builds and joins UNC paths canonically", () => {
    expect(wslRoot("arch")).toBe("\\\\wsl.localhost\\arch\\");
    expect(uncJoin("\\\\wsl.localhost\\arch\\", "home")).toBe("\\\\wsl.localhost\\arch\\home\\");
    expect(uncJoin("\\\\wsl.localhost\\arch\\home", "me")).toBe("\\\\wsl.localhost\\arch\\home\\me\\");
  });

  it("up-navigation stops at the distro root", () => {
    expect(uncUp("\\\\wsl.localhost\\arch\\home\\me\\")).toBe("\\\\wsl.localhost\\arch\\home\\");
    expect(uncUp("\\\\wsl.localhost\\arch\\home\\")).toBe("\\\\wsl.localhost\\arch\\");
    expect(uncUp("\\\\wsl.localhost\\arch\\")).toBe("\\\\wsl.localhost\\arch\\");
  });

  it("converts the LINUX home to UNC and drives ~ display/expansion", () => {
    const home = wslHomeUnc("arch", "/home/me");
    expect(home).toBe("\\\\wsl.localhost\\arch\\home\\me");
    expect(displayPath("\\\\wsl.localhost\\arch\\home\\me\\", home)).toBe("~");
    expect(displayPath("\\\\wsl.localhost\\arch\\home\\me\\src\\", home)).toBe("~\\src\\");
    expect(displayPath("\\\\wsl.localhost\\arch\\etc\\", home)).toBe("\\\\wsl.localhost\\arch\\etc\\");
    expect(expandPath("~", home)).toBe(home);
    expect(expandPath("~/src", home)).toBe("\\\\wsl.localhost\\arch\\home\\me\\src\\");
    expect(expandPath("\\\\wsl.localhost\\arch\\tmp\\", home)).toBe("\\\\wsl.localhost\\arch\\tmp\\");
    // without a home, ~ stays unexpandable
    expect(expandPath("~", null)).toBeNull();
  });

  it("canonicalizes directory paths and renders breadcrumbs", () => {
    expect(canonicalDir("\\\\wsl.localhost\\arch")).toBe("\\\\wsl.localhost\\arch\\");
    expect(canonicalDir("\\\\wsl.localhost\\arch\\\\")).toBe("\\\\wsl.localhost\\arch\\");
    const crumbs = breadcrumbs("\\\\wsl.localhost\\arch\\home\\me\\");
    expect(crumbs.map((c) => c.label)).toEqual(["wsl.localhost", "arch", "home", "me"]);
    expect(crumbs[1].path).toBe("\\\\wsl.localhost\\arch\\");
    expect(crumbs[3].path).toBe("\\\\wsl.localhost\\arch\\home\\me\\");
  });
});

describe("picker state machine (sources → browse → confirm)", () => {
  const root = wslRoot("arch");

  it("choosing a source opens the browse view at the root", () => {
    const s = pickerFor("arch", root);
    expect(s).toMatchObject({ source: "arch", cwd: root, entries: null, confirmed: null });
  });

  it("loading/loaded pairs fill the listing; stale results are dropped", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, { type: "go", path: uncJoin(root, "home") });
    s = pickerReducer(s, { type: "loaded", path: root, entries: [{ name: "me", is_dir: true }] });
    // the load for the previous cwd must not land after the move
    expect(s.entries).toBeNull();
    const next = s.cwd!;
    s = pickerReducer(s, { type: "loading", path: next });
    s = pickerReducer(s, { type: "loaded", path: next, entries: [{ name: "me", is_dir: true }] });
    expect(s.entries).toEqual([{ name: "me", is_dir: true }]);
  });

  it("descend follows the highlighted row; up goes one level; floor is the root", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, {
      type: "loaded",
      path: root,
      entries: [
        { name: "etc", is_dir: true },
        { name: "home", is_dir: true },
        { name: "notes.txt", is_dir: false },
      ],
    });
    s = pickerReducer(s, { type: "highlight", index: 1 });
    s = pickerReducer(s, { type: "descend" });
    expect(s.cwd).toBe("\\\\wsl.localhost\\arch\\home\\");
    s = pickerReducer(s, { type: "up" });
    expect(s.cwd).toBe(root);
    s = pickerReducer(s, { type: "up" });
    expect(s.cwd).toBe(root);
    // descending onto a file (or with no listing) is a no-op
    s = pickerReducer(s, { type: "descend" });
    expect(s.cwd).toBe(root);
  });

  it("Enter-as-go navigates a typed path (canonicalized); confirm needs a loaded listing", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, { type: "loaded", path: root, entries: [] });
    s = pickerReducer(s, { type: "go", path: "\\\\wsl.localhost\\arch\\var\\\\log" });
    expect(s.cwd).toBe("\\\\wsl.localhost\\arch\\var\\log\\");
    // confirm only on a real dir: the listing of the CURRENT cwd must have
    // landed (the UI confirms only when the browse pane shows it)
    s = pickerReducer(s, { type: "confirm" });
    expect(s.confirmed).toBeNull();
    const navigated = "\\\\wsl.localhost\\arch\\var\\log\\";
    s = pickerReducer(s, { type: "loading", path: navigated });
    s = pickerReducer(s, {
      type: "loaded",
      path: navigated,
      entries: [{ name: "www", is_dir: true }],
    });
    s = pickerReducer(s, { type: "confirm" });
    expect(s.confirmed).toBe("\\\\wsl.localhost\\arch\\var\\log\\");
  });

  it("confirm is refused without a successful listing", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "confirm" });
    expect(s.confirmed).toBeNull();
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, { type: "failed", path: root, error: "no route to host" });
    expect(s.error).toBe("no route to host");
    s = pickerReducer(s, { type: "confirm" });
    expect(s.confirmed).toBeNull();
  });
});
