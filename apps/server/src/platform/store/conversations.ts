// The chat ↔ durable-conversation mapping (chat_conversations): which
// pi-durable conversation holds a chat's agent state, and the project
// instruction chain the chat's latest desktop submit carried.

import type { PlatformPool } from "../db.js";

export class ConversationMapStore {
  constructor(private readonly pool: PlatformPool) {}

  /** The chat's conversation; creates it through `create` when the chat
   *  has none. A per-chat advisory lock serializes creation across
   *  processes, so two first touches map one conversation. */
  async ensure(chatId: string, create: () => Promise<number>): Promise<number> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 49012))", [chatId]);
      locked = true;
      const rows = await client.query<{ conversation_id: number }>(
        "SELECT conversation_id FROM chat_conversations WHERE chat_id=$1",
        [chatId],
      );
      if (rows.rows[0]) return Number(rows.rows[0].conversation_id);
      const id = await create();
      await client.query("INSERT INTO chat_conversations(chat_id,conversation_id) VALUES($1,$2)", [chatId, id]);
      return id;
    } finally {
      let releaseError: Error | undefined;
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 49012))", [chatId]);
        } catch (error) {
          releaseError = error instanceof Error ? error : new Error(String(error));
        }
      }
      client.release(releaseError);
    }
  }

  /** The chat's conversation id; null when it has none. */
  async conversationOf(chatId: string): Promise<number | null> {
    const res = await this.pool.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM chat_conversations WHERE chat_id = $1",
      [chatId],
    );
    return res.rows[0] === undefined ? null : Number(res.rows[0].conversation_id);
  }

  /** The conversation ids of the given chats that have one. */
  async conversationsOf(chatIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (chatIds.length === 0) return out;
    const res = await this.pool.query<{ chat_id: string; conversation_id: string }>(
      "SELECT chat_id, conversation_id FROM chat_conversations WHERE chat_id = ANY($1::uuid[])",
      [chatIds],
    );
    for (const row of res.rows) out.set(row.chat_id, Number(row.conversation_id));
    return out;
  }

  /** The chats mapped to one conversation. */
  async chatsOf(conversationId: string | number): Promise<string[]> {
    const res = await this.pool.query<{ chat_id: string }>(
      "SELECT chat_id FROM chat_conversations WHERE conversation_id = $1",
      [conversationId],
    );
    return res.rows.map((row) => row.chat_id);
  }

  /** Drops the chat's mapping (its conversation is gone). */
  async remove(chatId: string): Promise<void> {
    await this.pool.query("DELETE FROM chat_conversations WHERE chat_id = $1", [chatId]);
  }

  /** The project instruction chain the chat's latest submit carried. */
  async projectInstructions(chatId: string): Promise<string | undefined> {
    const res = await this.pool.query<{ project_instructions: string | null }>(
      "SELECT project_instructions FROM chat_conversations WHERE chat_id = $1",
      [chatId],
    );
    return res.rows[0]?.project_instructions ?? undefined;
  }

  async setProjectInstructions(chatId: string, instructions: string): Promise<void> {
    await this.pool.query("UPDATE chat_conversations SET project_instructions = $2 WHERE chat_id = $1", [
      chatId,
      instructions,
    ]);
  }
}
