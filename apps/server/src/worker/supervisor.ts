// The worker supervisor: the main server's one forker. A forked child owns
// one chat's conversation (its scoped harness, bridge, codemode sandbox);
// the supervisor routes admission + control over IPC. Workers are
// reaped after idle work completes; crashed owners resume from the journal.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { workerConfigEnv, type Config } from "../config.js";
import type { MachineToolOutcome } from "../machines/dispatch.js";
import type { SubmitTurnInput } from "../harness/turn-backend.js";
import {
  failure,
  failureError,
  type MachineDispatchCall,
  type Outcome,
  type ServerReply,
  type ServerRequest,
  type WorkerToServer,
} from "./protocol.js";
import type { GenerationStreamSink, LiveBuffers } from "../chats/bridge.js";

const WORKER_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

/** Per-request IPC timeout: admission (configure + submit) normally takes
 *  well under a second; the ceiling only matters when a worker wedges, and
 *  the route's catch surfaces the failure (turn command marked failed). */
const REQUEST_TIMEOUT_MS = 120_000;
/** A stop is the user asking for the turn to end; a tool that cannot be
 *  cancelled must not keep the chat generating. Past this wait the worker is
 *  killed and its respawn commits the abort from the journal. */
const STOP_SETTLE_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 60_000;

/** A request that outlived its timeout; the caller decides whether to give up
 *  on the worker or to keep it. */
class WorkerRequestTimeout extends Error {
  constructor() {
    super("worker request timed out");
  }
}
const HEARTBEAT_STALE_MS = 90_000;
/** Respawn backoff for a worker that died with pending work. */
const RESPAWN_DELAYS_MS = [1_000, 5_000, 30_000];

interface Handle {
  readonly chatId: string;
  child: ReturnType<typeof fork>;
  alive: boolean;
  buffers: LiveBuffers;
  lastBeat: number;
  nextRef: number;
  /** Requests sent before the ready handshake resolved. */
  readonly queued: ServerRequest[];
  readonly dispatches: Map<number, AbortController>;
  readonly waiters: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >;
  ready: Promise<void>;
  lastUsed: number;
  retiring: boolean;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyState: "starting" | "ready" | "failed";
}

/** Bun runs TypeScript natively and the production server runs under bun;
 *  in tests (node) the fork still needs bun for the TS entry. */
function workerExecPath(config: Config): string {
  if (config.bunBin !== null) return config.bunBin;
  if (process.execPath.includes("bun")) return process.execPath;
  return "bun";
}

/** The fork env: the server's own environment (ambient settings modules
 *  read directly) plus the server's parsed config and the worker's chat.
 *  Trusted fleet model — the worker holds the same credentials the server
 *  does. */
function workerEnv(config: Config, chatId: string): NodeJS.ProcessEnv {
  return { ...process.env, ...workerConfigEnv(config, chatId) };
}

type WithoutRef<T> = T extends { ref: number } ? Omit<T, "ref"> : never;

export class ForkSupervisor {
  private readonly handles = new Map<string, Handle>();
  private heartbeatSweeper: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly spawning = new Map<string, Promise<Handle>>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, number>();
  private readonly recoveryAbort = new AbortController();
  private launchQueue: Promise<void> = Promise.resolve();
  private bootRecovery?: Promise<void>;
  private get maxWorkers(): number {
    return this.config.workerLimit;
  }
  private get idleMs(): number {
    return this.config.workerIdleMs;
  }
  private streamSink: GenerationStreamSink | null = null;
  private turnEnded: ((chatId: string, failed: boolean) => Promise<void>) | null = null;
  private submitRemote: ((chatId: string, input: SubmitTurnInput) => Promise<number>) | null = null;

  setStreamSink(sink: GenerationStreamSink | null): void {
    this.streamSink = sink;
  }

  /** A turn ended in a worker: the server's push lane runs here, where the
   *  member sockets are. */
  setTurnEnded(hook: ((chatId: string, failed: boolean) => Promise<void>) | null): void {
    this.turnEnded = hook;
  }

  /** Worker-initiated admission for another chat (delegation): the server
   *  runtime owns every worker, so it forwards the turn to the target
   *  chat's own worker. */
  setRemoteSubmit(submit: (chatId: string, input: SubmitTurnInput) => Promise<number>): void {
    this.submitRemote = submit;
  }

  liveBuffers(chatId: string): LiveBuffers {
    return { ...(this.handles.get(chatId)?.buffers ?? { text: "", thinking: "" }) };
  }

