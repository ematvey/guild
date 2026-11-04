// Composes model access, tool provisioning, and chat admission. ConversationHost
// owns the scheduler lifetime; the turn backend (turn-backend.ts) decides
// where a chat's turns run, and a worker scopes the lifetime to one chat.
// Durable projection and live presentation consume the same committed records.
// Every store comes in through RuntimeDeps (built once by the process's
// composition root); the runtime constructs none.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  createSession,
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  ProviderDoc,
  Harness,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type EntryDraft,
  type InboxItem,
  type SubmissionId,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import { type PgPoolDatabase, PostgresDurableStorage } from "../storage/postgres/index.js";
import { ScopedDurableStorage } from "../storage/postgres/scoped.js";
import { CURRENT_POSTGRES_SCHEMA_VERSION } from "../storage/postgres/migrations.js";
import { admittedSubmission, chatsWithWork, durableSchemaVersion } from "../storage/postgres/queries.js";
import type { PlatformPool } from "../platform/db.js";
import { assertPlatformSchema } from "../platform/migrations.js";
import type { PlatformStores } from "../platform/stores.js";
import type { ObjectStore } from "../platform/s3.js";
import type { SkillReadSink } from "../platform/skill-reads.js";
import type { TraceStore } from "../platform/trace.js";
import { modalityOf } from "../platform/domain/mime.js";
import { ASSISTANT_PROMPT_KEY } from "../platform/store/org-kv.js";
import type { UserRow } from "../platform/store/identity.js";
import { machineDispatch, type ExecutorKind, type MachineDispatchHost } from "../machines/dispatch.js";
import type { SandboxTarget } from "../sandbox/client.js";
import { execPolicy as loadExecPolicy, type ExecPolicy } from "../execpolicy/matcher.js";
import type { Config } from "../config.js";
import type { AgentStore } from "../agents/store.js";
import type { Agent } from "../agents/types.js";
import { AgentRunLifecycle } from "../agents/lifecycle.js";
import { ChildResultDelivery, type ChildRunFinished } from "../agents/delivery.js";
import { failStaleRuns } from "../agents/reconcile.js";
import { AgentConflictJournal, createConflictHook } from "../agents/conflict.js";
import { createRunHook } from "../agents/run-hook.js";
import { createTraceHook } from "../agents/trace-hook.js";
import { ThreadBinding, type ChatAgentBinding } from "../agents/thread-binding.js";
import { ConversationRecovery } from "../chats/recovery.js";
import { ChatBridge, type GenerationStreamSink, type LiveBuffers } from "../chats/bridge.js";
import { agentMessageEntry } from "../chats/agent-message.js";
import {
  childResultEntry,
  childResultOf,
  childResultText,
  childResultWrite,
  type ChildResultEvent,
} from "../chats/child-result.js";
import { chatQueue } from "../chats/queue.js";
import { SharedPoolDatabase } from "../chats/durable-mapping.js";
import type { QueuedInput } from "@guild/wire/types";
import { createGuildExtension } from "./extension.js";
import { ConversationHost, type ConversationLifetime } from "./conversation-host.js";
import { ConversationDirectory } from "./conversation-directory.js";
import { SingleFlight, ConversationAdmissions, AdmissionCancelled } from "./operations.js";
import { drainIdleInbox } from "./queue-recovery.js";
import { createThreadHistoryTools } from "./thread-history.js";
import { IntegrationsRuntime } from "./integrations.js";
import { UserMcpRuntime } from "./user-mcp.js";
import { SkillRuntime } from "./skills.js";
import { guildProviderId } from "./models.js";
import { OrgModels } from "./org-models.js";
import { ConversationExecutors } from "./executors.js";
import { TurnTools, chatExtensionNames } from "./turn-tools.js";
import { turnBackend, type SubmitTurnInput, type TurnBackend, type TurnPlacement } from "./turn-backend.js";

export { ThreadAgentLocked } from "../agents/thread-binding.js";
export type { SubmitTurnInput, TurnPlacement } from "./turn-backend.js";

/** Everything the runtime runs on, built once by the process's composition
 *  root (composition.ts for the server, worker/main.ts for a worker). */
export interface RuntimeDeps {
  readonly config: Config;
  /** The platform pool: the durable storage facade and the agent lanes'
   *  reads run on it; its lifetime is the composition root's. */
  readonly pool: PlatformPool;
  readonly log: Logger;
  readonly stores: Pick<
    PlatformStores,
    | "chats"
    | "identity"
    | "threads"
    | "turnCommands"
    | "gatewayStore"
    | "toolArtifacts"
    | "attachments"
    | "events"
    | "integrations"
    | "integrationSecrets"
    | "userMcp"
    | "registry"
    | "skills"
    | "machines"
    | "teams"
    | "orgKv"
    | "orgs"
    | "conversations"
  >;
  /** The process's one agent store. */
  readonly agents: AgentStore;
  /** The 32-byte secrets key. */
  masterKey(): Buffer;
  /** Where this process's turns run. */
  readonly placement: TurnPlacement;
  readonly objects?: ObjectStore;
  /** The machine/member socket registry (the server only). */
  readonly hub?: MachineDispatchHost;
  readonly skillReads?: Pick<SkillReadSink, "record" | "ensureOnce">;
  /** The LLM trace sink: the approval judge self-reports through it. */
  readonly trace?: TraceStore;
}

/** The pause between stale-run sweeps. */
const STALE_RUN_SWEEP_MS = 5 * 60 * 1000;

export class GuildRuntime {
  private readonly config: Config;
  private readonly pool: PlatformPool;
  private readonly log: Logger;
  private readonly stores: RuntimeDeps["stores"];
  private readonly registry: Registry = createRegistry();
  /** The process's one agent store: routes, the scheduler and the agent
   *  feed read through it. */
  readonly agents: AgentStore;
  readonly binding: ThreadBinding;
  private readonly conflicts: AgentConflictJournal;
  private readonly agentRuns: AgentRunLifecycle;
  private readonly childDelivery: ChildResultDelivery;
  private readonly bridge: ChatBridge;
  private readonly recovery: ConversationRecovery;
  private readonly directory: ConversationDirectory;
  private readonly orgModels: OrgModels;
  private readonly executors: ConversationExecutors;
  private readonly turnTools: TurnTools;
  private readonly host: ConversationHost;
  private readonly turns: TurnBackend;
  private readonly watchOpening = new SingleFlight<string, void>();
  private readonly admissions = new ConversationAdmissions();
  private get watches(): Map<string, AgentEventStream> {
    return this.host.value!.watches;
  }
  /** The chat ↔ conversation mapping, both directions. Writes go through
   *  `mapConversation`/`unmapConversation`; `conversationForChat` is the only
   *  accessor that may create, and the reverse map makes
   *  `chatOfConversation` a constant-time read. */
  private readonly chatToConversation = new Map<string, number>();
  private readonly conversationToChat = new Map<number, string>();
  private get harness() {
    return this.host.value?.harness;
  }
  /** The durable database facade over the shared platform pool (the facade
   *  must not end it). Reused by every reopen. */
  private readonly durableDb: PgPoolDatabase;
  /** The supervisor's state: the harness reopen loop below. */
  private reopenAttempts = 0;
  private harnessOpenedAt = 0;
  private reopening: Promise<void> | undefined;
  private policyInstance: ExecPolicy | undefined;
  private starting: Promise<void> | undefined;
  private stopped = false;
  private reconcileStarted = false;
  private reconcileTimer: NodeJS.Timeout | undefined;

