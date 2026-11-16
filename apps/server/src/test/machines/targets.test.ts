// The per-call machine target: which machine a `machine` argument names, the
// folder a call runs in, and the environment it gets.

import { describe, expect, it } from "vitest";
import { MachineTargetError, MachineTargets, renderMachineLines, shellOf } from "../../machines/targets.js";
import type { MachineRow } from "../../platform/store/machines.js";

function row(machine_id: string, label: string | null, os: string | null = "macos"): MachineRow {
  return {
    machine_id,
    org_id: "org-1",
    user_id: "user-1",
    label,
    hardware_fingerprint: null,
    os,
    os_version: os === null ? null : "26.1",
    app_version: null,
    last_ip: null,
    first_connected_at: "2026-01-01T00:00:00Z",
    last_connected_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:00Z",
    re_paired_at: null,
  };
}

/** A registry of one member's machines, the live slots, and the two facts a
 *  hub (or a worker's IPC seam) answers: liveness and the home folder. */
function rig(options: { rows?: MachineRow[]; online?: string[] } = {}) {
  const rows = options.rows ?? [row("m-1", "MacBook"), row("m-2", "Build box")];
  const online = new Set(options.online ?? ["m-1", "m-2"]);
  const state = { homes: 0 };
  const dispatched: { machineId: string; workdir: string | null }[] = [];
  const targets = new MachineTargets({
    listForUser: async () => rows,
    facts: {
      online: async (_orgId, machineIds) => new Set(machineIds.filter((id) => online.has(id))),
      home: async (_orgId, machineId) => {
        if (!online.has(machineId)) throw new MachineTargetError("machine offline");
        state.homes += 1;
        return `/home/${machineId}`;
      },
    },
    dispatch: () => ({
      dispatch: async (call) => {
        dispatched.push({ machineId: call.machineId, workdir: call.workdir });
        return { content: "ok", is_error: false, meta: null, images: [] };
      },
    }),
    timeoutMs: () => 1000,
  });
  return { targets, state, dispatched, online };
}

describe("MachineTargets.resolve", () => {
  it("resolves by id", async () => {
    const { targets } = rig();
    expect((await targets.resolve("org-1", "user-1", "m-2")).label).toBe("Build box");
  });

  it("resolves by a label, ignoring case", async () => {
    const { targets } = rig();
    expect((await targets.resolve("org-1", "user-1", "macbook")).machine_id).toBe("m-1");
  });

  it("refuses a label two machines share", async () => {
    const { targets } = rig({ rows: [row("m-1", "Laptop"), row("m-2", "Laptop")] });
    await expect(targets.resolve("org-1", "user-1", "Laptop")).rejects.toThrow(/more than one machine is labelled/);
  });

  it("refuses a machine the member does not own, and names the ones they do", async () => {
    const { targets } = rig();
    await expect(targets.resolve("org-1", "user-1", "m-9")).rejects.toThrow(/no such machine.*MacBook = m-1/s);
  });

  it("refuses any machine when the member has none", async () => {
    const { targets } = rig({ rows: [] });
    await expect(targets.resolve("org-1", "user-1", "m-1")).rejects.toThrow(/no paired machines/);
  });
});

describe("MachineTargets.home", () => {
  it("asks once and keeps the answer", async () => {
    const { targets, state } = rig();
    expect(await targets.home("org-1", "m-1")).toBe("/home/m-1");
    expect(await targets.home("org-1", "m-1")).toBe("/home/m-1");
    expect(state.homes).toBe(1);
  });

  it("asks again after the machine was seen offline", async () => {
    const { targets, state, online } = rig();
    expect(await targets.home("org-1", "m-1")).toBe("/home/m-1");
    online.delete("m-1");
    await targets.list("org-1", "user-1");
    online.add("m-1");
    expect(await targets.home("org-1", "m-1")).toBe("/home/m-1");
    expect(state.homes).toBe(2);
  });

  it("is a target error while the machine is offline", async () => {
    const { targets } = rig({ online: [] });
    await expect(targets.home("org-1", "m-1")).rejects.toBeInstanceOf(MachineTargetError);
    await expect(targets.home("org-1", "m-1")).rejects.toThrow(/machine offline/);
  });
});

describe("MachineTargets.envFor", () => {
  it("runs in the machine home when the call names no folder", async () => {
    const { targets, dispatched } = rig();
    const env = await targets.envFor({ orgId: "org-1", userId: "user-1", chatId: "c-1", machine: "MacBook" });
    await env.exec("ls", undefined, {} as never);
    expect(dispatched).toEqual([{ machineId: "m-1", workdir: "/home/m-1" }]);
  });

  it("runs in the folder the call names", async () => {
    const { targets, dispatched, state } = rig();
    const env = await targets.envFor({
      orgId: "org-1",
      userId: "user-1",
      chatId: "c-1",
      machine: "MacBook",
      cwd: "/srv/app",
    });
    await env.exec("ls", undefined, {} as never);
    expect(dispatched).toEqual([{ machineId: "m-1", workdir: "/srv/app" }]);
    // A named folder is no reason to ask for the home.
    expect(state.homes).toBe(0);
  });

  it("refuses an offline machine before any dispatch", async () => {
    const { targets, dispatched } = rig({ online: ["m-2"] });
    await expect(
      targets.envFor({ orgId: "org-1", userId: "user-1", chatId: "c-1", machine: "MacBook" }),
    ).rejects.toThrow(/machine offline: MacBook/);
    expect(dispatched).toEqual([]);
  });
});

describe("renderMachineLines", () => {
  it("says none paired", () => {
    expect(renderMachineLines([])).toBe("none paired");
  });

  it("names the label, the id, the live flag, the OS and the shell", () => {
    expect(
      renderMachineLines([
        { machine_id: "m-1", label: "MacBook", online: true, os: "macos", os_version: "26.1" },
        { machine_id: "m-2", label: null, online: false, os: "windows", os_version: "26H2" },
      ]),
    ).toBe(
      "- MacBook · m-1 · online · macos 26.1 · shell: sh -c\n" +
        "- (unlabelled) · m-2 · offline · windows 26H2 · shell: cmd.exe",
    );
  });

  it("claims no shell for a machine whose OS is unknown", () => {
    expect(renderMachineLines([{ machine_id: "m-1", label: "Box", online: true, os: null, os_version: null }])).toBe(
      "- Box · m-1 · online",
    );
  });

  it("omits an unknown version but keeps the OS", () => {
    expect(renderMachineLines([{ machine_id: "m-1", label: "Box", online: true, os: "linux", os_version: null }])).toBe(
      "- Box · m-1 · online · linux · shell: sh -c",
    );
  });
});

describe("shellOf", () => {
  it("is cmd.exe on Windows and sh -c elsewhere", () => {
    expect(shellOf("windows")).toBe("cmd.exe");
    expect(shellOf("Windows")).toBe("cmd.exe");
    expect(shellOf("linux")).toBe("sh -c");
    expect(shellOf("macos")).toBe("sh -c");
    expect(shellOf(null)).toBeNull();
  });
});
