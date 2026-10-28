// Queue-state cursor: submissions feed the queue state. The transcript cursor
// (chat_projection_cursors) is separate and lives in projection.ts.
// coherence:seam owner=@ematvey until=2027-01-31 reason="durable log and platform tables retire at different times"

import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";

/** Incremental platform reconciliation, independent of bounded live events. */
export class ConversationRecovery {
  constructor(private readonly pool: PlatformPool) {}

  async submissions(chatId: string, conversationId: ConversationId): Promise<SubmissionRecord[]> {
    const result = await this.pool.query<{ record: string }>(
      `SELECT record FROM (
        SELECT s.id,s.record FROM submissions s WHERE s.conversation_id=$1
          AND s.id>COALESCE((SELECT submission_id FROM chat_reconciliation_cursors WHERE chat_id=$2 AND conversation_id=$1),0)
        UNION
        SELECT s.id,s.record FROM chat_submission_projections p JOIN submissions s ON s.id=p.submission_id
          WHERE p.chat_id=$2 AND p.status IN ('queued','placed') AND s.status<>p.status
      ) changed ORDER BY id`,
      [conversationId, chatId],
    );
    return result.rows.map((row) => JSON.parse(row.record) as SubmissionRecord);
  }

  async acknowledge(chatId: string, records: readonly SubmissionRecord[]): Promise<void> {
    if (!records.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failures(
    _chatId: string,
    conversationId: ConversationId,
    persist: (taskId: number, message: string) => Promise<unknown>,
  ): Promise<void> {
    const result = await this.pool.query<{ id: number; record: string }>(
      `SELECT t.id,t.record FROM tasks t
      WHERE t.conversation_id=$1 AND t.kind='"pi.generation"' AND t.status='terminal'
        AND t.outcome_status IN ('failed','faulted','orphaned')
        AND NOT EXISTS(SELECT 1 FROM chat_task_projections p WHERE p.task_id=t.id) ORDER BY t.id`,
      [conversationId],
    );
    for (const row of result.rows) {
      const record = JSON.parse(row.record) as {
        state: { outcome: { error?: { message?: string }; reason?: string } };
      };
      const outcome = record.state.outcome;
      await persist(Number(row.id), outcome.error?.message ?? outcome.reason ?? "Generation failed");
    }
  }
}
