// The one outbound queue consumed by a socket's writer task
//. The hub clones
// sinks into registry slots; the ws route runs the writer loop.
//
// An unbounded queue with a pending counter, a high-water latch (4096 → latched until disconnect), an
// AuthRequired latch the writer observes even while stalled on a write, a
// last-matched-pong register for the heartbeat challenge, and a notify that
// wakes the writer. Enqueue is synchronous (no await before the push), so
// messages keep their send order without a lock.

import type { TicketIdentity } from "./tickets.js";
import type { WsServerMsg } from "./protocol.js";

export type SocketOutput =
  | { kind: "message"; msg: WsServerMsg }
  | { kind: "sync_start" }
  | { kind: "sync_message"; msg: WsServerMsg }
  | { kind: "ping"; payload: Buffer }
  | { kind: "pong"; payload: Buffer };

export const SOCKET_HIGH_WATER = 4096;

export const SURFACE_FRAMES = {
  work: new Set<WsServerMsg["type"]>([
    "hello", "pong", "auth_required", "displaced", "error", "workspace_identity", "member_profile", "model_list",
    "agent_list", "agent_run", "agent_threads", "agent_routines", "skill_catalog", "app_list", "org_event",
    "thread_list", "chat_status", "thread_events", "sync_begin", "thread_state", "sync_done", "live_frame",
    "subagent_tree", "machine_status", "archived_thread_list", "project_list", "machine_list", "chat_tree",
    "chat_row", "context_usage",
  ]),
  control: new Set<WsServerMsg["type"]>([
    "hello", "pong", "auth_required", "displaced", "error", "workspace_identity", "member_profile", "model_list",
    "agent_list", "integration_access", "agent_run", "agent_threads", "agent_routines", "agent_coordination",
    "activity_run", "activity_run_unavailable", "activity_conversation", "skill_catalog", "app_list", "org_event",
  ]),
};

export interface BacklogState {
  /** Latched: the writer must disconnect even while stalled on a write. */
  overloaded: boolean;
  /** Latched: the writer must flush an AuthRequired terminal notice. */
  authRequired: boolean;
  /** Latched by the hub's machine-shutdown signal (displacement). */
  shutdown: boolean;
  /** Last pong payload the reader saw (heartbeat challenge matching). */
  lastPong: Buffer | null;
  /** Queued + in-flight + sync-deferred output the writer has not written. */
  pending: number;
}

export class SocketSink {
  /** Optional frames the client declared it applies (the upgrade query's
   *  `features`); a frame outside this set is never sent to it. */
  readonly features: ReadonlySet<string>;
  /** The chat this socket displays: the target of its newest `sync`
   *  (null for a page that shows no chat). Undefined until the first
   *  `sync`: such a socket (the engine's turn stream) receives every chat
   *  of its user. Per-chat view frames go only to sockets showing the chat. */
  view: string | null | undefined = undefined;
  /** The Activity Run whose durable steps this socket displays. */
  runView: string | null = null;
  runViewChat: string | null = null;
  activityConversation: string | null = null;
  coordinationAgent: string | null = null;
  readonly legacyCoordinationAgents = new Set<string>();
  private queue: SocketOutput[] = [];
  private pending = 0;
  private overloaded = false;
  private authRequired = false;
  private shutdownSignalled = false;
  private dead = false;
  private lastPong: Buffer | null = null;
  private notifyWriter: (() => void) | null = null;

  constructor(features: Iterable<string> = [], private readonly surface?: TicketIdentity["surface"]) {
    this.features = new Set(features);
  }

  /** Resolves when the writer has something to act on (output, a latch, or
   *  death). */
  waitForWork(): Promise<void> {
    if (this.workAvailable()) return Promise.resolve();
    return new Promise((resolve) => {
      this.notifyWriter = resolve;
    });
  }

  private workAvailable(): boolean {
    return this.dead || this.overloaded || this.authRequired || this.shutdownSignalled || this.queue.length > 0;
  }

  private wake(): void {
    const notify = this.notifyWriter;
    this.notifyWriter = null;
    notify?.();
  }

  enqueue(output: SocketOutput): boolean {
    if (this.dead) return false;
    if (output.kind === "message" || output.kind === "sync_message") {
      const tag = output.msg.type;
      if (this.surface && !SURFACE_FRAMES[this.surface].has(tag)) return true;
    }
    this.pending += 1;
    this.queue.push(output);
    if (this.pending > SOCKET_HIGH_WATER) {
      // Latched until disconnect; the writer observes this even while
      // awaiting a permanently stalled network write.
      this.overloaded = true;
    }
    if (this.queue.length === 1) this.wake();
    return true;
  }

  /** Sends a message; AuthRequired bypasses the queue entirely (the latch is
   *  the message). */
  send(msg: WsServerMsg): boolean {
    if (this.dead) return false;
    if (msg.type === "auth_required") {
      this.authRequired = true;
      this.wake();
      return true;
    }
    return this.enqueue({ kind: "message", msg });
  }

  /** A live queue always receives its ordered terminal notice. */
  displace(): boolean {
    return this.enqueue({ kind: "message", msg: { type: "displaced" } });
  }

  startSync(): boolean {
    return this.enqueue({ kind: "sync_start" });
  }

  /** A bracket message: written in order while the bracket is open, never
   *  deferred by the live-frame gate. */
  sendSync(msg: WsServerMsg): boolean {
    if (this.dead) return false;
    return this.enqueue({ kind: "sync_message", msg });
  }

  pong(payload: Buffer): boolean {
    return this.enqueue({ kind: "pong", payload });
  }

  ping(payload: Buffer): boolean {
    return this.enqueue({ kind: "ping", payload });
  }

  /** The reader's Pong with the heartbeat challenge payload. */
  notifyPong(payload: Buffer): void {
    this.lastPong = Buffer.from(payload);
  }

  /** Hub-side displacement signal (the machine slot was taken). */
  signalShutdown(): void {
    this.shutdownSignalled = true;
    this.wake();
  }

  /** Marks the sink dead: every later enqueue fails (SendError), the writer
   *  exits after its terminal flush. */
  close(): void {
    this.dead = true;
    this.wake();
  }

  get backlog(): BacklogState {
    return {
      overloaded: this.overloaded,
      authRequired: this.authRequired,
      shutdown: this.shutdownSignalled,
      lastPong: this.lastPong,
      pending: this.pending,
    };
  }

  /** Dequeues the next output. Does NOT settle the pending count: the writer
   *  settles each output when it disposes of it (ackWritten / ackSyncStart),
   *  so sync-deferred messages keep counting until written. */
  take(): SocketOutput | undefined {
    const output = this.queue.shift();
    if (this.queue.length > 0) this.wake();
    return output;
  }

  /** The writer settled a SyncStart marker (a bracket, never a wire frame). */
  ackSyncStart(): void {
    this.pending -= 1;
  }

  /** The writer settled `n` outputs by writing them. */
  ackWritten(n: number): void {
    this.pending -= n;
  }

  get isOverloaded(): boolean {
    return this.overloaded;
  }

  get isAuthRequired(): boolean {
    return this.authRequired;
  }

  get isShutdown(): boolean {
    return this.shutdownSignalled;
  }

  get isDead(): boolean {
    return this.dead;
  }

  get pendingCount(): number {
    return this.pending;
  }

  get queueDepth(): number {
    return this.queue.length;
  }
}
