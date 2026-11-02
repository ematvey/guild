// Queue-state cursor: submissions feed the queue state. The transcript cursor
// (chat_projection_cursors) is separate and lives in projection.ts.
// coherence:seam owner=@maintainer until=2027-01-31 reason="durable log and platform tables retire at different times"

import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import type { ConversationMapStore } from "../platform/store/conversations.js";
import { changedSubmissions, unprojectedFailedGenerations } from "../storage/postgres/queries.js";

/** Incremental platform reconciliation, independent of bounded live events. */
export class ConversationRecovery {
  constructor(
    private readonly pool: PlatformPool,
    private readonly conversations: Pick<ConversationMapStore, "acknowledgeSubmissions">,
  ) {}

  async submissions(chatId: string, conversationId: ConversationId): Promise<SubmissionRecord[]> {
    const records = await changedSubmissions(this.pool, chatId, conversationId);
    return records.map((record) => JSON.parse(record) as SubmissionRecord);
  }

  async acknowledge(chatId: string, records: readonly SubmissionRecord[]): Promise<void> {
    if (!records.length) return;
    await this.conversations.acknowledgeSubmissions(
      chatId,
      records[0]!.conversationId,
      records.map((record) => ({
        id: record.id,
        status: record.status,
        entry: record.entry ?? null,
        answer: record.type === "input" && record.status === "done" ? record.answer : null,
      })),
    );
  }

  async failures(
    _chatId: string,
    conversationId: ConversationId,
    persist: (taskId: number, message: string) => Promise<unknown>,
  ): Promise<void> {
    for (const row of await unprojectedFailedGenerations(this.pool, conversationId)) {
      const record = JSON.parse(row.record) as {
        state: { outcome: { error?: { message?: string }; reason?: string } };
      };
      const outcome = record.state.outcome;
      await persist(Number(row.id), outcome.error?.message ?? outcome.reason ?? "Generation failed");
    }
  }
}
