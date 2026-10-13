// Hub seam — the in-process machine/member socket registry and dispatch API.
//
// This module mirrors the public surface of the Rust hub
//. The M5 hub lane replaced InMemoryHub with
// the real WS-backed implementation (`LiveHub` + `SocketSink`); the M3
// harness lane only imports the types and injects fakes in tests.
//
// Ownership note (design decision 9): one Node process owns the hub.

export interface Member {
  userId: string;
  connId: string;
  clientId: string;
}

export interface MachineRequestError {
  kind: "offline" | "timeout" | "socket_limit" | "send_failed" | "rejected";
  message?: string;
}

/**
 * Dispatch one request to a connected machine and await its response.
 * Mirrors Rust `Hub::machine_request`: the holder must still hold the
 * machine slot and belong to `orgId`, else `offline`.
 */
export type MachineRequestFn = (
  machineId: string,
  orgId: string,
  op: string,
  payload: unknown,
  timeoutMs: number,
) => Promise<{ ok: true; value: unknown } | { ok: false; error: MachineRequestError }>;

export interface Hub {
  registerMember(member: Member): { ok: true } | { ok: false; error: "socket_limit" };
  unregisterMember(userId: string, connId: string): void;

  registerMachine(
    machineId: string,
    orgId: string,
    userId: string,
    connId: string,
    meta: { label?: string; appVersion?: string },
  ): Promise<{ ok: true } | { ok: false; error: "socket_limit" | "displaced" }>;
  unregisterMachine(machineId: string, connId: string): void;

  machineRequest: MachineRequestFn;
  machineOnline(machineId: string): boolean;
  machineLabel(machineId: string): string | undefined;
}

/** Test/dev placeholder: no transport, every request resolves `offline`.
 *  Kept for the M3 harness lane's fakes; production uses `LiveHub`. */
export class InMemoryHub implements Hub {
  private members = new Map<string, Member>();
  private machines = new Map<string, { orgId: string; userId: string; connId: string; label?: string }>();

  registerMember(member: Member) {
    this.members.set(`${member.userId}:${member.connId}`, member);
    return { ok: true } as const;
  }
  unregisterMember(userId: string, connId: string) {
    this.members.delete(`${userId}:${connId}`);
  }
  async registerMachine(
    machineId: string,
    orgId: string,
    userId: string,
    connId: string,
    meta: { label?: string; appVersion?: string },
  ) {
    this.machines.set(machineId, { orgId, userId, connId, label: meta.label });
    return { ok: true } as const;
  }
  unregisterMachine(machineId: string, connId: string) {
    const m = this.machines.get(machineId);
    if (m && m.connId === connId) this.machines.delete(machineId);
  }
  async machineRequest() {
    return { ok: false, error: { kind: "offline" } } as const;
  }
  machineOnline(machineId: string) {
    return this.machines.has(machineId);
  }
  machineLabel(machineId: string) {
    return this.machines.get(machineId)?.label;
  }
}

export { LiveHub } from "./live.js";
export type { LiveMember, MachineRegistration, MachineRejected } from "./live.js";
export { MAX_SOCKETS_PER_USER } from "./live.js";
export { SocketSink, SOCKET_HIGH_WATER } from "./sink.js";
export type { SocketOutput } from "./sink.js";
export { serializeServerMsg, parseClientMsg } from "./protocol.js";
export type { WsServerMsg, WsClientMsg } from "./protocol.js";