  private async pause(ms: number): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.recoveryAbort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.recoveryAbort.signal.addEventListener("abort", done, { once: true });
    });
  }

  private retire(handle: Handle): void {
    handle.retiring = true;
    this.attempts.delete(handle.chatId);
    handle.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (handle.alive) handle.child.kill("SIGKILL");
    }, 5000);
    timer.unref();
    handle.child.once("exit", () => clearTimeout(timer));
  }

  private async retireIdle(force = false): Promise<boolean> {
    for (const handle of this.handles.values()) {
      if (handle.retiring || handle.readyState !== "ready" || handle.waiters.size || handle.dispatches.size) continue;
      if (!force && Date.now() - handle.lastUsed < this.idleMs) continue;
      const pending = await this.hasPendingWork(handle.chatId).catch(() => true);
      if (pending || handle.waiters.size || handle.dispatches.size) continue;
      // Removal waits for exit, preserving the single-worker invariant.
      this.retire(handle);
      return true;
    }
    return false;
  }

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    /** Pending-work probe for respawn decisions: does the chat's
     *  conversation still have live tasks or queued submissions? */
    private readonly hasPendingWork: (chatId: string) => Promise<boolean>,
    /** Machine-tool dispatch on the server's hub (workers proxy their
     *  env calls here; undefined only in degenerate test stacks). */
    private readonly dispatchMachine?: (call: MachineDispatchCall, signal?: AbortSignal) => Promise<MachineToolOutcome>,
    private readonly options: {
      spawn?: typeof fork;
      readyTimeoutMs?: number;
      respawnDelays?: readonly number[];
      /** How long a stop may wait for the worker before it is killed. */
      stopSettleTimeoutMs?: number;
    } = {},
  ) {}

  private startHeartbeatSweeper(): void {
    if (this.heartbeatSweeper) return;
    this.heartbeatSweeper = setInterval(() => {
      void this.retireIdle().catch((error) => this.log.warn({ err: error }, "idle worker retirement failed"));
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
    if (existing?.alive && !existing.retiring) {
      await existing.ready;
      existing.lastUsed = Date.now();
      return existing;
    }
    const pending = this.spawning.get(chatId);
    if (pending) return pending;
    const operation = (async () => {
      let release!: () => void;
      const previous = this.launchQueue;
      this.launchQueue = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      let handle: Handle;
      try {
        const deadline = Date.now() + REQUEST_TIMEOUT_MS;
        while (!this.closed && (this.handles.size >= Math.max(1, this.maxWorkers) || this.handles.has(chatId))) {
          await this.retireIdle(true);
          if (Date.now() > deadline) throw new Error("worker capacity unavailable");
          await this.pause(100);
        }
        if (this.closed) throw new Error("supervisor is closed");
        handle = this.spawnWorker(chatId);
      } finally {
        release();
      }
      await handle.ready;
      return handle;
    })();
    this.spawning.set(chatId, operation);
    void operation.finally(() => this.spawning.delete(chatId)).catch(() => {});
    return operation;
  }

  private spawnWorker(chatId: string): Handle {
    this.startHeartbeatSweeper();

    const handle: Handle = {
      chatId,
      child: (this.options.spawn ?? fork)(WORKER_ENTRY, [], {
        execPath: workerExecPath(this.config),
        env: workerEnv(this.config, chatId) as NodeJS.ProcessEnv,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: [],
      }),
      alive: true,
      buffers: { text: "", thinking: "" },
      lastBeat: Date.now(),
      nextRef: 1,
      queued: [],
      waiters: new Map(),
      dispatches: new Map(),
      ready: Promise.resolve(),
      lastUsed: Date.now(),
      retiring: false,
      resolveReady: () => {},
      rejectReady: () => {},
      readyState: "starting",
    };
    const ready = new Promise<void>((resolve, reject) => {
      handle.resolveReady = () => {
        if (handle.readyState === "starting") {
          handle.readyState = "ready";
          resolve();
        }
      };
      handle.rejectReady = (error) => {
        if (handle.readyState === "starting") {
          handle.readyState = "failed";
          reject(error);
        }
      };
    });
    handle.ready = ready;
    this.handles.set(chatId, handle);

    const readyTimer = setTimeout(() => {
      if (handle.readyState !== "starting") return;
      handle.rejectReady(new Error("worker did not become ready in time"));
      handle.child.kill("SIGKILL");
    }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
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
      if (this.handles.get(chatId) === handle) {
        this.handles.delete(chatId);
        this.streamSink?.close(chatId);
        this.streamSink?.dirty(chatId);
      }
      for (const waiter of handle.waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("worker exited with a request in flight"));
      }
      handle.waiters.clear();
      this.recover(chatId, handle);
    });

    return handle;
  }

  /** Answers one of the worker's own requests. */
  private reply(handle: Handle, ref: number, outcome: Outcome): void {
    const message: ServerReply = { t: "reply", ref, ...outcome };
    if (handle.child.connected) handle.child.send(message, () => {});
  }

  /** Serves one worker request and answers it. */
  private serve(handle: Handle, ref: number, op: () => Promise<unknown>, done?: () => void): void {
    void (async () => {
      try {
        this.reply(handle, ref, { ok: true, data: await op() });
      } catch (error) {
        this.reply(handle, ref, failure(error));
      } finally {
        done?.();
      }
    })();
  }

  private onMessage(handle: Handle, raw: unknown): void {
    const message = raw as WorkerToServer;
    if (!message || typeof message !== "object" || !("t" in message)) return;
    if (message.t === "stream") {
      if (!handle.alive || this.handles.get(handle.chatId) !== handle) return;
      const chatId = handle.chatId;
      switch (message.action) {
        case "open":
          handle.buffers = { text: "", thinking: "" };
          this.streamSink?.open(chatId, message.generationId);
          break;
        case "event":
          this.streamSink?.event(chatId, message.event);
          break;
        case "dirty":
          this.streamSink?.dirty(chatId);
          break;
        case "close":
          handle.buffers = { text: "", thinking: "" };
          this.streamSink?.close(chatId);
          break;
        case "buffers":
          for (const key of ["text", "thinking"] as const) {
            const update = message[key];
            if (update)
              handle.buffers[key] = "replace" in update ? update.replace : handle.buffers[key] + update.append;
          }
          break;
      }
      return;
    }
    if (message.t === "turn-ended") {
      void this.turnEnded?.(message.chatId, message.failed).catch((error: unknown) =>
        this.log.warn({ err: error, chatId: message.chatId }, "turn-end hook failed"),
      );
      return;
    }
    if (message.t === "ready") {
      if (handle.readyState !== "starting") return;
      handle.lastBeat = Date.now();
      const queued = handle.queued.splice(0);
      handle.resolveReady();
      handle.lastUsed = Date.now();
      for (const request of queued) this.send(handle, request);
      return;
    }
    if (message.t === "heartbeat") {
      handle.lastBeat = Date.now();
      return;
    }
    if (message.t === "remote-deliver-steer") {
      this.serve(handle, message.ref, async () => {
        await this.deliverSteer(message.chatId, message.orgId, message.text, message.model);
        return null;
      });
      return;
    }
    if (message.t === "remote-deliver-message") {
      this.serve(handle, message.ref, async () => {
        await this.deliverMessage(message.chatId, message.orgId, message.text, message.model);
        return null;
      });
      return;
    }
    if (message.t === "remote-submit") {
      this.serve(handle, message.ref, () => {
        if (!this.submitRemote) throw new Error("remote submit is unavailable");
        return this.submitRemote(message.chatId, message.input);
      });
      return;
    }
    // Worker-initiated machine dispatch (the IPC proxy): the hub-backed
    // registry does the real frame send + result wait on the server side.
    if (message.t === "dispatch_cancel") {
      handle.dispatches.get(message.ref)?.abort();
      return;
    }
    if (message.t === "dispatch") {
      const controller = new AbortController();
      handle.dispatches.set(message.ref, controller);
      this.serve(
        handle,
        message.ref,
        () => {
          if (!this.dispatchMachine) throw new Error("machine dispatch unavailable");
          return this.dispatchMachine(message.call, controller.signal);
        },
        () => handle.dispatches.delete(message.ref),
      );
      return;
    }
    if (message.t === "result") {
      const waiter = handle.waiters.get(message.ref);
      if (!waiter) return;
      handle.waiters.delete(message.ref);
      clearTimeout(waiter.timer);
      handle.lastUsed = Date.now();
      if (message.ok) waiter.resolve(message.data);
      else waiter.reject(failureError(message));
    }
  }

  /** The journal decides respawn: a dead worker whose conversation still
   *  has pending work gets one, with backoff; an idle worker just stays
   *  dead until the next touch. */
  private recover(chatId: string, handle: Handle): void {
    for (const controller of handle.dispatches.values()) controller.abort();
    handle.dispatches.clear();
    if (this.closed || handle.retiring || this.recovering.has(chatId)) return;
    const operation = this.recoverChat(chatId);
    this.recovering.set(chatId, operation);
    void operation.finally(() => this.recovering.delete(chatId)).catch(() => {});
  }

  private async recoverChat(chatId: string): Promise<void> {
    while (!this.closed) {
      const attempt = this.attempts.get(chatId) ?? 0;
      const delays = this.options.respawnDelays ?? RESPAWN_DELAYS_MS;
      const delay = delays[Math.min(attempt, delays.length - 1)]!;
      this.attempts.set(chatId, attempt + 1);
      await this.pause(delay);
      if (this.closed) return;
      try {
        if (!(await this.hasPendingWork(chatId))) {
          this.attempts.delete(chatId);
          return;
        }
        const handle = await this.ensureWorker(chatId);
        if (!handle.alive) continue;
        // A healthy interval, rather than a new PID, resets the crash budget.
        const timer = setTimeout(() => {
          if (handle.alive) this.attempts.delete(chatId);
        }, 600_000);
        timer.unref();
        handle.child.once("exit", () => clearTimeout(timer));
        return;
      } catch (error) {
        this.log.warn({ err: error, chatId, attempt }, "worker recovery will retry");
      }
    }
  }

  private send(handle: Handle, request: ServerRequest): void {
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

  private async request<T>(chatId: string, msg: WithoutRef<ServerRequest>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const handle = await this.ensureWorker(chatId);
    const ref = handle.nextRef++;
    const full = { ...msg, ref } as ServerRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.waiters.delete(ref);
        reject(new WorkerRequestTimeout());
      }, timeoutMs);
      timer.unref?.();
      handle.waiters.set(ref, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (handle.readyState === "ready") this.send(handle, full);
      else handle.queued.push(full);
    });
  }

  /** Routes a turn admission into the chat's worker; resolves with the
   *  submission id. */
  submit(chatId: string, input: SubmitTurnInput): Promise<number> {
    return this.request<number>(chatId, { t: "submit", input });
  }

  deliverSteer(chatId: string, orgId: string, text: string, model: string | null): Promise<void> {
    return this.request<void>(chatId, { t: "deliver-steer", orgId, text, model });
  }

  deliverMessage(chatId: string, orgId: string, text: string, model: string | null): Promise<void> {
    return this.request<void>(chatId, { t: "deliver-message", orgId, text, model });
  }

  steer(chatId: string, submissionId: number): Promise<boolean> {
    return this.request<boolean>(chatId, { t: "steer", submissionId });
  }

  withdraw(chatId: string, submissionId: number): Promise<string> {
    return this.request<string>(chatId, { t: "withdraw", submissionId });
  }

  stop(chatId: string): Promise<void> {
    const handle = this.handles.get(chatId);
    // No worker owns this chat, so nothing of it is in flight here.
    if (handle === undefined) return Promise.resolve();
    return this.request<void>(chatId, { t: "stop" }, this.options.stopSettleTimeoutMs ?? STOP_SETTLE_TIMEOUT_MS).catch(
      (error: unknown) => {
        if (!(error instanceof WorkerRequestTimeout)) throw error;
        // The abort mark was committed before the worker began to wait, so the
        // journal ends the turn on respawn. The stuck process is unrecoverable.
        this.log.warn({ chatId }, "stop did not settle; killing the stuck worker");
        handle.child.kill("SIGKILL");
      },
    );
  }

  compact(chatId: string): Promise<number | null> {
    return this.request<number | null>(chatId, { t: "compact" });
  }

  /** Boot recovery: fork workers for every chat whose conversation still
   *  has pending work. This replaces the in-process resume()-everything —
   *  the journal is the registry. */
  async recoverFromJournal(chats: Iterable<{ chatId: string }>): Promise<void> {
    const pending = [...chats];
    let next = 0;
    const operation = Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (!this.closed) {
          const row = pending[next++];
          if (!row) return;
          const { chatId } = row;
          try {
            const handle = await this.ensureWorker(chatId);
            if (!(await this.hasPendingWork(chatId)) && !handle.waiters.size && !handle.dispatches.size) {
              handle.retiring = true;
              handle.child.kill("SIGTERM");
            }
          } catch (error) {
            this.log.error({ err: error, chatId }, "boot worker spawn failed");
            if (!this.recovering.has(chatId)) {
              const recovery = this.recoverChat(chatId);
              this.recovering.set(chatId, recovery);
              void recovery.finally(() => this.recovering.delete(chatId)).catch(() => {});
            }
          }
        }
      }),
    ).then(() => {});
    const previous = this.bootRecovery;
    this.bootRecovery = Promise.allSettled([previous, operation]).then(() => {});
  }

  /** Test/ops accessor: the worker child's pid, when one is live. */
  pidOf(chatId: string): number | undefined {
    return this.handles.get(chatId)?.child.pid;
  }

  /** Kills every worker (SIGTERM → the worker closes its scoped harness
   *  cleanly, leaving pending work pending) and stops the sweeper. */
  async close(): Promise<void> {
    this.closed = true;
    this.recoveryAbort.abort();
    if (this.heartbeatSweeper) clearInterval(this.heartbeatSweeper);
    const children = [...this.handles.values()];
    for (const handle of children) {
      for (const controller of handle.dispatches.values()) controller.abort();
      handle.dispatches.clear();
    }
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
    await this.bootRecovery;
    await Promise.allSettled([...this.spawning.values(), ...this.recovering.values()]);
  }
}
