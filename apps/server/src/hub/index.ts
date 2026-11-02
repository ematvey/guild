// The in-process machine/member socket registry (`LiveHub`, one per Node
// process), its socket sink and wire protocol, and the machine-request
// types the dispatch code shares.

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

export { LiveHub } from "./live.js";
export type { LiveMember, MachineRegistration, MachineRejected, MachineRequestResult } from "./live.js";
export { MAX_SOCKETS_PER_USER } from "./live.js";
export { SocketSink, SOCKET_HIGH_WATER } from "./sink.js";
export type { SocketOutput } from "./sink.js";
export { serializeServerMsg, parseClientMsg } from "./protocol.js";
export type { WsServerMsg, WsClientMsg } from "./protocol.js";
