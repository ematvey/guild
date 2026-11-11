// The per-call machine target: which machine a `machine` argument names, the
// folder a call runs in, and the environment it gets.

import { describe, expect, it } from "vitest";
import { MachineTargetError, MachineTargets, renderMachineLines } from "../../machines/targets.js";
import type { MachineRow } from "../../platform/store/machines.js";

function row(machine_id: string, label: string | null): MachineRow {
  return {
    machine_id,
    org_id: "org-1",
    user_id: "user-1",
    label,
    hardware_fingerprint: null,
    os: null,
    os_version: null,
    app_version: null,
    last_ip: null,
    first_connected_at: "2026-01-01T00:00:00Z",
    last_connected_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:00Z",
    re_paired_at: null,
  };
}

/** A registry of one member's machines plus the live slots, and a hub that
 *  answers `fs_home` with a per-connection folder. */
function rig(options: { rows?: MachineRow[]; online?: string[]; conn?: string } = {}) {
  const rows = options.rows ?? [row("m-1", "MacBook"), row("m-2", "Build box")];
  const online = new Set(options.online ?? ["m-1", "m-2"]);
  const state = { conn: options.conn ?? "conn-1", homes: 0 };
  const dispatched: { machineId: string; workdir: string | null }[] = [];
  const targets = new MachineTargets({
    listForUser: async () => rows,
    machineOnline: (machineId) => online.has(machineId),
    machineHolder: (machineId) => (online.has(machineId) ? { conn_id: state.conn, org_id: "org-1" } : null),
    machineRequest: async (machineId, _orgId, op) => {
      if (!online.has(machineId)) return { ok: false, error: { kind: "offline" } };
      if (op !== "fs_home") return { ok: false, error: { kind: "rejected", message: "unknown op" } };
      state.homes += 1;
      return { ok: true, value: { home: `/home/${machineId}` } };
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
  it("asks once per connection", async () => {
    const { targets, state } = rig();
    expect(await targets.home("org-1", "m-1")).toBe("/home/m-1");
    expect(await targets.home("org-1", "m-1")).toBe("/home/m-1");
    expect(state.homes).toBe(1);
    state.conn = "conn-2";
    await targets.home("org-1", "m-1");
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

  it("names the label, the id and the live flag", () => {
    expect(
      renderMachineLines([
        { machine_id: "m-1", label: "MacBook", online: true },
        { machine_id: "m-2", label: null, online: false },
      ]),
    ).toBe("- MacBook · m-1 · online\n- (unlabelled) · m-2 · offline");
  });
});
