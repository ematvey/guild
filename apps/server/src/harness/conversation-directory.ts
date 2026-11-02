import { SingleFlight } from "./operations.js";
import type { ConversationMapStore } from "../platform/store/conversations.js";

/** Coalesces first touch and serializes mapping creation across processes. */
export class ConversationDirectory {
  private readonly pending = new SingleFlight<string, number>();
  private creating: Promise<unknown> = Promise.resolve();
  constructor(private readonly map: Pick<ConversationMapStore, "ensure">) {}

  ensure(chatId: string, create: () => Promise<number>): Promise<number> {
    return this.pending.run(chatId, () => {
      // Creation needs another connection for durable commits. Reserve at most
      // one mapping connection per process so concurrent chats cannot fill the pool.
      const operation = this.creating.then(() => this.map.ensure(chatId, create));
      this.creating = operation.catch(() => {});
      return operation;
    });
  }
}
