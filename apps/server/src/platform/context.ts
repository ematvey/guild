import { pendingWorkQuery } from "./store/work.js";
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
import { RegistryStore } from "./store/registry.js";
import { SkillStore } from "./store/skills.js";
import { ReleaseStore } from "./store/releases.js";
import { ProjectStore } from "./store/projects.js";
import { TeamStore } from "./store/teams.js";
import { OrgKvStore, KvStore } from "./store/org_kv.js";
import { UserKvStore } from "./store/user_kv.js";
import { IntegrationStore, IntegrationSecretStore } from "./store/integrations.js";
import { UserMcpStore } from "./store/userMcp.js";
import { LiveHub } from "../hub/live.js";
import { TicketStore } from "../hub/tickets.js";
import { ChatStore } from "./store/chats.js";
import { ThreadStore } from "./store/thread.js";
import { TurnCommandStore } from "./store/turn_commands.js";
import { ToolArtifactStore } from "./store/toolArtifacts.js";
import { machineDispatch, type MachineDispatch } from "../machines/dispatch.js";
import { GuildRuntime } from "../harness/runtime.js";
import { AgentStore } from "../agents/store.js";
import { AgentScheduler } from "../agents/scheduler.js";
import { ForkSupervisor } from "../worker/supervisor.js";
import { NotifyHub } from "./notify.js";
import { FeedForwarder } from "../hub/feed.js";
import { ClickhouseClient } from "./clickhouse.js";
import { SkillReadSink } from "./skillReads.js";
import { UsageSink } from "./usage.js";
import { LlmTraceSink } from "./trace.js";
import { ApiError } from "./errors.js";
import type { GatewayCredential } from "./http/llm.js";
import type { ChatsCtx } from "./contexts.js";
import type { Logger } from "pino";

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
  /** M6 long-tail stores (registry, releases, projects, teams, admin
   *  settings, integration config rows). */
  readonly registry: RegistryStore;
  readonly skills: SkillStore;
  readonly releases: ReleaseStore;
  readonly projects: ProjectStore;
  readonly teams: TeamStore;
  readonly orgKv: OrgKvStore;
  readonly kv: KvStore;
  /** Per-user preference rows (user_kv): the chat view mode. */
  readonly userKv: UserKvStore;
  readonly integrations: IntegrationStore;
  readonly integrationSecrets: IntegrationSecretStore;
  /** User-owned MCP server rows (the user_mcp settings surface + runtime). */
  readonly userMcp: UserMcpStore;
  /** The real machine/member socket registry (M5 hub core). The M3 harness
   *  lane injects fakes typed against the seam `Hub` interface in hub/index.ts
   *  and casts here in its own tests. */
  readonly hub: LiveHub;
  /** The per-hub tool-dispatch registry (machines/dispatch.ts; one per
   *  process, hub-owned lifetime). */
  readonly machineDispatch: MachineDispatch;
  readonly wsTickets: TicketStore;
  readonly usage: UsageSink;
  /** The LLM trace sink (llm_calls + opt-in llm_payloads; trace.ts). */
  readonly trace: LlmTraceSink;
  /** The ClickHouse skill-read sink (read_skill analytics; Task 6's
   *  detail page reads the query side). */
  readonly skillReads: SkillReadSink;
  readonly clickhouse: ClickhouseClient;
  /** M3: the chat-side stores and the agent runtime (the harness is owned
   *  by this process, decision 9; it starts lazily — durable migrations run
   *  idempotently on first use and at server startup). */
  readonly chats: ChatStore;
  readonly threads: ThreadStore;
  readonly turnCommands: TurnCommandStore;
  /** The tool-artifact spill store. */
  readonly toolArtifacts: ToolArtifactStore;
  /** Postgres LISTEN hub (guild_thread_committed / guild_chat_status /
   *  guild_events) — one dedicated connection shared by all subscribers. */
  readonly notify: NotifyHub;
  readonly runtime: GuildRuntime;
  /** The routine scheduler loop (started after the runtime opens). */
  readonly scheduler: AgentScheduler;
  /** Worker-per-chat: the fork supervisor (undefined when worker mode is
   *  off). The runtime routes admission through it and closes it. */
  readonly supervisor: ForkSupervisor | undefined;
  /** The member-socket feed forwarder (M5/ws-feed lane): notify fan-in →
   *  ThreadState views, LiveFrame generation streams, ChatStatus, org
   *  events, presence-driven ThreadList — all to the chat owner's sinks. */
  readonly feed: FeedForwarder;

  /** Seams for lanes that land after M5-hub-core (all optional, no-op when
   *  unset):
   *  - wsSync: the chats lane's state-sync capture, called inside the socket
   *    reader's sync bracket (SyncBegin … SyncDone).
   *  - wsToolResult: the dispatch lane's tool-result completion (owns_pending_tool
   *    + turn completion).
   *  - wsMachineReconcile: the dispatch lane's uncertain-execution sweep at
   *    machine connect (Rust reconcile_machine_tools).
   *  - wsLog: trace sink for the socket supervisor (server log in Rust). */
  wsSync?: ChatsCtx["wsSync"];
  wsToolResult?: ChatsCtx["wsToolResult"];
  wsMachineReconcile?: ChatsCtx["wsMachineReconcile"];
  wsLog?: ChatsCtx["wsLog"];

  constructor(
    readonly config: Config,
    log: Logger = { warn() {}, error() {}, info() {} } as never,
  ) {
    this.pool = createPlatformPool(config.databaseUrl, config.poolMax);
    this.objects = new ObjectStore(config);
    this.identity = new IdentityStore(this.pool, (orgId, kind, payload) =>
      this.events.emit(orgId, kind, payload));
    this.pairing = new PairingStore(this.pool);
    this.events = new EventStore(this.pool);
    this.attachments = new AttachmentStore(this.pool);
    this.orgs = new OrgStore(this.pool);
    this.oidc = new OidcStore(this.pool);
    this.apiKeys = new ApiKeyStore(this.pool);
    this.gatewayStore = new GatewayStore(this.pool);
    this.machines = new MachineStore(this.pool);
    this.registry = new RegistryStore(this.pool);
    this.skills = new SkillStore(this.pool);
    this.releases = new ReleaseStore(this.pool);
    this.projects = new ProjectStore(this.pool);
    this.teams = new TeamStore(this.pool);
    this.orgKv = new OrgKvStore(this.pool);
    this.kv = new KvStore(this.pool);
    this.userKv = new UserKvStore(this.pool);
    this.integrations = new IntegrationStore(this.pool);
    this.integrationSecrets = new IntegrationSecretStore(this.pool);
    this.userMcp = new UserMcpStore(this.pool);
    this.hub = new LiveHub();
    this.machineDispatch = machineDispatch(this.hub);
    this.wsTickets = new TicketStore();
    this.clickhouse = this.createClickhouse();
    this.usage = new UsageSink(this.clickhouse);
    this.trace = new LlmTraceSink(this.clickhouse, config.tracePayloads);
    this.skillReads = new SkillReadSink(this.clickhouse);
    this.skillReads.attachPool(this.pool);
    this.chats = new ChatStore(this.pool);
    this.threads = new ThreadStore(this.pool);
    this.turnCommands = new TurnCommandStore(this.pool);
    this.toolArtifacts = new ToolArtifactStore(this.pool);
    this.notify = new NotifyHub(config.databaseUrl, log);
    // Worker-per-chat mode: the server forks one worker per active chat and
    // holds no harness itself; admission routes over IPC (worker mode is
    // flag-gated: GUILD_WORKER_MODE=on).
    this.supervisor =
      config.workerMode === "on"
        ? new ForkSupervisor(
            config,
            log,
            pendingWorkQuery(this.pool),
            // Workers proxy machine-tool dispatch to the hub-backed
            // registry (this.machineDispatch resolves lazily at call time
            // — the runtime below is not constructed yet here).
            (call, signal) => this.machineDispatch.dispatch(call, signal),
          )
        : undefined;
    this.runtime = new GuildRuntime(config, this.pool, log, this.objects, this.hub, this.skillReads, this.trace, this.supervisor);
    this.supervisor?.setRemoteSubmit((chatId, input) => this.runtime.submitTurn(chatId, input.orgId, input));
    this.scheduler = new AgentScheduler({
      pool: this.pool,
      store: new AgentStore(this.pool),
      runtime: this.runtime,
      log,
      enabled: config.agentsScheduler,
    });
    // The machine dispatch registry settles pending tool waiters when a
    // machine's slot dies (the unknown-outcome sweep).
    this.hub.onMachineDisconnected = (_machineId, connId) => this.machineDispatch.unregisterConnection(connId);
    // The dispatch lane's tool-result completion + connect sweep (the
    // ws.ts seams; no-op until a test/lane sets richer behavior).
    this.wsToolResult = async ({ member, frame }) => {
      this.machineDispatch.resolveToolResult(member, frame);
    };
    this.wsMachineReconcile = async (machineId, connId) => {
      this.machineDispatch.reconcileMachine(machineId, connId);
    };
    this.feed = new FeedForwarder(this);
    this.feed.start();
    this.runtime.setStreamSink(this.feed);
  }

  masterKey(): Buffer {
    const key = Buffer.from(this.config.masterKeyHex, "hex");
    if (key.length !== 32) throw new Error("GUILD_MASTER_KEY_HEX must decode to 32 bytes");
    return key;
  }

  private createClickhouse(): ClickhouseClient {
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

  /** Starts the routine loop after the runtime is open. A no-op when the
   *  scheduler flag is off. */
  startScheduler(): void {
    this.scheduler.start();
  }

  async close(): Promise<void> {
    this.scheduler.stop();
    this.feed.stop();
    await this.runtime.close();
    await this.notify.close();
    this.objects.destroy();
    await this.pool.end();
  }
}
