// The one decision point for a push: a live member socket means the frame is
// enough, so nothing is pushed; no socket means one notification per thread
// per window. Every push is a hint to open the thread — the app syncs on
// open, so a lost push costs nothing.

import type { PushStore, PushSubscriptionRow } from "../platform/store/push.js";
import type { PushPayload, PushSender } from "./sender.js";

/** One notification per thread per window; the OS also collapses by tag. */
const COALESCE_MS = 20_000;

export interface TurnEndedEvent {
  orgId: string;
  userId: string;
  chatId: string;
  title: string;
  failed: boolean;
}

export interface PushNotifierDeps {
  store: PushStore;
  /** True when the user has at least one live member socket. */
  isPresent(userId: string): boolean;
  /** Resolved lazily: the VAPID pair is minted on first use. */
  sender(): Promise<PushSender>;
  log?: (message: string) => void;
}

export class PushNotifier {
  private readonly sentAt = new Map<string, number>();

  constructor(private readonly deps: PushNotifierDeps) {}

  /** A turn ended for a chat its owner is not watching. */
  async turnEnded(event: TurnEndedEvent): Promise<void> {
    try {
      await this.notify(event.userId, event.chatId, turnEndedPayload(event), `chat-${event.chatId}`);
    } catch (error) {
      this.deps.log?.(`push turnEnded failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A direct test push from the settings page; no presence gate, no
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
    // Presence gate: a live socket already carries the frame.
    if (this.deps.isPresent(userId)) return;
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
