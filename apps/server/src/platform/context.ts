// Platform context: the per-process Postgres pool, object store, ClickHouse
// usage sink, and typed store facades shared by the native route handlers.

import type { Config } from "../config.js";
import { createPlatformPool, type PlatformPool } from "./db.js";
import { ObjectStore } from "./s3.js";
import { IdentityStore } from "./store/identity.js";
import { PairingStore } from "./store/pairing.js";
import { EventStore } from "./store/events.js";
import { AttachmentStore } from "./store/attachments.js";
import { OrgStore } from "./store/orgs.js";
import { OidcStore } from "./store/oidc.js";
import { ApiKeyStore } from "./store/api_keys.js";
import { GatewayStore } from "./store/gateway.js";
import { MachineStore } from "./store/machines.js";
import type { UserRow } from "./store/identity.js";
import { LiveHub } from "../hub/live.js";
import { TicketStore } from "../hub/tickets.js";
import type { SocketSink } from "../hub/sink.js";
import type { WsServerMsg } from "../hub/protocol.js";
import type { LiveMember } from "../hub/live.js";
import { ClickhouseClient } from "./clickhouse.js";
import { UsageSink } from "./usage.js";
import { ApiError } from "./http/error.js";
import type { GatewayCredential } from "./http/llm.js";

// Fixed identities for the config-minted internal gateway key (spec
// decision 7). Usage rows for internal calls stay distinct through them:
// the synthetic caller id belongs to no user row, so per-user breakdowns
// show it separately (unknown ids keep the raw value in the UI). The
// constants are pinned (sha256("guild-internal-caller")/
// sha256("guild-internal-key"), formatted as UUIDs).
const INTERNAL_CALLER_UUID = "084e9c72-8c73-636b-f784-132bbeaf766e";
const INTERNAL_KEY_UUID = "bf14cf48-bd7d-5fb6-6c0f-9047919fb0d8";

export class PlatformContext {
  readonly pool: PlatformPool;
  readonly objects: ObjectStore;
  readonly identity: IdentityStore;
  readonly pairing: PairingStore;
  readonly events: EventStore;
  readonly attachments: AttachmentStore;
  readonly orgs: OrgStore;
  readonly oidc: OidcStore;
  readonly apiKeys: ApiKeyStore;
  readonly gatewayStore: GatewayStore;
  readonly machines: MachineStore;
  /** The real machine/member socket registry (M5 hub core). The M3 harness
   *  lane injects fakes typed against the seam `Hub` interface in hub/index.ts
   *  and casts here in its own tests. */
  readonly hub: LiveHub;
  readonly wsTickets: TicketStore;
  readonly usage: UsageSink;

  /** Seams for lanes that land after M5-hub-core (all optional, no-op when
   *  unset):
   *  - wsSync: the chats lane's state-sync capture, called inside the socket
   *    reader's sync bracket (SyncBegin … SyncDone).
   *  - wsToolResult: the dispatch lane's tool-result completion (owns_pending_tool
   *    + turn completion).
   *  - wsMachineReconcile: the dispatch lane's uncertain-execution sweep at
   *    machine connect (Rust reconcile_machine_tools).
   *  - wsLog: trace sink for the socket supervisor (server log in Rust). */
  wsSync?: (args: { chatId: string; user: UserRow; sink: SocketSink }) => Promise<WsServerMsg | null>;
  wsToolResult?: (args: { member: LiveMember; user: UserRow; frame: { type: "tool_result"; chat_id: string; call_id: string; content: string; is_error: boolean; meta: unknown; images: string[] } }) => Promise<void>;
  wsMachineReconcile?: (machineId: string, connId: string) => Promise<void>;
  wsLog?: (message: string) => void;

  constructor(readonly config: Config) {
    this.pool = createPlatformPool(config.databaseUrl);
    this.objects = new ObjectStore(config);
    this.identity = new IdentityStore(this.pool);
    this.pairing = new PairingStore(this.pool);
    this.events = new EventStore(this.pool);
    this.attachments = new AttachmentStore(this.pool);
    this.orgs = new OrgStore(this.pool);
    this.oidc = new OidcStore(this.pool);
    this.apiKeys = new ApiKeyStore(this.pool);
    this.gatewayStore = new GatewayStore(this.pool);
    this.machines = new MachineStore(this.pool);
    this.hub = new LiveHub();
    this.wsTickets = new TicketStore();
    this.usage = new UsageSink(this.clickhouse());
  }

  masterKey(): Buffer {
    const key = Buffer.from(this.config.masterKeyHex, "hex");
    if (key.length !== 32) throw new Error("GUILD_MASTER_KEY_HEX must decode to 32 bytes");
    return key;
  }

  private clickhouse(): ClickhouseClient {
    return new ClickhouseClient({
      url: this.config.clickhouseUrl,
      database: this.config.clickhouseDatabase,
      user: this.config.clickhouseUser,
      password: this.config.clickhousePassword,
    });
  }

  /** Resolves a gateway bearer token (gk_… key or the config-minted
   *  internal key) to the credential the LLM gateway endpoints meter
   *  against. The internal key never exists as a row: it is org-scoped via
   *  the x-guild-org-id request header the harness sends, with optional
   *  x-guild-user-id / x-guild-session-id attribution overrides. */
  async gatewayCredential(req: {
    headers: Record<string, unknown>;
  }): Promise<GatewayCredential> {
    const header = req.headers["authorization"];
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const xApiKey = typeof req.headers["x-api-key"] === "string" ? (req.headers["x-api-key"] as string) : null;
    const token = [bearer, xApiKey].find((t) => t !== null && t !== "") ?? null;
    if (token === null) throw new ApiError(401, "unauthorized", "missing api key");
    const row = await this.apiKeys.authenticate(token);
    if (row !== null) {
      // Usage belongs to the key's owner when user-minted, else to the
      // admin who created the org key.
      return {
        orgId: row.org_id,
        userId: row.user_id ?? row.created_by,
        sessionId: row.id,
      };
    }
    if (this.config.internalKey !== null && token === this.config.internalKey) {
      const headerOr = (name: string): string | null => {
        const value = req.headers[name];
        return typeof value === "string" && value !== "" ? value : null;
      };
      const orgId = headerOr("x-guild-org-id");
      if (orgId === null) {
        throw new ApiError(400, "invalid_request", "internal key requires the x-guild-org-id header");
      }
      return {
        orgId,
        userId: headerOr("x-guild-user-id") ?? INTERNAL_CALLER_UUID,
        sessionId: headerOr("x-guild-session-id") ?? INTERNAL_KEY_UUID,
      };
    }
    throw new ApiError(401, "unauthorized", "invalid api key");
  }

  async close(): Promise<void> {
    this.objects.destroy();
    await this.pool.end();
  }
}
