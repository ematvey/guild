// Hub seam — the in-process machine/member socket registry and dispatch API.
//
// This skeleton mirrors the public surface of the Rust hub
// (crates/server/src/http/hub.rs) so parallel lanes can code against one
// contract. The M5 hub lane replaces InMemoryHub with the real WS-backed
// implementation (byte-compatible frames, live-slot rules); the M3 harness
// lane only imports the types and injects fakes in tests.
//
// Ownership note (design decision 9): one Node process owns the hub.

export interface Member {
  userId: string;
  connId: string;
  clientId: string;
}

export interface MachineRequestError {
  kind: "offline" | "timeout" | "socket_limit";
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

/** Test/dev placeholder: no transport, every request resolves `offline`. */
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
