// The sandbox RPC wire: one JSON frame per line between the server's
// SandboxExecutionEnv (client) and the in-sandbox agent (serveEnv). The
// runner only relays frames; it never parses them.
//
// Every ExecutionEnv member is one call. Objects with methods that a call
// returns (line/binary/dir readers, file watchers) stay in the agent and
// travel as handles; their methods are calls named `h.<method>`. Callbacks
// (exec `onOutput`, watch `onChange`) travel as event frames tagged with
// the originating call id.

import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { sanitizeText } from "../platform/domain/text.js";

export { sanitizeText };

/** Client → agent. */
export type SandboxClientFrame = { t: "call"; id: number; m: string; a: unknown[] } | { t: "cancel"; id: number };

/** Agent → client. */
export type SandboxAgentFrame =
  | { t: "result"; id: number; r: unknown }
  | { t: "throw"; id: number; message: string }
  | { t: "output"; id: number; text: string; info: unknown }
  | { t: "watch"; id: number; change: unknown };

/** A handle to an object living in the agent. */
export interface HandleRef {
  $h: number;
  kind: HandleKind;
  /** FileWatcher.mode. */
  mode?: "native" | "polling";
}

export type HandleKind = "textLineReader" | "binaryReader" | "dirReader" | "watcher";

/** The methods each handle kind exposes over the wire. */
export const HANDLE_METHODS: Record<HandleKind, readonly string[]> = {
  textLineReader: ["readLine", "close"],
  binaryReader: ["info", "read", "scanLines", "close"],
  dirReader: ["next", "close"],
  watcher: ["close"],
};

/** ExecutionEnv members callable over the wire whose results are plain
 *  Results (no handle in the value). */
export const PLAIN_METHODS = [
  "absolutePath",
  "joinPath",
  "readTextFile",
  "readTextLines",
  "readBinaryFile",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "listFiles",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
] as const;

/** ExecutionEnv members whose ok value is a handle. */
export const HANDLE_RETURNING_METHODS: Record<string, HandleKind> = {
  openTextLineReader: "textLineReader",
  openBinaryReader: "binaryReader",
  openDirReader: "dirReader",
  watch: "watcher",
};

/** Encodes a value for JSON: bytes, undefined, and the env error classes
 *  survive the round trip. The encoding is lossless: a string keeps its
 *  bytes, so a `write` argument arrives in the sandbox unchanged. A value
 *  that later enters a record is cleaned by the record encoder, not here. */
export function encodeValue(value: unknown): unknown {
  if (value === undefined) return { $u: 1 };
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array)
    return { $b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (value instanceof FileError) {
    return { $fe: value.code, message: value.message, path: value.path };
  }
  if (value instanceof ExecutionError) {
    return { $ee: value.code, message: value.message, spillPath: value.spillPath };
  }
  if (value instanceof Error) return { $err: value.message };
  if (Array.isArray(value)) return value.map(encodeValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "function") continue;
    out[k] = encodeValue(v);
  }
  return out;
}

export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const obj = value as Record<string, unknown>;
  if ("$u" in obj) return undefined;
  if (typeof obj["$b64"] === "string") return new Uint8Array(Buffer.from(obj["$b64"], "base64"));
  if (typeof obj["$fe"] === "string") {
    return new FileError(
      obj["$fe"] as FileError["code"],
      String(obj["message"] ?? ""),
      obj["path"] as string | undefined,
    );
  }
  if (typeof obj["$ee"] === "string") {
    const error = new ExecutionError(obj["$ee"] as ExecutionError["code"], String(obj["message"] ?? ""));
    if (typeof obj["spillPath"] === "string") error.spillPath = obj["spillPath"];
    return error;
  }
  if (typeof obj["$err"] === "string") return new Error(obj["$err"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = decodeValue(v);
  return out;
}

/** A bidirectional frame channel (stdio pipe, a WebSocket, a test pair). */
export interface Wire {
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): void;
  /** Fires once when the channel ends, for any reason. */
  onClose(listener: (error?: Error) => void): void;
  close(): void;
}

/** Two connected in-memory wires (tests, in-process agents). */
export function wirePair(): [Wire, Wire] {
  const make = () => ({
    frameListeners: [] as Array<(frame: string) => void>,
    closeListeners: [] as Array<(error?: Error) => void>,
    closed: false,
  });
  const a = make();
  const b = make();
  const end = (side: ReturnType<typeof make>) => {
    if (side.closed) return;
    side.closed = true;
    for (const l of side.closeListeners) l();
  };
  const wire = (self: ReturnType<typeof make>, peer: ReturnType<typeof make>): Wire => ({
    send(frame) {
      if (self.closed || peer.closed) return;
      queueMicrotask(() => {
        if (!peer.closed) for (const l of peer.frameListeners) l(frame);
      });
    },
    onFrame(listener) {
      self.frameListeners.push(listener);
    },
    onClose(listener) {
      self.closeListeners.push(listener);
    },
    close() {
      queueMicrotask(() => {
        end(self);
        end(peer);
      });
    },
  });
  return [wire(a, b), wire(b, a)];
}

/** Splits a byte stream into newline-terminated frames. */
export class LineSplitter {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array, emit: (line: string) => void): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let start = 0;
    let index = this.buffer.indexOf("\n", start);
    while (index !== -1) {
      if (index > start) emit(this.buffer.slice(start, index));
      start = index + 1;
      index = this.buffer.indexOf("\n", start);
    }
    this.buffer = this.buffer.slice(start);
  }
}
