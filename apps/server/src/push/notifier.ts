// The one decision point for a push. A finished turn waits a short grace
// period; if the owner's read marker passed the turn's last event by then,
// they saw it (a client marks read only while that chat is open and on
// screen), so nothing is pushed. Otherwise one notification per thread per
// window. Every push is a hint to open the thread — the app syncs on open,
// so a lost push costs nothing.

import { createHash } from "node:crypto";
import type { PushStore, PushSubscriptionRow } from "../platform/store/push.js";
import type { PushPayload, PushSender } from "./sender.js";

/** One notification per thread per window; the OS also collapses by tag. */
const COALESCE_MS = 20_000;
/** How long a finished turn waits for a read before it pushes: a client
 *  watching the chat marks it read within a second of the final frame. */
export const READ_GRACE_MS = 4_000;

export interface TurnEndedEvent {
  orgId: string;
  userId: string;
  chatId: string;
  title: string;
  failed: boolean;
}

export interface PushNotifierDeps {
  store: PushStore;
  /** The seq of the chat's newest durable event; null for an empty log. */
  lastEventSeq(chatId: string): Promise<number | null>;
  /** The seq the user's read marker on the chat has reached. */
  readSeq(userId: string, chatId: string): Promise<number | null>;
  /** The wait before deciding; READ_GRACE_MS unless a test shortens it. */
  graceMs?: number;
  /** Resolved lazily: the VAPID pair is minted on first use. */
  sender(): Promise<PushSender>;
  log?: (message: string) => void;
}

export class PushNotifier {
  private readonly sentAt = new Map<string, number>();

  constructor(private readonly deps: PushNotifierDeps) {}

  /** A turn ended: after the grace period, push unless the owner read the
   *  chat through the turn's end. Resolves once decided; callers on the
   *  turn path do not wait for it. */
  async turnEnded(event: TurnEndedEvent): Promise<void> {
    try {
      const endSeq = await this.deps.lastEventSeq(event.chatId);
      await new Promise((resolve) => setTimeout(resolve, this.deps.graceMs ?? READ_GRACE_MS).unref?.());
      if (endSeq !== null) {
        const read = await this.deps.readSeq(event.userId, event.chatId);
        if (read !== null && read >= endSeq) return;
      }
      await this.notify(event.userId, event.chatId, turnEndedPayload(event), pushTopic(event.chatId));
    } catch (error) {
      this.deps.log?.(`push turnEnded failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A direct test push from the settings page; no read check, no
   *  coalescing: the user asked for it now. */
  async test(userId: string): Promise<number> {
    const rows = await this.deps.store.forUser(userId);
    if (rows.length === 0) return 0;
    const sender = await this.deps.sender();
    let delivered = 0;
    for (const row of rows) {
      const result = await sender.send(
        row,
        { title: "Guild notifications are on", body: "This is a test notification.", url: "/chats" },
        "guild-test",
      );
      await this.record(row, result.outcome, result.error);
      if (result.outcome === "ok") delivered += 1;
    }
    return delivered;
  }

  private async notify(userId: string, chatId: string, payload: PushPayload, topic: string): Promise<void> {
    const key = `${userId}:${chatId}`;
    const now = Date.now();
    const last = this.sentAt.get(key);
    if (last !== undefined && now - last < COALESCE_MS) return;
    const rows = await this.deps.store.forUser(userId);
    if (rows.length === 0) return;
    this.sentAt.set(key, now);
    // Bound the map: entries older than the window are dead weight.
    for (const [k, at] of this.sentAt) if (now - at > COALESCE_MS) this.sentAt.delete(k);
    const sender = await this.deps.sender();
    for (const row of rows) {
      const result = await sender.send(row, payload, topic);
      await this.record(row, result.outcome, result.error);
    }
  }

  private async record(row: PushSubscriptionRow, outcome: string, error?: string): Promise<void> {
    if (outcome === "ok") {
      await this.deps.store.markSeen(row.endpoint);
      return;
    }
    await this.deps.store.recordFailure(row.endpoint, error ?? "push failed", outcome === "gone");
    if (outcome !== "gone") this.deps.log?.(`push failed for ${row.endpoint}: ${error ?? "unknown"}`);
  }
}

/** The collapse topic: the push service allows 32 URL-safe characters, so a
 *  chat id is hashed. Stable per chat, so a second notification replaces the
 *  first instead of stacking. */
export function pushTopic(chatId: string): string {
  const digest = createHash("sha256").update(chatId).digest("base64url");
  return `c${digest.slice(0, 31)}`;
}

/** Generic by default: the notification says which thread and how it ended,
 *  not what the agent wrote. */
export function turnEndedPayload(event: TurnEndedEvent): PushPayload {
  return {
    title: event.title === "" ? "Guild" : event.title,
    body: event.failed ? "The run failed." : "The answer is ready.",
    url: `/thread/${event.chatId}`,
    tag: `chat-${event.chatId}`,
    chat_id: event.chatId,
  };
}
