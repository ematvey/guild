// Pure tests for the project surfaces (spec 2026-09-17 §5): sidebar
// grouping, chip label, picker recency, and the WSL path specifier state
// machine (sources → browse → confirm). No DOM, no I/O.

import { describe, expect, it } from "vitest";
import type { ChatSummary, Project } from "../../transport";
import {
  PROJECT_PAGE_INITIAL,
  PROJECT_PAGE_STEP,
  breadcrumbs,
  canonicalDir,
  chatProjectOf,
  displayPath,
  expandError,
  expandPath,
  filterProjects,
  linuxJoin,
  outgoingProjectId,
  pickerFor,
  pickerReducer,
  projectChipLabel,
  recentProjects,
  sidebarGrouping,
  uncJoin,
  uncUp,
  wslFolder,
  wslRoot,
} from "./projects";

const chat = (id: string, project_id?: string, created_at = "t"): ChatSummary =>
  ({ id, title: id, created_at, project_id } as ChatSummary);

const project = (id: string, name = id, machine_label?: string): Project =>
  ({ id, name, folder: "C:\\x", machine_id: "m1", machine_label, created_at: "t" });

describe("sidebarGrouping", () => {
  const chats = [chat("c1", "p1"), chat("c2"), chat("c3", "p2"), chat("c4", "p1")];

  it("recents shows only the stateless chats, in list order", () => {
    const g = sidebarGrouping(chats);
    expect(g.visible.map((c) => c.id)).toEqual(["c2"]);
  });

  it("project-bound chats never appear in recents (they live under their project)", () => {
    const g = sidebarGrouping(chats);
    expect(g.visible.every((c) => !c.project_id)).toBe(true);
  });

  it("each project's fold-out list carries only that project's chats, in list order", () => {
    const g = sidebarGrouping(chats);
    expect(g.chatsByProject["p1"].map((c) => c.id)).toEqual(["c1", "c4"]);
    expect(g.chatsByProject["p2"].map((c) => c.id)).toEqual(["c3"]);
    expect(g.chatsByProject["missing"]).toBeUndefined();
  });

  it("stateless chats never appear under any project", () => {
    const g = sidebarGrouping(chats);
    for (const list of Object.values(g.chatsByProject)) {
      expect(list.every((c) => !!c.project_id)).toBe(true);
    }
  });

  it("tolerates a null list (still loading)", () => {
    expect(sidebarGrouping(null)).toEqual({ visible: [], chatsByProject: {} });
  });

  it("sorts each surface by recent activity, most recent first", () => {
    // Real stamps: the server's list order is already activity order — the
    // client-side re-sort matters when live event pushes move a background
    // chat's stamp forward between list refreshes.
    const active = [
      chat("old-quiet", "p1", "2026-10-15T09:00:00Z"),
      chat("busy", "p1", "2026-10-15T08:00:00Z"),
      chat("fresh-idle", "p1", "2026-10-15T10:00:00Z"),
    ];
    (active[1] as ChatSummary).last_activity_at = "2026-10-15T12:00:00Z";
    const g = sidebarGrouping(active);
    // The chat whose latest event is newest leads, even though a newer
    // creation and an older creation surround it.
    expect(g.chatsByProject["p1"].map((c) => c.id)).toEqual(["busy", "fresh-idle", "old-quiet"]);
  });

  it("sorts recents by recent activity too", () => {
    const active = [
      chat("quiet", undefined, "2026-10-15T09:00:00Z"),
      chat("live", undefined, "2026-10-15T08:00:00Z"),
    ];
    (active[1] as ChatSummary).last_activity_at = "2026-10-15T12:00:00Z";
    expect(sidebarGrouping(active).visible.map((c) => c.id)).toEqual(["live", "quiet"]);
  });

  it("rows without a stamp keep the stable list order (placeholder stamps parse as NaN → 0)", () => {
    const g = sidebarGrouping([chat("a", "p1"), chat("b", "p1"), chat("c", "p1")]);
    expect(g.chatsByProject["p1"].map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("pagination constants: a fold-out opens with 5, each click adds 20", () => {
    expect(PROJECT_PAGE_INITIAL).toBe(5);
    expect(PROJECT_PAGE_STEP).toBe(20);
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

describe("outgoingProjectId (request-wins only for an in-session pick)", () => {
  it("sends the project id only when the user picked it this session", () => {
    expect(outgoingProjectId({ id: "p1", name: "web" })).toBe("p1");
  });

  it("omits the field otherwise so the server uses the persisted binding", () => {
    // A stale sidebar row (possibly re-bound elsewhere since this list was
    // fetched) must never ride on the request.
    expect(outgoingProjectId(null)).toBeNull();
    expect(outgoingProjectId(undefined)).toBeNull();
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

  it("drives ~ display/expansion in Linux path space", () => {
    const home = "/home/me";
    expect(displayPath("/home/me/", home)).toBe("~");
    expect(displayPath("/home/me/src/", home)).toBe("~/src/");
    expect(displayPath("/etc/", home)).toBe("/etc/");
    expect(expandPath("~", home)).toBe("/home/me/");
    expect(expandPath("~/src", home)).toBe("/home/me/src/");
    expect(expandPath("/tmp/", home)).toBe("/tmp/");
    // without a home, ~ stays unexpandable
    expect(expandPath("~", null)).toBeNull();
    // …and committing it is an inline error, not a silent descend
    expect(expandError("~", null)).toBe("home directory unknown for this distro");
    expect(expandError("~/src", null)).toBeNull();
    expect(expandError("~", "/home/me")).toBeNull();
    // the UNC boundary: the confirmed inner path becomes the stored folder
    expect(wslFolder("arch", "/home/me/")).toBe("\\\\wsl.localhost\\arch\\home\\me\\");
    expect(wslFolder("arch", "/")).toBe("\\\\wsl.localhost\\arch\\");
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
  const root = "/";

  it("choosing a source opens the browse view at the root", () => {
    const s = pickerFor("arch", root);
    expect(s).toMatchObject({ source: "arch", cwd: root, entries: null, confirmed: null });
  });

  it("loading/loaded pairs fill the listing; stale results are dropped", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, { type: "go", path: linuxJoin(root, "home") });
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
    expect(s.cwd).toBe("/home/");
    s = pickerReducer(s, { type: "up" });
    expect(s.cwd).toBe("/");
    s = pickerReducer(s, { type: "up" });
    expect(s.cwd).toBe("/");
    // descending onto a file (or with no listing) is a no-op
    s = pickerReducer(s, { type: "descend" });
    expect(s.cwd).toBe("/");
  });

  it("Enter-as-go navigates a typed path (canonicalized); confirm needs a loaded listing", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, { type: "loaded", path: root, entries: [] });
    s = pickerReducer(s, { type: "go", path: "/var//log" });
    expect(s.cwd).toBe("/var/log/");
    // confirm only on a real dir: the listing of the CURRENT cwd must have
    // landed (the UI confirms only when the browse pane shows it)
    s = pickerReducer(s, { type: "confirm" });
    expect(s.confirmed).toBeNull();
    const navigated = "/var/log/";
    s = pickerReducer(s, { type: "loading", path: navigated });
    s = pickerReducer(s, {
      type: "loaded",
      path: navigated,
      entries: [{ name: "www", is_dir: true }],
    });
    s = pickerReducer(s, { type: "confirm" });
    expect(s.confirmed).toBe("/var/log/");
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

  it("an inline commit error (like an unavailable home for ~) shows without clearing the listing", () => {
    let s = pickerFor("arch", root);
    s = pickerReducer(s, { type: "loading", path: root });
    s = pickerReducer(s, { type: "loaded", path: root, entries: [{ name: "home", is_dir: true }] });
    s = pickerReducer(s, { type: "error", message: "home directory unknown for this distro" });
    expect(s.error).toBe("home directory unknown for this distro");
    expect(s.entries).not.toBeNull();
  });
});