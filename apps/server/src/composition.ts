// The composition root. It builds the per-process Postgres pool, object
// store, ClickHouse usage sink, typed store facades and the services above
// them (runtime, hub, feed, scheduler, push) once, then hands each route
// group a narrow slice from platform/route-contexts.ts. It sits above every
// layer, so platform/ never imports the services it wires.

import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { createPlatformPool, type PlatformPool } from "./platform/db.js";
import { ObjectStore } from "./platform/s3.js";
import { pendingWorkQuery } from "./platform/store/work.js";
import { IdentityStore } from "./platform/store/identity.js";
import { PairingStore } from "./platform/store/pairing.js";
import { EventStore } from "./platform/store/events.js";
import { AttachmentStore } from "./platform/store/attachments.js";
import { OrgStore } from "./platform/store/orgs.js";
import { OidcStore } from "./platform/store/oidc.js";
import { ApiKeyStore } from "./platform/store/api_keys.js";
import { GatewayStore } from "./platform/store/gateway.js";
import { MachineStore } from "./platform/store/machines.js";
import { RegistryStore } from "./platform/store/registry.js";
import { SkillStore } from "./platform/store/skills.js";
import { ReleaseStore } from "./platform/store/releases.js";
import { ProjectStore } from "./platform/store/projects.js";
import { TeamStore } from "./platform/store/teams.js";
import { OrgKvStore, KvStore } from "./platform/store/org_kv.js";
import { IntegrationStore, IntegrationSecretStore } from "./platform/store/integrations.js";
import { UserMcpStore } from "./platform/store/userMcp.js";
import { PushStore } from "./platform/store/push.js";
import { PushNotifier } from "./push/notifier.js";
import { webPushSender } from "./push/sender.js";
import { pushSubject, vapidKeys, type VapidKeys } from "./push/vapid.js";
import { LiveHub } from "./hub/live.js";
import { TicketStore } from "./hub/tickets.js";
import { ChatStore } from "./platform/store/chats.js";
import { ThreadStore } from "./platform/store/thread.js";
import { TurnCommandStore } from "./platform/store/turn_commands.js";
import { ToolArtifactStore } from "./platform/store/toolArtifacts.js";
import { machineDispatch, type MachineDispatch } from "./machines/dispatch.js";
import { GuildRuntime } from "./harness/runtime.js";
import { AgentScheduler } from "./agents/scheduler.js";
import { ForkSupervisor } from "./worker/supervisor.js";
import { NotifyHub } from "./platform/notify.js";
import { FeedForwarder } from "./hub/feed.js";
import { ClickhouseClient } from "./platform/clickhouse.js";
import { SkillReadSink } from "./platform/skillReads.js";
import { UsageSink } from "./platform/usage.js";
import { TraceStore } from "./platform/trace.js";
import { ApiError } from "./platform/errors.js";
import type { GatewayCredential } from "./platform/llm-gateway.js";
import type { ChatsCtx } from "./platform/route-contexts.js";
import type { Logger } from "pino";

// Fixed identities for the config-minted internal gateway key (spec
// decision 7). Usage rows for internal calls stay distinct through them:
// the synthetic caller id belongs to no user row, so per-user breakdowns
// show it separately (unknown ids keep the raw value in the UI). The
// constants are pinned (sha256("guild-internal-caller")/
// sha256("guild-internal-key"), formatted as UUIDs).
const INTERNAL_CALLER_UUID = "084e9c72-8c73-636b-f784-132bbeaf766e";
const INTERNAL_KEY_UUID = "bf14cf48-bd7d-5fb6-6c0f-9047919fb0d8";

