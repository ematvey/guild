// SandboxExecutionEnv: an ExecutionEnv whose every member runs in a sandbox
// container, through the agent behind a Wire (sandbox/serve.ts on the far
// end). The wire is opened lazily and reopened on the next call after it
// drops; calls in flight when it drops fail as "connection lost".

import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  FileError,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileListing,
  type FileWatcher,
  type LineScan,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputInfo,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { decodeValue, encodeValue, type SandboxAgentFrame, type SandboxClientFrame, type HandleRef, type Wire } from "./protocol.js";

type Lost = "file" | "exec" | "void";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  lost: Lost;
  onOutput?: (text: string, info: ShellOutputInfo) => void;
}

const LOST_MESSAGE = "sandbox connection lost; outcome unknown";

function lostValue(kind: Lost): unknown {
  if (kind === "file") return err(new FileError("unknown", LOST_MESSAGE));
  if (kind === "exec") return err(new ExecutionError("unknown", LOST_MESSAGE));
  return undefined;
}

function abortedValue(kind: Exclude<Lost, "void">): unknown {
  if (kind === "file") return err(new FileError("aborted", "aborted"));
  return err(new ExecutionError("aborted", "aborted"));
}

/** One live wire plus its pending calls. A new Connection replaces it after
 *  a drop; handles opened on a dead connection fail their calls. */
class Connection {
  private nextId = 1;
  readonly pending = new Map<number, Pending>();
  readonly watchers = new Map<number, (change: WatchChange) => void>();
  closed = false;

  constructor(readonly wire: Wire) {
    wire.onFrame((raw) => this.onFrame(raw));
    wire.onClose(() => this.onClose());
  }

  private onFrame(raw: string): void {
    let frame: SandboxAgentFrame;
    try {
      frame = JSON.parse(raw) as SandboxAgentFrame;
    } catch {
      return;
    }
    if (frame.t === "output") {
      this.pending.get(frame.id)?.onOutput?.(frame.text, decodeValue(frame.info) as ShellOutputInfo);
      return;
    }
    if (frame.t === "watch") {
      this.watchers.get(frame.id)?.(decodeValue(frame.change) as WatchChange);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    this.pending.delete(frame.id);
    if (frame.t === "result") pending.resolve(decodeValue(frame.r));
    else pending.reject(new Error(`sandbox: ${frame.message}`));
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.resolve(lostValue(pending.lost));
    this.pending.clear();
    for (const listener of this.watchers.values()) {
      listener({ error: new FileError("unknown", LOST_MESSAGE) });
    }
    this.watchers.clear();
  }

  call(
    method: string,
    args: unknown[],
    context: Context,
    lost: Lost,
    hooks: { onOutput?: Pending["onOutput"]; onSent?: (id: number) => void } = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.resolve(lostValue(lost));
    const signal = context.abortSignal;
    // An already-aborted context fails before any work, as in the local env;
    // sending it would race the cancel frame against the call.
    if (signal?.aborted && lost !== "void") return Promise.resolve(abortedValue(lost));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => this.send({ t: "cancel", id });
      const done = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
        lost,
        onOutput: hooks.onOutput,
      });
      this.send({ t: "call", id, m: method, a: args.map(encodeValue) });
      hooks.onSent?.(id);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  send(frame: SandboxClientFrame): void {
    if (!this.closed) this.wire.send(JSON.stringify(frame));
  }
}

export interface SandboxEnvOptions {
  /** Stable id of the file namespace (one per sandbox). */
  id: string;
  /** The working directory inside the sandbox. */
  cwd: string;
  /** Opens a fresh wire to the sandbox's agent. */
  connect: () => Promise<Wire>;
  /** Runs on each fresh connection before any queued call; may use the env. */
  onConnected?: () => Promise<void>;
}

export class SandboxExecutionEnv implements ExecutionEnv {
  readonly id: string;
  private currentCwd: string;
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;

  constructor(private readonly options: SandboxEnvOptions) {
    this.id = options.id;
    this.currentCwd = options.cwd;
  }

  get cwd(): string {
    return this.currentCwd;
  }

  set cwd(value: string) {
    this.currentCwd = value;
    if (this.connection !== null && !this.connection.closed) {
      this.connection.send({ t: "call", id: 0, m: "setCwd", a: [value] });
    }
  }

  /** Calls in flight or watchers open on the current connection. */
  get busy(): boolean {
    const c = this.connection;
    return c !== null && !c.closed && (c.pending.size > 0 || c.watchers.size > 0);
  }

  /** Closes the current wire (the agent kills its commands on close). */
  disconnect(): void {
    this.connection?.wire.close();
    this.connection = null;
  }

