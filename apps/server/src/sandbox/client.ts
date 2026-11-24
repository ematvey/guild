// The server's side of the sandbox runner: ensure calls over HTTP, agent
// connections over WebSocket, and a pool of SandboxExecutionEnvs keyed by
// sandbox (one per workspace session or plain chat).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Logger } from "pino";
import WebSocket from "ws";
import { SandboxExecutionEnv } from "./env.js";
import type { Wire } from "./protocol.js";

/** Ceiling on the attach handshake: the runner answers an upgrade as soon as
 *  the agent exec starts, so a longer wait means the runner or Docker is
 *  wedged. A bounded failure ends the tool call instead of the turn. */
const ATTACH_TIMEOUT_MS = 30_000;

/** A failed runner call, carrying its status: 503 means the runner is
 *  replacing a sandbox or restarting itself, and one retry is worth it. */
export class SandboxRunnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface SandboxTarget {
  /** Stable identity for a Workspace session, plain chat, or Agent sandbox scope. */
  key: string;
  /** The workspace dir on the data volume, relative to its root. */
  subpath: string;
}

export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly attachTimeoutMs: number = ATTACH_TIMEOUT_MS,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async health(): Promise<{ runtime: string; image: string; network: string }> {
    const res = await fetch(`${this.baseUrl}/v1/healthz`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`sandbox runner health: ${res.status}`);
    return (await res.json()) as { runtime: string; image: string; network: string };
  }

  async ensure(target: SandboxTarget): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
    if (!res.ok || typeof body.name !== "string") {
      throw new SandboxRunnerError(`sandbox ensure failed: ${body.error ?? res.status}`, res.status);
    }
    return body.name;
  }

  /** Removes the sandbox container for a key, if one exists. */
  async remove(key: string): Promise<void> {
    const signal = AbortSignal.timeout(30_000);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/v1/sandboxes?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: this.headers(),
        signal,
      });
      await res.body?.cancel();
      if (res.ok || res.status === 404) return;
      // The runner may still be accounting for the connection we just closed.
      if (res.status !== 409 || attempt === 10) {
        throw new SandboxRunnerError(`sandbox remove failed: ${res.status}`, res.status);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Opens an agent connection; resolves once the socket is open. */
  connect(name: string): Promise<Wire> {
    const url = `${this.baseUrl.replace(/^http/, "ws")}/v1/sandboxes/${name}/rpc`;
    const ws = new WebSocket(url, { headers: this.headers(), maxPayload: 256 * 1024 * 1024 });
    return new Promise<Wire>((resolve, reject) => {
      const frameListeners: Array<(frame: string) => void> = [];
      const closeListeners: Array<(error?: Error) => void> = [];
      let closed = false;
      let opened = false;
      const timer = setTimeout(
        () => fail(new SandboxRunnerError(`sandbox attach timed out after ${this.attachTimeoutMs} ms`, 0)),
        this.attachTimeoutMs,
      );
      timer.unref?.();
      /** Settles the open promise exactly once. The socket is terminated, so
       *  an upgrade that never answers cannot leave the caller waiting. */
      const fail = (error: Error) => {
        if (opened || closed) return;
        closed = true;
        clearTimeout(timer);
        reject(error);
        ws.terminate();
      };
      const end = (error?: Error) => {
        if (closed) return;
        closed = true;
        for (const l of closeListeners) l(error);
      };
      ws.on("message", (data) => {
        const frame = data.toString();
        for (const l of frameListeners) l(frame);
      });
      // ws reports a refused or aborted handshake as `error` with the socket
      // already CLOSING, so the ready state cannot decide this.
      ws.on("close", () => {
        fail(new SandboxRunnerError("sandbox attach closed before it opened", 0));
        end();
      });
      ws.on("error", (error) => {
        fail(error instanceof SandboxRunnerError ? error : new SandboxRunnerError(error.message, 0));
        end(error);
      });
      ws.on("unexpected-response", (_req, res) =>
        fail(new SandboxRunnerError(`sandbox attach failed: ${res.statusCode}`, res.statusCode ?? 0)),
      );
      ws.on("open", () => {
        opened = true;
        clearTimeout(timer);
        resolve({
          send: (frame) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(frame);
          },
          onFrame: (l) => frameListeners.push(l),
          onClose: (l) => closeListeners.push(l),
          close: () => ws.close(),
        });
      });
    });
  }
}

interface PoolEntry {
  env: SandboxExecutionEnv;
  lastUsed: number;
}

/** 503 is the runner replacing a sandbox or restarting itself; a refused or
 *  reset connection is it restarting. A timeout means it is wedged, and a
 *  retry would only repeat the wait. */
function recoverable(error: unknown): boolean {
  if (error instanceof SandboxRunnerError) return error.status === 503;
  const code = ((error as { cause?: NodeJS.ErrnoException }).cause ?? (error as NodeJS.ErrnoException)).code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE";
}

export interface SandboxPoolOptions {
  runner: RunnerClient;
  log: Logger;
  /** Called once per fresh agent connection, before the first call runs
   *  (turn-start skill materialization). Errors are logged, not thrown. */
  onConnected?: (target: SandboxTarget, env: SandboxExecutionEnv) => Promise<void>;
  /** Drop a pooled connection after this long unused (the runner then
   *  counts the sandbox idle and stops it on its own schedule). */
  idleMs?: number;
}

export class SandboxPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly idleMs: number;

  constructor(private readonly options: SandboxPoolOptions) {
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.sweeper = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
    this.sweeper.unref();
  }

  envFor(target: SandboxTarget): SandboxExecutionEnv {
    let entry = this.entries.get(target.key);
    if (entry === undefined) {
      const env: SandboxExecutionEnv = new SandboxExecutionEnv({
        id: `sandbox:${target.key}`,
        cwd: "/workspace",
        connect: () => this.attach(target),
        onConnected: async () => {
          try {
            await this.options.onConnected?.(target, env);
          } catch (error) {
            this.options.log.warn({ err: error, key: target.key }, "sandbox connect hook failed");
          }
        },
      });
      entry = { env, lastUsed: Date.now() };
      this.entries.set(target.key, entry);
    }
    entry.lastUsed = Date.now();
    return entry.env;
  }

  /** Opens the agent wire. A 503 means the runner is replacing a sandbox
   *  whose workspace mount died, or restarting after a volume remount; both
   *  heal on their own, so a few retries ride it out. */
  private async attach(target: SandboxTarget): Promise<Wire> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.options.runner.connect(await this.options.runner.ensure(target));
      } catch (error) {
        if (attempt >= 3 || !recoverable(error)) throw error;
        this.options.log.warn({ err: error, key: target.key, attempt }, "sandbox runner is recovering; retrying");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.env.busy) {
        entry.lastUsed = now;
        continue;
      }
      if (now - entry.lastUsed > this.idleMs) {
        entry.env.disconnect();
        this.entries.delete(key);
      }
    }
  }

  /** Drops the pooled connection and removes the sandbox container (its
   *  workspace files stay on the volume). */
  async remove(target: SandboxTarget): Promise<void> {
    this.entries.get(target.key)?.env.disconnect();
    this.entries.delete(target.key);
    try {
      await this.options.runner.remove(target.key);
    } catch (error) {
      this.options.log.warn({ err: error, key: target.key }, "sandbox remove failed");
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const entry of this.entries.values()) {
      await entry.env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
      entry.env.disconnect();
    }
    this.entries.clear();
  }
}
