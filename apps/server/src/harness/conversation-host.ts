import type { AgentEventStream, Harness, Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export interface ConversationLifetime {
  harness: Harness;
  storage: Storage;
  watches: Map<string, AgentEventStream>;
}

/** Owns exactly one scheduler lifetime, including unsuccessful initialization. */
export class ConversationHost {
  private active?: ConversationLifetime;
  private candidate?: ConversationLifetime;
  private opening?: Promise<void>;
  private stopped = false;

  get value(): ConversationLifetime | undefined {
    return this.candidate ?? this.active;
  }

  replace(
    create: () => Promise<ConversationLifetime>,
    initialize: (value: ConversationLifetime) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("conversation host is closed"));
    if (this.opening) return this.opening;
    const operation = (async () => {
      await this.dispose(this.active);
      this.active = undefined;
      let value: ConversationLifetime | undefined;
      try {
        value = await create();
        this.candidate = value;
        await initialize(value);
        if (this.stopped) throw new Error("conversation host closed during initialization");
        this.active = value;
        void value.harness.closed.then((end) => {
          if (this.active === value && !this.stopped && end.reason === "failed") failed(end.error);
        });
      } catch (error) {
        await this.dispose(value);
        throw error;
      } finally {
        this.candidate = undefined;
      }
    })();
    this.opening = operation;
    void operation
      .finally(() => {
        if (this.opening === operation) this.opening = undefined;
      })
      .catch(() => {});
    return operation;
  }

  private async dispose(value?: ConversationLifetime): Promise<void> {
    if (!value) return;
    // Close the scheduler first: a projection callback waiting on its Session
    // must settle before joining its watch.
    await value.harness.close(BACKGROUND_CONTEXT).catch(() => {});
    await Promise.all([...value.watches.values()].map((watch) => watch.stop().catch(() => {})));
    value.watches.clear();
    await value.storage.close(BACKGROUND_CONTEXT).catch(() => {});
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.opening?.catch(() => {});
    await this.dispose(this.active);
    this.active = undefined;
  }
}