  private async conn(): Promise<Connection> {
    if (this.connection !== null && !this.connection.closed) return this.connection;
    this.connecting ??= (async () => {
      try {
        const connection = new Connection(await this.options.connect());
        connection.send({ t: "call", id: 0, m: "setCwd", a: [this.currentCwd] });
        this.connection = connection;
        await this.options.onConnected?.();
        return connection;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** The connection, but a caller that aborts stops waiting for it. Opening
   *  a sandbox waits on the runner and Docker, and neither can be cancelled;
   *  the shared connect keeps running and its result serves the next call. */
  private async connFor(context: Context): Promise<Connection> {
    const signal = context.abortSignal;
    if (signal === undefined) return this.conn();
    if (signal.aborted) throw new Error("aborted");
    return await new Promise<Connection>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.conn().then(
        (connection) => {
          signal.removeEventListener("abort", onAbort);
          resolve(connection);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async fileCall<T>(method: string, args: unknown[], context: Context): Promise<Result<T, FileError>> {
    let connection: Connection;
    try {
      connection = await this.connFor(context);
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
      return err(new FileError("unknown", `sandbox unavailable: ${(error as Error).message}`));
    }
    return (await connection.call(method, args, context, "file")) as Result<T, FileError>;
  }

  private async handleCall<T>(method: string, args: unknown[], context: Context): Promise<Result<T, FileError>> {
    let connection: Connection;
    try {
      connection = await this.connFor(context);
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
      return err(new FileError("unknown", `sandbox unavailable: ${(error as Error).message}`));
    }
    const result = (await connection.call(method, args, context, "file")) as Result<HandleRef, FileError>;
    if (!result.ok) return result;
    return { ok: true, value: this.proxy(connection, result.value) as T };
  }

  private proxy(connection: Connection, ref: HandleRef): unknown {
    // The agent's handle methods return exactly what the reader interfaces
    // promise; the wire value is typed per member below.
    const h = (method: string, args: unknown[], context: Context, lost: Lost): Promise<any> =>
      connection.call(`h.${method}`, [ref.$h, ...args], context, lost);
    switch (ref.kind) {
      case "textLineReader":
        return {
          readLine: (context: Context) => h("readLine", [], context, "file"),
          close: async (context: Context) => void (await h("close", [], context, "void")),
        } satisfies TextLineReader as TextLineReader;
      case "binaryReader":
        return {
          info: (context: Context) => h("info", [], context, "file"),
          read: (offset: number, length: number, context: Context) => h("read", [offset, length], context, "file"),
          scanLines: (options: { startLine: number; endLine?: number }, context: Context) =>
            h("scanLines", [options], context, "file"),
          close: async (context: Context) => void (await h("close", [], context, "void")),
        } as BinaryReader;
      case "dirReader":
        return {
          next: (maxEntries: number, context: Context) => h("next", [maxEntries], context, "file"),
          close: async (context: Context) => void (await h("close", [], context, "void")),
        } as DirReader;
      case "watcher":
        return {
          mode: ref.mode ?? "native",
          close: async (context: Context) => {
            await h("close", [], context, "void");
          },
        } satisfies FileWatcher as FileWatcher;
    }
  }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("absolutePath", [path], context);
  }
  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("joinPath", [parts], context);
  }
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("readTextFile", [path], context);
  }
  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.handleCall("openTextLineReader", [path], context);
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.fileCall("readTextLines", [path, options], context);
  }
  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.fileCall("readBinaryFile", [path], context);
  }
  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.handleCall("openBinaryReader", [path, options], context);
  }
  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("writeFile", [path, content], context);
  }
  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("appendFile", [path, content], context);
  }
  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("truncateFile", [path, size], context);
  }
  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("flushFile", [path], context);
  }
  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("renameFile", [sourcePath, destinationPath], context);
  }
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.fileCall("fileInfo", [path], context);
  }
  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.fileCall("listDir", [path], context);
  }
  listFiles(path: string, options: ListFilesOptions | undefined, context: Context): Promise<Result<FileListing, FileError>> {
    return this.fileCall("listFiles", [path, options], context);
  }
  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.handleCall("openDirReader", [path], context);
  }
  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    let connection: Connection;
    try {
      connection = await this.connFor(context);
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
      return err(new FileError("unknown", `sandbox unavailable: ${(error as Error).message}`));
    }
    let callId = 0;
    const result = (await connection.call("watch", [targets], context, "file", {
      onSent: (id) => {
        callId = id;
        connection.watchers.set(id, onChange);
      },
    })) as Result<HandleRef, FileError>;
    if (!result.ok) {
      connection.watchers.delete(callId);
      return result;
    }
    const watcher = this.proxy(connection, result.value) as FileWatcher;
    return {
      ok: true,
      value: {
        mode: watcher.mode,
        close: async (closeContext: Context) => {
          connection.watchers.delete(callId);
          await watcher.close(closeContext);
        },
      },
    };
  }
  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("canonicalPath", [path], context);
  }
  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.fileCall("exists", [path], context);
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("createDir", [path, options], context);
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall("remove", [path, options], context);
  }
  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("createTempDir", [prefix], context);
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("createTempFile", [options], context);
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    let connection: Connection;
    try {
      connection = await this.connFor(context);
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      return err(new ExecutionError("shell_unavailable", `sandbox unavailable: ${(error as Error).message}`));
    }
    const { onOutput, ...rest } = options ?? {};
    let callbackError: Error | undefined;
    let callId = 0;
    const wireOptions = options === undefined ? undefined : { ...rest, onOutput: onOutput !== undefined };
    const result = (await connection.call("exec", [command, wireOptions], context, "exec", {
      onSent: (id) => {
        callId = id;
      },
      onOutput:
        onOutput === undefined
          ? undefined
          : (text, info) => {
              if (callbackError !== undefined) return;
              try {
                onOutput(text, context, info);
              } catch (error) {
                callbackError = error instanceof Error ? error : new Error(String(error));
                connection.send({ t: "cancel", id: callId });
              }
            },
    })) as Result<ShellExecResult, ExecutionError>;
    if (callbackError !== undefined) {
      const error = new ExecutionError("callback_error", `output callback failed: ${callbackError.message}`, callbackError);
      if (!result.ok && result.error.spillPath !== undefined) error.spillPath = result.error.spillPath;
      return err(error);
    }
    return result;
  }

  async cleanup(context: Context): Promise<void> {
    if (this.connection === null || this.connection.closed) return;
    await this.connection.call("cleanup", [], context, "void");
  }
}

export type { LineScan, TextLine };
