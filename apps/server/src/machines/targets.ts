// The per-call machine target: a tool call names one of the member's paired
// machines with a `machine` argument (its id, or a label unique among that
// member's machines), and the call runs there instead of in the sandbox.
//
// This module owns the three facts such a call needs: which machine the
// member meant, the folder the call runs in (the machine's home, read once
// and kept until the machine goes offline), and the ExecutionEnv that
// carries it. A machine the member does not own is not addressable: machines
// are private to the Member who paired them.
//
// Liveness and the home are asked of the hub, which only the server process
// holds; a worker answers both over its IPC seam (worker/machine-facts.ts).
// That is why they are a dependency rather than a direct hub call.

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { MachineExecutionEnv, type MachineDispatch } from "./dispatch.js";
import type { MachineRow } from "../platform/store/machines.js";

/** A machine the member may address, with its live flag and the OS it runs. */
export interface MachineTarget {
  machine_id: string;
  label: string | null;
  online: boolean;
  os: string | null;
  os_version: string | null;
}

/** A call the member cannot make: the message is written for the model. */
export class MachineTargetError extends Error {}

/** The two facts about a machine that only a process holding the hub can
 *  answer: whether its socket is live, and where its home folder is. */
export interface MachineFacts {
  /** The subset of `machineIds` whose socket is live right now. */
  online(orgId: string, machineIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** The machine's home folder; throws `MachineTargetError` when the machine
   *  cannot answer. */
  home(orgId: string, machineId: string): Promise<string>;
}

export interface MachineTargetDeps {
  /** The member's registry rows (own machines only). */
  listForUser(orgId: string, userId: string): Promise<MachineRow[]>;
  facts: MachineFacts;
  /** The dispatch registry, built once the process has one. */
  dispatch(): Pick<MachineDispatch, "dispatch"> | undefined;
  /** The per-call result timeout. */
  timeoutMs(): number;
}

export class MachineTargets {
  private homes = new Map<string, string>();

  constructor(private readonly deps: MachineTargetDeps) {}

  /** The member's machines, most recently connected first. */
  async list(orgId: string, userId: string): Promise<MachineTarget[]> {
    const rows = await this.deps.listForUser(orgId, userId);
    const live = await this.deps.facts.online(
      orgId,
      rows.map((row) => row.machine_id),
    );
    for (const row of rows) if (!live.has(row.machine_id)) this.homes.delete(row.machine_id);
    return rows.map((row) => ({
      machine_id: row.machine_id,
      label: row.label,
      online: live.has(row.machine_id),
      os: row.os,
      os_version: row.os_version,
    }));
  }

  /** The machine a `machine` argument names: an exact id, or a label that
   *  matches exactly one of the member's machines. */
  async resolve(orgId: string, userId: string, spec: string): Promise<MachineTarget> {
    const wanted = spec.trim();
    if (wanted === "") throw new MachineTargetError("machine must name one of the member's machines");
    const mine = await this.list(orgId, userId);
    if (mine.length === 0) {
      throw new MachineTargetError("the member has no paired machines; omit machine to run in the sandbox");
    }
    const byId = mine.find((machine) => machine.machine_id === wanted);
    if (byId !== undefined) return byId;
    const byLabel = mine.filter((machine) => (machine.label ?? "").toLowerCase() === wanted.toLowerCase());
    if (byLabel.length === 1) return byLabel[0]!;
    if (byLabel.length > 1) {
      const ids = byLabel.map((machine) => machine.machine_id).join(", ");
      throw new MachineTargetError(`more than one machine is labelled "${wanted}" (${ids}); pass the machine id`);
    }
    const known = mine.map((machine) => `${machine.label ?? "(unlabelled)"} = ${machine.machine_id}`).join("; ");
    throw new MachineTargetError(`no such machine: "${wanted}". The member's machines are: ${known}`);
  }

  /** The folder a call on this machine runs in when it names none: the
   *  machine's home. Read once, and dropped when the machine goes offline. */
  async home(orgId: string, machineId: string): Promise<string> {
    const cached = this.homes.get(machineId);
    if (cached !== undefined) return cached;
    const home = await this.deps.facts.home(orgId, machineId);
    this.homes.set(machineId, home);
    return home;
  }

  /** The environment for one call on a named machine. `cwd` sets the folder
   *  the call runs in; omitted, it is the machine's home. */
  async envFor(args: {
    orgId: string;
    userId: string;
    chatId: string;
    machine: string;
    cwd?: string;
  }): Promise<ExecutionEnv> {
    const target = await this.resolve(args.orgId, args.userId, args.machine);
    if (!target.online) throw new MachineTargetError(`machine offline: ${target.label ?? target.machine_id}`);
    const workdir =
      args.cwd !== undefined && args.cwd !== "" ? args.cwd : await this.home(args.orgId, target.machine_id);
    const dispatch = this.deps.dispatch();
    if (dispatch === undefined) throw new MachineTargetError("no machine link is available in this process");
    return new MachineExecutionEnv({
      machineId: target.machine_id,
      orgId: args.orgId,
      chatId: args.chatId,
      workdir,
      timeoutMs: this.deps.timeoutMs(),
      dispatch,
    });
  }
}

/** The shell a machine's `command` runs in, from its OS alone. The engine
 *  picks the shell by workdir as well (`cmd.exe` for a native Windows folder,
 *  `bash` inside the distro for a `\\wsl.localhost\…` one); the prompt header
 *  carries that exception, this names the default. `null` when the OS is
 *  unknown, so no line claims a shell it cannot back. */
export function shellOf(os: string | null | undefined): string | null {
  if (os === null || os === undefined) return null;
  return os.toLowerCase() === "windows" ? "cmd.exe" : "sh -c";
}

/** One line per machine for the prompt and the `machine_list` tool: the
 *  label, the id, the live flag, and — when the OS is known — the OS and the
 *  shell the call's `command` runs in. */
export function renderMachineLines(machines: readonly MachineTarget[]): string {
  if (machines.length === 0) return "none paired";
  return machines
    .map((machine) => {
      const parts = [`- ${machine.label ?? "(unlabelled)"}`, machine.machine_id, machine.online ? "online" : "offline"];
      const shell = shellOf(machine.os);
      if (machine.os !== null && machine.os !== undefined) {
        parts.push(machine.os_version ? `${machine.os} ${machine.os_version}` : machine.os);
      }
      if (shell !== null) parts.push(`shell: ${shell}`);
      return parts.join(" · ");
    })
    .join("\n");
}
