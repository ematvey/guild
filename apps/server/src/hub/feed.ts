// The member-socket feed forwarder: pushes thread views, live generation
// frames, chat-status flips, org events, and presence-driven thread lists to
// the connected sockets of a chat's owner. One shared Postgres LISTEN (the
// NotifyHub) feeds an in-process fan-out. A chat's view frames (thread_state,
// thread_events, live_frame, context_usage) reach only the sockets that
// display that chat; list-level facts (chat_status, chat rows, subtrees)
// reach every socket of the owner. Views republish only when the capture
// changes (seq-zeroed content compare), coalesced on the view tick: a burst
// of writes to one chat sends one view. Live frames carry the generation
// identity the turn ack issues, and a machine presence flip pushes the
// thread list so the connection dot moves live. Workspace lists
// reach each socket only as the part that changed for it (sent-frames.ts).
// Agent and skill state rides the same LISTEN through AgentStateFeed.

import type { Logger } from "pino";
import type { PlatformContext } from "../composition.js";
import type { NotifyHandler } from "../platform/notify.js";
import { captureThreadState, threadStateMsg, threadStateWire } from "../chats/thread-state.js";
import { chatSubagentNodes, chatTreeFacts, chatTreeMsg, subagentTreeMsg } from "../agents/tree.js";
import { AgentStateFeed } from "./agent-state.js";
import {
  archivedThreadListSnapshot,
  machineListSnapshot,
  workspaceIdentitySnapshot,
  modelListSnapshot,
  projectListSnapshot,
  threadListSnapshot,
} from "./workspace.js";
import type { GenerationStreamSink } from "../chats/bridge.js";
import { contextUsageMsg } from "../chats/context-usage.js";
import type { StreamWireEvent, WsServerMsg } from "./protocol.js";
import type { SocketSink } from "./sink.js";
import { sendChanged, sendChatList } from "./sent-frames.js";

const VIEW_POLL_MS = 100;
/** A dirty view waits for one quiet tick (no new write) before it
 *  republishes, and never more than this many ticks after its first write. */
const VIEW_MAX_WAIT_TICKS = 3;
/** Ticks between sweeps of per-chat state whose owner has no socket. */
const SWEEP_EVERY_TICKS = 300;
/** Chat identities kept in the LRU. */
const MAX_CACHED_CHATS = 4_096;

type FeedLog = Pick<Logger, "warn">;
const SILENT: FeedLog = { warn: () => {} };

/** One workspace list; a push re-reads only the parts its change can move. */
export type WorkspacePart = "identity" | "chats" | "archived" | "projects" | "machines" | "models";

const ALL_PARTS: readonly WorkspacePart[] = ["identity", "chats", "archived", "projects", "machines", "models"];

/** One chat whose view awaits a republish: the ticks of its first and
 *  newest write, and whether the republish must send even an unchanged
 *  capture. */
interface DirtyView {
  first: number;
  last: number;
  force: boolean;
}

interface ChatIdentity {
  orgId: string;
  userId: string;
  machineId: string | null;
}

export class FeedForwarder implements GenerationStreamSink {
  private readonly ctx: PlatformContext;
  private unsubscribe: (() => void) | null = null;
  private viewTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticks = 0;

  /** Chat identities (org/owner/machine binding), least recently used
   *  first and bounded; the committed path re-reads the row every
   *  notification. */
  private readonly chats = new Map<string, ChatIdentity>();
  private readonly chatLookups = new Map<string, Promise<ChatIdentity | null>>();
  /** Last broadcast view per chat, as the seq-zeroed wire bytes. Views,
   *  trees and baselines are kept only while the owner has a socket. */
  private readonly views = new Map<string, string>();
  /** Chats whose view may have moved since the last capture. */
  private readonly dirtyChats = new Map<string, DirtyView>();
  /** A view tick is publishing: the next tick waits for it. */
  private publishing = false;
  /** Open generation identities (live_frame generation_id). */
  private readonly generations = new Map<string, string>();
  /** Last pushed subtree per chat, as JSON: a run-status write that leaves
   *  the rendered tree unchanged sends nothing. */
  private readonly subagentTrees = new Map<string, string>();
  /** Last pushed header facts per chat, as JSON: same dedupe as the tree. */
  private readonly chatTrees = new Map<string, string>();
  /** Last pushed context usage per chat, as JSON: same dedupe as the tree. */
  private readonly contextUsages = new Map<string, string>();
  /** The agent list, runs, routines, thread lists and skill catalog. */
  private readonly agentState: AgentStateFeed;
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

