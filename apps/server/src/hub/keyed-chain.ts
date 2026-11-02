// Per-key promise chains: the pushes of one key (a chat, a user's
// workspace, an agent) run one after another in call order, so a snapshot
// read before a write never lands after the one read after it. A failed
// step is reported and the chain moves on; the next change re-sends.

export type ChainFailure = (label: string, key: string, error: unknown) => void;

export class KeyedChain {
  private readonly chains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly failed: ChainFailure) {}

  /** Appends `op` to `key`'s chain. The returned promise settles when `op`
   *  has run (or failed, which it reports); it never rejects. After stop(),
   *  queued steps are skipped. */
  run(key: string, label: string, op: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => (this.stopped ? undefined : op()))
      .catch((error: unknown) => this.failed(label, key, error));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /** Whether any chain holds a queued or running step. */
  get active(): boolean {
    return this.chains.size > 0;
  }

  /** Resolves once every chain is empty, steps appended while it waits
   *  included. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  stop(): void {
    this.stopped = true;
  }
}
