// Machine-tool dispatch: an ExecutionEnv that proxies FileSystem/exec ops
// over the hub to the connected daemon. The server sends a `tool_dispatch`
// frame (crates/protocol/src/ws.rs ToolDispatch) on the machine's executor
// socket and the daemon answers a `tool_result` frame.
//
// Primitive → daemon mapping (the engine's dispatch names, served in
// crates/app-server/src/machine_link.rs):
//   exec             → `execute`        {command, timeout_ms?}
//   read* / open*    → `fs.read_raw_v1` {path} → {size, mtime_ms, data_b64}
//   writeFile        → `write_file`     {path, content}
//   fileInfo/exists  → `fs.stat_v1`     {path} → {exists, kind?, size?, mtime_ms?}
// The raw ops carry exact bytes; the model-facing `read_file` (paged,
// text-only, capped) is never used for file access. An engine without the
// raw ops fails reads with `not_supported`. Everything else is
// not-supported (the machine has no op for it).
// The machine ToolResult's meta/images have no channel in the
// ShellExecResult/byte shapes, so they are dropped.

import path from "node:path";
import { err, ok, ExecutionError, FileError, LineScanner, type BinaryReader, type DirReader, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions, type ShellExecResult, type ShellOutputInfo, type TextLine, type TextLineReader, type WatchChange, type WatchTarget, type FileWatcher } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import type { MachineRequestFn } from "../hub/index.js";

/** Where a conversation's tools execute — the env factory and the approval
 *  gate both resolve through the runtime. */
export type ExecutorKind = "machine" | "server" | null;
/** The hub surface the dispatch registry and the env need (LiveHub in
 *  production; a test double implements the same members). */
export interface MachineDispatchHost {
  machineHolder(machineId: string): { conn_id: string; org_id: string } | null;
  sendMachineToolDispatch(machineId: string, orgId: string, msg: { type: "tool_dispatch"; chat_id: string; call_id: string; name: string; arguments: string; workdir?: string }): boolean;
  sendMachineToolCancel(machineId: string, orgId: string, connectionId: string, callId: string): boolean;
  /** The control-plane request to a machine's executor socket (the skills
   *  fleet sync push) and the slot liveness the fan-out consults. */
  machineRequest: MachineRequestFn;
  machineOnline(machineId: string): boolean;
}


/** The daemon's guild-core `execute` accepts milliseconds. */
const DEFAULT_EXECUTE_TIMEOUT_MS = 300_000;

export interface MachineToolOutcome {
  content: string;
  is_error: boolean;
  meta: unknown;
  images: string[];
}

interface PendingTool {
  machineId: string;
  connectionId: string;
  orgId: string;
  settle: (outcome: MachineToolOutcome) => void;
}


export class MachineDispatch {
  /** call_id → pending tool (settle on the machine's tool_result frame,
   *  the dispatch timeout, or the machine slot dropping). */
  private pending = new Map<string, PendingTool>();
  private seq = 0;

  constructor(private readonly hub: MachineDispatchHost) {}

  /** Sends one tool-dispatch frame to the machine's executor socket and
   *  awaits its result. `offline` = no live slot or a
   *  dead sink; the call id is a fresh correlation id — the daemon echoes
   *  it verbatim. */
  async dispatch(opts: {
    machineId: string;
    orgId: string;
    chatId: string;
    name: string;
    args: Record<string, unknown>;
    workdir: string | null;
    timeoutMs: number;
  }, signal?: AbortSignal): Promise<MachineToolOutcome> {
    signal?.throwIfAborted();
    const holder = this.hub.machineHolder(opts.machineId);
    if (holder === null || holder.org_id !== opts.orgId) {
      return { content: "machine offline", is_error: true, meta: null, images: [] };
    }
    const callId = `md${Date.now().toString(36)}${(this.seq += 1).toString(36)}`;
    let settle: PendingTool["settle"];
    const done = new Promise<MachineToolOutcome>((resolve) => {
      settle = resolve;
    });
    this.pending.set(callId, {
      machineId: opts.machineId,
      connectionId: holder.conn_id,
      orgId: opts.orgId,
      settle: settle!,
    });
    let timer: NodeJS.Timeout | undefined;
    const cancel = () => {
      this.hub.sendMachineToolCancel(opts.machineId, opts.orgId, holder.conn_id, callId);
      settle!({ content: "machine tool cancelled", is_error: true, meta: null, images: [] });
    };
    try {
      const sent = this.hub.sendMachineToolDispatch(opts.machineId, opts.orgId, {
        type: "tool_dispatch",
        chat_id: opts.chatId,
        call_id: callId,
        name: opts.name,
        arguments: JSON.stringify(opts.args),
        ...(opts.workdir !== null ? { workdir: opts.workdir } : {}),
      });
      if (!sent) {
        return { content: "machine offline", is_error: true, meta: null, images: [] };
      }
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const timeout = new Promise<MachineToolOutcome>((resolve) => {
        timer = setTimeout(
          () => {
            this.hub.sendMachineToolCancel(opts.machineId, opts.orgId, holder.conn_id, callId);
            resolve({
              content: `client tool ${opts.name} (${callId}) timed out after ${Math.round(opts.timeoutMs / 1000)}s: no client result arrived`,
              is_error: true,
              meta: null,
              images: [],
            });
          },
          opts.timeoutMs,
        );
        timer.unref?.();
      });
      return await Promise.race([done, timeout]);
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.pending.delete(callId);
      clearTimeout(timer);
    }
  }

