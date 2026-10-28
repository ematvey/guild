// The agent side of the sandbox RPC: serves one ExecutionEnv over a Wire.
// Runs inside the sandbox container (sandbox/agent.ts) and in-process in
// tests.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { err, FileError, type ExecutionEnv, type Result, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import {
  HANDLE_METHODS,
  HANDLE_RETURNING_METHODS,
  PLAIN_METHODS,
  decodeValue,
  encodeValue,
  sanitizeText,
  type SandboxAgentFrame,
  type SandboxClientFrame,
  type HandleKind,
  type HandleRef,
  type Wire,
} from "./protocol.js";

interface HandleEntry {
  kind: HandleKind;
  target: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

/** Serves `env` on `wire` until the wire closes; then closes every open
 *  handle and kills the env's running commands. */
export function serveEnv(env: ExecutionEnv, wire: Wire): Promise<void> {
  const inflight = new Map<number, AbortController>();
  const handles = new Map<number, HandleEntry>();
  let nextHandle = 1;
  const plain = new Set<string>(PLAIN_METHODS);

  const send = (frame: SandboxAgentFrame) => wire.send(JSON.stringify(frame));

  const contextFor = (id: number): Context => {
    const controller = new AbortController();
    inflight.set(id, controller);
    return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  };

  const register = (kind: HandleKind, target: unknown): HandleRef => {
    const id = nextHandle++;
    handles.set(id, { kind, target: target as HandleEntry["target"] });
    const ref: HandleRef = { $h: id, kind };
    if (kind === "watcher") ref.mode = (target as { mode: "native" | "polling" }).mode;
    return ref;
  };

  const call = async (id: number, method: string, rawArgs: unknown[], context: Context): Promise<unknown> => {
    const args = rawArgs.map(decodeValue);
    if (method.startsWith("h.")) {
      const name = method.slice(2);
      const handleId = args[0] as number;
      const entry = handles.get(handleId);
      if (entry === undefined || !HANDLE_METHODS[entry.kind].includes(name)) {
        throw new Error(`unknown handle method ${method} on ${handleId}`);
      }
      const result = await entry.target[name]!.call(entry.target, ...args.slice(1), context);
      // A closed handle answers later calls itself (use-after-close errors,
      // idempotent close) for a while, then is forgotten.
      if (name === "close") setTimeout(() => handles.delete(handleId), 60_000).unref();
      return result;
    }
    if (method === "exec") {
      const [command, options] = args as [string | string[], (Omit<ShellExecOptions, "onOutput"> & { onOutput?: boolean }) | undefined];
      const forwarded: ShellExecOptions | undefined = options === undefined ? undefined : { ...options, onOutput: undefined };
      if (options?.onOutput === true) {
        forwarded!.onOutput = (text, _context, info) =>
          send({ t: "output", id, text: sanitizeText(text), info: encodeValue(info) });
      }
      return env.exec(command, forwarded, context);
    }
    if (method === "watch") {
      const [targets] = args as [Parameters<ExecutionEnv["watch"]>[0]];
      const result = await env.watch(targets, (change) => send({ t: "watch", id, change: encodeValue(change) }), context);
      return result.ok ? { ok: true, value: register("watcher", result.value) } : result;
    }
    if (method === "cleanup") {
      await env.cleanup(context);
      return undefined;
    }
    if (method in HANDLE_RETURNING_METHODS) {
      const fn = (env as unknown as Record<string, (...a: unknown[]) => Promise<Result<unknown, unknown>>>)[method]!;
      const result = await fn.call(env, ...args, context);
      return result.ok ? { ok: true, value: register(HANDLE_RETURNING_METHODS[method]!, result.value) } : result;
    }
    if (plain.has(method)) {
      const fn = (env as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[method];
      if (fn === undefined) {
        // Optional members (listFiles) report not_supported, per the contract.
        return err(new FileError("not_supported", `${method} is not supported`));
      }
      return fn.call(env, ...args, context);
    }
    if (method === "setCwd") {
      env.cwd = args[0] as string;
      return undefined;
    }
    throw new Error(`unknown method ${method}`);
  };

  wire.onFrame((raw) => {
    let frame: SandboxClientFrame;
    try {
      frame = JSON.parse(raw) as SandboxClientFrame;
    } catch {
      return;
    }
    if (frame.t === "cancel") {
      inflight.get(frame.id)?.abort(new Error("cancelled by client"));
      return;
    }
    if (frame.t !== "call") return;
    const context = contextFor(frame.id);
    call(frame.id, frame.m, frame.a, context)
      .then(
        (r) => send({ t: "result", id: frame.id, r: encodeValue(r) }),
        (error: unknown) => send({ t: "throw", id: frame.id, message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => inflight.delete(frame.id));
  });

  return new Promise((resolve) => {
    wire.onClose(() => {
      for (const controller of inflight.values()) controller.abort(new Error("connection closed"));
      const closing = [...handles.values()].map((entry) =>
        entry.target["close"]!.call(entry.target, BACKGROUND_CONTEXT).catch(() => {}),
      );
      handles.clear();
      void Promise.all(closing)
        .then(() => env.cleanup(BACKGROUND_CONTEXT))
        .catch(() => {})
        .finally(() => resolve());
    });
  });
}