  readonly toolArtifacts: PlatformStores["toolArtifacts"];
  /** The integrations chat runtime: per-turn plugin resolution, the
   *  dynamic per-org tool registration, execution + audit. */
  readonly integrationsRuntime: IntegrationsRuntime;
  /** The user-MCP chat runtime: the chat owner's servers declared as
   *  mcp<length>_<server>_<tool> per turn, executed server-side with the stored
   *  headers. */
  readonly userMcpRuntime: UserMcpRuntime;
  /** Skill tools, prompt index, materialization, and install fan-out. */
  readonly skillsRuntime: SkillRuntime;
  /** The guild extension object (the per-conversation selection carries
   *  it, resolved by name against the registry). */
  private readonly guildExtension: ReturnType<typeof createGuildExtension>;
  /** The codemode extension (the `codemode` tool, its nested model tools,
   *  and the `codemode` prompt section) — one registration object shared
   *  by every conversation configure, like CodingTools. */
  private readonly codemodeExtension: Extension;
  /** The coding tools (read/write/edit/list/bash/web_search), offered to the
   *  model directly. Integration tools stay script-only. */
  private readonly codingTools: Extension = CodingTools;
  /** The codemode scripts' QuickJS sandbox (one per process; a worker
   *  thread per script, 300 s deadline, no memory cap beyond wasm32). */
  private readonly codemodeSandbox = new CodemodeSandbox();
  private readonly hub?: MachineDispatchHost;