  /** Routes a machine's `tool_result` frame to its waiter (from the socket
   *  inbound path — the ctx.wsToolResult seam). Results from a connection
   *  that no longer holds the machine's slot, or unknown call ids, are
   *  dropped silently. */
  resolveToolResult(member: { conn_id: string; org_id: string }, frame: { call_id: string; content: string; is_error: boolean; meta: unknown; images: string[] }): boolean {
    const pending = this.pending.get(frame.call_id);
    if (!pending) return false;
    if (pending.connectionId !== member.conn_id || pending.orgId !== member.org_id) return false;
    this.pending.delete(frame.call_id);
    pending.settle({
      content: frame.content,
      is_error: frame.is_error,
      meta: frame.meta,
      images: frame.images,
    });
    return true;
  }

  /** The uncertain-execution sweep: pending
   *  dispatches of this machine whose recorded connection differs from the
   *  freshly connected one resolve as unknown-outcome errors — the result
   *  may have executed on the dead link, so retrying blind is unsafe. */
  reconcileMachine(machineId: string, connId: string): void {
    for (const [callId, pending] of this.pending) {
      if (pending.machineId !== machineId || pending.connectionId === connId) continue;
      this.pending.delete(callId);
      pending.settle({
        content:
          "Machine connection changed; execution outcome is unknown. Do not retry this action without checking its effects.",
        is_error: true,
        meta: null,
        images: [],
      });
    }
  }

  /** Every pending dispatch of one connection resolves when the slot
   *  unregisters (socket death → the watchers' unknown-outcome path). */
  unregisterConnection(connId: string): void {
    for (const [callId, pending] of this.pending) {
      if (pending.connectionId !== connId) continue;
      this.pending.delete(callId);
      pending.settle({
        content: "Machine connection changed; execution outcome is unknown. Do not retry this action without checking its effects.",
        is_error: true,
        meta: null,
        images: [],
      });
    }
  }
}

let dispatchForHost: WeakMap<MachineDispatchHost, MachineDispatch> | null = null;

/** The per-hub dispatch registry (hub-owned lifetime; one per process). */
export function machineDispatch(host: MachineDispatchHost): MachineDispatch {
  dispatchForHost ??= new WeakMap();
  let d = dispatchForHost.get(host);
  if (!d) {
    d = new MachineDispatch(host);
    dispatchForHost.set(host, d);
  }
  return d;
}

// ---------------------------------------------------------------------------
// The ExecutionEnv proxy
// ---------------------------------------------------------------------------

function fileErr(code: (typeof FileError.prototype)["code"], message: string, path?: string): Result<never, FileError> {
  return err(new FileError(code, message, path));
}

const RAW_READ_OP = "fs.read_raw_v1";
const RAW_STAT_OP = "fs.stat_v1";

/** The FileError code for a raw op failure code (`too_large` is an
 *  invalid request for this transport). */
function rawErrorCode(code: unknown): (typeof FileError.prototype)["code"] {
  switch (code) {
    case "not_found":
    case "permission_denied":
    case "is_directory":
    case "invalid":
      return code;
    case "too_large":
      return "invalid";
    default:
      return "unknown";
  }
}

/** Renders one argv element as a shell word: bare when plainly safe,
 *  double-quoted with backslash escapes otherwise. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+]+$/.test(arg)) return arg;
  return `"${arg.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export interface MachineEnvOptions {
  machineId: string;
  orgId: string;
  chatId: string;
  /** The project's workspace folder on the machine (null = no workspace:
   *  the executor errors the machine tools). */
  workdir: string | null;
  timeoutMs: number;
  dispatch: Pick<MachineDispatch, "dispatch">;
}

