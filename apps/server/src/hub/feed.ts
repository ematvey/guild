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

import type { PlatformContext } from "../platform/context.js";
import type { ChatsCtx } from "../platform/contexts.js";
import type { PlatformPool } from "../platform/db.js";
import type { UserRow } from "../platform/store/identity.js";
import { pgTimestampToRfc3339 } from "../platform/time.js";
import type { NotifyHandler } from "../platform/notify.js";
import { captureThreadState, threadStateMsg, threadStateWire } from "../chats/thread-state.js";
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
  /** Per-chat send chains: the async watermark + fan-out of one frame
   *  serializes before the next, so frame order matches emission order. */
  private readonly chains = new Map<string, Promise<void>>();
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
    if (channel === "guild_events") {
      let parsed: { org_id?: string; event_id?: string };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof parsed.org_id !== "string" || typeof parsed.event_id !== "string") return;
      void this.orgEvent(parsed.org_id, parsed.event_id).catch(() => {});
    }
  };

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
    // A streaming turn owns its view: intermediate commits (per-step
    // assistant messages, tool results) ride the run-end publish — the
    // generating=false flip dirties the chat exactly once per turn. Each
    // frame carries the full event history, so per-commit publishes
    // re-broadcast the whole thread per step.
    if (this.generations.has(chatId)) {
      this.dirtyChats.delete(chatId);
      return;
    }
    this.dirtyChats.delete(chatId);
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
  }

  // -- live generation frames (Rust Feed::drain_events) -----------------------

  open(chatId: string, generationId: string): void {
    this.generations.set(chatId, generationId);
    void this.ensureChat(chatId, false);
  }

  event(chatId: string, event: StreamWireEvent): void {
    const generationId = this.generations.get(chatId);
    if (generationId === undefined) return;
    // The generation identity and the frame order are captured now; the
    // async owner lookup + watermark ride the per-chat chain.
    this.enqueue(chatId, async () => {
      const chat = await this.ensureChat(chatId, false);
      if (chat === null || this.generations.get(chatId) !== generationId) return;
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

  close(chatId: string): void {
    this.generations.delete(chatId);
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
      let list;
      try {
        list = await threadListSnapshot(this.ctx, this.ctx.pool, { org_id: bindings.orgId, id: userId } as UserRow);
      } catch {
        continue;
      }
      this.sendToUser(userId, { type: "thread_list", chats: list });
    }
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

  private sendToUser(userId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.sinksOfUser(userId)) sink.send(frame);
  }

  private sendToOrg(orgId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.sinksOfOrg(orgId)) sink.send(frame);
  }
}

// ---------------------------------------------------------------------------
// Shared thread-list snapshot (moved verbatim from http/ws.ts — the connect
// bootstrap and the presence poll render the same payload).

/** The same thread-list payload as GET /api/v1/chats (Rust
 *  feed::thread_list_filtered), computed for a push: every active
 *  (non-archived) chat of the caller with the hub's live machine state. */
export async function threadListSnapshot(chats: ChatsCtx, pool: PlatformPool, user: Pick<UserRow, "org_id" | "id">): Promise<unknown[]> {
  const res = await pool.query<{
    id: string;
    org_id: string;
    user_id: string;
    title: string | null;
    created_at: string;
    machine_id: string | null;
    machine_label: string | null;
    generating: boolean;
    unread: boolean;
    project_id: string | null;
    project_name: string | null;
    project_machine_label: string | null;
  }>(
    `SELECT c.id, c.org_id, c.user_id, c.title,
            to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            c.machine_id, c.machine_label, c.generating, c.project_id, pr.name AS project_name,
            m.label AS project_machine_label,
            c.generating = false AND EXISTS (
              SELECT 1 FROM thread_events e
              WHERE e.chat_id = c.id AND e.type = 'assistant_message'
                AND (r.last_read_seq IS NULL OR e.seq > r.last_read_seq)) AS unread
     FROM chats c
     LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $2
     LEFT JOIN projects pr ON pr.id = c.project_id
     LEFT JOIN machines m ON m.machine_id = pr.machine_id
     WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NULL
     ORDER BY c.created_at DESC, c.id DESC`,
    [user.org_id, user.id],
  );
  return res.rows.map((chat) => {
    const online = chat.machine_id !== null && chats.hub.machineOnline(chat.machine_id);
    // Old chats stored the raw machine id as their label; the live hub label
    // (the machine's hostname) is the truth when the slot is up.
    const label =
      online && chat.machine_id !== null
        ? (chats.hub.machineLabel(chat.machine_id) ?? chat.machine_id)
        : chat.machine_label;
    // Key order: the Rust handler serializes each chat through
    // serde_json::Value (json! BTreeMap), so the wire order is ALPHABETICAL —
    // verified against the Rust server's captured frames (ws-golden.json).
    return {
      created_at: pgTimestampToRfc3339(chat.created_at),
      generating: chat.generating,
      id: chat.id,
      ...(chat.machine_id !== null ? { machine_id: chat.machine_id } : {}),
      ...(label !== null ? { machine_label: label } : {}),
      machine_online: online,
      org_id: chat.org_id,
      ...(chat.project_id !== null ? { project_id: chat.project_id } : {}),
      ...(chat.project_name !== null ? { project_name: chat.project_name } : {}),
      ...(chat.project_machine_label !== null
        ? { project_machine_label: chat.project_machine_label }
        : {}),
      ...(chat.title !== null ? { title: chat.title } : {}),
      unread: chat.unread,
      user_id: chat.user_id,
    };
  });
}
