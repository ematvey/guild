// The Guild agent runtime (spec decision 9): one process owns the pi-durable
// harness — the Postgres durable storage over the same database, the model
// providers (loopback gateway, decision 7), the extension registry, and the
// scheduler with auto-compaction + steering/follow-ups enabled (decision 12).
//
// Chats map 1:1 to durable conversations (the chat_conversations table,
// spec decision 6). The ChatBridge keeps thread_events, the generating
// flag, and turn-command settlement in sync so the wire contracts the
// clients consume never change.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createModels, type MutableModels, type UserMessage } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import { RunnerClient, SandboxPool, type SandboxTarget } from "../sandbox/client.js";
import { applyPostgresMigrations, PgPoolDatabase, PostgresDurableStorage } from "../storage/postgres/index.js";
import type { PlatformPool } from "../platform/db.js";
import { applyPlatformMigrations } from "../platform/migrations.js";
import { GatewayStore } from "../platform/store/gateway.js";
import { ChatStore } from "../platform/store/chats.js";
import { ThreadStore } from "../platform/store/thread.js";
import { TurnCommandStore } from "../platform/store/turn_commands.js";
import { AgentSessionStore } from "../platform/store/agentSessions.js";
import { ToolArtifactStore } from "../platform/store/toolArtifacts.js";
import { EventStore } from "../platform/store/events.js";
import { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import { UserMcpStore } from "../platform/store/userMcp.js";
import { RegistryStore } from "../platform/store/registry.js";
import { SkillStore } from "../platform/store/skills.js";
import { MachineStore } from "../platform/store/machines.js";
import { TeamStore } from "../platform/store/teams.js";
import type { ObjectStore } from "../platform/s3.js";
import type { SkillReadSink } from "../platform/skillReads.js";
import { MachineExecutionEnv, machineDispatch, type ExecutorKind, type MachineDispatchHost } from "../machines/dispatch.js";
import { execPolicy as loadExecPolicy, type ExecPolicy } from "../execpolicy/matcher.js";
import type { Config } from "../config.js";
import { createGuildExtension, ASSISTANT_PROMPT_KEY, type GuildExtensionDeps } from "./extension.js";
import { IntegrationsRuntime } from "./integrations.js";
import { UserMcpRuntime } from "./userMcp.js";
import { SkillRuntime } from "./skills.js";
import { ensureOrgProvider, guildProviderId, type GuildRouteInfo } from "./models.js";
import { ChatBridge, type GenerationStreamSink } from "../chats/bridge.js";
import type { LiveBuffers } from "../chats/bridge.js";

/** Guild-side chat ↔ durable-conversation mapping (spec decision 6). Kept
 *  out of the shared durable migrations: the storage conformance suite runs
 *  on bare databases without the platform schema. */
export async function applyChatMappingMigration(pool: PlatformPool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_conversations (
    chat_id UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL UNIQUE
  )`);
}

export interface SubmitTurnInput {
  orgId: string;
  /** The command id (turn_commands row): the submission's request id, so a
   *  retried dispatch cannot double-admit. */
  requestId: string;
  /** Composed user turn content (typed message + inlined attachment text). */
  content: string;
  /** Model-facing image parts (data URIs), when the route supports them. */
  images: { mimeType: string; data: string }[];
  model: string | null;
  /** The machine turn's client-assembled skills index (the combined
   *  section's local portion); browser/server turns send none. */
  skillsIndex?: string;
}

export class GuildRuntime {
  private readonly models: MutableModels;
  private readonly registry: Registry;
  private readonly threads: ThreadStore;
  private readonly chats: ChatStore;
  private readonly turnCommands: TurnCommandStore;
  private readonly gateway: GatewayStore;
  private readonly bridge: ChatBridge;
  private readonly watches = new Map<string, AgentEventStream>();
  private readonly chatToConversation = new Map<string, number>();
  private storage: PostgresDurableStorage | undefined;
  private harness: Harness | undefined;
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
  private policyInstance: ExecPolicy | undefined;
  private starting: Promise<void> | undefined;
  private stopped = false;


  private readonly agentSessions: AgentSessionStore;
  readonly toolArtifacts: ToolArtifactStore;
  /** The integrations chat runtime (M8): per-turn plugin resolution, the
   *  dynamic per-org tool registration, execution + audit. */
  readonly integrationsRuntime: IntegrationsRuntime;
  /** The user-MCP chat runtime: the chat owner's servers declared as
   *  mcp_<server>_<tool> per turn, executed server-side with the stored
   *  headers. */
  readonly userMcpRuntime: UserMcpRuntime;
  /** The skills runtime: the read_skill/search_skills/push_skill tools
   *  (the guild extension carries them), the Task 6 index section, and the
   *  install-fan-out hook the routes call (Task 8 fills syncUser). */
  readonly skillsRuntime: SkillRuntime;
  /** The guild extension object (the per-conversation selection carries
   *  it, resolved by name against the registry). */
  private readonly guildExtension: ReturnType<typeof createGuildExtension>;
  /** The codemode extension (the `codemode` tool, its nested model tools,
   *  and the `codemode` prompt section) — one registration object shared
   *  by every conversation configure, like CodingTools. */
  private readonly codemodeExtension: Extension;
  /** The codemode scripts' QuickJS sandbox (one per process; a worker
   *  thread per script, 300 s deadline, no memory cap beyond wasm32). */
  private readonly codemodeSandbox = new CodemodeSandbox();
  /** Server-side tool sandboxes (GUILD_SANDBOX=runner); null otherwise. */
  private readonly sandboxes: SandboxPool | null;
  /** Sandbox key → chat id, for the connect-time skill materialization. */
  private readonly sandboxChats = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly pool: PlatformPool,
    private readonly log: Logger,
    objects?: ObjectStore,
    private readonly hub?: MachineDispatchHost,
    private readonly skillReads?: Pick<SkillReadSink, "record" | "ensureOnce">,
  ) {
    this.sandboxes =
      config.sandbox.mode === "runner"
        ? new SandboxPool({
            runner: new RunnerClient(config.sandbox.runnerUrl, config.sandbox.runnerToken),
            log,
            onConnected: async (target, env) => {
              const chatId = this.sandboxChats.get(target.key);
              if (chatId !== undefined) await this.materializeSandboxSkills(chatId, env);
            },
          })
        : null;
    this.models = createModels();
    this.registry = createRegistry();
    this.threads = new ThreadStore(pool);
    this.chats = new ChatStore(pool);
    this.turnCommands = new TurnCommandStore(pool);
    this.gateway = new GatewayStore(pool);
    this.agentSessions = new AgentSessionStore(pool);
    this.toolArtifacts = new ToolArtifactStore(pool);
    const registryStore = new RegistryStore(pool);
    const events = new EventStore(pool);
    this.skillsRuntime = new SkillRuntime({
      log,
      registry: registryStore,
      skills: new SkillStore(pool),
      machines: new MachineStore(pool),
      machineOnline: (machineId) => this.hub?.machineOnline(machineId) ?? false,
      machineRequest: async ({ machineId, orgId, op, payload }) =>
        (await this.hub?.machineRequest(machineId, orgId, op, payload, 10_000)) ?? {
          ok: false,
          error: { kind: "offline" as const },
        },
      selfBaseUrl: this.config.selfBaseUrl,
      events,
      teams: new TeamStore(pool),
      objects,
      skillReads: this.skillReads,
      chatOfConversation: (conversationId) => this.chatOfConversation(conversationId),
      chatOwner: async (chatId) => {
        const owner = await this.chats.ownerOf(chatId);
        if (owner === null) return null;
        const res = await this.pool.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [owner.user_id]);
        return { orgId: owner.org_id, userId: owner.user_id, role: res.rows[0]?.role ?? "member" };
      },
      executorKind: (conversationId) => this.executorKind(conversationId),
      conversationEnv: (conversationId, orgId) => this.envForConversation(conversationId, orgId),
      materialize: (args) => this.materializeInstalledSkill(args),
    });
    this.integrationsRuntime = new IntegrationsRuntime(
      {
        gateway: {
          integrations: new IntegrationStore(pool),
          integrationSecrets: new IntegrationSecretStore(pool),
          registry: registryStore,
          masterKey: () => this.masterKey(),
        },
        events,
        artifacts: this.toolArtifacts,
        objects,
        pool,
        log,
        chatOfConversation: (conversationId) => this.chatOfConversation(conversationId),
      },
      this.registry,
    );
    this.userMcpRuntime = new UserMcpRuntime(
      {
        store: new UserMcpStore(pool),
        masterKey: () => this.masterKey(),
        log,
        chatOfConversation: (conversationId) => this.chatOfConversation(conversationId),
        chatOwnerOf: async (chatId) => await this.chats.ownerOf(chatId),
      },
      this.registry,
    );
    this.bridge = new ChatBridge({
      threads: this.threads,
      chats: this.chats,
      turnCommands: this.turnCommands,
      routeSupportsImages: async (orgId, model) => {
        if (model === null) return false;
        try {
          const route = await this.gateway.resolveRoute(orgId, model, this.masterKey());
          return route.modalities.includes("image");
        } catch {
          return false;
        }
      },
      ...(objects !== undefined ? { spill: { artifacts: this.toolArtifacts, objects } } : {}),
      log,
    });
    // Registry: the built-in tasks + the guild prompt section + the coding
    // tools (spec decision 12: built-in coding tools enabled) + codemode.
    this.guildExtension = createGuildExtension(this.extensionDeps());
    this.registry.install(this.guildExtension);
    this.registry.install(CodingTools);
    // models: false — guild's gateway carries only chat models, so the
    // scripts' `models.classify`/`generateImages` surface would be a dead
    // end and its description dead prompt weight.
    this.codemodeExtension = createCodemodeExtension({ sandbox: this.codemodeSandbox, models: false });
    this.registry.install(this.codemodeExtension);
  }

  /** The base conversation configuration: the guild, coding, and codemode
   *  extensions with their tools — every configure starts from this. */
  private baseConfiguration(): { extensions: readonly Extension[]; tools: readonly ToolRegistration[] } {
    return {
      extensions: [this.guildExtension, CodingTools, this.codemodeExtension],
      tools: [...(CodingTools.tools ?? []), ...this.skillsRuntime.tools(), ...(this.codemodeExtension.tools ?? [])],
    };
  }

  private masterKey(): Buffer {
    return Buffer.from(this.config.masterKeyHex, "hex");
  }

  private extensionDeps(): GuildExtensionDeps {
    return {
      orgPrompt: async (orgId) => {
        const res = await this.pool.query<{ value: string | null }>(
          "SELECT value FROM org_kv WHERE org_id = $1 AND key = $2",
          [orgId, ASSISTANT_PROMPT_KEY],
        );
        return res.rows[0]?.value ?? null;
      },
      orgOfConversation: async (conversationId) => {
        const chatId = await this.chatOfConversation(conversationId);
        if (chatId === null) return null;
        const res = await this.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
        return res.rows[0]?.org_id ?? null;
      },
      userOfConversation: async (conversationId) => {
        const chatId = await this.chatOfConversation(conversationId);
        if (chatId === null) return null;
        const owner = await this.chats.ownerOf(chatId);
        return owner === null ? null : { id: owner.user_id };
      },
      // The approval gate (M4): exec policy + approvals over the chat
      // mapping and the executor resolution below.
      pool: this.pool,
      threads: this.threads,
      log: this.log,
      execPolicy: this.execPolicy(),
      approvalTimeoutMs: this.config.approvalTimeoutMs,
      selfBaseUrl: this.config.selfBaseUrl,
      internalKey: this.config.internalKey,
      allowShellTools: this.config.allowShellTools,
      chatOfConversation: (conversationId) => this.chatOfConversation(conversationId),
      executorKind: (conversationId) => this.executorKind(conversationId),
      integrations: {
        gateDecision: async (conversationId, callName) => {
          const userDecision = await this.userMcpRuntime.gateDecision(conversationId, callName);
          if (userDecision !== undefined) return userDecision;
          return this.integrationsRuntime.gateDecision(conversationId, callName);
        },
      },
      skillRuntime: this.skillsRuntime,
      currentModel: async (conversationId) => {
        await this.start();
        const conversation = await this.harness!.conversation(conversationId as never, BACKGROUND_CONTEXT);
        const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT) : undefined;
        const resolved = agent?.model?.modelId ?? null;
        this.log.info({ conversationId, found: conversation !== undefined, agentModel: resolved }, "currentModel probe");
        return resolved;
      },
    };
  }

  /** The conversation's chat id (the reverse of the chat→conversation
   *  mapping; unmapped conversations — e.g. the root — have none). */
  async chatOfConversation(conversationId: number): Promise<string | null> {
    for (const [chatId, id] of this.chatToConversation) {
      if (id === conversationId) return chatId;
    }
    return null;
  }

  /** The conversation's server-side sandbox: an agent session's workspace
   *  (`workspaces/<org>/<name>`) when one is bound, the per-conversation
   *  chat dir (`chats/<org>/<conversationId>`) otherwise. `hostDir` is
   *  where the in-process executor keeps it (tests/dev). */
  private async sandboxTarget(conversationId: number, orgId: string): Promise<SandboxTarget & { hostDir: string; chatId: string | null }> {
    const chatId = await this.chatOfConversation(conversationId);
    if (chatId !== null) {
      const workspace = await this.agentSessions.workspaceForChat(orgId, chatId);
      if (workspace !== null) {
        return {
          key: `ws:${orgId}:${workspace}`,
          subpath: `workspaces/${orgId}/${workspace}`,
          hostDir: `${this.config.dataDir}/workspaces/${orgId}/${workspace}`,
          chatId,
        };
      }
    }
    return {
      key: `chat:${orgId}:${conversationId}`,
      subpath: `chats/${orgId}/${conversationId}`,
      hostDir: `${sandboxRoot()}/${conversationId}`,
      chatId,
    };
  }

  /** The execution env for a conversation's server-side tools (the
   *  SkillRuntime deps hook and the harness env factory). Sandboxed
   *  (runner), in-process (tests/dev), or refused (disabled). */
  private async envForConversation(conversationId: number, orgId: string, opts: { materialize?: boolean } = {}): Promise<ExecutionEnv> {
    const target = await this.sandboxTarget(conversationId, orgId);
    switch (this.config.sandbox.mode) {
      case "runner": {
        if (target.chatId !== null) this.sandboxChats.set(target.key, target.chatId);
        return this.sandboxes!.envFor({ key: target.key, subpath: target.subpath });
      }
      case "inprocess-unsafe": {
        // NodeExecutionEnv.exec requires an existing cwd; the dir is
        // created lazily on first tool use.
        await mkdir(target.hostDir, { recursive: true });
        const env = new NodeExecutionEnv({ cwd: target.hostDir });
        if (opts.materialize && target.chatId !== null) await this.materializeSandboxSkills(target.chatId, env);
        return env;
      }
      case "disabled":
        throw new Error("server-side tools are disabled: no sandbox runner is configured (GUILD_SANDBOX_RUNNER_URL)");
    }
  }

  /** Removes a conversation's sandbox container (its files stay on the
   *  volume); a no-op outside runner mode. */
  async removeSandbox(target: SandboxTarget): Promise<void> {
    await this.sandboxes?.remove(target);
  }

  /** Where this conversation's tools execute — the env factory and the
   *  approval gate both resolve through this: the chat's bound machine
   *  (machine dispatch), an agent session's workspace dir, or the per-
   *  conversation sandbox (regular chats). */
  async executorKind(conversationId: number): Promise<ExecutorKind> {
    const chatId = await this.chatOfConversation(conversationId);
    if (chatId === null) return null;
    const chat = await this.pool.query<{ machine_id: string | null; org_id: string }>(
      "SELECT machine_id, org_id FROM chats WHERE id = $1",
      [chatId],
    );
    const row = chat.rows[0];
    if (!row) return null;
    if (row.machine_id !== null) return "machine";
    const workspace = await this.agentSessions.workspaceForChat(row.org_id, chatId);
    return workspace !== null ? "server" : null;
  }
  /** Turn-start skill materialization (spec §3): the chat owner's
   *  installed org skills land under the server-side executor dir before
   *  the turn's tools run. Never throws — a broken bundle or a store
   *  failure is logged and the turn proceeds without the skill files. */
  private async materializeSandboxSkills(chatId: string, env: ExecutionEnv): Promise<void> {
    try {
      const owner = await this.chats.ownerOf(chatId);
      if (owner === null) return;
      await this.skillsRuntime.materializeIntoSandbox(owner.org_id, owner.user_id, env);
    } catch (error) {
      this.log.warn({ err: error, chatId }, "skill materialization failed");
    }
  }

  /** The read_skill install-on-use dep (Task 5's hook): one freshly
   *  installed skill into the conversation's dir; the caller in
   *  harness/skills.ts catches and logs, so errors must not escape here. */
  private async materializeInstalledSkill(args: {
    conversationId: number;
    orgId: string;
    slug: string;
    version: string;
  }): Promise<void> {
    const env = await this.envForConversation(args.conversationId, args.orgId);
    await this.skillsRuntime.materializeSkill(args.orgId, args.slug, args.version, env);
  }

  /** Idempotent start: migrations, harness open, watches for every mapped
   *  conversation. The one owning process (decision 9) is the server. */
  async start(): Promise<void> {
    this.starting ??= this.startOnce();
    await this.starting;
  }

  private async startOnce(): Promise<void> {
    // The shared platform pool outlives the runtime (PlatformContext owns
    // it); the database facade must not end it on storage close.
    const db = new SharedPoolDatabase(this.pool);
    // Platform schema first: the mapping below references chats(id), and
    // every route handler assumes apps/server/migrations are current.
    // Failure throws — startup must not come up on a stale schema.
    await applyPlatformMigrations(this.pool, { log: this.log });
    await applyPostgresMigrations(db);
    await applyChatMappingMigration(this.pool);
    // The skill_reads ClickHouse DDL: ensured once at startup (spec §3's
    // detail-page stats read the table; record() also awaits it). ClickHouse
    // being down must not block startup — reads degrade to zero and writes
    // are dropped until it recovers.
    try {
      await this.skillReads?.ensureOnce();
    } catch (error) {
      this.log.warn({ err: error }, "skill_reads table ensure failed");
    }
    this.storage = await PostgresDurableStorage.open(db);
    const harness = await Harness.open(this.storage, {
      models: this.models,
      registry: this.registry,
      settings: {
        extensions: [this.registry.snapshot().extension("guild")!, CodingTools, this.codemodeExtension],
        // Decision 12: automatic background compaction on (built-in default
        // thresholds), steering/follow-ups on (the inbox boundary places
        // queued inputs; "one-at-a-time" keeps turn semantics).
        compaction: { enabled: true },
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
      },
      env: async (target) => {
        // M4 executor selection: the chat's bound machine (machine dispatch
        // over the hub), an agent session's workspace dir
        // (workspaces/<org>/<name>), or the per-conversation sandbox the M3
        // runtime used for regular chats.
        const kind = await this.executorKind(Number(target.conversationId));
        if (kind === "machine") {
          const chatId = (await this.chatOfConversation(Number(target.conversationId)))!;
          const chat = await this.pool.query<{ machine_id: string; machine_label: string | null; org_id: string; project_folder: string | null }>(
            `SELECT c.machine_id, c.machine_label, c.org_id, pr.folder AS project_folder
             FROM chats c LEFT JOIN projects pr ON pr.id = c.project_id WHERE c.id = $1`,
            [chatId],
          );
          const row = chat.rows[0]!;
          return new MachineExecutionEnv({
            machineId: row.machine_id,
            orgId: row.org_id,
            chatId,
            workdir: row.project_folder,
            timeoutMs: this.config.clientToolTimeoutMs,
            dispatch: this.dispatch()!,
          });
        }
        // Agent-session workspaces and plain chats: the server-side
        // sandbox (envForConversation picks runner / in-process / refused).
        const chatId = await this.chatOfConversation(Number(target.conversationId));
        if (chatId === null) {
          // Unmapped conversations have no org to sandbox under; only the
          // in-process executor serves them.
          if (this.config.sandbox.mode !== "inprocess-unsafe") throw new Error("no chat is bound to this conversation");
          const dir = `${sandboxRoot()}/${target.conversationId}`;
          await mkdir(dir, { recursive: true });
          return new NodeExecutionEnv({ cwd: dir });
        }
        const chat = await this.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
        return this.envForConversation(Number(target.conversationId), chat.rows[0]!.org_id, { materialize: true });
      },
      onReport: (error) => this.log.warn({ err: error }, "harness extension failure"),
    }, BACKGROUND_CONTEXT);
    harness.resume();
    this.harness = harness;
    await this.loadMapping();
    for (const [chatId, conversationId] of this.chatToConversation) {
      this.attachWatch(chatId, conversationId).catch((error) =>
        this.log.error({ err: error, chatId }, "watch attach failed"),
      );
    }
  }

  private async loadMapping(): Promise<void> {
    const res = await this.pool.query<{ chat_id: string; conversation_id: string }>(
      "SELECT chat_id, conversation_id FROM chat_conversations",
    );
    for (const row of res.rows) this.chatToConversation.set(row.chat_id, Number(row.conversation_id));
  }

  /** Attaches the bridge's event stream to one conversation (dedup: the
   *  latest watch wins). */
  private async attachWatch(chatId: string, conversationId: number): Promise<void> {
    const existing = this.watches.get(chatId);
    if (existing) {
      await existing.stop().catch(() => {});
      this.watches.delete(chatId);
    }
    const key = String(conversationId);
    this.bridge.bind(key, chatId, await this.orgOfChat(chatId));
    const stream = await watchEvents(this.harness!, conversationId as never, BACKGROUND_CONTEXT);
    stream.start(async (events) => {
      await this.bridge.handle(key, events);
    });
    this.watches.set(chatId, stream);
  }

  private async orgOfChat(chatId: string): Promise<string> {
    const res = await this.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
    return res.rows[0]!.org_id;
  }

  /** Resolves (or creates) the durable conversation for a chat. */
  async conversationForChat(chatId: string, orgId: string): Promise<Conversation> {
    await this.start();
    const known = this.chatToConversation.get(chatId);
    if (known !== undefined) {
      const conversation = await this.harness!.conversation(known as never, BACKGROUND_CONTEXT);
      if (conversation) return conversation;
      this.chatToConversation.delete(chatId);
      await this.pool.query("DELETE FROM chat_conversations WHERE chat_id = $1", [chatId]);
    }
    const conversation = await this.harness!.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await this.pool.query(
      "INSERT INTO chat_conversations (chat_id, conversation_id) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id",
      [chatId, conversation.id],
    );
    this.chatToConversation.set(chatId, conversation.id);
    await this.attachWatch(chatId, conversation.id);
    void orgId;
    return conversation;
  }

  /** Submits a user turn into the chat's conversation: the model provider
   *  for the org is refreshed from the gateway routes, the agent's model is
   *  configured, and the input is durably admitted (queued in the inbox when
   *  busy — steering/follow-up semantics, decision 12). */
  async submitTurn(chatId: string, orgId: string, input: SubmitTurnInput): Promise<number> {
    const conversation = await this.conversationForChat(chatId, orgId);
    await this.refreshOrgModels(orgId);
    // Integrations (M8): per turn the org's enabled plugins resolve into a
    // snapshot, the per-org extension carries their tools, and the
    // conversation's agent selection + tool allow-list are refreshed
    // (role-filtered like the Rust disclosure filter). User MCP servers:
    // the chat owner's enabled servers declare their tools the same way
    // (one extension + bare registrations). Orgs/users with neither keep
    // the exact previous configure behavior.
    const prepared = await this.integrationsRuntime.prepareTurn(Number(conversation.id), chatId, orgId);
    const userPrepared = await this.userMcpRuntime.prepareTurn(Number(conversation.id), chatId, orgId);
    // A "clear" must still reconfigure — it drops that runtime's stale
    // extension — so the conversation is left untouched only when both
    // runtimes have never configured it and have nothing to add now.
    if (prepared.action !== "none" || userPrepared.action !== "none") {
      const base = this.baseConfiguration();
      await conversation.configure(
        {
          extensions: [...base.extensions, ...prepared.extensions, ...userPrepared.extensions],
          tools: [...base.tools, ...prepared.tools, ...userPrepared.tools],
        },
        BACKGROUND_CONTEXT,
      );
    }
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
    const owner = await this.chats.ownerOf(chatId);
    const directive =
      owner === null ? null : await this.skillsRuntime.invocationDirective(orgId, input.content, input.skillsIndex);
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
      },
      BACKGROUND_CONTEXT,
    );
    return Number(submission.id);
  }

  /** Registers/refreshes the org's loopback provider from the gateway route
   *  table (the provider's model catalog = the org's enabled routes). */
  async refreshOrgModels(orgId: string): Promise<void> {
    const routes = await this.gateway.listRoutes(orgId);
    const infos: GuildRouteInfo[] = routes
      .filter((route) => route.enabled)
      .map((route) => ({
        model: route.model,
        reasoning: route.reasoning,
        context_window: route.context_window,
        max_output_tokens: route.max_output_tokens,
        price_in: route.price_per_mtok_in_usd,
        price_out: route.price_per_mtok_out_usd,
      }));
    ensureOrgProvider(
      this.models,
      { selfBaseUrl: this.config.selfBaseUrl, internalKey: this.config.internalKey },
      orgId,
      infos,
    );
  }

  /** Stops the chat's in-flight generation: withdraws queued inputs, aborts
   *  the ordinary ownership scope, and waits until it is idle. */
  async stopChat(chatId: string): Promise<void> {
    await this.start();
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return;
    const conversation = await this.harness!.conversation(conversationId as never, BACKGROUND_CONTEXT);
    if (!conversation) return;
    await conversation.abort(BACKGROUND_CONTEXT).catch((error) => this.log.warn({ err: error, chatId }, "abort failed"));
    await this.chats.setGenerating(await this.orgOfChat(chatId), chatId, false);
  }

  /** Kicks off a manual compaction (the fire-and-forget Rust handler): the
   *  conversation-owned compaction task summarizes while the conversation
   *  keeps working; the summary lands as a Compaction thread event. */
  async compactChat(chatId: string): Promise<boolean> {
    await this.start();
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return false;
    const conversation = await this.harness!.conversation(conversationId as never, BACKGROUND_CONTEXT);
    if (!conversation) return false;
    await conversation.compact(undefined, BACKGROUND_CONTEXT);
    return true;
  }

  /** Wires the live-frame fan-out (the member-socket feed forwarder). The
   *  bridge emits into it; without a sink the frames are simply dropped. */
  setStreamSink(sink: GenerationStreamSink | null): void {
    this.bridge.setStream(sink);
  }

  /** Live streaming buffers of a conversation (the ThreadState frame's
   *  text/thinking). */
  liveBuffers(chatId: string): LiveBuffers {
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return { text: "", thinking: "" };
    return this.bridge.buffers(String(conversationId));
  }

  conversationIdForChat(chatId: string): number | undefined {
    return this.chatToConversation.get(chatId);
  }

  /** Settles every generating chat before shutdown: aborts the in-flight
   *  generation so tasks settle, the generating flag flips, and the terminal
   *  frames reach clients while the process and its sockets are alive. */
  async drainChats(): Promise<void> {
    const rows = await this.pool.query<{ id: string }>("SELECT id FROM chats WHERE generating = true");
    for (const row of rows.rows) {
      await this.stopChat(row.id).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.drainChats().catch(() => {});
    for (const stream of this.watches.values()) {
      await stream.stop().catch(() => {});
    }
    this.watches.clear();
    if (this.harness) await this.harness.close(BACKGROUND_CONTEXT).catch(() => {});
    if (this.storage) await this.storage.close(BACKGROUND_CONTEXT).catch(() => {});
    await this.codemodeSandbox.close().catch(() => {});
    await this.sandboxes?.close().catch(() => {});
  }
}

function sandboxRoot(): string {
  return process.env.GUILD_SANDBOX_ROOT ?? "/tmp/guild-sandboxes";
}

/** PgPoolDatabase whose close() does not end the shared platform pool (the
 *  pool's lifetime belongs to the PlatformContext). */
export class SharedPoolDatabase extends PgPoolDatabase {
  override async close(): Promise<void> {
    // Storage close seals the session; the shared platform pool (owned by
    // PlatformContext) stays open.
  }
}

export type { Context };