  constructor(
    ctx: PlatformContext,
    private readonly log: FeedLog = SILENT,
  ) {
    this.ctx = ctx;
    this.agentState = new AgentStateFeed(ctx, (channel, error) => this.failed(channel, null, error));
  }

  /** Logs one dropped push: the frame is lost, the next change re-sends. */
  private failed(channel: string, chatId: string | null, error: unknown): void {
    this.log.warn({ err: error, channel, chatId }, "feed push failed");
  }

  /** Subscribes the notify fan-out and starts the poll timers. */
  start(): void {
    if (this.unsubscribe !== null || this.stopped) return;
    const off = this.ctx.notify.subscribe(this.onNotify, this.resync);
    this.unsubscribe = off;
    this.viewTimer = setInterval(() => {
      if (++this.ticks % SWEEP_EVERY_TICKS === 0) this.sweep();
      void this.publishDirtyViews().catch((error: unknown) => this.failed("view_poll", null, error));
    }, VIEW_POLL_MS);
    this.viewTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.agentState.stop();
    if (this.viewTimer !== undefined) clearInterval(this.viewTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The LISTEN connection came back: every NOTIFY sent while it was down
   *  is lost. Each connected user's workspace, agent lists and skill
   *  catalog are re-pushed (each socket receives only what differs from
   *  what it holds), and every chat a socket shows re-captures its view and
   *  subtree; the captures compare against the last value sent. */
  private resync = (): void => {
    if (this.stopped) return;
    for (const { userId, orgId } of this.ctx.hub.memberUsers()) {
      void this.pushWorkspace(orgId, userId, ALL_PARTS);
      void this.agentState.connect(orgId, userId).catch((error: unknown) => this.failed("resync", null, error));
      for (const sink of this.ctx.hub.memberSinksOfUser(userId)) {
        if (typeof sink.view !== "string") continue;
        this.markDirty(sink.view);
        this.subagentTree(sink.view);
      }
    }
  };

  // -- notify fan-in ------------------------------------------------------------

  private onNotify: NotifyHandler = (channel, payload) => {
    if (this.stopped) return;
    if (channel === "guild_thread_committed") {
      if (payload === "") return;
      void this.committed(payload).catch((error: unknown) => this.failed(channel, payload, error));
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
      // Owner-scoped: only the owner's sockets get the frame.
      const frame: WsServerMsg = {
        type: "chat_status",
        chat_id: parsed.chat_id,
        generating: parsed.generating,
      };
      this.sendToUser(parsed.user_id, frame);
      // The flip moves the chat's list row (its spinner, its unread dot):
      // each socket gets that row alone.
      void this.pushWorkspace(parsed.org_id, parsed.user_id, ["chats"]);
      // A generating flip changes the chat's view content: the next view
      // poll re-captures and broadcasts it if it differs.
      if (!this.chats.has(parsed.chat_id)) {
        this.remember(parsed.chat_id, { orgId: parsed.org_id, userId: parsed.user_id, machineId: null });
      }
      this.markDirty(parsed.chat_id);
      return;
    }
    if (channel === "guild_workspace") {
      let parsed: { org_id?: string; user_id?: string; parts?: unknown };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof parsed.org_id !== "string" || typeof parsed.user_id !== "string") return;
      // Every sidebar list (chats, archived, projects, machines) rides one
      // serialized push, so a snapshot taken before a write can never land
      // after the one that carries it. A payload naming its `parts` re-reads
      // only those.
      const parts = Array.isArray(parsed.parts)
        ? parsed.parts.filter((part): part is WorkspacePart => ALL_PARTS.includes(part as WorkspacePart))
        : ALL_PARTS;
      void this.pushWorkspace(parsed.org_id, parsed.user_id, parts.length > 0 ? parts : ALL_PARTS);
      return;
    }
    if (channel === "guild_org") {
      let parsed: { org_id?: string };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof parsed.org_id !== "string") return;
      void this.pushWorkspaceIdentity(parsed.org_id).catch((error: unknown) => this.failed(channel, null, error));
      return;
    }
    if (channel === "guild_models") {
      let parsed: { org_id?: string };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof parsed.org_id !== "string") return;
      void this.pushModelList(parsed.org_id).catch((error: unknown) => this.failed(channel, null, error));
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
      void this.orgEvent(parsed.org_id, parsed.event_id).catch((error: unknown) => this.failed(channel, null, error));
      return;
    }
    if (channel === "guild_compaction") {
      if (payload === "") return;
      void this.compaction(payload).catch((error: unknown) => this.failed(channel, null, error));
      return;
    }
    if (channel === "guild_subagent_tree") {
      if (payload === "") return;
      this.subagentTree(payload);
      return;
    }
    this.agentState.onNotify(channel, payload);
  };

  /** A member socket connected: its agent list and skill catalog. */
  connectMember(orgId: string, userId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.agentState.connect(orgId, userId);
  }

  /** One chat's thread subtree and header facts, pushed to its owner's
   *  sockets when they move. Both are display state, not log state, so each
   *  frame carries the whole value and the client replaces its view. Frames
   *  ride the chat's send chain so an older snapshot never lands after a
   *  newer one. */
  private subagentTree(chatId: string): void {
    this.enqueue(chatId, "guild_subagent_tree", async () => {
      const chat = await this.ensureChat(chatId, false);
      if (chat === null) return;
      if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
        this.evict(chatId);
        return;
      }
      const [nodes, tree] = await Promise.all([
        chatSubagentNodes(this.ctx.pool, chatId),
        chatTreeFacts(this.ctx.pool, chatId, chat.userId),
      ]);
      const wire = JSON.stringify(nodes);
      if (this.subagentTrees.get(chatId) !== wire) {
        this.subagentTrees.set(chatId, wire);
        this.sendToUser(chat.userId, subagentTreeMsg(chatId, nodes));
      }
      if (tree === null) return;
      const treeWire = JSON.stringify(tree);
      if (this.chatTrees.get(chatId) === treeWire) return;
      this.chatTrees.set(chatId, treeWire);
      this.sendToUser(chat.userId, chatTreeMsg(tree));
    });
  }

  private async committed(chatId: string): Promise<void> {
    const chat = await this.ensureChat(chatId, true);
    if (chat === null) return;
    // Nobody is listening: drop the chat's cached state so the next
    // connection re-captures from scratch.
    if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
      this.evict(chatId);
      return;
    }
    // List-level state: a new user turn creates the row (and moves its
    // activity stamp), an assistant turn moves the unread count, and an
    // approval request or decision flips the blocked flag. Each one moves
    // only the chat list, and each socket gets only the rows that changed.
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
      void this.pushWorkspace(chat.orgId, chat.userId, ["chats"]);
    }
    // An open turn owns the view: instead of re-broadcasting the whole
    // thread per append, fan out only the rows committed since the last
    // fan-out (thread_events frames). Tool calls, approval cards and
    // messages all land as durable-log events — the client renders them
    // through the same replay rules a refresh uses, live.
    const since = this.sentSeqs.get(chatId);
    if (this.generations.has(chatId) && since !== undefined) {
      // The incremental rows carry the commit; a pending plain republish
      // has nothing left to add.
      if (this.dirtyChats.get(chatId)?.force === false) this.dirtyChats.delete(chatId);
      this.publishIncremental(chatId, chat.userId, since);
      return;
    }
    this.markDirty(chatId);
  }

  private async orgEvent(orgId: string, eventId: string): Promise<void> {
    const event = await this.ctx.events.get(orgId, eventId);
    if (event === null) return;
    this.sendToOrg(orgId, { type: "org_event", event });
  }

  // -- view captures --------------------------------------------------------------

  /** Marks a chat's view for the view tick. Writes that land together
   *  (a turn's end, a compaction's summary and settlement) share one
   *  republish; `force` survives the coalescing. */
  private markDirty(chatId: string, force = false): void {
    const pending = this.dirtyChats.get(chatId);
    if (pending === undefined) {
      this.dirtyChats.set(chatId, { first: this.ticks, last: this.ticks, force });
      return;
    }
    pending.last = this.ticks;
    pending.force ||= force;
  }

  /** Republishes every dirty view that has been quiet for a whole tick or
   *  has waited the longest allowed. */
  private async publishDirtyViews(): Promise<void> {
    if (this.publishing || this.dirtyChats.size === 0) return;
    const due: [string, boolean][] = [];
    for (const [chatId, pending] of this.dirtyChats) {
      if (pending.last <= this.ticks - 2 || pending.first <= this.ticks - VIEW_MAX_WAIT_TICKS) {
        due.push([chatId, pending.force]);
      }
    }
    if (due.length === 0) return;
    for (const [chatId] of due) this.dirtyChats.delete(chatId);
    this.publishing = true;
    try {
      for (const [chatId, force] of due) {
        try {
          const chat = await this.ensureChat(chatId, false);
          if (chat === null) continue;
          if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
            this.evict(chatId);
            continue;
          }
          await this.publishView(chatId, chat.orgId, chat.userId, force);
        } catch (error) {
          this.failed("view_poll", chatId, error);
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  /** The owner's member sockets that display a chat: those whose newest
   *  `sync` named it, and those that never sent one (the engine's turn
   *  stream). */
  private viewSinks(userId: string, chatId: string): SocketSink[] {
    return this.ctx.hub
      .memberSinksOfUser(userId)
      .filter((sink) => sink.view === undefined || sink.view === chatId);
  }

  /** One capture → broadcast if the seq-zeroed content differs from the
   *  last view (the frame itself carries the real seq), or always when
   *  `force`: a client can hold a flag the server never sent (a /compact it
   *  armed itself), so a compaction's settlement re-asserts the view. The
   *  chat's context usage follows every capture, deduped on its own. With no
   *  socket displaying the chat nothing is captured, and the cached view is
   *  dropped: a socket that opens it later gets the whole view in its sync
   *  bracket. */
  private async publishView(chatId: string, orgId: string, userId: string, force = false): Promise<void> {
    if (this.viewSinks(userId, chatId).length === 0) {
      this.views.delete(chatId);
      this.contextUsages.delete(chatId);
      return;
    }
    const capture = await captureThreadState(this.ctx, this.ctx.pool, orgId, chatId);
    await this.publishContextUsage(chatId, orgId, userId);
    const dedupe = threadStateWire({ ...capture, seq: 0 });
    if (!force && this.views.get(chatId) === dedupe) return;
    this.views.set(chatId, dedupe);
    const frame = threadStateMsg(capture);
    for (const sink of this.viewSinks(userId, chatId)) sink.send(frame);
    // The full view carried every row of the log: the incremental lane
    // resumes above the newest one it delivered (the capture watermark
    // is reserved later than the read — a row can commit in between).
    const maxRow = capture.events.reduce((max, row) => Math.max(max, row.seq), 0);
    this.sentSeqs.set(chatId, Math.max(this.sentSeqs.get(chatId) ?? 0, maxRow));
  }

  /** The chat's context usage, pushed when it differs from the last one
   *  sent (a turn ended, a compaction moved the measured window). */
  private async publishContextUsage(chatId: string, orgId: string, userId: string): Promise<void> {
    const frame = await contextUsageMsg(this.ctx, orgId, chatId);
    const wire = JSON.stringify(frame);
    if (this.contextUsages.get(chatId) === wire) return;
    this.contextUsages.set(chatId, wire);
    for (const sink of this.viewSinks(userId, chatId)) sink.send(frame);
  }

  /** A compaction task of a conversation was written (created or settled):
   *  its chat's next view republish sends even when the capture matches the
   *  last one, so a compaction that began and ended between two captures,
   *  with no summary, still lowers the line a client armed. The republish
   *  rides the view tick with the chat's other writes. */
  private async compaction(conversationId: string): Promise<void> {
    const res = await this.ctx.pool.query<{ chat_id: string }>(
      "SELECT chat_id FROM chat_conversations WHERE conversation_id = $1",
      [conversationId],
    );
    for (const { chat_id: chatId } of res.rows) {
      const chat = await this.ensureChat(chatId, false);
      if (chat === null) continue;
      if (this.ctx.hub.sinksOfUser(chat.userId).length === 0) {
        this.evict(chatId);
        continue;
      }
      this.markDirty(chatId, true);
    }
  }

  // -- live generation frames ---------------------------------------------------

  open(chatId: string, generationId: string): void {
    this.generations.set(chatId, generationId);
    this.lookup(chatId, "open");
    // Baseline on the chat's send chain (ordered before any incremental
    // this turn commits): everything already durable reached clients via
    // sync; the turn fans out only rows appended after this max.
    this.enqueue(chatId, "open", async () => {
      if (this.generations.get(chatId) !== generationId) return;
      try {
        const res = await this.ctx.pool.query<{ max: string | null }>(
          "SELECT MAX(seq) AS max FROM thread_events WHERE chat_id = $1",
          [chatId],
        );
        this.sentSeqs.set(chatId, Number(res.rows[0]?.max ?? 0));
      } catch (error) {
        // Without a baseline, committed() falls back to full-view publishes.
        this.sentSeqs.delete(chatId);
        this.failed("open", chatId, error);
      }
    });
  }

  event(chatId: string, event: StreamWireEvent): void {
    const generationId = this.generations.get(chatId);
    if (generationId === undefined) return;
    // The generation identity and the frame order are captured now; the
    // async owner lookup + watermark ride the per-chat chain.
    this.enqueue(chatId, "live_frame", async () => {
      const chat = await this.ensureChat(chatId, false);
      if (chat === null) return;
      if (this.viewSinks(chat.userId, chatId).length === 0) return;
      const seq = await this.ctx.threads.watermark();
      const frame: WsServerMsg = {
        type: "live_frame",
        chat_id: chatId,
        generation_id: generationId,
        seq,
        machine_id: chat.machineId,
        event,
      };
      for (const sink of this.viewSinks(chat.userId, chatId)) sink.send(frame);
    });
  }

  dirty(chatId: string): void {
    this.markDirty(chatId);
  }

  /** One incremental fan-out on the chat's send chain: rows appended since
   *  `since`, as a thread_events frame (same serialized chain as the live
   *  frames, so a committed row never overtakes its own stream frames). */
  private publishIncremental(chatId: string, userId: string, since: number): void {
    this.enqueue(chatId, "guild_thread_committed", async () => {
      if (this.generations.get(chatId) === undefined) return;
      const rows = await this.ctx.threads.listEventsSince(chatId, since);
      if (rows.length === 0) return;
      const maxRow = rows.reduce((max, row) => Math.max(max, row.seq), since);
      this.sentSeqs.set(chatId, Math.max(this.sentSeqs.get(chatId) ?? 0, maxRow));
      const frame: WsServerMsg = {
        type: "thread_events",
        chat_id: chatId,
        seq: maxRow,
        events: rows,
      };
      for (const sink of this.viewSinks(userId, chatId)) sink.send(frame);
    });
  }

  close(chatId: string): void {
    const generationId = this.generations.get(chatId);
    this.enqueue(chatId, "close", async () => {
      if (this.generations.get(chatId) === generationId) this.generations.delete(chatId);
      this.markDirty(chatId);
    });
  }

  /** Serializes one chat's async sends: order preserved, a failed op is
   *  logged and the chain moves on. */
  private enqueue(chatId: string, channel: string, op: () => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const settled: Promise<void> = prev.then(op).then(
      () => {
        if (this.chains.get(chatId) === settled) this.chains.delete(chatId);
      },
      (error: unknown) => {
        this.failed(channel, chatId, error);
        if (this.chains.get(chatId) === settled) this.chains.delete(chatId);
      },
    );
    this.chains.set(chatId, settled);
  }

  /** Drops a chat's cached view, tree and baseline. The next capture for
   *  a connected owner starts from a full view. */
  private evict(chatId: string): void {
    this.views.delete(chatId);
    this.subagentTrees.delete(chatId);
    this.chatTrees.delete(chatId);
    this.contextUsages.delete(chatId);
    this.sentSeqs.delete(chatId);
    this.dirtyChats.delete(chatId);
  }

  /** Evicts every chat whose owner has no socket (or whose identity left
   *  the LRU), so cached state follows the connected users, not history. */
  sweep(): void {
    const chatIds = new Set([
      ...this.views.keys(),
      ...this.subagentTrees.keys(),
      ...this.chatTrees.keys(),
      ...this.contextUsages.keys(),
      ...this.sentSeqs.keys(),
    ]);
    for (const chatId of chatIds) {
      const chat = this.chats.get(chatId);
      if (chat === undefined || this.ctx.hub.sinksOfUser(chat.userId).length === 0) this.evict(chatId);
    }
  }

  /** Caches one identity as the most recently used, evicting the oldest
   *  past the bound. */
  private remember(chatId: string, identity: ChatIdentity): void {
    this.chats.delete(chatId);
    this.chats.set(chatId, identity);
    if (this.chats.size > MAX_CACHED_CHATS) {
      const oldest = this.chats.keys().next().value;
      if (oldest !== undefined) this.chats.delete(oldest);
    }
  }

  /** Warms the identity cache without waiting on it. */
  private lookup(chatId: string, channel: string): void {
    void this.ensureChat(chatId, false).catch((error: unknown) => this.failed(channel, chatId, error));
  }

  private async ensureChat(chatId: string, refresh: boolean): Promise<ChatIdentity | null> {
    if (!refresh) {
      const cached = this.chats.get(chatId);
      if (cached !== undefined) {
        this.remember(chatId, cached);
        return cached;
      }
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
      this.remember(chatId, identity);
      return identity;
    })();
    this.chatLookups.set(chatId, lookup);
    try {
      return await lookup;
    } finally {
      this.chatLookups.delete(chatId);
    }
  }

  /** One serialized workspace push per user. Every list-changing write and
   *  presence flip calls this with the parts its change can move (all by
   *  default); the chain keeps the wire order equal to the commit order, so
   *  an older snapshot can never overtake a newer one. Each socket receives
   *  only what differs from what it holds: a socket's first push (on
   *  connect, always all parts) is the whole workspace, a later one is the
   *  change. */
  pushWorkspace(orgId: string, userId: string, parts: readonly WorkspacePart[] = ALL_PARTS): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = `${orgId}:${userId}`;
    const previous = this.workspaceChains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.sendWorkspace(orgId, userId, parts))
      .catch((error: unknown) => this.failed("guild_workspace", null, error));
    this.workspaceChains.set(key, next);
    void next.finally(() => {
      if (this.workspaceChains.get(key) === next) this.workspaceChains.delete(key);
    });
    return next;
  }

  private async sendWorkspace(orgId: string, userId: string, parts: readonly WorkspacePart[]): Promise<void> {
    if (this.stopped) return;
    const sinks = this.ctx.hub.sinksOfUser(userId);
    if (sinks.length === 0) return;
    const user = { org_id: orgId, id: userId };
    const want = new Set<WorkspacePart>(parts);
    const [info, chats, archived, projects, machines, models] = await Promise.all([
      want.has("identity") ? workspaceIdentitySnapshot(this.ctx, orgId) : null,
      want.has("chats") ? threadListSnapshot(this.ctx, user) : null,
      want.has("archived") ? archivedThreadListSnapshot(this.ctx, user) : null,
      want.has("projects") ? projectListSnapshot(this.ctx, user) : null,
      want.has("machines") ? machineListSnapshot(this.ctx, user) : null,
      want.has("models") ? modelListSnapshot(this.ctx, orgId) : null,
    ]);
    for (const sink of sinks) {
      // The chat list goes first: the local engine waits on it at
      // bootstrap; the rest are additive frames.
      if (chats !== null) sendChatList(sink, chats);
      if (info !== null) sendChanged(sink, "workspace_identity", { type: "workspace_identity", ...info });
      if (archived !== null) sendChanged(sink, "archived_thread_list", { type: "archived_thread_list", chats: archived });
      if (projects !== null) {
        sendChanged(sink, "project_list", {
          type: "project_list",
          projects: projects.projects,
          archived_projects: projects.archived_projects,
        });
      }
      if (machines !== null) sendChanged(sink, "machine_list", { type: "machine_list", machines });
      if (models !== null) sendChanged(sink, "model_list", { type: "model_list", models });
    }
  }

  // -- fan-out ------------------------------------------------------------------

  /** The workspace identity moved (an admin renamed it or changed the
   *  logo): every member socket of the org repaints its title. */
  private async pushWorkspaceIdentity(orgId: string): Promise<void> {
    if (this.stopped) return;
    const info = await workspaceIdentitySnapshot(this.ctx, orgId);
    const frame: WsServerMsg = { type: "workspace_identity", ...info };
    for (const sink of this.ctx.hub.sinksOfOrg(orgId)) sendChanged(sink, "workspace_identity", frame);
  }

  /** The org's model routes moved (an admin added, renamed, toggled or
   *  removed one): every member socket of the org repaints its pickers. */
  private async pushModelList(orgId: string): Promise<void> {
    if (this.stopped) return;
    const models = await modelListSnapshot(this.ctx, orgId);
    const frame: WsServerMsg = { type: "model_list", models };
    for (const sink of this.ctx.hub.sinksOfOrg(orgId)) sendChanged(sink, "model_list", frame);
  }

  /** Machine presence flip: the owner's member sockets repaint the online
   *  dot without polling the registry. */
  machineStatus(machineId: string, userId: string, orgId: string, online: boolean): void {
    if (this.stopped) return;
    const frame: WsServerMsg = { type: "machine_status", machine_id: machineId, online };
    for (const sink of this.ctx.hub.memberSinksOfUser(userId)) sink.send(frame);
    // A claim can be a new registration or a re-pair (the rows and the
    // chats' machine labels move), so the registry list repaints too.
    void this.pushWorkspace(orgId, userId, ["chats", "archived", "projects", "machines"]);
  }

  private sendToUser(userId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.sinksOfUser(userId)) sink.send(frame);
  }

  private sendToOrg(orgId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.sinksOfOrg(orgId)) sink.send(frame);
  }
}
