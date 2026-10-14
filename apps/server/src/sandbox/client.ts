// The server's side of the sandbox runner: ensure calls over HTTP, agent
// connections over WebSocket, and a pool of SandboxExecutionEnvs keyed by
// sandbox (one per workspace session or plain chat).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Logger } from "pino";
import WebSocket from "ws";
import { SandboxExecutionEnv } from "./env.js";
import type { Wire } from "./protocol.js";

export interface SandboxTarget {
  /** Stable sandbox identity: `ws:<org>:<name>` or `chat:<org>:<conversationId>`. */
  key: string;
  /** The workspace dir on the data volume, relative to its root. */
  subpath: string;
}

export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async health(): Promise<{ runtime: string; image: string; network: string }> {
    const res = await fetch(`${this.baseUrl}/v1/healthz`, { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
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
    if (!res.ok || typeof body.name !== "string") throw new Error(`sandbox ensure failed: ${body.error ?? res.status}`);
    return body.name;
  }

  /** Removes the sandbox container for a key, if one exists. */
  async remove(key: string): Promise<void> {
    await fetch(`${this.baseUrl}/v1/sandboxes?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /** Opens an agent connection; resolves once the socket is open. */
  connect(name: string): Promise<Wire> {
    const url = `${this.baseUrl.replace(/^http/, "ws")}/v1/sandboxes/${name}/rpc`;
    const ws = new WebSocket(url, { headers: this.headers(), maxPayload: 256 * 1024 * 1024 });
    return new Promise<Wire>((resolve, reject) => {
      const frameListeners: Array<(frame: string) => void> = [];
      const closeListeners: Array<(error?: Error) => void> = [];
      let closed = false;
      const end = (error?: Error) => {
        if (closed) return;
        closed = true;
        for (const l of closeListeners) l(error);
      };
      ws.on("message", (data) => {
        const frame = data.toString();
        for (const l of frameListeners) l(frame);
      });
      ws.on("close", () => end());
      ws.on("error", (error) => {
        if (ws.readyState === WebSocket.CONNECTING) reject(error);
        end(error);
      });
      ws.on("unexpected-response", (_req, res) => {
        reject(new Error(`sandbox attach failed: ${res.statusCode}`));
        ws.terminate();
      });
      ws.on("open", () =>
        resolve({
          send: (frame) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(frame);
          },
          onFrame: (l) => frameListeners.push(l),
          onClose: (l) => closeListeners.push(l),
          close: () => ws.close(),
        }),
      );
    });
  }
}

interface PoolEntry {
  env: SandboxExecutionEnv;
  lastUsed: number;
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
        connect: async () => {
          const name = await this.options.runner.ensure(target);
          return this.options.runner.connect(name);
        },
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
