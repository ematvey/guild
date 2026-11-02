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

/** A JSON object payload, or null when the text is not one. */
export function jsonPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A string field of a payload object, or null. */
export function stringField(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" ? value : null;
}

/** An org-scoped payload whose other fields are optional ids. */
export interface OrgPayload {
  org_id: string;
  agent_id: string | null;
  run_id: string | null;
  user_id: string | null;
}

/** A bare-id payload (a chat or conversation id); empty is no payload. */
function idPayload(raw: string): string | null {
  return raw === "" ? null : raw;
}

function orgPayload(raw: string): OrgPayload | null {
  const payload = jsonPayload(raw);
  if (payload === null) return null;
  const orgId = stringField(payload, "org_id");
  if (orgId === null) return null;
  return {
    org_id: orgId,
    agent_id: stringField(payload, "agent_id"),
    run_id: stringField(payload, "run_id"),
    user_id: stringField(payload, "user_id"),
  };
}

/** Every channel the stores NOTIFY, with the parser its payload goes
 *  through. A parser returns null for a payload it cannot read, and the
 *  notification is dropped. */
export const NOTIFY_PARSERS = {
  /** A thread event committed: the chat id. */
  guild_thread_committed: idPayload,
  /** A chat's generating flag flipped. */
  guild_chat_status: (raw: string) => {
    const payload = jsonPayload(raw);
    if (payload === null) return null;
    const orgId = stringField(payload, "org_id");
    const userId = stringField(payload, "user_id");
    const chatId = stringField(payload, "chat_id");
    const generating = payload["generating"];
    if (orgId === null || userId === null || chatId === null || typeof generating !== "boolean") return null;
    return { org_id: orgId, user_id: userId, chat_id: chatId, generating };
  },
  /** An org event row was written. */
  guild_events: (raw: string) => {
    const payload = jsonPayload(raw);
    if (payload === null) return null;
    const orgId = stringField(payload, "org_id");
    const eventId = stringField(payload, "event_id");
    return orgId === null || eventId === null ? null : { org_id: orgId, event_id: eventId };
  },
  /** A chat's agent-thread subtree moved: the chat id. */
  guild_subagent_tree: idPayload,
  /** A user's sidebar lists moved; `parts` names the ones (all when null). */
  guild_workspace: (raw: string) => {
    const payload = jsonPayload(raw);
    if (payload === null) return null;
    const orgId = stringField(payload, "org_id");
    const userId = stringField(payload, "user_id");
    if (orgId === null || userId === null) return null;
    const parts = Array.isArray(payload["parts"])
      ? (payload["parts"] as unknown[]).filter((part): part is string => typeof part === "string")
      : null;
    return { org_id: orgId, user_id: userId, parts };
  },
  /** The workspace's name, logo or telemetry switch moved. */
  guild_workspace_identity: orgPayload,
  /** The org's model routes moved. */
  guild_models: orgPayload,
  guild_agents: orgPayload,
  guild_agent_runs: orgPayload,
  guild_agent_routines: orgPayload,
  guild_agent_threads: orgPayload,
  guild_skills: orgPayload,
  /** A compaction task was written: the conversation id. */
  guild_compaction: idPayload,
} as const;

export type NotifyChannel = keyof typeof NOTIFY_PARSERS;
export type NotifyPayload<C extends NotifyChannel> = NonNullable<ReturnType<(typeof NOTIFY_PARSERS)[C]>>;

/** One handler per channel: a channel without one fails the typecheck. */
export type NotifyHandlers = { readonly [C in NotifyChannel]: (payload: NotifyPayload<C>) => void };

/** The channels the hub LISTENs on. */
export const NOTIFY_CHANNELS = Object.keys(NOTIFY_PARSERS) as NotifyChannel[];

function isNotifyChannel(channel: string): channel is NotifyChannel {
  return Object.hasOwn(NOTIFY_PARSERS, channel);
}

/** A raw notification handler that parses each payload with its channel's
 *  parser and calls that channel's handler. A channel outside the table or
 *  an unreadable payload goes to `dropped`. */
export function notifyDispatcher(
  handlers: NotifyHandlers,
  dropped: (channel: string, payload: string) => void = () => {},
): NotifyHandler {
  return (channel, raw) => {
    if (!isNotifyChannel(channel)) {
      dropped(channel, raw);
      return;
    }
    const payload = NOTIFY_PARSERS[channel](raw);
    if (payload === null) {
      dropped(channel, raw);
      return;
    }
    (handlers[channel] as (payload: unknown) => void)(payload);
  };
}

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
   *  forever while the hub is open: a dead notify connection would silence
   *  the member-socket feed with no other error signal. */
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
