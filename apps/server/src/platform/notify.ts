// Postgres LISTEN hub: one dedicated client per process listening on the
// NOTIFY channels the stores emit, dispatching payloads to in-process
// subscribers. The member-socket feed (M5) and the M3 thread-stream SSE
// endpoint both consume this instead of holding their own connections.

import pg from "pg";
import type { Logger } from "pino";

export type NotifyHandler = (channel: string, payload: string) => void;

/** The channels the stores NOTIFY (crates/server/src/store/*). */
export const NOTIFY_CHANNELS = [
  "guild_thread_committed",
  "guild_chat_status",
  "guild_events",
] as const;

export class NotifyHub {
  private client: pg.Client | undefined;
  private connecting: Promise<void> | undefined;
  private readonly handlers = new Set<NotifyHandler>();
  private closed = false;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger = { warn() {}, error() {}, info() {} } as never,
  ) {}

  subscribe(handler: NotifyHandler): () => void {
    this.handlers.add(handler);
    void this.ensureListening();
    return () => {
      this.handlers.delete(handler);
    };
  }

  private async ensureListening(): Promise<void> {
    if (this.client !== undefined || this.connecting !== undefined || this.closed) return;
    this.connecting = (async () => {
      for (let attempt = 1; attempt <= 3 && !this.closed; attempt++) {
        const client = new pg.Client({ connectionString: this.connectionString });
        try {
          client.on("notification", (msg) => {
            if (msg.channel === undefined) return;
            for (const handler of this.handlers) handler(msg.channel, msg.payload ?? "");
          });
          client.on("error", (error) => {
            this.log.warn(`notify connection error: ${String(error)}`);
          });
          await client.connect();
          for (const channel of NOTIFY_CHANNELS) await client.query(`LISTEN ${channel}`);
          this.client = client;
          return;
        } catch (error) {
          await client.end().catch(() => {});
          if (attempt === 3) {
            this.log.warn(`notify hub could not connect: ${String(error)}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.end().catch(() => {});
  }
}