/** An ExecutionEnv whose file/shell operations run on the chat's bound
 *  desktop machine, through the hub's executor socket. */
export class MachineExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;

  constructor(private readonly options: MachineEnvOptions) {
    this.id = `machine:${options.machineId}`;
    this.cwd = options.workdir ?? "/";
  }

  private async runTool(name: string, args: Record<string, unknown>, context?: Context): Promise<MachineToolOutcome> {
    return this.options.dispatch.dispatch({
      machineId: this.options.machineId,
      orgId: this.options.orgId,
      chatId: this.options.chatId,
      name,
      args,
      workdir: this.options.workdir,
      timeoutMs: this.options.timeoutMs,
    }, context?.abortSignal);
  }

  async absolutePath(p: string): Promise<Result<string, FileError>> {
    return ok(p.startsWith("/") ? p : path.join(this.cwd, p));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(path.join(...parts));
  }

  /** One raw file op (`fs.read_raw_v1` / `fs.stat_v1`) and its decoded
   *  JSON payload. A failure carries `{code, message}`; an engine that
   *  predates the op answers "unknown tool", which fails as
   *  `not_supported` instead of falling back to the lossy `read_file`. */
  private async rawOp(op: typeof RAW_READ_OP | typeof RAW_STAT_OP, p: string, context: Context): Promise<Result<Record<string, unknown>, FileError>> {
    const outcome = await this.runTool(op, { path: p }, context);
    let payload: unknown;
    try {
      payload = JSON.parse(outcome.content);
    } catch {
      payload = undefined;
    }
    if (outcome.is_error) {
      if (/unknown tool/i.test(outcome.content)) {
        return fileErr("not_supported", `this machine's Guild engine cannot transfer files exactly (${op} missing); update the desktop app`, p);
      }
      const failure = (payload ?? {}) as { code?: unknown; message?: unknown };
      const message = typeof failure.message === "string" ? failure.message : outcome.content;
      return fileErr(rawErrorCode(failure.code), message, p);
    }
    if (payload === null || typeof payload !== "object") {
      return fileErr("unknown", `malformed ${op} result`, p);
    }
    return ok(payload as Record<string, unknown>);
  }

  private async readRaw(p: string, context: Context): Promise<Result<{ bytes: Uint8Array; mtimeMs: number }, FileError>> {
    const result = await this.rawOp(RAW_READ_OP, p, context);
    if (!result.ok) return result;
    const data = result.value.data_b64;
    if (typeof data !== "string") return fileErr("unknown", `malformed ${RAW_READ_OP} result`, p);
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    const mtime = result.value.mtime_ms;
    return ok({ bytes, mtimeMs: typeof mtime === "number" ? mtime : 0 });
  }

  async readTextFile(p: string, context: Context): Promise<Result<string, FileError>> {
    const raw = await this.readRaw(p, context);
    if (!raw.ok) return raw;
    try {
      return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.value.bytes));
    } catch {
      return fileErr("invalid", "file is not valid UTF-8 text", p);
    }
  }

  async openTextLineReader(p: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(p, context);
    if (!text.ok) return text;
    const lines = text.value === "" ? [] : text.value.split("\n");
    // A final newline terminates the last line; it does not open another.
    const endsTerminated = text.value.endsWith("\n");
    if (endsTerminated) lines.pop();
    let index = 0;
    const reader: TextLineReader = {
      async readLine(): Promise<Result<TextLine | undefined, FileError>> {
        if (index >= lines.length) return ok(undefined);
        const line = lines[index]!;
        index += 1;
        return ok({ text: line, terminated: index < lines.length || endsTerminated });
      },
      async close(): Promise<void> {},
    };
    return ok(reader);
  }

  async readTextLines(p: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(p, context);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    return ok(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines);
  }

  async readBinaryFile(p: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const raw = await this.readRaw(p, context);
    if (!raw.ok) return raw;
    return ok(raw.value.bytes);
  }

  /** Positional reads over one whole-file `fs.read_raw_v1` transfer (the
   *  machine has no paged op; `noFollow` has no channel in the wire
   *  contract — a final-component symlink is followed). */
  async openBinaryReader(p: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const raw = await this.readRaw(p, context);
    if (!raw.ok) return raw;
    const bytes = raw.value.bytes;
    const info: FileInfo = { name: path.basename(p), path: p, kind: "file", size: bytes.length, mtimeMs: raw.value.mtimeMs };
    const reader: BinaryReader = {
      info: async () => ok(info),
      read: async (offset, length) => {
        if (offset < 0 || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0) {
          return fileErr("invalid", "invalid binary read range", p);
        }
        if (offset >= bytes.length) return ok(new Uint8Array());
        return ok(bytes.slice(offset, Math.min(offset + length, bytes.length)));
      },
      scanLines: async (scanOptions) => {
        const scanner = new LineScanner(scanOptions.startLine, scanOptions.endLine);
        scanner.push(bytes);
        return ok(scanner.finish());
      },
      close: async () => {},
    };
    return ok(reader);
  }

  async openDirReader(): Promise<Result<DirReader, FileError>> {
    return fileErr("not_supported", "directory readers are not supported over machine dispatch");
  }

  async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
    return fileErr("not_supported", "watching is not supported over machine dispatch");
  }

  async writeFile(p: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    if (typeof content !== "string") {
      return fileErr("not_supported", "binary writes are not supported over machine dispatch", p);
    }
    const outcome = await this.runTool("write_file", { path: p, content }, _context);
    if (outcome.is_error) return fileErr("unknown", outcome.content, p);
    return ok(undefined);
  }

  async appendFile(): Promise<Result<void, FileError>> {
    return fileErr("not_supported", "append is not supported over machine dispatch");
  }

  async truncateFile(): Promise<Result<void, FileError>> {
    return fileErr("not_supported", "truncate is not supported over machine dispatch");
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return ok(undefined);
  }

  async renameFile(): Promise<Result<void, FileError>> {
    return fileErr("not_supported", "rename is not supported over machine dispatch");
  }

  async fileInfo(p: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const stat = await this.rawOp(RAW_STAT_OP, p, context);
    if (!stat.ok) return stat;
    const { exists, kind, size, mtime_ms } = stat.value;
    if (exists !== true) return fileErr("not_found", `${p}: no such file or directory`, p);
    if (kind !== "file" && kind !== "directory") return fileErr("invalid", `${p}: not a regular file or directory`, p);
    return ok({
      name: path.basename(p),
      path: p,
      kind,
      size: typeof size === "number" ? size : 0,
      mtimeMs: typeof mtime_ms === "number" ? mtime_ms : 0,
    });
  }

  async listDir(): Promise<Result<FileInfo[], FileError>> {
    return fileErr("not_supported", "directory listing is not supported over machine dispatch");
  }

  async canonicalPath(p: string): Promise<Result<string, FileError>> {
    return ok(p);
  }

  async exists(p: string, context: Context): Promise<Result<boolean, FileError>> {
    const stat = await this.rawOp(RAW_STAT_OP, p, context);
    if (!stat.ok) return stat;
    return ok(stat.value.exists === true);
  }

  async createDir(): Promise<Result<void, FileError>> {
    return fileErr("not_supported", "directory creation is not supported over machine dispatch");
  }

  async remove(): Promise<Result<void, FileError>> {
    return fileErr("not_supported", "remove is not supported over machine dispatch");
  }

  async createTempDir(): Promise<Result<string, FileError>> {
    return fileErr("not_supported", "temp dirs are not supported over machine dispatch");
  }

  async createTempFile(): Promise<Result<string, FileError>> {
    return fileErr("not_supported", "temp files are not supported over machine dispatch");
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, _context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (_context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const timeoutMs =
      options?.timeout !== undefined ? Math.min(Math.max(options.timeout * 1000, 1), DEFAULT_EXECUTE_TIMEOUT_MS) : DEFAULT_EXECUTE_TIMEOUT_MS;
    // The wire contract carries one shell command string; an argv array is
    // rendered into that shell's command line (guild tools never use the
    // argv form over machine dispatch).
    const line = typeof command === "string" ? command : command.map(shellQuote).join(" ");
    let streamed = 0;
    const outcome = await this.runTool("execute", { command: line, timeout_ms: timeoutMs }, _context);
    if (_context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    if (options?.onOutput !== undefined && outcome.content.length > streamed) {
      const info: ShellOutputInfo = { stream: "stdout" };
      options.onOutput(outcome.content, _context, info);
      streamed = outcome.content.length;
    }
    void streamed;
    if (outcome.is_error && /timed out/i.test(outcome.content)) {
      return err(new ExecutionError("timeout", outcome.content));
    }
    return ok({ exitCode: outcome.is_error ? 1 : 0 });
  }

  async cleanup(_context: Context): Promise<void> {}
}
