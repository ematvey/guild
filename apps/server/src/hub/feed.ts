// The member-socket feed forwarder: pushes
// thread views, live generation frames, chat-status flips, org events, and
// presence-driven thread lists to every connected socket of a chat's owner.
//
// Topology differs from Rust by design (one shared Postgres LISTEN via the
// NotifyHub + in-process fan-out instead of one feed task per user); the
// observable behavior mirrors the Rust contract: views republish only when
// the capture changes (seq-zeroed content compare), live frames carry the
// generation identity the turn ack issues, and presence flips re-send the
// thread list so the connection dot moves live.

import type { PlatformContext } from "../platform/root-context.js";
import type { NotifyHandler } from "../platform/notify.js";
import { captureThreadState, threadStateMsg, threadStateWire } from "../chats/thread-state.js";
import { chatSubagentNodes, subagentTreeMsg } from "../agents/tree.js";
import {
  archivedThreadListSnapshot,
  machineListSnapshot,
  projectListSnapshot,
  threadListSnapshot,
} from "./workspace.js";
import type { GenerationStreamSink } from "../chats/bridge.js";
import type { StreamWireEvent, WsServerMsg } from "./protocol.js";

const PRESENCE_POLL_MS = 1_000;
const VIEW_POLL_MS = 100;
const BINDINGS_TTL_MS = 4_000;

interface ChatIdentity {
  orgId: string;
  userId: string;
  machineId: string | null;
}

interface UserBindings {
  fetchedAt: number;
  orgId: string;
  chats: { id: string; machineId: string | null }[];
}

export class FeedForwarder implements GenerationStreamSink {
  private readonly ctx: PlatformContext;
  private unsubscribe: (() => void) | null = null;
  private viewTimer: NodeJS.Timeout | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  /** Cached chat identities (org/owner/machine binding); the committed
   *  path re-reads the row every notification (Rust refresh_bindings). */
  private readonly chats = new Map<string, ChatIdentity>();
  private readonly chatLookups = new Map<string, Promise<ChatIdentity | null>>();
  /** Last broadcast view per chat, as the seq-zeroed wire bytes (Rust
   *  `views` with content["seq"]=0). */
  private readonly views = new Map<string, string>();
  /** Chats whose streaming buffers moved since the last view capture. */
  private readonly dirtyChats = new Set<string>();
  /** Open generation identities (live_frame generation_id). */
  private readonly generations = new Map<string, string>();
  /** Last pushed subtree per chat, as JSON: a run-status write that leaves
   *  the rendered tree unchanged sends nothing. */
  private readonly subagentTrees = new Map<string, string>();
  /** Per-chat fan-out baseline: rows at/below this seq already reached the
   *  client (full-view publishes re-baseline to the capture's max row).
   *  Undefined = the open() baseline hasn't run yet — committed() falls
   *  back to a full-view publish instead of guessing. */
  private readonly sentSeqs = new Map<string, number>();
  /** Per-chat send chains: the async watermark + fan-out of one frame
   *  serializes before the next, so frame order matches emission order. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Per-user workspace push chains: one snapshot in flight per user, so a
   *  query started before a write can never land after the one that
   *  carries it. */
  private readonly workspaceChains = new Map<string, Promise<void>>();
  /** Last known machine-online state per (user, chat) binding. */
  private readonly presence = new Map<string, boolean>();
  private readonly bindings = new Map<string, UserBindings>();

  constructor(ctx: PlatformContext) {
    this.ctx = ctx;
  }

