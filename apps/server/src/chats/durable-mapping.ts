// Guild-side chat ↔ durable-conversation mapping (spec decision 6), plus
// the storage adapter that keeps the shared platform pool open. Kept out of
// the shared durable migrations: the storage conformance suite runs on bare
// databases without the platform schema.

import { PgPoolDatabase } from "../storage/postgres/index.js";
import type { PlatformPool } from "../platform/db.js";

/** Guild-side chat ↔ durable-conversation mapping (spec decision 6), with
 *  the project instruction chain of the chat's latest desktop submit — a
 *  resumed run configures the same instructions its submit did. Kept out of
 *  the shared durable migrations: the storage conformance suite runs on bare
 *  databases without the platform schema. */
export async function applyChatMappingMigration(pool: PlatformPool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_conversations (
    chat_id UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL UNIQUE
  )`);
  await pool.query("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS project_instructions TEXT");
}

/** PgPoolDatabase whose close() does not end the shared platform pool (the
 *  pool's lifetime belongs to the PlatformContext). */
export class SharedPoolDatabase extends PgPoolDatabase {
  override async close(): Promise<void> {
    // Storage close seals the session; the shared platform pool (owned by
    // PlatformContext) stays open.
  }
}
