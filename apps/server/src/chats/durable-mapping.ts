// The durable storage facade over the shared platform pool. The chat ↔
// conversation mapping table itself is a platform migration
// (migrations/0105_chat_conversations.sql).

import { PgPoolDatabase } from "../storage/postgres/index.js";

/** PgPoolDatabase whose close() does not end the shared platform pool (the
 *  pool's lifetime belongs to the process's composition root). */
export class SharedPoolDatabase extends PgPoolDatabase {
  override async close(): Promise<void> {
    // Storage close seals the session; the shared platform pool stays open.
  }
}
