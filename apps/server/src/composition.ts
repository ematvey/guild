// The composition root. It builds the per-process Postgres pool, object
// store, ClickHouse sinks, typed store facades and the services above them
// (runtime, hub, feed, scheduler, push) once, then hands each route group a
// narrow slice from platform/route-contexts.ts. It sits above every layer,
// so platform/ never imports the services it wires. `start()` is the one
// bootstrap: every migration, the boot repairs, then the runtime.

import type { Config } from "./config.js";
import { createPlatformPool, type PlatformPool } from "./platform/db.js";
import { applyPlatformMigrations } from "./platform/migrations.js";
import { ObjectStore } from "./platform/s3.js";
import { createStores, type PlatformStores } from "./platform/stores.js";
import { pendingWorkQuery, seedRecoveryBoundary } from "./storage/postgres/queries.js";
import { applyPostgresMigrations } from "./storage/postgres/index.js";
import { SharedPoolDatabase } from "./chats/durable-mapping.js";
import { syncSeams } from "./chats/ws-sync.js";
import { PushNotifier, turnEndPushTarget } from "./push/notifier.js";
import { webPushSender } from "./push/sender.js";
import { pushSubject, vapidKeys, type VapidKeys } from "./push/vapid.js";
import { LiveHub } from "./hub/live.js";
import { TicketStore } from "./hub/tickets.js";
import { FeedForwarder } from "./hub/feed.js";
import { machineDispatch, type MachineDispatch } from "./machines/dispatch.js";
import { GuildRuntime, type TurnPlacement } from "./harness/runtime.js";
import { AgentStore } from "./agents/store.js";
import { AgentScheduler } from "./agents/scheduler.js";
import { ForkSupervisor } from "./worker/supervisor.js";
import { NotifyHub } from "./platform/notify.js";
import { clickhouseFromConfig, type ClickhouseClient } from "./platform/clickhouse.js";
import { reportMalformedEventRows } from "./hub/protocol.js";
import { SkillReadSink } from "./platform/skill-reads.js";
import { UsageSink } from "./platform/usage.js";
import { TraceStore } from "./platform/trace.js";
import { masterKeyBytes } from "./platform/crypto.js";
import { IdpRecheck } from "./platform/idp-recheck.js";
import { gatewayCredential } from "./platform/http/auth.js";
import type { GatewayCredential } from "./platform/llm-gateway.js";
import type { SocketSeams } from "./platform/route-contexts.js";
import pino, { type Logger } from "pino";

/** Every schema step, in order: the platform migrations (which create the
 *  chat ↔ conversation mapping), the durable storage migrations, then the
 *  legacy task boundary the task-failure projection reads. Idempotent. */
export async function migrateSchema(pool: PlatformPool, log: Logger): Promise<void> {
  await applyPlatformMigrations(pool, { log });
  await applyPostgresMigrations(new SharedPoolDatabase(pool));
  await seedRecoveryBoundary(pool);
}

export class PlatformContext implements PlatformStores {
  readonly pool: PlatformPool;
  readonly objects: ObjectStore;
  readonly identity: PlatformStores["identity"];
  readonly pairing: PlatformStores["pairing"];
  readonly events: PlatformStores["events"];
  readonly attachments: PlatformStores["attachments"];
  readonly orgs: PlatformStores["orgs"];
  readonly oidc: PlatformStores["oidc"];
  readonly apiKeys: PlatformStores["apiKeys"];
  readonly gatewayStore: PlatformStores["gatewayStore"];
  readonly machines: PlatformStores["machines"];
  readonly registry: PlatformStores["registry"];
  readonly skills: PlatformStores["skills"];
  readonly releases: PlatformStores["releases"];
  readonly projects: PlatformStores["projects"];
  readonly teams: PlatformStores["teams"];
  readonly orgKv: PlatformStores["orgKv"];
  readonly kv: PlatformStores["kv"];
  readonly integrations: PlatformStores["integrations"];
  readonly integrationSecrets: PlatformStores["integrationSecrets"];
  readonly userMcp: PlatformStores["userMcp"];
  readonly push: PlatformStores["push"];
  readonly chats: PlatformStores["chats"];
  readonly threads: PlatformStores["threads"];
  readonly turnCommands: PlatformStores["turnCommands"];
  readonly toolArtifacts: PlatformStores["toolArtifacts"];
  readonly conversations: PlatformStores["conversations"];
  readonly pushNotifier: PushNotifier;
  /** The machine/member socket registry. */
  readonly hub: LiveHub;
  /** The per-hub tool-dispatch registry (machines/dispatch.ts; one per
   *  process, hub-owned lifetime). */
  readonly machineDispatch: MachineDispatch;
  readonly wsTickets: TicketStore;
  /** Activity-driven IdP revalidation: an active OIDC user's refresh token
   *  is replayed on the interval, and a refused replay revokes the user's
   *  credentials. */
  readonly idpRecheck: IdpRecheck;
  readonly usage: UsageSink;
  /** The agent trace store (agent_traces + agent_spans + opt-in
   *  llm_payloads; trace.ts). */
  readonly trace: TraceStore;
  /** The conversation-history read model behind the Activity surface. */
  readonly conversationHistory: PlatformStores["conversationHistory"];
  /** The ClickHouse skill-read sink (read_skill analytics; the skill
   *  detail page reads the query side). */
  readonly skillReads: SkillReadSink;
  readonly clickhouse: ClickhouseClient;
  /** Postgres LISTEN hub — one dedicated connection shared by all
   *  subscribers. */
  readonly notify: NotifyHub;
  /** The process's one agent store: routes, the runtime, the scheduler and
   *  the agent feed read through it. */
  readonly agents: AgentStore;
  readonly runtime: GuildRuntime;
  /** The routine scheduler loop (started after the runtime opens). */
  readonly scheduler: AgentScheduler;
  /** Worker-per-chat: the fork supervisor (undefined when worker mode is
   *  off). The runtime routes admission through it and closes it. */
  readonly supervisor: ForkSupervisor | undefined;
  /** The member-socket feed forwarder: notify fan-in → thread views, live
   *  generation frames, chat status, org events and workspace lists, to the
   *  chat owner's sinks. */
  readonly feed: FeedForwarder;
  /** The member socket's seams into the lanes: the sync bracket's capture
   *  and subtree, the dispatch lane's tool-result completion and connect
   *  sweep, and the socket supervisor's log. */
  readonly sockets: SocketSeams;
  private readonly secretsKey: Buffer;

