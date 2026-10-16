import { ApiError } from "../platform/errors.js";

export class AdmissionCancelled extends ApiError {
  constructor() {
    super(409, "cancelled", "message admission cancelled");
  }
}

/** Coalesce a shared acquisition; remove it on either success or failure. */
export class SingleFlight<K, V> {
  private readonly pending = new Map<K, Promise<V>>();
  run(key: K, operation: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = operation();
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => {});
    return result;
  }
}

/** Serialize admission/configuration without blocking independent chat controls. */
export class ConversationAdmissions {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  run<T>(chatId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const controllers = this.controllers.get(chatId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(chatId, controllers);
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      });
    this.tails.set(chatId, result);
    void result
      .finally(() => {
        controllers.delete(controller);
        if (!controllers.size) this.controllers.delete(chatId);
        if (this.tails.get(chatId) === result) this.tails.delete(chatId);
      })
      .catch(() => {});
    return result;
  }
  cancel(chatId: string): void {
    for (const controller of this.controllers.get(chatId) ?? []) controller.abort(new AdmissionCancelled());
  }
  async close(): Promise<void> {
    for (const id of this.controllers.keys()) this.cancel(id);
    await Promise.allSettled([...this.tails.values()]);
  }
}