/** Byte-wise comparison with no early exit; unequal lengths are unequal. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

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
  /** Registry, releases, projects, teams, admin settings, integration
   *  config rows. */
  readonly registry: RegistryStore;
  readonly skills: SkillStore;
  readonly releases: ReleaseStore;
  readonly projects: ProjectStore;
  readonly teams: TeamStore;
  readonly orgKv: OrgKvStore;
  readonly kv: KvStore;
  readonly integrations: IntegrationStore;
  readonly integrationSecrets: IntegrationSecretStore;
  /** User-owned MCP server rows (the user_mcp settings surface + runtime). */
  readonly userMcp: UserMcpStore;
  readonly push: PushStore;
  readonly pushNotifier: PushNotifier;
  /** The machine/member socket registry. */
  readonly hub: LiveHub;
  /** The per-hub tool-dispatch registry (machines/dispatch.ts; one per
   *  process, hub-owned lifetime). */
  readonly machineDispatch: MachineDispatch;
  readonly wsTickets: TicketStore;
  readonly usage: UsageSink;
  /** The agent trace store (agent_traces + agent_spans + opt-in
   *  llm_payloads; trace.ts). */
  readonly trace: TraceStore;
  /** The ClickHouse skill-read sink (read_skill analytics; the skill
   *  detail page reads the query side). */
  readonly skillReads: SkillReadSink;
  readonly clickhouse: ClickhouseClient;
  /** The chat-side stores and the agent runtime (the harness is owned by
   *  this process; it starts lazily — durable migrations run idempotently
   *  on first use and at server startup). */
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
  /** The member-socket feed forwarder: notify fan-in →
   *  ThreadState views, LiveFrame generation streams, ChatStatus, org
   *  events, presence-driven ThreadList — all to the chat owner's sinks. */
  readonly feed: FeedForwarder;

  /** Socket seams wired at startup (all optional, no-op when unset):
   *  - wsSync: the chats lane's state-sync capture, called inside the socket
   *    reader's sync bracket (SyncBegin … SyncDone).
   *  - wsSubagentTree: the chat's thread subtree, sent inside the same
   *    bracket.
   *  - wsToolResult: the dispatch lane's tool-result completion (owns_pending_tool
   *    + turn completion).
   *  - wsMachineReconcile: the dispatch lane's uncertain-execution sweep at
   *    machine connect.
   *  - wsLog: trace sink for the socket supervisor (the server log). */
  wsSync?: ChatsCtx["wsSync"];
  wsSubagentTree?: ChatsCtx["wsSubagentTree"];
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
    this.integrations = new IntegrationStore(this.pool);
    this.integrationSecrets = new IntegrationSecretStore(this.pool);
    this.userMcp = new UserMcpStore(this.pool);
    this.push = new PushStore(this.pool);
    this.pushNotifier = new PushNotifier({
      store: this.push,
      // Presence gate: a live member socket already carries the frame.
      isPresent: (userId) => this.hub.memberSinksOfUser(userId).length > 0,
      sender: async () => webPushSender(await this.pushKeys(), pushSubject(this.config)),
      log: (message) => log.warn?.(message),
    });
    this.hub = new LiveHub();
    this.machineDispatch = machineDispatch(this.hub);
    this.wsTickets = new TicketStore();
    this.clickhouse = this.createClickhouse();
    this.usage = new UsageSink(this.clickhouse);
    this.trace = new TraceStore(this.clickhouse, config.tracePayloads);
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
    this.runtime.setTurnEnded((chatId, failed) => this.pushTurnEnded(chatId, failed));
    this.scheduler = new AgentScheduler({
      pool: this.pool,
      store: this.runtime.agents,
      threads: this.threads,
      runtime: this.runtime,
      log,
      enabled: config.agentsScheduler,
      workspaceRoot: config.agentWorkspaceWriteRoot,
    });
    // The machine dispatch registry settles pending tool waiters when a
    // machine's slot dies (the unknown-outcome sweep).
    this.hub.onMachineDisconnected = (_machineId, connId) => this.machineDispatch.unregisterConnection(connId);
    // Presence flips ride the member socket: the sidebar dot and the
    // machine list move live instead of holding a registry snapshot.
    this.hub.onMachineStatus = (machineId, userId, orgId, online) => this.feed.machineStatus(machineId, userId, orgId, online);
    // The dispatch lane's tool-result completion + connect sweep (the
    // ws.ts seams; no-op until a test/lane sets richer behavior).
    this.wsToolResult = async ({ member, frame }) => {
      this.machineDispatch.resolveToolResult(member, frame);
    };
    this.wsMachineReconcile = async (machineId, connId) => {
      this.machineDispatch.reconcileMachine(machineId, connId);
    };
    this.feed = new FeedForwarder(this, log);
    this.feed.start();
    this.runtime.setStreamSink(this.feed);
  }

  masterKey(): Buffer {
    const key = Buffer.from(this.config.masterKeyHex, "hex");
    if (key.length !== 32) throw new Error("GUILD_MASTER_KEY_HEX must decode to 32 bytes");
    return key;
  }

  pushKeys(): Promise<VapidKeys> {
    return vapidKeys(this.kv);
  }

  /** A turn ended for a chat: notify its owner when no socket is watching. */
  private async pushTurnEnded(chatId: string, failed: boolean): Promise<void> {
    const owner = await this.chats.ownerOf(chatId);
    if (owner === null) return;
    const chat = await this.chats.getChatInOrg(owner.org_id, chatId).catch(() => null);
    await this.pushNotifier.turnEnded({
      orgId: owner.org_id,
      userId: owner.user_id,
      chatId,
      title: chat?.title ?? "",
      failed,
    });
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
    if (token === null) throw ApiError.unauthorized("missing api key");
    const row = await this.apiKeys.authenticate(token);
    if (row !== null) {
      // Usage belongs to the key's owner when user-minted, else to the
      // admin who created the org key.
      return {
        orgId: row.org_id,
        userId: row.user_id ?? row.created_by,
        sessionId: row.id,
        internal: false,
      };
    }
    if (this.config.internalKey !== null && constantTimeEquals(token, this.config.internalKey)) {
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
        internal: true,
      };
    }
    throw ApiError.unauthorized("invalid api key");
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
