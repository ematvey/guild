// Probes of the durable store for tests that act mid-turn.

interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

/** Whether a generation partial holding `text` has committed: the streamed
 *  message so far lives in the conversation's live document, so a revision
 *  carrying the text means the commit landed. */
export async function partialCommitted(db: Queryable, text: string): Promise<boolean> {
  const res = await db.query("SELECT 1 FROM document_revisions WHERE strpos(content, $1) > 0 LIMIT 1", [text]);
  return (res.rowCount ?? 0) > 0;
}
