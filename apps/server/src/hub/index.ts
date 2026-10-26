// Hub seam — the in-process machine/member socket registry and dispatch API.
// The WS-backed implementation is `LiveHub` with `SocketSink`; the harness
// and dispatch code depend on the interface, not the transport.
//
// One Node process owns the hub.

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
 * The holder must still hold the machine slot and belong to `orgId`,
 * else the call resolves `offline`.
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

export { LiveHub } from "./live.js";
export type { LiveMember, MachineRegistration, MachineRejected, MachineRequestResult } from "./live.js";
export { MAX_SOCKETS_PER_USER } from "./live.js";
export { SocketSink, SOCKET_HIGH_WATER } from "./sink.js";
export type { SocketOutput } from "./sink.js";
export { serializeServerMsg, parseClientMsg } from "./protocol.js";
export type { WsServerMsg, WsClientMsg } from "./protocol.js";
