// Conversation search over agent_thread_chunks: chunk a completed turn into
// searchable rows and query them with Postgres FTS. Scope is enforced in SQL
// by agent_id; callers pass the agent whose threads may match.

import type { PlatformPool } from "../platform/db.js";
import { type AgentChunkInput, insertChunks, searchChunks } from "./store/chunks.js";

export { type AgentChunkInput, insertChunks } from "./store/chunks.js";

/** A message slice fed to chunkThread: the durable journal's sequence
 *  number plus the rendered user/assistant text. */
export interface AgentChunkMessage {
  seq: number;
  role: string;
  text: string;
}

export interface AgentSearchHit {
  thread_id: string;
  thread_title: string;
  seq_from: number;
  seq_to: number;
  ts: string;
  snippet: string;
  rank: number;
}

const MAX_QUERY_CHARS = 512;
const MAX_RESULTS = 20;
const MAX_SNIPPET_CHARS = 700;
const CHUNK_TARGET_CHARS = 2000;

/**
 * Chunks one completed turn's user/assistant messages and inserts the rows.
 * Messages are grouped up to ~2000 characters; empty and non-conversational
 * roles are skipped. A2 calls this after a turn commits.
 */
export async function chunkThread(
  pool: PlatformPool,
  args: { threadId: string; agentId: string; messages: AgentChunkMessage[] },
): Promise<void> {
  const messages = args.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim() !== "")
    .sort((a, b) => a.seq - b.seq);
  if (messages.length === 0) return;

  const chunks: AgentChunkInput[] = [];
  let current: AgentChunkMessage[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
    chunks.push({
      thread_id: args.threadId,
      agent_id: args.agentId,
      seq_from: current[0]!.seq,
      seq_to: current[current.length - 1]!.seq,
      text,
    });
    current = [];
    currentChars = 0;
  };

  for (const message of messages) {
    if (current.length > 0 && currentChars + message.text.length > CHUNK_TARGET_CHARS) {
      flush();
    }
    current.push(message);
    currentChars += message.text.length;
  }
  flush();

  await insertChunks(pool, chunks);
}

/** FTS over one user's threads with an agent: max 20 rows, rank/ts order,
 *  a highlighted snippet capped at 700 characters. Sharing an agent shares
 *  its workspace, never its conversations, so the user is always a filter. */
export async function search(
  pool: PlatformPool,
  args: { agentId: string; userId: string; query: string; limit?: number },
): Promise<AgentSearchHit[]> {
  const query = args.query.trim();
  if (query === "") return [];
  const limit = Math.max(1, Math.min(MAX_RESULTS, args.limit ?? MAX_RESULTS));
  const rows = await searchChunks(pool, {
    agentId: args.agentId,
    userId: args.userId,
    query: query.slice(0, MAX_QUERY_CHARS),
    limit,
    snippetChars: MAX_SNIPPET_CHARS,
  });
  return rows.map((row) => ({
    thread_id: row.thread_id,
    thread_title: row.thread_title,
    seq_from: Number(row.seq_from),
    seq_to: Number(row.seq_to),
    ts: row.ts,
    snippet: row.snippet,
    rank: Number(row.rank),
  }));
}