  constructor(deps: RuntimeDeps) {
    const { config, pool, log, stores, objects } = deps;
    this.config = config;
    this.pool = pool;
    this.log = log;
    this.stores = stores;
    this.hub = deps.hub;
    this.agents = deps.agents;
    this.toolArtifacts = stores.toolArtifacts;
    this.durableDb = new SharedPoolDatabase(pool);
    this.host = new ConversationHost((step, error) => log.warn({ err: error, step }, "harness teardown step failed"));
    this.turns = turnBackend(deps.placement, {
      submit: (chatId, orgId, input, signal) => this.admitInProcess(chatId, orgId, input, signal),
      writeEntry: (chatId, entry) => this.writeEntryInProcess(chatId, entry),
      steer: (chatId, submissionId) => this.steerInProcess(chatId, submissionId),
      withdraw: (chatId, submissionId) => this.withdrawInProcess(chatId, submissionId),
      stop: (chatId) => this.stopInProcess(chatId),
      compact: (chatId) => this.compactInProcess(chatId),
      liveBuffers: (chatId) => this.liveBuffersInProcess(chatId),
    });
    const chatOfConversation = (conversationId: number) => this.chatOfConversation(conversationId);
    this.directory = new ConversationDirectory(stores.conversations);
    this.recovery = new ConversationRecovery(pool, stores.conversations);
    this.binding = new ThreadBinding(pool, this.agents, {
      maxDepth: config.agentMaxDepth,
      maxChildrenPerNode: config.agentMaxChildrenPerNode,
    });
    this.orgModels = new OrgModels({
      config,
      log,
      gateway: stores.gatewayStore,
      orgs: stores.orgs,
      chats: stores.chats,
      agents: this.agents,
    });
    this.conflicts = new AgentConflictJournal({
      pool,
      store: this.agents,
      writeEntry: (chatId, entry) => this.writeEntry(chatId, entry),
    });
    this.childDelivery = new ChildResultDelivery({
      pool,
      log,
      runtime: {
        submitChildResult: (chatId, orgId, result, model) => this.submitChildResult(chatId, orgId, result, model),
      },
    });
    this.agentRuns = new AgentRunLifecycle({
      pool,
      log,
      runs: this.agents.runs,
      journal: this.conflicts,
      trace: deps.trace,
      attachments: stores.attachments,
      delivery: this.childDelivery,
      title: (chatId, threadId) => this.generateThreadTitle(chatId, threadId),
    });
    this.executors = new ConversationExecutors({
      config,
      pool,
      log,
      chats: stores.chats,
      threads: stores.threads,
      attachments: stores.attachments,
      agents: this.agents,
      ...(objects === undefined ? {} : { objects }),
      chatOfConversation,
      machineDispatch: () => this.turns.machineDispatch ?? this.dispatch(),
      skills: () => this.skillsRuntime,
    });
    this.skillsRuntime = new SkillRuntime({
      log,
      registry: stores.registry,
      skills: stores.skills,
      machines: stores.machines,
      machineOnline: (machineId) => this.hub?.machineOnline(machineId) ?? false,
      machineRequest: async ({ machineId, orgId, op, payload }) =>
        (await this.hub?.machineRequest(machineId, orgId, op, payload, 10_000)) ?? {
          ok: false,
          error: { kind: "offline" as const },
        },
      selfBaseUrl: config.selfBaseUrl,
      events: stores.events,
      teams: stores.teams,
      objects,
      skillReads: deps.skillReads,
      chatOfConversation,
      chatOwner: async (chatId) => {
        const owner = await stores.chats.ownerOf(chatId);
        if (owner === null) return null;
        const label = owner.display_name !== null && owner.display_name !== "" ? owner.display_name : owner.email;
        return { orgId: owner.org_id, userId: owner.user_id, role: owner.role, label };
      },
      executorKind: (conversationId) => this.executorKind(conversationId),
      conversationEnv: (conversationId, orgId) => this.executors.envFor(conversationId, orgId),
      materialize: (args) => this.executors.materializeInstalledSkill(args),
    });
    this.integrationsRuntime = new IntegrationsRuntime(
      {
        gateway: {
          integrations: stores.integrations,
          integrationSecrets: stores.integrationSecrets,
          registry: stores.registry,
          objects: objects ?? {
            get: async () => {
              throw new Error("code plugins need the object store, which this process has none of");
            },
          },
          orgKv: stores.orgKv,
          masterKey: () => deps.masterKey(),
        },
        events: stores.events,
        artifacts: stores.toolArtifacts,
        objects,
        pool,
        chats: stores.chats,
        log,
        chatOfConversation,
      },
      this.registry,
    );
    this.userMcpRuntime = new UserMcpRuntime(
      {
        store: stores.userMcp,
        masterKey: () => deps.masterKey(),
        log,
        chatOfConversation,
        chatOwnerOf: async (chatId) => await stores.chats.ownerOf(chatId),
      },
      this.registry,
    );
    this.bridge = new ChatBridge({
      threads: stores.threads,
      chats: stores.chats,
      turnCommands: stores.turnCommands,
      routeSupportsImages: async (orgId, model) => {
        if (model === null) return false;
        try {
          const route = await stores.gatewayStore.resolveRoute(orgId, model, deps.masterKey());
          return route.modalities.includes("image");
        } catch {
          return false;
        }
      },
      ...(objects !== undefined ? { spill: { artifacts: stores.toolArtifacts, objects } } : {}),
      agentRuns: {
        postedMessage: (chatId, row) => this.agentRuns.postedMessage(chatId, row),
        runEnd: (chatId, inputs, failure) => {
          this.forgetRun(chatId);
          return this.agentRuns.runEnd(chatId, inputs, failure);
        },
      },
      agentFiles: {
        pending: async (chatId) =>
          (await stores.attachments.pendingAgentFiles(chatId)).map((row) => ({
            id: row.id,
            filename: row.filename,
            content_type: row.content_type,
            size_bytes: Number(row.size_bytes),
            modality: modalityOf(row.content_type),
          })),
      },
      log,
    });
    // Registry: the built-in tasks + the guild prompt section + the coding
    // tools (built-in coding tools enabled) + codemode.
    this.guildExtension = createGuildExtension({
      orgProfile: async (orgId) => {
        const [org, prompt] = await Promise.all([
          stores.orgs.get(orgId).catch(() => null),
          stores.orgKv.get(orgId, ASSISTANT_PROMPT_KEY),
        ]);
        return org === null ? null : { name: org.name, prompt };
      },
      orgOfConversation: async (conversationId) => {
        const chatId = await this.chatOfConversation(conversationId);
        return chatId === null ? null : stores.chats.orgOf(chatId);
      },
      userOfConversation: async (conversationId) => {
        const chatId = await this.chatOfConversation(conversationId);
        if (chatId === null) return null;
        const owner = await stores.chats.ownerOf(chatId);
        return owner === null
          ? null
          : { id: owner.user_id, email: owner.email, display_name: owner.display_name, role: owner.role };
      },
      // The approval gate: exec policy + approvals over the chat mapping and
      // the executor resolution.
      pool,
      threads: stores.threads,
      chats: stores.chats,
      orgKv: stores.orgKv,
      log,
      execPolicy: this.execPolicy(),
      approvalTimeoutMs: config.approvalTimeoutMs,
      selfBaseUrl: config.selfBaseUrl,
      internalKey: config.internalKey,
      allowShellTools: config.allowShellTools,
      chatOfConversation,
      executorKind: (conversationId) => this.executorKind(conversationId),
      attachments: stores.attachments,
      ...(objects === undefined ? {} : { objects }),
      integrations: {
        gateDecision: async (conversationId, callName) => {
          const userDecision = await this.userMcpRuntime.gateDecision(conversationId, callName);
          if (userDecision !== undefined) return userDecision;
          return this.integrationsRuntime.gateDecision(conversationId, callName);
        },
      },
      skillRuntime: this.skillsRuntime,
      toolHooks: [
        createRunHook((chatId, inputs) => this.agentRuns.runStart(chatId, inputs), chatOfConversation),
        createConflictHook(this.conflicts, chatOfConversation),
        ...(deps.trace !== undefined ? [createTraceHook(deps.trace, this.agents, chatOfConversation)] : []),
      ],
      trace: deps.trace,
      currentModel: async (conversationId) => {
        await this.start();
        const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
        const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT) : undefined;
        const resolved = agent?.model?.modelId ?? null;
        this.log.debug(
          { conversationId, found: conversation !== undefined, agentModel: resolved },
          "currentModel probe",
        );
        return resolved;
      },
      threadTools: createThreadHistoryTools({ chats: stores.chats, threads: stores.threads, chatOfConversation }),
    });
    this.registry.install(this.guildExtension);
    this.registry.install(this.codingTools);
    // models: false — guild's gateway carries only chat models, so the
    // scripts' `models.classify`/`generateImages` surface would be a dead
    // end and its description dead prompt weight.
    // The default 3000-char inline budget drops the tail of the callable
    // list (thread_history) once the agent tool set grows, so the section
    // gets 500 more characters.
    this.codemodeExtension = createCodemodeExtension({
      sandbox: this.codemodeSandbox,
      models: false,
      inlineBudget: 3500,
    });
    this.registry.install(this.codemodeExtension);
    this.turnTools = new TurnTools({
      config,
      pool,
      log,
      registry: this.registry,
      base: () => this.baseConfiguration(),
      agents: this.agents,
      threads: stores.threads,
      chats: stores.chats,
      identity: stores.identity,
      attachments: stores.attachments,
      ...(objects === undefined ? {} : { objects }),
      conversations: stores.conversations,
      binding: this.binding,
      integrations: this.integrationsRuntime,
      userMcp: this.userMcpRuntime,
      executors: this.executors,
      turns: {
        submitTurn: (chatId, orgId, input) => this.submitTurn(chatId, orgId, input),
        writeEntry: (chatId, entry) => this.writeEntry(chatId, entry),
        stopChat: (chatId) => this.stopChat(chatId),
        canStopChat: (chatId) => this.canStopChat(chatId),
      },
    });
  }

  /** Test/diagnostic access to the owned harness (read-only usage). */
  harnessForTest(): Harness | undefined {
    return this.harness;
  }

  /** The hub-backed dispatch registry (one per process, keyed by the hub). */
  dispatch(): ReturnType<typeof machineDispatch> | undefined {
    return this.hub === undefined ? undefined : machineDispatch(this.hub);
  }

  /** The process-wide exec policy (the base rules asset + local layer). */
  execPolicy(): ExecPolicy {
    this.policyInstance ??= loadExecPolicy(this.config.execPolicyRulesPath ?? undefined);
    return this.policyInstance;
  }

  /** The base conversation configuration: the guild, coding, and codemode
   *  extensions with their tools — every configure starts from this. */
  private baseConfiguration(): { extensions: readonly Extension[]; tools: readonly ToolRegistration[] } {
    const extensions = [this.guildExtension, this.codingTools, this.codemodeExtension];
    return { extensions, tools: extensions.flatMap((extension) => extension.tools ?? []) };
  }

  /** The conversation's chat id (the reverse of the chat→conversation
   *  mapping; unmapped conversations — e.g. the root — have none). */
  async chatOfConversation(conversationId: number): Promise<string | null> {
    return this.conversationToChat.get(conversationId) ?? null;
  }

  /** Where this conversation's tools execute (executors.ts). */
  executorKind(conversationId: number): Promise<ExecutorKind> {
    return this.executors.executorKind(conversationId);
  }

  /** Removes a conversation's sandbox container (its files stay on the
   *  volume); a no-op outside runner mode. */
  removeSandbox(target: SandboxTarget): Promise<void> {
    return this.executors.removeSandbox(target);
  }

  /** Initialize once: verify the schema the composition root migrated, then
   *  open this process's harness (or, with workers, recover theirs). */
  async start(): Promise<void> {
    this.starting ??= this.startOnce();
    await this.starting;
    await this.reopening;
    if (this.stopped) throw new Error("runtime is closed");
    // Runs left open by a dead process are failed once the harness is up, so
    // the stop path can reach it. Only the process that owns the whole
    // database sweeps.
    if (this.turns.ownsDatabase && !this.reconcileStarted) {
      this.reconcileStarted = true;
      await this.reconcileStaleRuns();
      this.reconcileTimer = setInterval(() => {
        void this.reconcileStaleRuns();
      }, STALE_RUN_SWEEP_MS);
      this.reconcileTimer.unref();
    }
  }

  private async reconcileStaleRuns(): Promise<void> {
    await failStaleRuns({
      pool: this.pool,
      log: this.log,
      runtime: {
        stopChat: (chatId) => this.stopChat(chatId),
        canStopChat: (chatId) => this.canStopChat(chatId),
        deliverChildResult: (input) => this.childDelivery.deliver(input),
        deliverPending: (chatId) => this.childDelivery.deliverPending(chatId),
      },
    }).catch((error: unknown) => {
      this.log.warn({ err: error }, "stale run reconcile failed");
    });
  }

  private async startOnce(): Promise<void> {
    // Startup must not come up on a stale schema: the composition root
    // migrates before the runtime starts.
    await assertPlatformSchema(this.pool);
    if ((await durableSchemaVersion(this.pool)) !== CURRENT_POSTGRES_SCHEMA_VERSION) {
      throw new Error("durable schema requires server migration");
    }
    if (!this.turns.hostsHarness) {
      // Workers run every chat: no harness here — a second scheduler would
      // adopt the workers' tasks. Boot recovery spawns workers for every
      // conversation the journal says still has pending work.
      await this.turns.recover(await chatsWithWork(this.pool, true));
      return;
    }
    // A worker bootstraps its chat's conversation mapping (create on first
    // touch), then opens the scoped harness for exactly that conversation.
    if (this.turns.scope !== undefined) await this.bootstrapWorkerConversation(this.turns.scope);
    await this.openHarness();
  }

  /** Create a chat's initial records through the Session kernel, without
   * opening a scheduler or adopting any other worker's live tasks. */
  private async bootstrapWorkerConversation(chatId: string): Promise<void> {
    const id = await this.directory.ensure(chatId, async () => {
      const bootstrap = createSession(await PostgresDurableStorage.open(this.durableDb, { migrate: false }));
      try {
        const conversation = await bootstrap.commit(async (tx) => {
          const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await tx.doc(LiveDoc, record.id);
          await tx.doc(InboxDoc, record.id);
          await tx.doc(UsageDoc, record.id);
          await tx.doc(ProviderDoc, record.id);
          await tx.doc(AgentDoc, record.id);
          return record;
        }, BACKGROUND_CONTEXT);
        return Number(conversation.id);
      } finally {
        await bootstrap.close(BACKGROUND_CONTEXT);
      }
    });
    this.mapConversation(chatId, id);
  }

  private mapConversation(chatId: string, conversationId: number): void {
    this.chatToConversation.set(chatId, conversationId);
    this.conversationToChat.set(conversationId, chatId);
  }

  private unmapConversation(chatId: string): void {
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return;
    this.chatToConversation.delete(chatId);
    if (this.conversationToChat.get(conversationId) === chatId) this.conversationToChat.delete(conversationId);
  }

  /** Opens the durable storage + harness and attaches everything a resumed
   *  session needs. Both the startup path and the supervisor's reopen loop
   *  run this — pi-durable's documented recovery for a failed session is
   *  reopen + resume: commits are atomic, so the journal is consistent, and
   *  a sealed session takes no writes, so in-flight tasks stay pending and
   *  resume re-drives them. */
  private async openHarness(): Promise<void> {
    await this.host.replace(
      () => this.createHarness(),
      () => this.initializeHarness(),
      (error) => {
        if (!this.stopped)
          this.reopening ??= this.scheduleReopen(error).finally(() => {
            this.reopening = undefined;
          });
      },
    );
  }

  private async createHarness(): Promise<ConversationLifetime> {
    const durable = await PostgresDurableStorage.open(this.durableDb, { migrate: false });
    try {
      const scope = this.turns.scope;
      const scopeId = scope === undefined ? undefined : this.chatToConversation.get(scope);
      if (scope !== undefined && scopeId === undefined) throw new Error("worker has no conversation mapping");
      const repaired = await durable.repairLiveProjections(scopeId as ConversationId | undefined);
      if (repaired.length)
        this.log.warn({ documents: repaired, conversationId: scopeId }, "rebuilt damaged live projections");
      // A worker's view: every scan forced onto its conversation, by-id
      // reads refusing foreign records — the boundary that keeps the
      // scheduler from adopting another conversation's work.
      const storage = scopeId === undefined ? durable : new ScopedDurableStorage(durable, scopeId as ConversationId);
      const harness = await Harness.open(
        storage,
        {
          models: this.orgModels.models,
          registry: this.registry,
          settings: {
            extensions: [this.registry.snapshot().extension("guild")!, this.codingTools, this.codemodeExtension],
            // Automatic background compaction on (built-in default
            // thresholds), steering/follow-ups on (the inbox boundary places
            // queued inputs; "one-at-a-time" keeps turn semantics).
            compaction: { enabled: true },
            // Every queued steer is placed at the next boundary together:
            // results of children that finished close together, or a
            // member's several steers, reach the model in one call.
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            // Same policy as pi-durable's default, with the base delay exposed
            // so tests do not spend 2+4+8 seconds on a retryable 502.
            retry: {
              enabled: true,
              maxRetries: 3,
              baseDelayMs: this.config.retryBaseDelayMs,
              maxAgentDelayMs: 60_000,
            },
          },
          env: (target) => this.executors.harnessEnv(Number(target.conversationId)),
          onReport: (error) => this.log.warn({ err: error }, "harness extension failure"),
        },
        BACKGROUND_CONTEXT,
      );
      void harness.closed.then(() =>
        this.log.info({ durable: durable.diagnostics() }, "durable storage lifetime closed"),
      );
      return { harness, storage, watches: new Map() };
    } catch (error) {
      await durable.close(BACKGROUND_CONTEXT).catch((closeError: unknown) => {
        this.log.warn({ err: closeError }, "durable storage close after a failed open failed");
      });
      throw error;
    }
  }

  private async initializeHarness(): Promise<void> {
    const harness = this.harness!;
    for (const [chatId, id] of this.chatToConversation) this.forgetConversation(chatId, id);
    this.orgModels.clear();
    // Only chats with journal work attach now; every other chat maps and
    // attaches on its first touch (attachedConversation). The worker's
    // mapping was bootstrapped for exactly its chat: the scoped harness
    // refuses foreign conversations by design.
    if (this.turns.scope === undefined) {
      this.chatToConversation.clear();
      this.conversationToChat.clear();
      await this.loadPendingMapping();
    }
    // Watches attach before resume: a re-driven run must start with its
    // watch already live. Attached after, the attach snapshot is not
    // delivered as run_start, and the bridge misses the generation id and
    // the turn-command claims for the whole resumed run.
    for (const [chatId, conversationId] of this.chatToConversation) {
      await this.attachWatch(chatId, conversationId);
    }
    // Org model providers register before resume: a re-driven run resolves
    // its model through the registry, and without this it fails no_model —
    // submit-time refresh alone only covers turns submitted in this process.
    if (this.turns.scope !== undefined)
      await this.orgModels.refresh(await this.stores.chats.requireOrgOf(this.turns.scope));
    else await this.orgModels.refreshAll();
    // Tool provisioning rides the same path a submit uses: a re-driven run
    // (crash or deploy restart) must issue new integration/MCP calls
    // against a provisioned surface, not the fresh process's core-only
    // registry.
    const pendingChats = new Set((await chatsWithWork(this.pool, false)).map((row) => row.chatId));
    for (const [chatId, conversationId] of this.chatToConversation) {
      if (!pendingChats.has(chatId)) continue;
      await this.provisionResumedConversation(chatId, conversationId);
    }
    // Re-drives the runs the previous process left pending (a crash, or a
    // deploy restart that skipped the drain): the turn continues where it
    // stopped instead of ending as interrupted.
    harness.resume();
    for (const [chatId, conversationId] of this.chatToConversation) {
      await this.reconcileConversation(chatId, conversationId);
    }
    // Never-delivered commands of past failed submits are swept at startup
    // and on every submit; the sweep failing must not block the turn.
    await this.sweepExpiredCommands();
    this.harnessOpenedAt = Date.now();
  }

  /** Provisions one resumed conversation's tools — the submit path's
   *  provisioning, keyed by chat. */
  private async provisionResumedConversation(chatId: string, conversationId: number): Promise<void> {
    const orgId = await this.stores.chats.orgOf(chatId);
    if (orgId === null) return;
    const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return;
    await this.turnTools.provision(conversation, chatId, orgId);
  }

  /** The reopen backoff ladder (first attempt immediate, then capped). */
  private static readonly REOPEN_DELAYS_MS = [0, 1_000, 5_000, 30_000];

  /** pi-durable's reopen loop with backoff. The backoff resets after ten
   *  minutes of stable running, so an isolated transient failure costs one
   *  reopen instead of a permanent 30s recovery tail. Concurrent failures
   *  (the old and the new harness both settling) collapse into one loop. */
  private async scheduleReopen(error: unknown): Promise<void> {
    if (this.stopped) return;
    if (Date.now() - this.harnessOpenedAt > 10 * 60_000) this.reopenAttempts = 0;
    let lastError = error;
    for (;;) {
      const delays = GuildRuntime.REOPEN_DELAYS_MS;
      const delay = delays[Math.min(this.reopenAttempts, delays.length - 1)]!;
      this.reopenAttempts++;
      this.log.error(
        { err: lastError, attempt: this.reopenAttempts, delayMs: delay },
        "durable session failed; reopening",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.stopped) return;
      try {
        await this.openHarness();
        this.log.info({ attempt: this.reopenAttempts }, "durable session reopened");
        return;
      } catch (reopenError) {
        lastError = reopenError;
      }
    }
  }

  /** Fails turn commands whose delivery never happened (pending = the
   *  accept committed but the submit threw — the two run back to back). */
  private async sweepExpiredCommands(): Promise<void> {
    try {
      const swept = await this.stores.turnCommands.sweepExpired(15 * 60);
      if (swept.length > 0) this.log.warn({ swept: swept.length }, "expired pending turn commands failed by sweep");
      for (const command of swept) await this.discardUnsent(command.chat_id, command.id);
    } catch (error) {
      this.log.warn({ err: error }, "turn command sweep failed");
    }
  }

  /** The submission a chat's conversation admitted under a request id, or
   *  null when it never did. */
  admittedSubmission(chatId: string, requestId: string): Promise<number | null> {
    return admittedSubmission(this.pool, chatId, requestId);
  }

  /** Drops the command of a member turn that never reached the
   *  conversation, so a retry under the same id starts over. An admitted
   *  turn is left alone. Returns the admitted submission id, or null when
   *  the turn was discarded. */
  async discardUnsent(chatId: string, requestId: string): Promise<number | null> {
    const admitted = await this.admittedSubmission(chatId, requestId);
    if (admitted !== null) return admitted;
    await this.stores.turnCommands.discardUnsubmitted(requestId);
    await this.stores.chats.reconcileGenerating(await this.stores.chats.requireOrgOf(chatId), chatId);
    return null;
  }

  /** Maps the chats whose conversation has journal work: live tasks,
   *  queued submissions, or entries the projection has not caught up on. */
  private async loadPendingMapping(): Promise<void> {
    const pending = (await chatsWithWork(this.pool, true)).map((row) => row.chatId);
    for (const [chatId, conversationId] of await this.stores.conversations.conversationsOf(pending)) {
      this.mapConversation(chatId, conversationId);
    }
  }

  /** Drops everything this process holds for one conversation: bridge
   *  state, provisioned tool snapshots and the chat-scoped extensions. */
  private forgetConversation(chatId: string, conversationId: number): void {
    this.bridge.forget(String(conversationId));
    this.orgModels.forgetConversation(conversationId);
    this.integrationsRuntime.forget(conversationId);
    this.userMcpRuntime.forget(conversationId);
    this.skillsRuntime.forget(conversationId);
    const installed = this.registry.snapshot();
    for (const name of chatExtensionNames(chatId)) {
      const extension = installed.extension(name);
      if (extension) this.registry.uninstall(extension);
    }
    this.forgetRun(chatId);
  }

  /** Drops the per-run caches of one chat once its run ends. */
  private forgetRun(chatId: string): void {
    this.orgModels.forgetRun(chatId);
    this.executors.forgetRun(chatId);
  }

  /** The chat's existing conversation with its watch attached, mapping it
   *  on first touch; undefined when the chat has none. Never creates. */
  private async attachedConversation(chatId: string): Promise<Conversation | undefined> {
    await this.start();
    let id = this.chatToConversation.get(chatId);
    if (id === undefined) {
      const mapped = await this.stores.conversations.conversationOf(chatId);
      if (mapped === null) return undefined;
      id = mapped;
      this.mapConversation(chatId, id);
    }
    const conversation = await this.harness!.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (conversation && !this.watches.has(chatId)) await this.attachWatch(chatId, id);
    return conversation;
  }

  /** Attaches the bridge's event stream to one conversation (dedup: the
   *  latest watch wins). */
  private attachWatch(chatId: string, conversationId: number): Promise<void> {
    return this.watchOpening.run(chatId, () => this.attachWatchOnce(chatId, conversationId));
  }

  private async attachWatchOnce(chatId: string, conversationId: number): Promise<void> {
    const existing = this.watches.get(chatId);
    if (existing) {
      await existing
        .stop()
        .catch((error: unknown) => this.log.debug({ err: error, chatId }, "previous watch stop failed"));
      this.watches.delete(chatId);
    }
    const key = String(conversationId);
    this.bridge.bind(key, chatId, await this.stores.chats.requireOrgOf(chatId));
    const sessionId = await this.harness!.commit(
      async (tx) => (await tx.doc(ProviderDoc, conversationId as ConversationId)).sessionId,
      BACKGROUND_CONTEXT,
    );
    this.orgModels.bindSession(sessionId, chatId, conversationId);
    const harness = this.harness!;
    const conversation = (await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT))!;
    const stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
    let closed = false;
    void harness.closed.then(() => {
      closed = true;
    });
    const recover = async () => {
      // Bound the backfill and submission snapshot on the Session line.
      // A later placement must not be skipped by advancing past its entry
      // before its queued echo was delivered.
      const { submissions, through } = await harness.commit(async (tx) => {
        const tail = await tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 1);
        const submissions = await this.recovery.submissions(chatId, conversation.id);
        return { submissions, through: tail.items[0]?.id };
      }, BACKGROUND_CONTEXT);
      if (through !== undefined) await this.bridge.recover(conversation, submissions, through);
      for (const record of submissions) {
        if (record.status === "queued") continue;
        if (
          typeof record.requestId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.requestId)
        ) {
          await this.stores.turnCommands.submitted(record.requestId, `sub:${record.id}`);
        }
        await this.bridge.handle(key, [{ type: "submission", record }]);
      }
      await this.recovery.acknowledge(chatId, submissions);
      await this.recovery.failures(chatId, conversation.id, (id, message) =>
        this.bridge.persistTaskFailure(key, id, message),
      );
    };
    try {
      await recover();
      await this.bridge.handle(key, [stream.snapshot]);
    } catch (error) {
      await stream.stop();
      throw error;
    }
    stream.start(async (events) => {
      try {
        if (events.some((event) => event.type === "snapshot")) await recover();
        await this.bridge.handle(key, events);
        if (events.some((event) => event.type === "run_end" || event.type === "snapshot")) {
          await recover();
          await this.reconcileConversation(chatId, conversationId);
        }
      } catch (error) {
        if (this.stopped || closed) return;
        this.log.error({ err: error, chatId }, "retrying transcript projection");
        // Keep the watch alive. A bounded event stream may coalesce while
        // storage is unavailable; immutable backfill and a fresh snapshot
        // restore everything needed without replaying partial deltas.
        let retryDelayMs = 250;
        while (!this.stopped && !closed && this.harness === harness) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
          try {
            await recover();
            const current = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
            const snapshot = current.snapshot;
            await current.stop();
            await this.bridge.handle(key, [snapshot]);
            await this.reconcileConversation(chatId, conversationId);
            break;
          } catch (retryError) {
            this.log.warn({ err: retryError, chatId }, "transcript projection retry failed");
          }
        }
      }
    });
    this.watches.set(chatId, stream);
  }

  /** Every ending (including model_error) must leave queued inputs with
   * a runnable owner. Startup also heals queues left by an older process. */
  private async reconcileConversation(chatId: string, conversationId: number): Promise<void> {
    const harness = this.harness;
    if (!harness || this.stopped) return;
    const conversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return;
    const chat = await this.stores.chats.identityOf(chatId);
    if (chat === null) return;
    if (!chat.archived && (await drainIdleInbox(conversation))) harness.resume();
    await this.stores.chats.reconcileGenerating(chat.org_id, chatId);
  }

  /** Resolves (or creates) the durable conversation for a chat. This is the
   *  only accessor that may create. The durable conversation is ownerless:
   *  the chat row owns the tenant, and callers resolve org from it. */
  async conversationForChat(chatId: string): Promise<Conversation> {
    await this.start();
    const known = this.chatToConversation.get(chatId);
    if (known !== undefined) {
      const conversation = await this.harness!.conversation(known as ConversationId, BACKGROUND_CONTEXT);
      if (conversation) {
        if (!this.watches.has(chatId)) await this.attachWatch(chatId, known);
        return conversation;
      }
      this.unmapConversation(chatId);
      await this.stores.conversations.remove(chatId);
      // Missing durable state cannot be reconstructed from a possibly
      // incomplete visible journal. A replacement starts with empty context.
      this.log.warn(
        { chatId, conversationId: known },
        "chat's durable conversation is gone; resetting to an empty conversation (thread history is not replayed)",
      );
    }
    const id = await this.directory.ensure(chatId, async () =>
      Number((await this.harness!.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)).id),
    );
    this.mapConversation(chatId, id);
    if (!this.watches.has(chatId)) await this.attachWatch(chatId, id);
    const conversation = await this.harness!.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("mapped conversation does not exist");
    return conversation;
  }

  /** Makes a plain chat an agent chat (agents/thread-binding.ts). */
  adoptChatAgent(chatId: string, orgId: string, userId: string, title: string): Promise<ChatAgentBinding | null> {
    return this.binding.adopt(chatId, orgId, userId, title);
  }

  /** Binds a chat to a chosen agent (agents/thread-binding.ts). */
  bindChatAgent(
    chatId: string,
    userId: string,
    agentId: string,
    title: string,
    user: UserRow,
  ): Promise<ChatAgentBinding> {
    return this.binding.bind(chatId, userId, agentId, title, user);
  }

  /** The agent bound to a chat, for the composer's chip. */
  chatAgent(chatId: string): Promise<Agent | null> {
    return this.binding.agentOf(chatId);
  }

  /** Whether the chat's thread may move to another agent. */
  agentSwitchAllowed(chatId: string): Promise<boolean> {
    return this.binding.switchAllowed(chatId);
  }

  /** Archiving a chat closes its agent-thread subtree. */
  closeChatSubtree(chatId: string): Promise<void> {
    return this.binding.closeSubtree(chatId);
  }

  /** Delivers one terminal child run to its parent thread. The run-settle
   *  path calls the same object through the lifecycle. */
  async deliverChildResult(input: ChildRunFinished): Promise<void> {
    await this.childDelivery.deliver(input);
  }

  /** Submits one child result into its parent chat as a steer input whose
   *  request id is the child run id, so a redelivery never admits it twice.
   *  The input's entry carries the event; the card is projected from it
   *  once placed. */
  async submitChildResult(
    chatId: string,
    orgId: string,
    result: ChildResultEvent,
    model: string | null,
  ): Promise<void> {
    await this.submitTurn(chatId, orgId, {
      orgId,
      requestId: result.run_id,
      content: childResultText(result, new Date().toISOString()),
      images: [],
      model,
      sendMode: "steer",
      entry: childResultEntry(result),
    });
  }

  /** The inputs waiting in a chat's inbox, as the ThreadState frame shows
   *  them. Read from the durable tables, so any process can answer. */
  chatQueue(chatId: string): Promise<QueuedInput[]> {
    return chatQueue(this.pool, chatId);
  }

  /** Writes one entry into a chat's conversation: a posted agent message
   *  (send_message), a notice another chat's work caused. It lands at once
   *  when the chat is idle, else at the turn's next boundary; the transcript
   *  row is projected from the entry. Worker IPC routes it to the chat's
   *  owner. */
  writeEntry(chatId: string, entry: EntryDraft): Promise<void> {
    return this.turns.writeEntry(chatId, entry);
  }

  /** Posts an agent message into a chat's conversation (send_message). */
  deliverAgentMessage(chatId: string, orgId: string, text: string, model: string | null): Promise<void> {
    return this.writeEntry(chatId, agentMessageEntry(orgId, model, text));
  }

  private async writeEntryInProcess(chatId: string, entry: EntryDraft): Promise<void> {
    await this.start();
    const conversation = await this.conversationForChat(chatId);
    await conversation.submit({ type: "write", entry }, BACKGROUND_CONTEXT);
    await this.reconcileConversation(chatId, Number(conversation.id));
  }

  /** Submits a user turn into the chat's conversation: the model provider
   *  for the org is refreshed from the gateway routes, the agent's model is
   *  configured, and the input is durably admitted (queued in the inbox when
   *  busy — steering/follow-up semantics). */
  submitTurn(chatId: string, orgId: string, input: SubmitTurnInput): Promise<number> {
    // A fresh turn starts a new run (the caller creates it before this
    // call), so the cached run id from the previous turn is stale.
    this.orgModels.forgetRun(chatId);
    // A chat whose turns run elsewhere (a worker delegating to another chat)
    // does not open the workspace-turn row: the chat's own worker owns it.
    if (this.turns.owns(chatId)) {
      void this.conflicts.beginTurn(chatId).catch((error: unknown) => {
        this.log.warn({ err: error, chatId }, "agent turn journal start failed");
      });
    }
    return this.admissions
      .run(chatId, (signal) => this.turns.submit(chatId, orgId, input, signal))
      .catch(async (error) => {
        if (error instanceof AdmissionCancelled) {
          await this.stores.turnCommands.settleCancelledById(input.requestId, chatId);
          await this.stores.chats.reconcileGenerating(orgId, chatId);
        }
        throw error;
      });
  }

  private async admitInProcess(
    chatId: string,
    orgId: string,
    input: SubmitTurnInput,
    signal: AbortSignal,
  ): Promise<number> {
    await this.sweepExpiredCommands();
    const conversation = await this.conversationForChat(chatId);
    await this.orgModels.refresh(orgId);
    const owner = await this.stores.chats.ownerOf(chatId);
    // Integrations + user MCP: the shared per-turn provisioning (the same
    // call the resume path makes before a re-driven run). Empty desired
    // selections clear previously configured dynamic tools.
    await this.stores.conversations.setProjectInstructions(chatId, input.agentsMd ?? "");
    await this.turnTools.provision(conversation, chatId, orgId, signal);
    signal.throwIfAborted();
    // The combined skills index section renders at turn start from the
    // stash; a turn whose client sent no index re-renders from the server
    // portion alone (browser/server turns never send one).
    this.skillsRuntime.noteTurnInput(Number(conversation.id), input.skillsIndex ?? "");
    if (input.model !== null) {
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      const current = agent.model;
      if (!current || current.provider !== guildProviderId(orgId) || current.modelId !== input.model) {
        await conversation.configure(
          { model: { provider: guildProviderId(orgId), modelId: input.model } },
          BACKGROUND_CONTEXT,
        );
      }
    }
    const content: UserMessage["content"] =
      input.images.length === 0
        ? input.content
        : [
            { type: "text", text: input.content },
            ...input.images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
          ];
    // The composer's /-trigger is deterministic: a text that starts with a
    // known skill slug gets the read-and-follow directive appended (the
    // model never has to guess the prefix's meaning). The typed text stays
    // verbatim; images make the content an array, so only its text part
    // carries the directive.
    const directive =
      owner === null || input.entry !== undefined
        ? null
        : await this.skillsRuntime.invocationDirective(orgId, input.content, input.skillsIndex);
    signal.throwIfAborted();
    const submission = await conversation.submit(
      {
        type: "input",
        content:
          directive === null
            ? content
            : Array.isArray(content)
              ? [{ type: "text", text: `${input.content}\n\n${directive}` }, ...content.slice(1)]
              : `${content}\n\n${directive}`,
        requestId: input.requestId,
        ...(input.sendMode === "steer" ? { whenBusy: "steer" as const } : {}),
        ...(input.entry === undefined ? {} : { entry: input.entry }),
      },
      BACKGROUND_CONTEXT,
    );
    await this.reconcileConversation(chatId, Number(conversation.id));
    return Number(submission.id);
  }

  /** Changes only inbox placement; the submission and its visible echo keep identity. */
  steerQueued(chatId: string, submissionId: number): Promise<boolean> {
    return this.turns.steer(chatId, submissionId);
  }

  private async steerInProcess(chatId: string, submissionId: number): Promise<boolean> {
    const conversation = await this.attachedConversation(chatId);
    if (!conversation) return false;
    const promoted = await conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const item = inbox.items.find((item) => Number(item.id) === submissionId);
      if (!item || item.mode === "write") return false;
      item.mode = "steer";
      return true;
    }, BACKGROUND_CONTEXT);
    if (promoted) await this.reconcileConversation(chatId, Number(conversation.id));
    return promoted;
  }

  /** Withdraws one queued (not yet placed) submission — the desktop
   *  queued-chip trash button's backend. Returns the pi-durable abort
   *  outcome: "aborted" removes the inbox item; "already_placed"/"settled"
   *  mean the input just reached a boundary (the caller reports 409; the
   *  placement itself reaches the client as a pushed thread frame);
   *  "not_found" = gone already, nothing to do. */
  withdrawQueued(chatId: string, submissionId: number): Promise<string> {
    return this.turns.withdraw(chatId, submissionId);
  }

  private async withdrawInProcess(chatId: string, submissionId: number): Promise<string> {
    const conversation = await this.attachedConversation(chatId);
    if (!conversation) return "not_found";
    return this.harness!.abortSubmission(submissionId as SubmissionId, BACKGROUND_CONTEXT, conversation.id);
  }

  /** Registers/refreshes the org's loopback provider from the gateway route
   *  table (the provider's model catalog = the org's enabled routes). */
  refreshOrgModels(orgId: string): Promise<void> {
    return this.orgModels.refresh(orgId);
  }

  /** Names a fresh thread from its first user message with one short model
   *  call. Explicitly named threads (title_locked), non-chat threads, and
   *  threads that already carry a title are left alone. */
  async generateThreadTitle(chatId: string, threadId: string): Promise<void> {
    const source = await this.binding.titleSource(chatId, threadId);
    if (source === null) return;
    const title = await this.orgModels.title(source);
    if (title === "") return;
    await this.stores.chats.setGeneratedTitle(source.orgId, chatId, threadId, title);
  }

  /** Whether this process can stop the chat's in-flight turn: a worker
   *  stops only its own chat. */
  canStopChat(chatId: string): boolean {
    return this.turns.owns(chatId);
  }

  /** Stops the chat's in-flight generation: withdraws queued inputs, aborts
   *  the ordinary ownership scope, and waits until it is idle. A child
   *  chat's stop is delivered to its parent as a cancellation. */
  async stopChat(chatId: string): Promise<void> {
    this.admissions.cancel(chatId);
    await this.agentRuns.cancelChildOnStop(chatId).catch((error: unknown) => {
      this.log.warn({ err: error, chatId }, "child cancel marking failed");
    });
    await this.turns.stop(chatId);
  }

  private async stopInProcess(chatId: string): Promise<void> {
    const conversation = await this.attachedConversation(chatId);
    if (!conversation) return;
    const kept = await this.withdrawChildResults(conversation);
    await conversation
      .abort(BACKGROUND_CONTEXT)
      .catch((error) => this.log.warn({ err: error, chatId }, "abort failed"));
    for (const queued of kept) {
      await conversation
        .submit({ type: "write", entry: childResultWrite(queued.event, queued.content) }, BACKGROUND_CONTEXT)
        .catch((error) => this.log.warn({ err: error, chatId }, "stopped child result write failed"));
    }
    if (kept.length > 0) await this.reconcileConversation(chatId, Number(conversation.id));
    await this.stores.chats.setGenerating(await this.stores.chats.requireOrgOf(chatId), chatId, false);
  }

  /** Withdraws the child-result inputs still queued in a conversation that
   *  is being stopped. A stop withdraws every queued input, and a result
   *  must not vanish with it: the caller writes each withdrawn one back as
   *  an entry, which starts no run. Only results this call withdrew are
   *  returned; one placed meanwhile is already in the conversation. */
  private async withdrawChildResults(
    conversation: Conversation,
  ): Promise<{ submissionId: number; content: unknown; event: ChildResultEvent }[]> {
    const queued = await conversation.commit(
      async (tx) =>
        ((await tx.doc(InboxDoc, conversation.id)).items as InboxItem[]).flatMap((item) => {
          if (item.mode === "write") return [];
          // Inbox items are draft overlays bound to the commit: copy them out.
          const copy = JSON.parse(JSON.stringify(item)) as typeof item;
          const event = childResultOf(copy.entry as never);
          return event === null ? [] : [{ submissionId: Number(copy.id), content: copy.content as unknown, event }];
        }),
      BACKGROUND_CONTEXT,
    );
    const withdrawn: typeof queued = [];
    for (const item of queued) {
      const outcome = await this.harness!.abortSubmission(
        item.submissionId as SubmissionId,
        BACKGROUND_CONTEXT,
        conversation.id,
      );
      if (outcome === "aborted") withdrawn.push(item);
    }
    return withdrawn;
  }

  /** Starts a conversation-owned compaction and returns its durable task identity. */
  compactChat(chatId: string): Promise<number | null> {
    return this.turns.compact(chatId);
  }

  private async compactInProcess(chatId: string): Promise<number | null> {
    const conversation = await this.attachedConversation(chatId);
    if (!conversation) return null;
    return Number(await conversation.compact(undefined, BACKGROUND_CONTEXT));
  }

  /** Wires the live-frame fan-out (the member-socket feed forwarder). The
   *  bridge emits into it; without a sink the frames are dropped. */
  setStreamSink(sink: GenerationStreamSink | null): void {
    this.bridge.setStream(sink);
    this.turns.setStreamSink(sink);
  }

  /** The push lane's turn-end hook (the notifier decides whether a
   *  notification is worth sending). A turn that ends in a worker is
   *  forwarded here. */
  setTurnEnded(hook: ((chatId: string, failed: boolean) => Promise<void>) | null): void {
    this.bridge.setTurnEnded(hook);
    this.turns.setTurnEnded(hook);
  }

  /** Live streaming buffers of a conversation (the ThreadState frame's
   *  text/thinking). */
  liveBuffers(chatId: string): LiveBuffers {
    return this.turns.liveBuffers(chatId);
  }

  private liveBuffersInProcess(chatId: string): LiveBuffers {
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return { text: "", thinking: "" };
    return this.bridge.buffers(String(conversationId));
  }

  conversationIdForChat(chatId: string): number | undefined {
    return this.chatToConversation.get(chatId);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconcileTimer !== undefined) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    await this.admissions.close();
    await this.turns.close();
    await this.host.close();
    await this.reopening;
    for (const [chatId, id] of this.chatToConversation) this.forgetConversation(chatId, id);
    this.chatToConversation.clear();
    this.conversationToChat.clear();
    this.orgModels.clear();
    await this.codemodeSandbox
      .close()
      .catch((error: unknown) => this.log.warn({ err: error }, "codemode sandbox close failed"));
    await this.executors.close();
  }
}
