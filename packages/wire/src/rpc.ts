// The line-delimited JSON-RPC 2.0 envelope between the desktop UI and the
// engine, and over the local CLI socket, hand-written from
// protocol/rpc.schema.json. The schema is the contract. Presence follows it
// exactly: an optional field is `field?: T`; an always-serialized plain field
// is `field: T`.

/** Any JSON value. serde_json::Value in Rust. */
export type Json = unknown;

/** A request from client to server. Either side can be the client. */
export interface Request {
  jsonrpc: "2.0";
  /** A JSON number, not a bigint. u64 in Rust. */
  id: number;
  protocol: number;
  method: string;
  /** Always present; `#[serde(default)]`. */
  params: Json;
}

/** The error arm of a Response. */
export interface RpcError {
  /** A JSON number. i64 in Rust; the app base is -32000. */
  code: number;
  message: string;
  data?: Json;
}

/** A reply to a Request. Exactly one of result and error is present. */
export interface Response {
  jsonrpc: "2.0";
  id: number;
  protocol: number;
  /** Omitted on the error arm. */
  result?: Json;
  /** Omitted on the success arm. */
  error?: RpcError;
}

/** An unsolicited server push: streaming deltas and status. */
export interface Event {
  protocol: number;
  event: string;
  /** Always present; `#[serde(default)]`. */
  payload: Json;
}
