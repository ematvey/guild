// Online password-guessing guard: a sliding-window failure counter keyed by
// the normalized email and by the client address. A successful login clears
// the email key. State is per process and bounded — the oldest entries are
// evicted when the map is full, so random emails cannot grow it without
// limit.

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;

export class FailureWindow {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly maxFailures: number = 10,
  ) {}

  /** Failures inside the window; prunes expired timestamps. */
  count(key: string, now: number = Date.now()): number {
    const times = this.entries.get(key);
    if (times === undefined) return 0;
    const cutoff = now - this.windowMs;
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) {
      this.entries.delete(key);
      return 0;
    }
    this.entries.set(key, live);
    return live.length;
  }

  isLimited(key: string, now: number = Date.now()): boolean {
    return this.count(key, now) >= this.maxFailures;
  }

  /** Seconds until the oldest failure leaves the window (0 when unblocked). */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const times = this.entries.get(key);
    if (times === undefined || times.length === 0) return 0;
    const oldest = times[0]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const times = this.entries.get(key) ?? [];
    times.push(now);
    this.entries.set(key, times);
    if (this.entries.size > MAX_ENTRIES) this.evict(now);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.entries) {
      if (times.length === 0 || times[times.length - 1]! <= cutoff) this.entries.delete(key);
    }
    // Map preserves insertion order; drop the oldest keys until the cap holds.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export const loginThrottle = new FailureWindow();
export const addressThrottle = new FailureWindow(DEFAULT_WINDOW_MS, 100);
