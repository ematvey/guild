// Conversation search rows (agent_thread_chunks): chunk inserts with their
// tsvector, and Postgres FTS scoped in SQL by agent and user.

import { withTransaction, type PlatformPool } from "../../platform/db.js";
import { utcText, uuidv7 } from "../../platform/time.js";

/** One chunk row to insert. `text` is indexed as-is with the `simple`
 *  configuration (no stemming; agents write in mixed languages). */
export interface AgentChunkInput {
  thread_id: string;
  agent_id: string;
  seq_from: number;
  seq_to: number;
  text: string;
  ts?: string;
}

export interface ChunkHitRow {
  thread_id: string;
  thread_title: string;
  seq_from: number;
  seq_to: number;
  ts: string;
  snippet: string;
  rank: number;
}

/** Inserts chunks with their tsvector computed by Postgres. */
export async function insertChunks(pool: PlatformPool, chunks: AgentChunkInput[]): Promise<void> {
  if (chunks.length === 0) return;
  await withTransaction(pool, async (client) => {
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO agent_thread_chunks (id, thread_id, agent_id, seq_from, seq_to, ts, text, tsv)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, to_tsvector('simple', $7))`,
        [uuidv7(), chunk.thread_id, chunk.agent_id, chunk.seq_from, chunk.seq_to, chunk.ts ?? null, chunk.text],
      );
    }
  });
}

/** Inserts one chunk unless the thread already has one over the same seq
 *  range: a projection replay indexes nothing twice. */
export async function insertChunkOnce(pool: PlatformPool, chunk: AgentChunkInput): Promise<void> {
  await pool.query(
    `INSERT INTO agent_thread_chunks (id, thread_id, agent_id, seq_from, seq_to, ts, text, tsv)
     SELECT $1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, to_tsvector('simple', $7)
     WHERE NOT EXISTS (SELECT 1 FROM agent_thread_chunks WHERE thread_id = $2 AND seq_from = $4 AND seq_to = $5)`,
    [uuidv7(), chunk.thread_id, chunk.agent_id, chunk.seq_from, chunk.seq_to, chunk.ts ?? null, chunk.text],
  );
}

/** FTS over one user's chunks with an agent, rank/ts order, with a
 *  highlighted snippet capped at `snippetChars`. */
export async function searchChunks(
  pool: PlatformPool,
  args: { agentId: string; userId: string; query: string; limit: number; snippetChars: number },
): Promise<ChunkHitRow[]> {
  const res = await pool.query<ChunkHitRow>(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $2) AS tsq)
     SELECT c.thread_id, t.title AS thread_title, c.seq_from, c.seq_to,
            ${utcText("c.ts")} AS ts,
            left(ts_headline('simple', c.text, q.tsq,
              'StartSel=<mark>, StopSel=</mark>, MaxFragments=3, MaxWords=60, MinWords=15'), $4) AS snippet,
            ts_rank(c.tsv, q.tsq) AS rank
     FROM agent_thread_chunks c
     JOIN agent_threads t ON t.id = c.thread_id
     CROSS JOIN q
     WHERE c.agent_id = $1 AND t.user_id = $5 AND c.tsv @@ q.tsq
       AND NOT EXISTS (SELECT 1 FROM chats internal_chat WHERE internal_chat.id=t.chat_id AND internal_chat.internal)
     ORDER BY rank DESC, c.ts DESC
     LIMIT $3`,
    [args.agentId, args.query, args.limit, args.snippetChars, args.userId],
  );
  return res.rows;
}
