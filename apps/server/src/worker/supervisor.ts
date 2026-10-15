// The worker supervisor: the main server's one forker. A forked child owns
// one chat's conversation (its scoped harness, bridge, codemode sandbox);
// the supervisor routes admission + control over IPC. Workers are not
// idle-reaped in this milestone — they run until the server closes or die
// and get respawned while their journal slice still has pending work.
// Distributed placement later replaces fork() behind the same seam.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { WorkerMessage, WorkerRequest, WorkerResponse } from "./protocol.js";

const WORKER_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

/** Per-request IPC timeout: admission (configure + submit) normally takes
 *  well under a second; the ceiling only matters when a worker wedges, and
 *  the route's catch surfaces the failure (turn command marked failed). */
const REQUEST_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const HEARTBEAT_STALE_MS = 90_000;
/** Respawn backoff for a worker that died with pending work. */
const RESPAWN_DELAYS_MS = [1_000, 5_000, 30_000];

interface Handle {
  readonly chatId: string;
  child: ReturnType<typeof fork>;
  alive: boolean;
  lastBeat: number;
  nextRef: number;
  /** Requests sent before the ready handshake resolved. */
  readonly queued: WorkerRequest[];
  readonly waiters: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  respawns: number;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
}

/** Bun runs TypeScript natively and the production server runs under bun;
 *  in tests (node) the fork still needs bun for the TS entry. */
function workerExecPath(): string {
  const configured = process.env.GUILD_BUN_BIN;
  if (configured) return configured;
  if (process.execPath.includes("bun")) return process.execPath;
  return "bun";
}

/** The fork env: the server's own environment (config secrets, sandbox
 *  runner, gateway base URL) plus the worker's identity. Trusted fleet
 *  model — the worker holds the same credentials the server does. */
function workerEnv(config: Config, chatId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GUILD_DATABASE_URL: config.databaseUrl,
    GUILD_SELF_BASE_URL: config.selfBaseUrl,
    GUILD_S3_URL: config.s3Url,
    GUILD_S3_BUCKET: config.s3Bucket,
    GUILD_S3_ACCESS_KEY_ID: config.s3AccessKeyId,
    GUILD_S3_SECRET_ACCESS_KEY: config.s3SecretAccessKey,
    GUILD_DATA_DIR: config.dataDir,
    ...(config.execPolicyRulesPath ? { GUILD_EXEC_POLICY_RULES: config.execPolicyRulesPath } : {}),
    GUILD_SANDBOX: config.sandbox.mode,
    ...(config.sandbox.mode === "runner"
      ? { GUILD_SANDBOX_RUNNER_URL: config.sandbox.runnerUrl, GUILD_SANDBOX_RUNNER_TOKEN: config.sandbox.runnerToken }
      : {}),
    GUILD_ALLOW_SHELL_TOOLS: config.allowShellTools ? "1" : "0",
    GUILD_CLIENT_TOOL_TIMEOUT_MS: String(config.clientToolTimeoutMs),
    GUILD_APPROVAL_TIMEOUT_MS: String(config.approvalTimeoutMs),
    GUILD_LOG_LEVEL: config.logLevel,
    GUILD_WORKER_MODE: "off", // the worker itself must not spawn workers
    GUILD_WORKER_CHAT_ID: chatId,
    // Secrets + infra the Config parser requires (ambient env has them in
    // production; tests assemble config explicitly, so pass them through).
    GUILD_MASTER_KEY_HEX: config.masterKeyHex,
    GUILD_JWT_SECRET: config.jwtSecret,
    ...(config.internalKey ? { GUILD_INTERNAL_KEY: config.internalKey } : {}),
    GUILD_API_URL: config.apiUrl,
    GUILD_CLICKHOUSE_URL: config.clickhouseUrl,
    GUILD_CLICKHOUSE_DATABASE: config.clickhouseDatabase,
    GUILD_CLICKHOUSE_USER: config.clickhouseUser,
    GUILD_CLICKHOUSE_PASSWORD: config.clickhousePassword,
    GUILD_POOL_MAX: "4",
    ...(config.tracePayloads ? { GUILD_TRACE_PAYLOADS: "1" } : {}),
  };
}

