import type { PlatformPool } from "../db.js";

/** SQL fragments share the mapping alias c. UI generating remains agent-only. */
export const agentWorkSql = `EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.conversation_id AND t.status<>'terminal')
  OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id=c.conversation_id AND s.status='queued')`;
export const generationWorkSql = `EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.conversation_id
  AND t.kind='"pi.generation"' AND t.status<>'terminal')
  OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id=c.conversation_id AND s.status='queued')`;
export const projectionWorkSql = `EXISTS (SELECT 1 FROM entries e WHERE e.conversation_id=c.conversation_id
  AND e.id>COALESCE((SELECT p.entry_id FROM chat_projection_cursors p WHERE p.chat_id=c.chat_id AND p.conversation_id=c.conversation_id),0))
  OR EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.conversation_id AND t.kind='"pi.generation"' AND t.status='terminal'
    AND t.record::jsonb->'state'->'outcome'->>'status' IN ('failed','faulted','orphaned')
    AND NOT EXISTS(SELECT 1 FROM chat_task_projections p WHERE p.task_id=t.id))
  OR EXISTS (SELECT 1 FROM submissions s WHERE s.conversation_id=c.conversation_id AND s.status<>'queued'
    AND NOT EXISTS(SELECT 1 FROM chat_submission_projections p WHERE p.submission_id=s.id AND p.status=s.status))`;

export async function chatsWithWork(pool: PlatformPool, projections = true): Promise<{ chatId: string }[]> {
  const result = await pool.query<{
    chat_id: string;
  }>(`SELECT c.chat_id FROM chat_conversations c JOIN chats ch ON ch.id=c.chat_id
    WHERE ch.generating OR (${agentWorkSql}) ${projections ? `OR (${projectionWorkSql})` : ""}`);
  return result.rows.map((row) => ({ chatId: row.chat_id }));
}

export function pendingWorkQuery(pool: Pick<PlatformPool, "query">): (chatId: string) => Promise<boolean> {
  return async (chatId) => {
    const result = await pool.query<{ pending: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM chat_conversations c WHERE c.chat_id=$1
      AND ((${agentWorkSql}) OR (${projectionWorkSql}))) AS pending`,
      [chatId],
    );
    return result.rows[0]?.pending === true;
  };
}
