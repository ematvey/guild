// Queue-state cursor: submissions feed the queue state. The transcript cursor
// (chat_projection_cursors) is separate and lives in projection.ts.
// coherence:seam owner=@maintainer until=2027-01-31 reason="durable log and platform tables retire at different times"

import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import { withTransaction, type PlatformPool } from "../platform/db.js";
import { changedSubmissions, unprojectedFailedGenerations } from "../storage/postgres/queries.js";

/** Incremental platform reconciliation, independent of bounded live events. */
export class ConversationRecovery {
  constructor(private readonly pool: PlatformPool) {}

  async submissions(chatId: string, conversationId: ConversationId): Promise<SubmissionRecord[]> {
    const records = await changedSubmissions(this.pool, chatId, conversationId);
    return records.map((record) => JSON.parse(record) as SubmissionRecord);
  }

  async acknowledge(chatId: string, records: readonly SubmissionRecord[]): Promise<void> {
    if (!records.length) return;
    await withTransaction(this.pool, async (client) => {
      for (const record of records) {
        await client.query(
          `INSERT INTO chat_submission_projections(submission_id,chat_id,status,entry_id,answer_id)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(submission_id) DO UPDATE SET status=EXCLUDED.status,entry_id=EXCLUDED.entry_id,answer_id=EXCLUDED.answer_id`,
          [
            record.id,
            chatId,
            record.status,
            record.entry ?? null,
            record.type === "input" && record.status === "done" ? record.answer : null,
          ],
        );
      }
      const last = records.reduce((max, record) => Math.max(max, Number(record.id)), 0);
      await client.query(
        `INSERT INTO chat_reconciliation_cursors(chat_id,conversation_id,submission_id) VALUES($1,$2,$3)
        ON CONFLICT(chat_id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,
          submission_id=CASE WHEN chat_reconciliation_cursors.conversation_id=EXCLUDED.conversation_id
            THEN GREATEST(chat_reconciliation_cursors.submission_id,EXCLUDED.submission_id) ELSE EXCLUDED.submission_id END`,
        [chatId, records[0]!.conversationId, last],
      );
    });
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
