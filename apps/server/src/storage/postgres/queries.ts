// The durable tables' named reads: every query outside the storage engine
// that touches tasks, entries, submissions, documents or durable_* goes
// through a function here. Records are JSON text and are returned as text;
// decoding them is the caller's (chats/, harness/). The joins name the
// Guild-side chat ↔ conversation mapping (chat_conversations, alias c).
// A leaf module: it imports nothing from the server tree, so the DAL may
// use it.

/** The slice of a pg pool or client these reads take. */
export interface DurableQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** SQL fragments over the mapping alias c. Agent work: any live task or a
 *  queued submission. */
export const agentWorkSql = `EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.conversation_id AND t.status<>'terminal')
  OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id=c.conversation_id AND s.status='queued')`;
/** Generation work: a live generation task or a queued submission (the
 *  chat's generating flag follows it). */
export const generationWorkSql = `EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.conversation_id
  AND t.kind='"pi.generation"' AND t.status<>'terminal')
  OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id=c.conversation_id AND s.status='queued')`;
/** Projection work: entries, failed generations or submission states the
 *  chat's projection has not caught up on. */
export const projectionWorkSql = `EXISTS (SELECT 1 FROM entries e WHERE e.conversation_id=c.conversation_id
  AND e.id>COALESCE((SELECT p.entry_id FROM chat_projection_cursors p WHERE p.chat_id=c.chat_id AND p.conversation_id=c.conversation_id),0))
  OR EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.conversation_id AND t.kind='"pi.generation"' AND t.status='terminal'
    AND t.outcome_status IN ('failed','faulted','orphaned')
    AND NOT EXISTS(SELECT 1 FROM chat_task_projections p WHERE p.task_id=t.id))
  OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id=c.conversation_id AND s.status<>'queued'
    AND NOT EXISTS(SELECT 1 FROM chat_submission_projections p WHERE p.submission_id=s.id AND p.status=s.status))`;

/** Chats whose conversation has durable work (and, with `projections`,
 *  projection work), or whose generating flag is set. */
export async function chatsWithWork(db: DurableQueryable, projections = true): Promise<{ chatId: string }[]> {
  const result = await db.query<{ chat_id: string }>(
    `SELECT c.chat_id FROM chat_conversations c JOIN chats ch ON ch.id=c.chat_id
    WHERE ch.generating OR (${agentWorkSql}) ${projections ? `OR (${projectionWorkSql})` : ""}`,
  );
  return result.rows.map((row) => ({ chatId: row.chat_id }));
}

/** The pending-work probe: does the chat's conversation still have agent
 *  or projection work? */
