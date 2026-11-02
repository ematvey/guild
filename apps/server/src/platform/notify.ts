// Postgres LISTEN hub: one dedicated client per process listening on the
// NOTIFY channels the stores emit, dispatching payloads to in-process
// subscribers. The member-socket feed consumes it instead of holding its own
// connection.

import pg from "pg";
import type { Logger } from "pino";

export type NotifyHandler = (channel: string, payload: string) => void;

/** Called after the LISTEN client reconnected: every NOTIFY sent while it
 *  was down is lost, so a subscriber re-reads the state it pushes. */
export type ReconnectHandler = () => void;

/** The channels the stores NOTIFY. */
export const NOTIFY_CHANNELS = [
  "guild_thread_committed",
  "guild_chat_status",
  "guild_events",
  "guild_subagent_tree",
  "guild_workspace",
  "guild_org",
  "guild_models",
  "guild_agents",
  "guild_agent_runs",
  "guild_agent_routines",
  "guild_agent_threads",
  "guild_skills",
  "guild_compaction",
] as const;

export class NotifyHub {
  private client: pg.Client | undefined;
  private connecting: Promise<void> | undefined;
  private readonly handlers = new Set<NotifyHandler>();
  private readonly reconnectHandlers = new Set<ReconnectHandler>();
  /** True once a LISTEN client has been up: a later connect is a reconnect. */
  private listened = false;
  private closed = false;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger = { warn() {}, error() {}, info() {} } as never,
  ) {}

  subscribe(handler: NotifyHandler, onReconnect?: ReconnectHandler): () => void {
    this.handlers.add(handler);
    if (onReconnect !== undefined) this.reconnectHandlers.add(onReconnect);
    void this.ensureListening();
    return () => {
      this.handlers.delete(handler);
      if (onReconnect !== undefined) this.reconnectHandlers.delete(onReconnect);
    };
  }

  /** Connects (or reconnects) the shared LISTEN client. The loop retries
   *  forever while the hub is open — a dead notify connection would silence
   *  every consumer (SSE thread streams, the member-socket feed) with no
   *  other error signal. */
  private async ensureListening(): Promise<void> {
    if (this.client !== undefined || this.connecting !== undefined || this.closed) return;
    this.connecting = (async () => {
      let backoffMs = 250;
      while (!this.closed) {
        const client = new pg.Client({ connectionString: this.connectionString });
        try {
          const owned = { current: true };
          const drop = (): void => {
            if (!owned.current || this.client !== client) return;
            owned.current = false;
            this.client = undefined;
            // The handlers still hold their subscriptions: come back.
            if (!this.closed) void this.ensureListening();
          };
          client.on("notification", (msg) => {
            if (msg.channel === undefined) return;
            for (const handler of this.handlers) handler(msg.channel, msg.payload ?? "");
          });
          client.on("error", (error) => {
            this.log.warn(`notify connection error: ${String(error)}`);
            drop();
          });
          client.on("end", drop);
          await client.connect();
          for (const channel of NOTIFY_CHANNELS) await client.query(`LISTEN ${channel}`);
          this.client = client;
          backoffMs = 250;
          if (this.listened) {
            this.log.info("notify connection restored; subscribers resync");
            for (const handler of this.reconnectHandlers) handler();
          }
          this.listened = true;
          return;
        } catch (error) {
          await client.end().catch(() => {});
          this.log.warn(`notify hub could not connect: ${String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 5_000);
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