  /** Subscribes the notify fan-out and starts the poll timers. */
  start(): void {
    if (this.unsubscribe !== null || this.stopped) return;
    const off = this.ctx.notify.subscribe(this.onNotify);
    this.unsubscribe = off;
    this.viewTimer = setInterval(() => void this.publishDirtyViews(), VIEW_POLL_MS);
    this.viewTimer.unref?.();
    this.presenceTimer = setInterval(() => void this.watchPresence(), PRESENCE_POLL_MS);
    this.presenceTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.viewTimer !== undefined) clearInterval(this.viewTimer);
    if (this.presenceTimer !== undefined) clearInterval(this.presenceTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -- notify fan-in (Rust Feed::handle_notification) ------------------------

  private onNotify: NotifyHandler = (channel, payload) => {
    if (this.stopped) return;
    if (channel === "guild_thread_committed") {
      if (payload === "") return;
      void this.committed(payload).catch(() => {});
      return;
    }
    if (channel === "guild_chat_status") {
      let parsed: { org_id?: string; user_id?: string; chat_id?: string; generating?: boolean };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (
        typeof parsed.org_id !== "string" ||
        typeof parsed.user_id !== "string" ||
        typeof parsed.chat_id !== "string" ||
        typeof parsed.generating !== "boolean"
      ) {
        return;
      }
      // Owner-scoped: other members' feeds filter the frame out (Rust).
      const frame: WsServerMsg = {
        type: "chat_status",
        chat_id: parsed.chat_id,
        generating: parsed.generating,
      };
      this.sendToUser(parsed.user_id, frame);
      // A generating flip changes the chat's view content: the next view
      // poll re-captures and broadcasts it if it differs (Rust's poll finds
      // the changed view on its next 100ms tick).
      if (this.chats.get(parsed.chat_id) === undefined) {
        this.chats.set(parsed.chat_id, {
          orgId: parsed.org_id,
          userId: parsed.user_id,
          machineId: null,
        });
      }
      this.dirtyChats.add(parsed.chat_id);
      return;
    }
    if (channel === "guild_workspace") {
      let parsed: { org_id?: string; user_id?: string };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof parsed.org_id !== "string" || typeof parsed.user_id !== "string") return;
      // Every sidebar list (chats, archived, projects, machines) rides one
      // serialized push, so a snapshot taken before a write can never land
      // after the one that carries it.
      void this.pushWorkspace(parsed.org_id, parsed.user_id).catch(() => {});
      return;
    }
    if (channel === "guild_events") {
      let parsed: { org_id?: string; event_id?: string };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof parsed.org_id !== "string" || typeof parsed.event_id !== "string") return;
      void this.orgEvent(parsed.org_id, parsed.event_id).catch(() => {});
      return;
    }
    if (channel === "guild_subagent_tree") {
      if (payload === "") return;
      void this.subagentTree(payload).catch(() => {});
    }
  };

  /** One chat's thread subtree, pushed to its owner's sockets when it moves.
   *  The tree is display state, not log state, so the frame carries the whole
   *  node list and the client replaces its view. Frames ride the chat's send
   *  chain so an older snapshot never lands after a newer one. */
  private async subagentTree(chatId: string): Promise<void> {
    this.enqueue(chatId, async () => {
      const chat = await this.ensureChat(chatId, false);
      if (chat === null) return;
      if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
        this.subagentTrees.delete(chatId);
        return;
      }
      const nodes = await chatSubagentNodes(this.ctx.pool, chatId);
      const wire = JSON.stringify(nodes);
      if (this.subagentTrees.get(chatId) === wire) return;
      this.subagentTrees.set(chatId, wire);
      this.sendToUser(chat.userId, subagentTreeMsg(chatId, nodes));
    });
  }

  private async committed(chatId: string): Promise<void> {
    const chat = await this.ensureChat(chatId, true);
    if (chat === null) return;
    // Nobody is listening: drop the cached view so the next connection
    // re-captures (Rust's feed dies with its last receiver and comes back
    // with empty state).
    if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
      this.views.delete(chatId);
      this.dirtyChats.delete(chatId);
      return;
    }
    this.dirtyChats.delete(chatId);
    // List-level state: a new user turn creates the row (and moves its
    // activity stamp), an assistant turn moves the unread count, and an
    // approval request or decision flips the blocked flag. Each one
    // re-pushes the workspace, not a bare chat list.
    const last = await this.ctx.pool.query<{ type: string }>(
      "SELECT type FROM thread_events WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1",
      [chatId],
    );
    const lastType = last.rows[0]?.type;
    if (
      lastType === "user_message" ||
      lastType === "approval_request" ||
      lastType === "approval_decision" ||
      lastType === "assistant_message"
    ) {
      void this.pushWorkspace(chat.orgId, chat.userId).catch(() => {});
    }
    // An open turn owns the view: instead of re-broadcasting the whole
    // thread per append, fan out only the rows committed since the last
    // fan-out (thread_events frames). Tool calls, approval cards and
    // messages all land as durable-log events — the client renders them
    // through the same replay rules a refresh uses, live.
    const since = this.sentSeqs.get(chatId);
    if (this.generations.has(chatId)) {
      if (since !== undefined) this.publishIncremental(chatId, chat.userId, since);
      else this.dirtyChats.add(chatId);
      return;
    }
    await this.publishView(chatId, chat.orgId, chat.userId);
  }

  private async orgEvent(orgId: string, eventId: string): Promise<void> {
    let event;
    try {
      event = await this.ctx.events.get(orgId, eventId);
    } catch {
      return;
    }
    if (event === null) return;
    this.sendToOrg(orgId, { type: "org_event", event });
  }

  // -- view captures (Rust Feed::publish_views) -------------------------------

  private async publishDirtyViews(): Promise<void> {
    if (this.dirtyChats.size === 0) return;
    const chatIds = [...this.dirtyChats];
    this.dirtyChats.clear();
    for (const chatId of chatIds) {
      const chat = this.chats.get(chatId);
      if (chat === undefined) {
        void this.ensureChat(chatId, false);
        continue;
      }
      if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
        this.views.delete(chatId);
        continue;
      }
      await this.publishView(chatId, chat.orgId, chat.userId);
    }
  }

  /** One capture → broadcast if the seq-zeroed content differs from the
   *  last view (Rust's dedupe: the frame itself carries the real seq). */
  private async publishView(chatId: string, orgId: string, userId: string): Promise<void> {
    let capture;
    try {
      capture = await captureThreadState(this.ctx, this.ctx.pool, orgId, chatId);
    } catch {
      return;
    }
    const dedupe = threadStateWire({ ...capture, seq: 0 });
    if (this.views.get(chatId) === dedupe) return;
    this.views.set(chatId, dedupe);
    this.sendToUser(userId, threadStateMsg(capture));
    // The full view carried every row of the log: the incremental lane
    // resumes above the newest one it delivered (the capture watermark
    // is reserved later than the read — a row can commit in between).
    const maxRow = capture.events.reduce((max, row) => Math.max(max, row.seq), 0);
    this.sentSeqs.set(chatId, Math.max(this.sentSeqs.get(chatId) ?? 0, maxRow));
  }

  // -- live generation frames (Rust Feed::drain_events) -----------------------

  open(chatId: string, generationId: string): void {
    this.generations.set(chatId, generationId);
    void this.ensureChat(chatId, false);
    // Baseline on the chat's send chain (ordered before any incremental
    // this turn commits): everything already durable reached clients via
    // sync; the turn fans out only rows appended after this max.
    this.enqueue(chatId, async () => {
      if (this.generations.get(chatId) !== generationId) return;
      try {
        const res = await this.ctx.pool.query<{ max: string | null }>(
          "SELECT MAX(seq) AS max FROM thread_events WHERE chat_id = $1",
          [chatId],
        );
        this.sentSeqs.set(chatId, Number(res.rows[0]?.max ?? 0));
      } catch {
        this.sentSeqs.delete(chatId);
      }
    });
  }

  event(chatId: string, event: StreamWireEvent): void {
    const generationId = this.generations.get(chatId);
    if (generationId === undefined) return;
    // The generation identity and the frame order are captured now; the
    // async owner lookup + watermark ride the per-chat chain.
    this.enqueue(chatId, async () => {
      const chat = await this.ensureChat(chatId, false);
      if (chat === null) return;
      const sinks = this.ctx.hub.sinksOfUser(chat.userId);
      if (sinks.length === 0) return;
      let seq: number;
      try {
        seq = await this.ctx.threads.watermark();
      } catch {
        return;
      }
      const frame: WsServerMsg = {
        type: "live_frame",
        chat_id: chatId,
        generation_id: generationId,
        seq,
        machine_id: chat.machineId,
        event,
      };
      for (const sink of sinks) sink.send(frame);
    });
  }

  dirty(chatId: string): void {
    this.dirtyChats.add(chatId);
  }

  /** One incremental fan-out on the chat's send chain: rows appended since
   *  `since`, as a thread_events frame (same serialized chain as the live
   *  frames, so a committed row never overtakes its own stream frames). */
  private publishIncremental(chatId: string, userId: string, since: number): void {
    this.enqueue(chatId, async () => {
      if (this.generations.get(chatId) === undefined) return;
      let rows;
      try {
        rows = await this.ctx.threads.listEventsSince(chatId, since);
      } catch {
        return;
      }
      if (rows.length === 0) return;
      const maxRow = rows.reduce((max, row) => Math.max(max, row.seq), since);
      this.sentSeqs.set(chatId, Math.max(this.sentSeqs.get(chatId) ?? 0, maxRow));
      const frame: WsServerMsg = {
        type: "thread_events",
        chat_id: chatId,
        seq: maxRow,
        events: rows,
      };
      for (const sink of this.ctx.hub.sinksOfUser(userId)) sink.send(frame);
    });
  }

  close(chatId: string): void {
    const generationId=this.generations.get(chatId);
    this.enqueue(chatId,async()=>{
      if(this.generations.get(chatId)===generationId) this.generations.delete(chatId);
      this.dirtyChats.add(chatId);
    });
  }

  /** Serializes one chat's async sends (order preserved, failures skipped). */
  private enqueue(chatId: string, op: () => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(op);
    this.chains.set(
      chatId,
      next.catch(() => {}).then(() => {
        if (this.chains.get(chatId) === next) this.chains.delete(chatId);
      }),
    );
  }

  private async ensureChat(chatId: string, refresh: boolean): Promise<ChatIdentity | null> {
    if (!refresh) {
      const cached = this.chats.get(chatId);
      if (cached !== undefined) return cached;
      const inFlight = this.chatLookups.get(chatId);
      if (inFlight !== undefined) return inFlight;
    }
    const lookup = (async (): Promise<ChatIdentity | null> => {
      const res = await this.ctx.pool.query<{ org_id: string; user_id: string; machine_id: string | null }>(
        "SELECT org_id, user_id, machine_id FROM chats WHERE id = $1",
        [chatId],
      );
      const row = res.rows[0];
      if (!row) return null;
      const identity: ChatIdentity = { orgId: row.org_id, userId: row.user_id, machineId: row.machine_id };
      this.chats.set(chatId, identity);
      return identity;
    })();
    this.chatLookups.set(chatId, lookup);
    try {
      return await lookup;
    } finally {
      this.chatLookups.delete(chatId);
    }
  }

  // -- presence (Rust Feed::watch_presence) -----------------------------------

  private async watchPresence(): Promise<void> {
    for (const userId of this.ctx.hub.connectedUserIds()) {
      const bindings = await this.bindingsOf(userId);
      let changed = false;
      for (const chat of bindings.chats) {
        if (chat.machineId === null) continue;
        const online = this.ctx.hub.machineOnline(chat.machineId);
        const key = `${userId}:${chat.id}`;
        if (this.presence.get(key) !== online) {
          this.presence.set(key, online);
          changed = true;
        }
      }
      if (!changed) continue;
      void this.pushWorkspace(bindings.orgId, userId).catch(() => {});
    }
  }

  /** One serialized workspace push per user. Every list-changing write and
   *  presence flip calls this; the chain keeps the wire order equal to the
   *  commit order, so an older snapshot can never overtake a newer one. */
  pushWorkspace(orgId: string, userId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = `${orgId}:${userId}`;
    const previous = this.workspaceChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.sendWorkspace(orgId, userId)).catch(() => {});
    this.workspaceChains.set(key, next);
    void next.finally(() => {
      if (this.workspaceChains.get(key) === next) this.workspaceChains.delete(key);
    });
    return next;
  }

  private async sendWorkspace(orgId: string, userId: string): Promise<void> {
    if (this.stopped) return;
    if (this.ctx.hub.sinksOfUser(userId).length === 0) return;
    const user = { org_id: orgId, id: userId };
    const [chats, archived, projects, machines] = await Promise.all([
      threadListSnapshot(this.ctx, user),
      archivedThreadListSnapshot(this.ctx, user),
      projectListSnapshot(this.ctx, user),
      machineListSnapshot(this.ctx, user),
    ]);
    // The legacy chat list stays first for old clients (and the Rust
    // daemon's bootstrap wait); the rest are additive frames.
    this.sendToUser(userId, { type: "thread_list", chats });
    this.sendToUser(userId, { type: "archived_thread_list", chats: archived });
    this.sendToUser(userId, {
      type: "project_list",
      projects: projects.projects,
      archived_projects: projects.archived_projects,
    });
    this.sendToUser(userId, { type: "machine_list", machines });
  }

  private async bindingsOf(userId: string): Promise<UserBindings> {
    const cached = this.bindings.get(userId);
    if (cached !== undefined && Date.now() - cached.fetchedAt < BINDINGS_TTL_MS) return cached;
    const res = await this.ctx.pool.query<{ id: string; org_id: string; machine_id: string | null }>(
      "SELECT id, org_id, machine_id FROM chats WHERE user_id = $1 AND archived_at IS NULL",
      [userId],
    );
    const fresh: UserBindings = {
      fetchedAt: Date.now(),
      orgId: res.rows[0]?.org_id ?? "",
      chats: res.rows.map((row) => ({ id: row.id, machineId: row.machine_id })),
    };
    this.bindings.set(userId, fresh);
    return fresh;
  }

  // -- fan-out ------------------------------------------------------------------

  /** Machine presence flip: the owner's member sockets repaint the online
   *  dot without polling the registry. */
  machineStatus(machineId: string, userId: string, orgId: string, online: boolean): void {
    if (this.stopped) return;
    const frame: WsServerMsg = { type: "machine_status", machine_id: machineId, online };
    for (const sink of this.ctx.hub.memberSinksOfUser(userId)) sink.send(frame);
    // A claim can be a new registration or a re-pair (the rows and the
    // chats' machine labels move), so the registry list repaints too.
    void this.pushWorkspace(orgId, userId).catch(() => {});
  }

  private sendToUser(userId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.sinksOfUser(userId)) sink.send(frame);
  }

  private sendToOrg(orgId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.sinksOfOrg(orgId)) sink.send(frame);
  }
}