export type WithoutRef<T> = T extends { ref: number } ? Omit<T, "ref"> : never;

export class ForkSupervisor {
  private readonly handles = new Map<string, Handle>();
  private heartbeatSweeper: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    /** Pending-work probe for respawn decisions: does the chat's
     *  conversation still have live tasks or queued submissions? */
    private readonly hasPendingWork: (chatId: string) => Promise<boolean>,
  ) {}

  private startHeartbeatSweeper(): void {
    if (this.heartbeatSweeper) return;
    this.heartbeatSweeper = setInterval(() => {
      for (const handle of this.handles.values()) {
        if (Date.now() - handle.lastBeat > HEARTBEAT_STALE_MS) {
          this.log.warn({ chatId: handle.chatId }, "worker heartbeat stale; killing for respawn");
          handle.child.kill("SIGKILL");
        }
      }
    }, 30_000);
    this.heartbeatSweeper.unref();
  }

  /** The live worker for a chat, forked on first touch. Admission sent
   *  before the ready handshake queues and flushes on ready. */
  private async ensureWorker(chatId: string): Promise<Handle> {
    const existing = this.handles.get(chatId);
    if (existing && existing.alive) return existing;
    if (this.closed) throw new Error("supervisor is closed");
    this.startHeartbeatSweeper();

    const handle: Handle = {
      chatId,
      child: fork(WORKER_ENTRY, [], {
        execPath: workerExecPath(),
        env: workerEnv(this.config, chatId) as NodeJS.ProcessEnv,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: [],
      }),
      alive: true,
      lastBeat: Date.now(),
      nextRef: 1,
      queued: [],
      waiters: new Map(),
      respawns: 0,
      resolveReady: () => {},
      rejectReady: () => {},
      readySettled: false,
    };
    const ready = new Promise<void>((resolve, reject) => {
      handle.resolveReady = () => {
        if (!handle.readySettled) {
          handle.readySettled = true;
          resolve();
        }
      };
      handle.rejectReady = (error) => {
        if (!handle.readySettled) {
          handle.readySettled = true;
          reject(error);
        }
      };
    });
    this.handles.set(chatId, handle);

    const readyTimer = setTimeout(
      () => handle.rejectReady(new Error("worker did not become ready in time")),
      READY_TIMEOUT_MS,
    );
    readyTimer.unref?.();
    void ready.catch(() => {});

    handle.child.on("message", (raw: unknown) => this.onMessage(handle, raw));
    handle.child.on("error", (error) => {
      this.log.error({ err: error, chatId }, "worker spawn failed");
      handle.rejectReady(error);
    });
    handle.child.on("exit", (code, signal) => {
      handle.alive = false;
      clearTimeout(readyTimer);
      handle.rejectReady(new Error(`worker exited (code ${code ?? "null"}, signal ${signal ?? "null"}) before ready`));
      if (this.handles.get(chatId) === handle) this.handles.delete(chatId);
      for (const waiter of handle.waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("worker exited with a request in flight"));
      }
      handle.waiters.clear();
      void this.onWorkerDeath(chatId, handle);
    });

    await ready;
    return handle;
  }

  private onMessage(handle: Handle, raw: unknown): void {
    const message = raw as WorkerMessage;
    if (!message || typeof message !== "object" || !("t" in message)) return;
    if (message.t === "ready") {
      handle.lastBeat = Date.now();
      const queued = handle.queued.splice(0);
      handle.resolveReady();
      for (const request of queued) this.send(handle, request);
      return;
    }
    if (message.t === "heartbeat") {
      handle.lastBeat = Date.now();
      return;
    }
    if (message.t === "result") {
      const waiter = handle.waiters.get(message.ref);
      if (!waiter) return;
      handle.waiters.delete(message.ref);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.data);
      else waiter.reject(new Error(message.error));
    }
  }

  /** The journal decides respawn: a dead worker whose conversation still
   *  has pending work gets one, with backoff; an idle worker just stays
   *  dead until the next touch. */
  private async onWorkerDeath(chatId: string, handle: Handle): Promise<void> {
    if (this.closed) return;
    if (!(await this.hasPendingWork(chatId).catch(() => false))) return;
    const delay = RESPAWN_DELAYS_MS[Math.min(handle.respawns, RESPAWN_DELAYS_MS.length - 1)]!;
    handle.respawns++;
    this.log.warn({ chatId, delayMs: delay }, "worker died with pending work; respawning");
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.closed) return;
    try {
      await this.ensureWorker(chatId);
    } catch (error) {
      this.log.error({ err: error, chatId }, "worker respawn failed");
      void this.onWorkerDeath(chatId, handle);
    }
  }

  private send(handle: Handle, request: WorkerRequest): void {
    if (!handle.child.connected) {
      const waiter = handle.waiters.get(request.ref);
      if (waiter) {
        handle.waiters.delete(request.ref);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("worker channel is closed"));
      }
      return;
    }
    handle.child.send(request);
  }

  private async request<T>(chatId: string, msg: WithoutRef<WorkerRequest>): Promise<T> {
    const handle = await this.ensureWorker(chatId);
    const ref = handle.nextRef++;
    const full = { ...msg, ref } as WorkerRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.waiters.delete(ref);
        reject(new Error("worker request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      handle.waiters.set(ref, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (handle.readySettled) this.send(handle, full);
      else handle.queued.push(full);
    });
  }

  /** Routes a turn admission into the chat's worker; resolves with the
   *  submission id. */
  submit(chatId: string, input: Extract<WorkerRequest, { t: "submit" }>["input"]): Promise<number> {
    return this.request<number>(chatId, { t: "submit", input });
  }

  withdraw(chatId: string, submissionId: number): Promise<string> {
    return this.request<string>(chatId, { t: "withdraw", submissionId });
  }

  stop(chatId: string): Promise<void> {
    return this.request<void>(chatId, { t: "stop" });
  }

  compact(chatId: string): Promise<boolean> {
    return this.request<boolean>(chatId, { t: "compact" });
  }

  /** Boot recovery: fork workers for every chat whose conversation still
   *  has pending work. This replaces the in-process resume()-everything —
   *  the journal is the registry. */
  async recoverFromJournal(chats: Iterable<{ chatId: string }>): Promise<void> {
    for (const { chatId } of chats) {
      await this.ensureWorker(chatId).catch((error) =>
        this.log.error({ err: error, chatId }, "boot worker spawn failed"),
      );
    }
  }

  /** Test/ops accessor: the worker child's pid, when one is live. */
  pidOf(chatId: string): number | undefined {
    return this.handles.get(chatId)?.child.pid;
  }

  /** Kills every worker (SIGTERM → the worker closes its scoped harness
   *  cleanly, leaving pending work pending) and stops the sweeper. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatSweeper) clearInterval(this.heartbeatSweeper);
    const children = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(
      children.map(
        (handle) =>
          new Promise<void>((resolve) => {
            if (!handle.alive) return resolve();
            const killer = setTimeout(() => {
              handle.child.kill("SIGKILL");
              resolve();
            }, 5_000);
            handle.child.once("exit", () => {
              clearTimeout(killer);
              resolve();
            });
            handle.child.kill("SIGTERM");
          }),
      ),
    );
  }
}

/** The pending-work probe the supervisor needs: live tasks or queued
 *  submissions on the chat's conversation. */
export function pendingWorkQuery(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
): (chatId: string) => Promise<boolean> {
  return async (chatId) => {
    const res = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM chat_conversations c
         WHERE c.chat_id = $1 AND (
           EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id = c.conversation_id AND t.status IN ('pending', 'running', 'waiting'))
           OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id = c.conversation_id AND s.status = 'queued')
         )
       ) AS pending`,
      [chatId],
    );
    return res.rows[0]?.pending === true;
  };
}

export type { WorkerResponse };
