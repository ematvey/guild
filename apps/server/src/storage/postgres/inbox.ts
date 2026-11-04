// A chat's pending inputs, read straight from pi-durable's own tables: the
// `queued` rows of `submissions` and the conversation's `pi.inbox` document
// (`documents` + `document_revisions`, a base and the deltas after it). Any
// process can read it, including a server that holds no harness.

import { apply, type Op } from "@earendil-works/chord/delta";
import type { InboxItem, InboxState } from "@earendil-works/pi-durable";
import type { DurableQueryable } from "./queries.js";

/** The queued items of a chat's inbox, in placement order, each with its
 *  submission's request id. Empty when nothing is queued. */
export async function queuedInbox(
  db: DurableQueryable,
  chatId: string,
): Promise<{ item: InboxItem; requestId: string | null }[]> {
  const queued = await db.query<{ id: string; request_id: string | null; conversation_id: string }>(
    `SELECT s.id, s.request_id, s.conversation_id FROM submissions s
     JOIN chat_conversations c ON c.conversation_id = s.conversation_id
     WHERE c.chat_id = $1 AND s.status = 'queued'`,
    [chatId],
  );
  if (queued.rows.length === 0) return [];
  const conversationId = queued.rows[0]!.conversation_id;
  const requestIds = new Map(
    queued.rows.map((row) => [Number(row.id), row.request_id === null ? null : (JSON.parse(row.request_id) as string)]),
  );
  const docs = await db.query<{ id: string }>(
    `SELECT id FROM documents
     WHERE kind = $1 AND scope_kind = 'conversation' AND owner_id = $2 AND retired_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [JSON.stringify("pi.inbox"), conversationId],
  );
  const documentId = docs.rows[0]?.id;
  if (documentId === undefined) return [];
  const base = await db.query<{ seq: string; version: number; content: string }>(
    `SELECT seq, version, content FROM document_revisions
     WHERE document_id = $1 AND kind = 'base' ORDER BY seq DESC LIMIT 1`,
    [documentId],
  );
  const head = base.rows[0];
  if (head === undefined) return [];
  let value = JSON.parse(head.content) as InboxState;
  const tail = await db.query<{ kind: string; version: number; content: string }>(
    "SELECT kind, version, content FROM document_revisions WHERE document_id = $1 AND seq > $2 ORDER BY seq",
    [documentId, head.seq],
  );
  for (const revision of tail.rows) {
    if (revision.kind !== "delta" || revision.version !== head.version) return [];
    value = apply(value as never, JSON.parse(revision.content) as readonly Op[]) as unknown as InboxState;
  }
  return value.items
    .filter((item) => requestIds.has(Number(item.id)))
    .map((item) => ({ item, requestId: requestIds.get(Number(item.id)) ?? null }));
}
