// Pure tests for the local-machine tab (no DOM, no server): the org
// installs list's view model (pinned versions + update availability), the
// local skill rows' provenance badge, the disable toggle's rpc wiring,
// and the panel tabs (the "On this machine" tab exists only in Tauri —
// the IS_TAURI=false fixture hides it).

import { describe, expect, it, vi } from "vitest";
import { installRow, sourceBadge, toggleDisabled, uninstallSkill, type LocalSkillRow } from "./LocalSkills";
import { panelTabs } from "./SkillsPanel";
import type { SkillInstall } from "./skills-api";

const pinnedBehind: SkillInstall = {
  slug: "code-review",
  pinned_version: "v1",
  installed_at: "2026-10-13T11:00:00Z",
};

describe("installRow (an org install's view model)", () => {
  it("carries the fields the row renders", () => {
    const vm = installRow(pinnedBehind, "v3");
    expect(vm.slug).toBe("code-review");
    expect(vm.pinnedVersion).toBe("v1");
    expect(vm.installedAt).toBe("2026-10-13T11:00:00Z");
  });

  it("flags an update when the pin sits behind the catalog's latest", () => {
    const vm = installRow(pinnedBehind, "v3");
    expect(vm.updateAvailable).toBe(true);
    expect(vm.pinTarget).toBe("v3");
  });

  it("shows no update when pinned at latest, or when the latest is unknown", () => {
    expect(installRow(pinnedBehind, "v1").updateAvailable).toBe(false);
    expect(installRow(pinnedBehind, null).updateAvailable).toBe(false);
    expect(installRow(pinnedBehind, null).pinTarget).toBeNull();
  });
});

describe("sourceBadge (a local row's provenance)", () => {
  const base: LocalSkillRow = {
    name: "deploy",
    description: "Compose rebuild and live-bundle check",
    path: "/repo/.agents/skills/deploy/SKILL.md",
    scope: "repo",
    provenance: null,
    installed: false,
    published_by_me: false,
    disabled: false,
  };

  it("marks registry-installed skills and the user's own publishes", () => {
    expect(sourceBadge(base)).toBe("local");
    expect(sourceBadge({ ...base, installed: true })).toBe("installed");
    expect(sourceBadge({ ...base, installed: true, published_by_me: true })).toBe("yours");
    expect(sourceBadge({ ...base, published_by_me: true })).toBe("yours");
  });
});

describe("toggleDisabled (the enable/disable rpc wiring)", () => {
  it("writes the flipped skillsDisabled entry to settings.json via the fs bridge", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "fs.scopes") return { result: { config_dir: "/cfg", home: "/home" } };
      if (method === "fs.write_text") return { result: { ok: true } };
      return { result: null };
    };
    const row = { path: "/repo/.agents/skills/deploy/SKILL.md", disabled: true };
    await toggleDisabled(rpc, row);

    const write = calls.find((c) => c.method === "fs.write_text");
    expect(write).toBeDefined();
    expect(write?.params.path).toBe("/cfg/settings.json");
    const saved = JSON.parse(String(write?.params.body)) as {
      skillsDisabled: Record<string, boolean>;
    };
    // the row was disabled → the toggle enables it
    expect(saved.skillsDisabled[row.path]).toBe(true);
  });

  it("disables an enabled row", async () => {
    const writes: string[] = [];
    const rpc = async (method: string, params: Record<string, unknown>) => {
      if (method === "fs.scopes") return { result: { config_dir: "/cfg", home: "/home" } };
      if (method === "fs.write_text") {
        writes.push(String(params.body));
        return { result: { ok: true } };
      }
      return { result: null };
    };
    await toggleDisabled(rpc, { path: "/repo/.agents/skills/triage/SKILL.md", disabled: false });
    const saved = JSON.parse(writes[0]) as { skillsDisabled: Record<string, boolean> };
    expect(saved.skillsDisabled["/repo/.agents/skills/triage/SKILL.md"]).toBe(false);
  });
});

describe("panelTabs (the IS_TAURI fixture)", () => {
  it("offers On this machine only in Tauri sessions", () => {
    const tauri = panelTabs(true).map(([value]) => value);
    expect(tauri).toEqual(["catalog", "activity", "machine"]);
    expect(panelTabs(true).find(([v]) => v === "machine")?.[1]).toBe("On this machine");

    // browser sessions don't render the tab at all
    const browser = panelTabs(false).map(([value]) => value);
    expect(browser).toEqual(["catalog", "activity"]);
    expect(browser).not.toContain("machine");
  });
});

describe("uninstallSkill (server-first, local cleanup second)", () => {
  type Rpc = (method: string, params: any, timeoutMs?: number) => Promise<any>;
  const okFetch = () =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

  it("removes the pin first, then the local folder (org installs live in the home scope)", async () => {
    okFetch();
    const rpc = vi.fn(async (_method: string, _params: any) => ({ result: { uninstalled: "deploy" } }));
    await uninstallSkill("deploy", rpc as unknown as Rpc, true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![0]).toBe("registry.uninstall");
    expect(rpc.mock.calls[0]![1]).toMatchObject({ slug: "deploy", global: true });
  });

  it("swallows the local cleanup's failure — the machine-sync push owns the rest", async () => {
    okFetch();
    const rpc = vi.fn(async (_method: string, _params: any) => {
      throw new Error("not materialized here");
    });
    await expect(uninstallSkill("deploy", rpc as unknown as Rpc, true)).resolves.toBeUndefined();
  });

  it("falls back to local-only removal when the server has no install record (a copied-in dir)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "not installed" }), { status: 404 })),
    );
    const rpc = vi.fn(async (_method: string, _params: any) => ({ result: {} }));
    await uninstallSkill("deploy", rpc as unknown as Rpc, false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ slug: "deploy", global: false });
  });

  it("propagates a failed local-only fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "not installed" }), { status: 404 })),
    );
    const rpc = vi.fn(async (_method: string, _params: any) => {
      throw new Error("remove failed");
    });
    await expect(uninstallSkill("deploy", rpc as unknown as Rpc, true)).rejects.toThrow("remove failed");
  });
});
