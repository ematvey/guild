// The in-process machine/member socket registry (`LiveHub`, one per Node
// process), its socket sink and wire protocol, and the machine-request
// types the dispatch code shares.

export { LiveHub, MAX_SOCKETS_PER_USER } from "./live.js";
export type {
  LiveMember,
  MachineRegistration,
  MachineRejected,
  MachineRequestError,
  MachineRequestFn,
  MachineRequestResult,
} from "./live.js";
export { SocketSink, SOCKET_HIGH_WATER } from "./sink.js";
export type { SocketOutput } from "./sink.js";
export { serializeServerMsg, parseClientMsg } from "./protocol.js";
export type { WsServerMsg, WsClientMsg } from "./protocol.js";