  constructor(
    readonly config: Config,
    private readonly log: Logger = pino({ level: "silent" }),
  ) {
    this.secretsKey = masterKeyBytes(config.masterKeyHex);
    reportMalformedEventRows((error) => log.warn({ err: error }, "thread event row sent unnormalized"));
    this.pool = createPlatformPool(config.databaseUrl, config.poolMax);
    this.objects = new ObjectStore(config);
    const stores = createStores(this.pool);
    this.identity = stores.identity;
    this.pairing = stores.pairing;
    this.events = stores.events;
    this.attachments = stores.attachments;
    this.orgs = stores.orgs;
    this.oidc = stores.oidc;
    this.apiKeys = stores.apiKeys;
    this.gatewayStore = stores.gatewayStore;
    this.machines = stores.machines;
    this.registry = stores.registry;
    this.skills = stores.skills;
    this.releases = stores.releases;
    this.projects = stores.projects;
    this.teams = stores.teams;
    this.orgKv = stores.orgKv;
    this.kv = stores.kv;
    this.integrations = stores.integrations;
    this.integrationSecrets = stores.integrationSecrets;
    this.userMcp = stores.userMcp;
    this.push = stores.push;
    this.chats = stores.chats;
    this.threads = stores.threads;
    this.turnCommands = stores.turnCommands;
    this.toolArtifacts = stores.toolArtifacts;
    this.conversations = stores.conversations;
    this.pushNotifier = new PushNotifier({
      store: this.push,
      lastEventSeq: (chatId) => this.chats.lastEventSeq(chatId),
      readSeq: (userId, chatId) => this.chats.readSeq(userId, chatId),
      sender: async () => webPushSender(await this.pushKeys(), pushSubject(this.config)),
      log: (message) => log.warn(message),
    });
    this.hub = new LiveHub();
    this.machineDispatch = machineDispatch(this.hub);
    this.wsTickets = new TicketStore();
    this.idpRecheck = new IdpRecheck({
      oidc: this.oidc,
      identity: this.identity,
      config,
      masterKey: () => this.masterKey(),
      log: (message) => log.warn(message),
    });
    this.clickhouse = clickhouseFromConfig(config);
    this.usage = new UsageSink(this.clickhouse);
    this.trace = new TraceStore(this.clickhouse, config.tracePayloads);
    this.conversationHistory = stores.conversationHistory;
    this.skillReads = new SkillReadSink(this.clickhouse);
    this.skillReads.attachPool(this.pool);
    this.notify = new NotifyHub(config.databaseUrl, log);
    this.agents = new AgentStore({
      pool: this.pool,
      chats: stores.chats,
      trace: this.trace,
      workspaceRoot: config.agentWorkspaceWriteRoot,
    });
    // Worker-per-chat mode: the server forks one worker per active chat and
    // holds no harness itself; admission routes over IPC.
    this.supervisor =
      config.workerMode === "on"
        ? new ForkSupervisor(config, log, pendingWorkQuery(this.pool), (call, signal) =>
            this.machineDispatch.dispatch(call, signal),
          )
        : undefined;
    const placement: TurnPlacement =
      this.supervisor === undefined ? { kind: "in-process" } : { kind: "workers", supervisor: this.supervisor };
    this.runtime = new GuildRuntime({
      config,
      pool: this.pool,
      log,
      stores,
      agents: this.agents,
      masterKey: () => this.masterKey(),
      placement,
      objects: this.objects,
      hub: this.hub,
      skillReads: this.skillReads,
      trace: this.trace,
    });
    this.supervisor?.setRemoteSubmit((chatId, input) => this.runtime.submitTurn(chatId, input.orgId, input));
    this.runtime.setTurnEnded((chatId, failed) => this.pushTurnEnded(chatId, failed));
    this.scheduler = new AgentScheduler({
      pool: this.pool,
      store: this.agents,
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
    this.hub.onMachineStatus = (machineId, userId, orgId, online) =>
      this.feed.machineStatus(machineId, userId, orgId, online);
    this.sockets = {
      ...syncSeams({
        pool: this.pool,
        chats: this.chats,
        threads: this.threads,
        runtime: this.runtime,
        gatewayStore: this.gatewayStore,
      }),
      toolResult: async ({ member, frame }) => {
        this.machineDispatch.resolveToolResult(member, frame);
      },
      machineReconcile: async (machineId, connId) => {
        this.machineDispatch.reconcileMachine(machineId, connId);
      },
      log: (message) => log.info({ ws: message }, "ws"),
    };
    this.feed = new FeedForwarder(
      {
        config,
        notify: this.notify,
        hub: this.hub,
        pool: this.pool,
        chats: this.chats,
        threads: this.threads,
        conversations: this.conversations,
        events: this.events,
        projects: this.projects,
        orgs: this.orgs,
        orgKv: this.orgKv,
        gatewayStore: this.gatewayStore,
        machines: this.machines,
        runtime: this.runtime,
        agents: this.agents,
        identity: this.identity,
        skills: this.skills,
        trace: this.trace,
      },
      log,
    );
    this.feed.start();
    this.runtime.setStreamSink(this.feed);
  }

  /** The 32-byte secrets key (GUILD_MASTER_KEY_HEX, checked at build). */
  masterKey(): Buffer {
    return this.secretsKey;
  }

  pushKeys(): Promise<VapidKeys> {
    return vapidKeys(this.kv);
  }

  /** Resolves a gateway bearer token to the credential the LLM gateway
   *  endpoints meter against (platform/http/auth.ts). */
  gatewayCredential(req: { headers: Record<string, unknown> }): Promise<GatewayCredential> {
    return gatewayCredential(this, req);
  }

  /** The bootstrap: every migration, the boot repairs (a send interrupted
   *  by the previous shutdown left its chat flagged as generating; the
   *  journal decides the truth), the skill_reads table, then the runtime
   *  and the routine loop (a no-op when the scheduler flag is off). */
  async start(): Promise<void> {
    await migrateSchema(this.pool, this.log);
    await this.chats.reconcileAllGenerating();
    // ClickHouse being down must not block startup: reads degrade to zero
    // and writes are dropped until it recovers.
    try {
      await this.skillReads.ensureOnce();
    } catch (error) {
      this.log.warn({ err: error }, "skill_reads table ensure failed");
    }
    await this.runtime.start();
    this.scheduler.start();
  }

  /** A turn ended for a chat: the notifier decides, after its grace period,
   *  whether the owner needs a push. The turn path does not wait for it. */
  private async pushTurnEnded(chatId: string, failed: boolean): Promise<void> {
    const owner = await this.chats.ownerOf(chatId);
    if (owner === null) return;
    const target = await turnEndPushTarget(this.agents.threads, chatId).catch((error: unknown) => {
      this.log.warn({ err: error, chatId }, "push target read failed");
      return null;
    });
    if (target === null) return;
    const chat =
      target.title === null
        ? await this.chats.getChatInOrg(owner.org_id, target.chat_id).catch((error: unknown) => {
            this.log.warn({ err: error, chatId }, "push title read failed");
            return null;
          })
        : null;
    void this.pushNotifier.turnEnded({
      orgId: owner.org_id,
      userId: owner.user_id,
      chatId: target.chat_id,
      title: target.title ?? chat?.title ?? "",
      failed,
      ...(target.body === undefined ? {} : { body: target.body }),
    });
  }

  /** Closes everything the constructor opened, in dependency order. Safe
   *  after a failed start. */
  async close(): Promise<void> {
    this.scheduler.stop();
    this.feed.stop();
    await this.runtime.close();
    await this.notify.close();
    this.objects.destroy();
    await this.pool.end();
  }
}