export function pendingWorkQuery(db: DurableQueryable): (chatId: string) => Promise<boolean> {
  return async (chatId) => {
    const result = await db.query<{ pending: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM chat_conversations c WHERE c.chat_id=$1
      AND ((${agentWorkSql}) OR (${projectionWorkSql}))) AS pending`,
      [chatId],
    );
    return result.rows[0]?.pending === true;
  };
}

/** The durable schema version the storage migrations recorded; null when
 *  the table is empty. */
export async function durableSchemaVersion(db: DurableQueryable): Promise<number | null> {
  const result = await db.query<{ version: number }>("SELECT version FROM durable_schema WHERE singleton=1");
  return result.rows[0]?.version ?? null;
}

/** Records the legacy task boundary once: tasks up to the current maximum
 *  predate the task-failure projection. */
export async function seedRecoveryBoundary(db: DurableQueryable): Promise<void> {
  await db.query(
    "INSERT INTO chat_recovery_metadata(singleton,legacy_task_id) SELECT true,COALESCE(max(id),0) FROM tasks ON CONFLICT DO NOTHING",
  );
}

/** Submissions of the conversation the chat has not reconciled yet: those
 *  past the chat's cursor, and projected ones whose status moved. */
export async function changedSubmissions(
  db: DurableQueryable,
  chatId: string,
  conversationId: number | string,
): Promise<string[]> {
  const result = await db.query<{ record: string }>(
    `SELECT record FROM (
      SELECT s.id,s.record FROM submissions s WHERE s.conversation_id=$1
        AND s.id>COALESCE((SELECT submission_id FROM chat_reconciliation_cursors WHERE chat_id=$2 AND conversation_id=$1),0)
      UNION
      SELECT s.id,s.record FROM chat_submission_projections p JOIN submissions s ON s.id=p.submission_id
        WHERE p.chat_id=$2 AND p.status IN ('queued','placed') AND s.status<>p.status
    ) changed ORDER BY id`,
    [conversationId, chatId],
  );
  return result.rows.map((row) => row.record);
}

/** Failed generation tasks of the conversation not projected yet. */
export async function unprojectedFailedGenerations(
  db: DurableQueryable,
  conversationId: number | string,
): Promise<{ id: number; record: string }[]> {
  const result = await db.query<{ id: number; record: string }>(
    `SELECT t.id,t.record FROM tasks t
    WHERE t.conversation_id=$1 AND t.kind='"pi.generation"' AND t.status='terminal'
      AND t.outcome_status IN ('failed','faulted','orphaned')
      AND NOT EXISTS(SELECT 1 FROM chat_task_projections p WHERE p.task_id=t.id) ORDER BY t.id`,
    [conversationId],
  );
  return result.rows.map((row) => ({ id: Number(row.id), record: row.record }));
}

/** The chat's compaction activity: whether a compaction task is live, and
 *  the records of its conversation's queued submissions. */
export async function compactionActivity(
  db: DurableQueryable,
  chatId: string,
): Promise<{ running: boolean; queued: string[] }> {
  const result = await db.query<{ running: boolean; queued: string[] }>(
    "SELECT EXISTS (" +
      "SELECT 1 FROM tasks t JOIN chat_conversations c ON c.conversation_id = t.conversation_id " +
      "WHERE c.chat_id = $1 AND t.kind = '\"pi.compaction\"' AND t.status <> 'terminal'" +
      ") AS running, ARRAY(" +
      "SELECT s.record FROM submissions s JOIN chat_conversations c ON c.conversation_id = s.conversation_id " +
      "WHERE c.chat_id = $1 AND s.status = 'queued'" +
      ") AS queued",
    [chatId],
  );
  const row = result.rows[0];
  return { running: row?.running === true, queued: row?.queued ?? [] };
}

/** One compaction task of the chat's conversation; null when it is not
 *  one. */
export async function compactionTask(
  db: DurableQueryable,
  chatId: string,
  taskId: number,
): Promise<{ status: string; record: string } | null> {
  const result = await db.query<{ status: string; record: string }>(
    `SELECT t.status,t.record FROM tasks t
     JOIN chat_conversations c ON c.conversation_id=t.conversation_id
     WHERE c.chat_id=$1 AND t.id=$2 AND t.kind='"pi.compaction"'`,
    [chatId, taskId],
  );
  return result.rows[0] ?? null;
}

/** One submission of the chat's conversation; null when it is not one. */
export async function chatSubmission(
  db: DurableQueryable,
  chatId: string,
  submissionId: number,
): Promise<{ status: string; record: string } | null> {
  const result = await db.query<{ status: string; record: string }>(
    `SELECT s.status,s.record FROM submissions s
     JOIN chat_conversations c ON c.conversation_id=s.conversation_id
     WHERE c.chat_id=$1 AND s.id=$2`,
    [chatId, submissionId],
  );
  return result.rows[0] ?? null;
}

/** The request id a submission carries (its JSON text unwrapped); null
 *  when the submission is gone or has none. */
export async function submissionRequestId(db: DurableQueryable, submissionId: number): Promise<string | null> {
  const result = await db.query<{ request_id: string | null }>(
    "SELECT request_id::jsonb #>> '{}' AS request_id FROM submissions WHERE id=$1",
    [submissionId],
  );
  return result.rows[0]?.request_id ?? null;
}

/** Whether an abort was requested for a task; null when the task is gone. */
export async function taskAbortRequested(db: DurableQueryable, taskId: number): Promise<boolean | null> {
  const result = await db.query<{ abort_requested: boolean }>("SELECT abort_requested FROM tasks WHERE id = $1", [
    taskId,
  ]);
  return result.rows[0]?.abort_requested ?? null;
}

/** The newest assistant entries of the chat's conversation since its last
 *  head change (reset or compaction), newest first, as record text. */
export async function assistantEntriesSinceHead(
  db: DurableQueryable,
  orgId: string,
  chatId: string,
  limit: number,
): Promise<string[]> {
  const result = await db.query<{ record: string }>(
    `SELECT e.record FROM entries e
     JOIN chat_conversations cc ON cc.conversation_id = e.conversation_id
     JOIN chats ch ON ch.id = cc.chat_id
     WHERE ch.org_id = $1 AND ch.id = $2
       AND e.id > COALESCE((SELECT h.id FROM entries h
         WHERE h.conversation_id = e.conversation_id AND h.head IS NOT NULL ORDER BY h.id DESC LIMIT 1), 0)
       AND e.kind = 'pi.assistant'
     ORDER BY e.id DESC LIMIT $3`,
    [orgId, chatId, limit],
  );
  return result.rows.map((row) => row.record);
}
