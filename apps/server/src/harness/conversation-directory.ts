import { SingleFlight } from "./operations.js";
import type { PlatformPool } from "../platform/db.js";

/** Coalesces first touch and serializes mapping creation across processes. */
export class ConversationDirectory {
  private readonly pending = new SingleFlight<string, number>();
  private creating: Promise<unknown> = Promise.resolve();
  constructor(private readonly pool: PlatformPool) {}

  ensure(chatId: string, create: () => Promise<number>): Promise<number> {
    return this.pending.run(chatId, () => {
      // Creation needs another connection for durable commits. Reserve at most
      // one mapping connection per process so concurrent chats cannot fill the pool.
      const operation = this.creating.then(() => this.create(chatId, create));
      this.creating = operation.catch(() => {});
      return operation;
    });
  }

  private async create(chatId: string, create: () => Promise<number>): Promise<number> {
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
}
