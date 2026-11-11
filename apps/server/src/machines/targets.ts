// The per-call machine target: a tool call names one of the member's paired
// machines with a `machine` argument (its id, or a label unique among that
// member's machines), and the call runs there instead of in the sandbox.
//
// This module owns the three facts such a call needs: which machine the
// member meant, the folder the call runs in (the machine's home, asked once
// per connection), and the ExecutionEnv that carries it. A machine the
// member does not own is not addressable: machines are private to the
// Member who paired them.

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MachineRequestFn } from "../hub/index.js";
import { MachineExecutionEnv, type MachineDispatch } from "./dispatch.js";
import type { MachineRow } from "../platform/store/machines.js";

/** A machine the member may address, with its live flag. */
export interface MachineTarget {
  machine_id: string;
  label: string | null;
  online: boolean;
}

/** A call the member cannot make: the message is written for the model. */
export class MachineTargetError extends Error {}

export interface MachineTargetDeps {
  /** The member's registry rows (own machines only). */
  listForUser(orgId: string, userId: string): Promise<MachineRow[]>;
  /** The socket presence flag (a machine is online only while it holds its
   *  slot). */
  machineOnline(machineId: string): boolean;
  /** The live slot's connection id: the home cache is keyed by it, so a
   *  reconnect re-reads the folder. */
  machineHolder(machineId: string): { conn_id: string; org_id: string } | null;
  machineRequest: MachineRequestFn;
  /** The dispatch registry, built once the hub exists. */
  dispatch(): Pick<MachineDispatch, "dispatch"> | undefined;
  /** The per-call result timeout. */
  timeoutMs(): number;
}

/** One machine's home, as read for one connection. */
interface HomeEntry {
  connId: string;
  home: string;
}

export class MachineTargets {
  private homes = new Map<string, HomeEntry>();

  constructor(private readonly deps: MachineTargetDeps) {}

  /** The member's machines, most recently connected first. */
  async list(orgId: string, userId: string): Promise<MachineTarget[]> {
    const rows = await this.deps.listForUser(orgId, userId);
    return rows.map((row) => ({
      machine_id: row.machine_id,
      label: row.label,
      online: this.deps.machineOnline(row.machine_id),
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
   *  machine's home. Read once per connection. */
  async home(orgId: string, machineId: string): Promise<string> {
    const holder = this.deps.machineHolder(machineId);
    if (holder === null || holder.org_id !== orgId) throw new MachineTargetError("machine offline");
    const cached = this.homes.get(machineId);
    if (cached !== undefined && cached.connId === holder.conn_id) return cached.home;
    const result = await this.deps.machineRequest(machineId, orgId, "fs_home", null, 10_000);
    if (!result.ok) {
      if (result.error.kind === "offline") throw new MachineTargetError("machine offline");
      throw new MachineTargetError(
        `the machine did not report its home folder: ${result.error.message ?? result.error.kind}`,
      );
    }
    const value = result.value as { home?: unknown } | null;
    const home = typeof value?.home === "string" ? value.home : "";
    if (home === "") throw new MachineTargetError("the machine reported no home folder");
    this.homes.set(machineId, { connId: holder.conn_id, home });
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

/** One line per machine for the prompt and the `machine_list` tool: the
 *  label, the id and the live flag. */
export function renderMachineLines(machines: readonly MachineTarget[]): string {
  if (machines.length === 0) return "none paired";
  return machines
    .map(
      (machine) =>
        `- ${machine.label ?? "(unlabelled)"} · ${machine.machine_id} · ${machine.online ? "online" : "offline"}`,
    )
    .join("\n");
}
