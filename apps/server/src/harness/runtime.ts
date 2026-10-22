import { SingleFlight, ConversationAdmissions, AdmissionCancelled } from "./operations.js";
// Composes model access, tool provisioning, and chat admission. ConversationHost
// owns the scheduler lifetime; worker mode scopes that lifetime to one chat.
// Durable projection and live presentation consume the same committed records.

import type { Context } from "@earendil-works/chord";
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
  type SubmissionId,
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
import { ScopedDurableStorage } from "../storage/postgres/scoped.js";
import { ForkSupervisor } from "../worker/supervisor.js";
import type { PlatformPool } from "../platform/db.js";
import { applyPlatformMigrations } from "../platform/migrations.js";
import { GatewayStore } from "../platform/store/gateway.js";
import { ChatStore } from "../platform/store/chats.js";
import { TurnCommandStore } from "../platform/store/turn_commands.js";
import { ThreadStore } from "../platform/store/thread.js";
import { ToolArtifactStore } from "../platform/store/toolArtifacts.js";
import { AttachmentStore } from "../platform/store/attachments.js";
import { EventStore } from "../platform/store/events.js";
import { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import { UserMcpStore } from "../platform/store/userMcp.js";
import { RegistryStore } from "../platform/store/registry.js";
import { SkillStore } from "../platform/store/skills.js";
import { MachineStore } from "../platform/store/machines.js";
import { TeamStore } from "../platform/store/teams.js";
import type { ObjectStore } from "../platform/s3.js";
import type { SkillReadSink } from "../platform/skillReads.js";
import {
  MachineExecutionEnv,
  machineDispatch,
  type ExecutorKind,
  type MachineDispatchHost,
} from "../machines/dispatch.js";
import { execPolicy as loadExecPolicy, type ExecPolicy } from "../execpolicy/matcher.js";
import type { Config } from "../config.js";
import { createGuildExtension, ASSISTANT_PROMPT_KEY, type GuildExtensionDeps } from "./extension.js";
import { ConversationHost, type ConversationLifetime } from "./conversation-host.js";
import { ConversationDirectory } from "./conversation-directory.js";
import { chatsWithWork } from "../platform/store/work.js";
import { assertPlatformSchema } from "../platform/migrations.js";
import { CURRENT_POSTGRES_SCHEMA_VERSION } from "../storage/postgres/migrations.js";
import { drainIdleInbox } from "./queue-recovery.js";
import { createThreadHistoryTools } from "./thread-history.js";
import { AgentStore } from "../agents/store.js";
import type { Agent } from "../agents/types.js";
import type { UserRow } from "../platform/store/identity.js";
import { AgentRunLifecycle } from "../agents/lifecycle.js";
import { ChildResultDelivery, assistantTextForRun, type ChildRunFinished } from "../agents/delivery.js";
import { createAgentTools } from "../agents/tools.js";
import { AgentConflictJournal, createConflictHook } from "../agents/conflict.js";
import { createTraceHook } from "../agents/trace-hook.js";
import { subagentsContextForChat } from "../agents/subagents.js";
import { appendToPendingSteer } from "./inbox-merge.js";
import { agentThreadForChat, agentWorkspaceSubpath, resolveConversationWorkspace } from "../agents/workspace.js";
import {
  CONFIG_FILES,
  TOTAL_MAX_CHARS,
  agentWorkspaceDir,
  readAgentConfig,
  AGENT_WORKSPACE_PATH,
  renderFileBlock,
  seedAgentWorkspace,
  type AgentConfigFiles,
} from "../agents/workspace-config.js";
import { uuidv7 } from "../platform/time.js";
import { CODING_TOOL_NAMES, IntegrationsRuntime } from "./integrations.js";
import { UserMcpRuntime } from "./userMcp.js";
import { SkillRuntime } from "./skills.js";
import { ensureOrgProvider, guildProviderId, type GuildRouteInfo } from "./models.js";
import type { TraceStore } from "../platform/trace.js";
import { ConversationRecovery } from "../chats/recovery.js";
import { materializeTurnAttachments } from "../chats/attachment-materialize.js";
import { ChatBridge, type GenerationStreamSink } from "../chats/bridge.js";
import { createAgentWorkspaceTools, createMachineTools } from "./agent-tools.js";
import type { LiveBuffers } from "../chats/bridge.js";

/** The direct tool surface for an agent: its allowlist narrows the coding
 *  and skill tools, and codemode is always present (the only path to the
 *  script-only integration and thread-history tools). */
export function directBaseTools<T extends { name: string }>(
  base: readonly T[],
  agent: { tools: string[]; tools_mode: string } | null,
): readonly T[] {
  if (agent === null || agent.tools_mode === "all") return base;
  const allowed = new Set(agent.tools);
  return base.filter((tool) => tool.name === "codemode" || allowed.has(tool.name));
}

/** Thrown when a chat's thread belongs to an agent the caller cannot leave. */
export class ThreadAgentLocked extends Error {
  constructor() {
    super("This thread belongs to its agent. Start a new chat to use another agent.");
    this.name = "ThreadAgentLocked";
  }
}

/** The system instructions of an agent thread: who the agent is, where its
 *  files live, what its threads and workspace share, and the workspace
 *  config files themselves (OpenClaw-style: IDENTITY, SOUL, AGENTS, USER,
 *  MEMORY, BOOTSTRAP). The agent edits those files; the next turn reads
 *  them back. A desktop turn adds the user's project context after them.
 *  Each file is a tagged block carrying its full path, so the two sources
 *  stay distinguishable. Pure over the files it is given. */
export function composeAgentInstructions(
  agent: { name: string; is_personal: boolean },
  config: AgentConfigFiles,
  projectInstructions?: string,
  machineBound = false,
  spawnedBy?: { parent_name: string; depth: number; can_spawn: boolean },
): string {
  const sharing = agent.is_personal
    ? "Only its owner can use this agent, so the workspace is private."
    : "Every thread is private to the user you are talking to. The workspace is shared with everyone who can use this agent.";
  const parts: string[] = [
    `You are ${agent.name}, a persistent agent in Guild.`,
    "Your workspace is /workspace. Files there persist across your threads and are your memory; keep durable notes under memories/.",
    sharing,
    "Talk to the user in their own terms. Do not mention workspace paths, sandboxes, tools, models or other internals unless they ask about them.",
  ];
  const workspace: string[] = [
    machineBound
      ? "Your own files. Read them with agent_read and edit them with agent_write/agent_edit; " +
        "a change applies on your next turn. If BOOTSTRAP.md exists, follow it and then delete it."
      : "Your own files. Edit them with write/edit; a change applies on your next turn. " +
        "If BOOTSTRAP.md exists, follow it and then delete it.",
  ];
  let budget = TOTAL_MAX_CHARS;
  for (const entry of CONFIG_FILES) {
    const text = config.files.get(entry.name);
    if (text === undefined) {
      if (entry.required) {
        workspace.push(
          `<agent_workspace_file path="${AGENT_WORKSPACE_PATH}/${entry.name}">\n` +
            `(missing: ${entry.name})\n</agent_workspace_file>`,
        );
      }
      continue;
    }
    if (budget <= 0) break;
    const block = renderFileBlock(entry.name, text, budget);
    budget -= block.length;
    workspace.push(block);
  }
  parts.push(
    `<agent_workspace path="${AGENT_WORKSPACE_PATH}">\n${workspace.join("\n\n")}\n</agent_workspace>`,
  );
  if (spawnedBy !== undefined) {
    const spawner = spawnedBy.parent_name.replace(/"/g, "&quot;");
    parts.push(
      [
        `<spawned_by agent="${spawner}" depth="${spawnedBy.depth}">`,
        `This thread was spawned by the agent ${spawnedBy.parent_name}.`,
        "Ending your turn is how you reply to the spawner: your final text, plus any files you attach with send_file, " +
          "is delivered to the parent thread. To ask a question, end your turn with the question.",
        spawnedBy.can_spawn
          ? "You can spawn further child agents."
          : "You cannot spawn further child agents.",
        "</spawned_by>",
      ].join("\n"),
    );
  }
  if (machineBound) {
    parts.push(
      "This chat is bound to the user's project, so `read`, `write`, `edit` and `bash` act on their machine " +
        "in the project folder. `agent_read`, `agent_write`, `agent_edit` and `agent_bash` act in your own " +
        "workspace sandbox; that sandbox is a full Linux environment, so other paths there work too.",
    );
  }
  const project = projectBlock(projectInstructions);
  if (project !== null) parts.push(project);
  return parts.join("\n\n");
}

/** Server-side cap on the client-sent chain; the desktop truncates to the
 *  same budget before sending, this is the trust boundary. */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 32 * 1024;

/** The desktop project's instruction chain, appended after the workspace
 *  files in pi's context syntax: the client sends `<project_instructions
 *  path="...">` blocks, this wraps them in the `<project_context>` section.
 *  The text is client-supplied, so it is cut here regardless of what the
 *  client did; empty or whitespace-only input yields no block. */
function projectBlock(text: string | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return null;
  const cut =
    trimmed.length <= PROJECT_INSTRUCTIONS_MAX_CHARS
      ? trimmed
      : `${trimmed.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n\n(truncated)`;
  return [
    "<project_context>",
    "Project-specific instructions and guidelines:",
    "From the user's desktop project, not your workspace. These files live on their machine.",
    "",
    cut,
    "</project_context>",
  ].join("\n");
}

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
  /** Requested placement when the conversation is busy: "steer" places the
   *  input after the current tool round and joins the running turn;
   *  absent (and "queue") is the default follow-up — the input waits for
   *  the turn's final boundary and starts the next run. */
  sendMode?: "queue" | "steer";
  /** The machine turn's client-assembled skills index (the combined
   *  section's local portion); browser/server turns send none. */
  skillsIndex?: string;
  /** The desktop's project instruction chain (global config-dir file plus
   *  the project's AGENTS.md chain); browser/server turns send none. */
  agentsMd?: string;
}

export class GuildRuntime {
  private readonly models: MutableModels;
  private readonly registry: Registry;
  private readonly threads: ThreadStore;
  private readonly chats: ChatStore;
  private readonly agents: AgentStore;
  private readonly conflicts: AgentConflictJournal;
  private readonly agentRuns: AgentRunLifecycle;
  private readonly childDelivery: ChildResultDelivery;
  private readonly turnCommands: TurnCommandStore;
  private readonly gateway: GatewayStore;
  private readonly bridge: ChatBridge;
  private readonly recovery: ConversationRecovery;
  private readonly host = new ConversationHost();
  /** The last desktop-sent project instruction chain per conversation, so
   *  a resumed run sees the same instructions its submit did. */
  private readonly projectInstructions = new Map<number, string>();
  private readonly watchOpening = new SingleFlight<string, void>();
  private readonly admissions = new ConversationAdmissions();
  private get watches(): Map<string, AgentEventStream> {
    return this.host.value!.watches;
  }
  private readonly directory: ConversationDirectory;
  private readonly providerChats = new Map<string, { chatId: string; conversationId: number }>();
  /** Short-lived chat → running run id cache: one lookup per model call is
   *  too much, and a run id only matters while the turn is live. */
  private readonly runIdCache = new Map<string, { id: string | null; at: number }>();
  private readonly chatToConversation = new Map<string, number>();
  private get harness() {
    return this.host.value?.harness;
  }
  /** The durable database facade, created once at startup (the platform
   *  pool outlives the runtime; the facade must not end it). Reused by
   *  every supervisor reopen. */
  private durableDb: PgPoolDatabase | undefined;
  /** Supervisor state (the reopen loop below). */
  private reopenAttempts = 0;
  private harnessOpenedAt = 0;
  private reopening: Promise<void> | undefined;
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

  readonly toolArtifacts: ToolArtifactStore;
  /** The integrations chat runtime (M8): per-turn plugin resolution, the
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
  private readonly codingTools: Extension;
  /** The codemode scripts' QuickJS sandbox (one per process; a worker
   *  thread per script, 300 s deadline, no memory cap beyond wasm32). */
  private readonly codemodeSandbox = new CodemodeSandbox();
  /** Server-side tool sandboxes (GUILD_SANDBOX=runner); null otherwise. */
  private readonly sandboxes: SandboxPool | null;
  /** Sandbox key → chat id, for the connect-time skill materialization. */
  private readonly sandboxChats = new Map<string, string>();
  /** Object storage for turn attachment materialization and send_file. */
  private readonly objects?: ObjectStore;
  private readonly attachments: AttachmentStore;
  /** Chat → run whose turn directory is already materialized. */
  private readonly materializedTurns = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly pool: PlatformPool,
    private readonly log: Logger,
    objects?: ObjectStore,
    private readonly hub?: MachineDispatchHost,
    private readonly skillReads?: Pick<SkillReadSink, "record" | "ensureOnce">,
    /** The LLM trace sink: the approval judge self-reports through it. */
    private readonly trace?: TraceStore,
    /** Worker-per-chat: the server's forker (worker mode only). When set,
     *  admission routes over IPC and the server opens no harness. */
    private readonly supervisor?: ForkSupervisor,
    /** Worker side: this process serves exactly one chat (worker/main.ts). */
    private readonly workerScope?: {
      chatId: string;
      /** The IPC machine-dispatch proxy (worker/dispatch-proxy.ts): the
       *  worker has no hub, so machine-bound chats proxy dispatch to the
       *  server's hub-backed registry over the fork channel. */
      dispatch?: Pick<import("../machines/dispatch.js").MachineDispatch, "dispatch">;
      /** Admission for a chat this worker does not own: proxied to the
       *  server, which owns every chat's worker (delegation). */
      remoteSubmit?: (chatId: string, orgId: string, input: SubmitTurnInput) => Promise<number>;
    },
  ) {
    this.objects = objects;
    this.attachments = new AttachmentStore(pool);
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
    this.directory = new ConversationDirectory(pool);
    this.recovery = new ConversationRecovery(pool);
    this.models = createModels();
    this.registry = createRegistry();
    this.threads = new ThreadStore(pool);
    this.chats = new ChatStore(pool);
    this.agents = new AgentStore(pool, this.trace, this.config.agentWorkspaceWriteRoot);
    this.conflicts = new AgentConflictJournal({ pool, store: this.agents, threads: this.threads });
    this.childDelivery = new ChildResultDelivery({
      pool,
      store: this.agents,
      threads: this.threads,
      log,
      runtime: {
        beginRun: async (thread) => {
          const run = await this.agents.createRun({
            agent_id: thread.agent_id,
            user_id: thread.user_id,
            thread_id: thread.id,
            depth: thread.depth,
            trigger: "message",
            status: "running",
            started_at: new Date().toISOString(),
          });
          return run.id;
        },
        deliverSteer: (chatId, orgId, text, model) => this.deliverChildSteer(chatId, orgId, text, model),
      },
    });
    this.agentRuns = new AgentRunLifecycle({
      pool,
      log,
      journal: this.conflicts,
      trace: this.trace,
      attachments: this.attachments,
      delivery: this.childDelivery,
    });
    this.turnCommands = new TurnCommandStore(pool);
    this.gateway = new GatewayStore(pool);
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
      agentRuns: {
        assistantEvent: (chatId, row) => this.agentRuns.assistantEvent(chatId, row),
        runEnd: (chatId, failure) => this.agentRuns.runEnd(chatId, failure),
      },
      log,
    });
    // Registry: the built-in tasks + the guild prompt section + the coding
    // tools (spec decision 12: built-in coding tools enabled) + codemode.
    this.guildExtension = createGuildExtension({
      ...this.extensionDeps(),
      threadTools: createThreadHistoryTools({
        pool: this.pool,
        chatOfConversation: (conversationId) => this.chatOfConversation(conversationId),
      }),
    });
    this.registry.install(this.guildExtension);
    this.codingTools = CodingTools;
    this.registry.install(this.codingTools);
    // models: false — guild's gateway carries only chat models, so the
    // scripts' `models.classify`/`generateImages` surface would be a dead
    // end and its description dead prompt weight.
    this.codemodeExtension = createCodemodeExtension({ sandbox: this.codemodeSandbox, models: false });
    this.registry.install(this.codemodeExtension);
  }

  /** The base conversation configuration: the guild, coding, and codemode
   *  extensions with their tools — every configure starts from this. */
  private baseConfiguration(): { extensions: readonly Extension[]; tools: readonly ToolRegistration[] } {
    const extensions = [this.guildExtension, this.codingTools, this.codemodeExtension];
    return { extensions, tools: extensions.flatMap((extension) => extension.tools ?? []) };
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
      toolHooks: [
        createConflictHook(this.conflicts, (id) => this.chatOfConversation(id)),
        ...(this.trace !== undefined
          ? [createTraceHook(this.trace, this.agents, (id) => this.chatOfConversation(id))]
          : []),
      ],
      trace: this.trace,
      currentModel: async (conversationId) => {
        await this.start();
        const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
        const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT) : undefined;
        const resolved = agent?.model?.modelId ?? null;
        this.log.info(
          { conversationId, found: conversation !== undefined, agentModel: resolved },
          "currentModel probe",
        );
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

  /** Agent workspace resolution lands with the agents runtime. Plain chats
   *  keep their per-conversation sandbox (`chats/<org>/<conversationId>`);
   *  `hostDir` is where the in-process executor keeps it (tests/dev). */
  private async sandboxTarget(
    conversationId: number,
    orgId: string,
  ): Promise<SandboxTarget & { hostDir: string; chatId: string | null }> {
    const chatId = await this.chatOfConversation(conversationId);
    const target = await resolveConversationWorkspace(this.pool, {
      conversationId,
      orgId,
      chatId,
      agentWorkspaceRoot: this.config.agentWorkspaceRoot,
      plainHostRoot: sandboxRoot(),
    });
    return {
      key: target.key,
      subpath: target.subpath,
      hostDir: target.hostDir,
      chatId: target.chatId,
    };
  }

  /** The execution env for a conversation's server-side tools (the
   *  SkillRuntime deps hook and the harness env factory). Sandboxed
   *  (runner), in-process (tests/dev), or refused (disabled). */
  private async envForConversation(
    conversationId: number,
    orgId: string,
    opts: { materialize?: boolean } = {},
  ): Promise<ExecutionEnv> {
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
    const workspace = await this.agentWorkspaceForChat(row.org_id, chatId);
    return workspace !== null ? "server" : null;
  }

  /** The agent workspace subpath behind a chat, or null for a plain chat. */
  private async agentWorkspaceForChat(orgId: string, chatId: string | null): Promise<string | null> {
    if (chatId === null) return null;
    const agent = await agentThreadForChat(this.pool, chatId);
    return agent === null ? null : agentWorkspaceSubpath(orgId, agent.agent_id);
  }
  /** Turn-start skill materialization: the chat owner's installed org
   *  skills land under the sandbox root before the turn's tools run, so a
   *  plain chat's agent can read a skill's extra files with read_file.
   *  An agent workspace outlives the conversation and belongs to the agent,
   *  so no skill files are copied into it — read_skill serves the registry
   *  bundle instead. Never throws: a broken bundle or a store failure is
   *  logged and the turn proceeds without the skill files. */
  private async materializeSandboxSkills(chatId: string, env: ExecutionEnv): Promise<void> {
    try {
      const owner = await this.chats.ownerOf(chatId);
      if (owner === null) return;
      if ((await this.agentWorkspaceForChat(owner.org_id, chatId)) !== null) return;
      await this.skillsRuntime.materializeIntoSandbox(owner.org_id, owner.user_id, env);
    } catch (error) {
      this.log.warn({ err: error, chatId }, "skill materialization failed");
    }
  }

  /** Writes the turn's attachments into the sandbox at
   *  /tmp/attachments/<runId>/ and wipes the previous turn's directory.
   *  Runs once per run, before the first tool call. */
  private async materializeAttachmentsForTurn(chatId: string, orgId: string, env: ExecutionEnv): Promise<void> {
    if (this.objects === undefined || this.config.sandbox.mode !== "runner") return;
    const run = await this.agents.runningRunForChat(chatId).catch(() => null);
    if (run === null) return;
    if (this.materializedTurns.get(chatId) === run.id) return;
    this.materializedTurns.set(chatId, run.id);
    try {
      const ids = new Set<string>();
      // The user event is written just before or just after the run row;
      // the nearest one in time is this turn's message, even when later
      // messages are already queued.
      const messages = await this.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM thread_events
         WHERE chat_id = $1 AND type = 'user_message'
         ORDER BY abs(extract(epoch FROM (created_at - $2::timestamptz))) ASC, seq DESC
         LIMIT 1`,
        [chatId, run.started_at ?? run.created_at],
      );
      const deliveries = await this.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM thread_events
         WHERE chat_id = $1 AND type = 'child_result'
           AND (consumed_by_run_id IS NULL OR consumed_by_run_id = $2)`,
        [chatId, run.id],
      );
      for (const row of [...messages.rows, ...deliveries.rows]) {
        const list = Array.isArray(row.payload.attachments) ? row.payload.attachments : [];
        for (const item of list) {
          if (typeof item === "string") ids.add(item);
          else if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
            ids.add((item as { id: string }).id);
          }
        }
      }
      const rows = await this.attachments.byIds(orgId, [...ids]);
      await materializeTurnAttachments({
        env,
        objects: this.objects,
        orgId,
        runId: run.id,
        rows,
        context: BACKGROUND_CONTEXT,
      });
    } catch (error) {
      this.materializedTurns.delete(chatId);
      this.log.warn({ err: error, chatId, runId: run.id }, "attachment materialization failed");
    }
  }

  /** The read_skill install-on-use dep: one freshly installed skill into a
   *  plain chat's dir; the caller in harness/skills.ts catches and logs, so
   *  errors must not escape here. An agent workspace gets nothing. */
  private async materializeInstalledSkill(args: {
    conversationId: number;
    orgId: string;
    slug: string;
    version: string;
  }): Promise<void> {
    const chatId = await this.chatOfConversation(args.conversationId);
    if (chatId === null) return;
    if ((await this.agentWorkspaceForChat(args.orgId, chatId)) !== null) return;
    const env = await this.envForConversation(args.conversationId, args.orgId);
    await this.skillsRuntime.materializeSkill(args.orgId, args.slug, args.version, env);
  }

  /** Initialize once; the server migrates, workers verify and open their scope. */
  async start(): Promise<void> {
    this.starting ??= this.startOnce();
    await this.starting;
    await this.reopening;
    if (this.stopped) throw new Error("runtime is closed");
  }

  private async startOnce(): Promise<void> {
    // The shared platform pool outlives the runtime (PlatformContext owns
    // it); the database facade must not end it on storage close.
    this.durableDb = new SharedPoolDatabase(this.pool);
    // Platform schema first: the mapping below references chats(id), and
    // every route handler assumes apps/server/migrations are current.
    // Failure throws — startup must not come up on a stale schema.
    if (this.workerScope) {
      await assertPlatformSchema(this.pool);
      const schema = await this.pool.query<{ version: number }>("SELECT version FROM durable_schema WHERE singleton=1");
      if (schema.rows[0]?.version !== CURRENT_POSTGRES_SCHEMA_VERSION)
        throw new Error("durable schema requires server migration");
    } else {
      await applyPlatformMigrations(this.pool, { log: this.log });
      await applyPostgresMigrations(this.durableDb!);
      await applyChatMappingMigration(this.pool);
      await this.pool.query(
        "INSERT INTO chat_recovery_metadata(singleton,legacy_task_id) SELECT true,COALESCE(max(id),0) FROM tasks ON CONFLICT DO NOTHING",
      );
    }
    // The skill_reads ClickHouse DDL: ensured once at startup (spec §3's
    // detail-page stats read the table; record() also awaits it). ClickHouse
    // being down must not block startup — reads degrade to zero and writes
    // are dropped until it recovers.
    try {
      await this.skillReads?.ensureOnce();
    } catch (error) {
      this.log.warn({ err: error }, "skill_reads table ensure failed");
    }
    if (this.workerScope) {
      // Worker: bootstrap its chat's conversation mapping (create on first
      // touch), then open the scoped harness for exactly that conversation.
      await this.bootstrapWorkerConversation();
    } else if (this.supervisor) {
      // Server in worker mode: no harness here — a second scheduler would
      // adopt the workers' tasks. Boot recovery spawns workers for every
      // conversation the journal says still has pending work.
      await this.supervisor.recoverFromJournal(await this.chatsWithPendingWork(true));
      return;
    }
    await this.openHarness();
  }

  /** Create a chat's initial records through the Session kernel, without
   * opening a scheduler or adopting any other worker's live tasks. */
  private async bootstrapWorkerConversation(): Promise<void> {
    const chatId = this.workerScope!.chatId;
    const id = await this.directory.ensure(chatId, async () => {
      const bootstrap = createSession(await PostgresDurableStorage.open(this.durableDb!, { migrate: false }));
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
    this.chatToConversation.set(chatId, id);
  }

  /** Server-side boot scan: chats whose conversation has live tasks or
   *  queued submissions (the journal is the registry). */
  private async chatsWithPendingWork(includeProjections = false): Promise<{ chatId: string }[]> {
    return chatsWithWork(this.pool, includeProjections);
  }

  /** Opens the durable storage + harness and attaches everything a resumed
   *  session needs. Both the startup path and the supervisor's reopen path
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
    const db = this.durableDb;
    if (!db) throw new Error("openHarness before startOnce");
    const durable = await PostgresDurableStorage.open(db, { migrate: false });
    try {
      const scopeId = this.workerScope ? this.chatToConversation.get(this.workerScope.chatId) : undefined;
      if (this.workerScope && scopeId === undefined) throw new Error("worker has no conversation mapping");
      const repaired = await durable.repairLiveProjections(scopeId as ConversationId | undefined);
      if (repaired.length)
        this.log.warn({ documents: repaired, conversationId: scopeId }, "rebuilt damaged live projections");
      let storage;
      if (this.workerScope) {
        // The worker's view: every scan forced onto its conversation, by-id
        // reads refusing foreign records — the boundary that keeps the
        // scheduler from adopting another conversation's work.
        const conversationId = this.chatToConversation.get(this.workerScope.chatId);
        if (conversationId === undefined) throw new Error("worker has no conversation mapping");
        storage = new ScopedDurableStorage(durable, conversationId as ConversationId);
      } else {
        storage = durable;
      }
      const harness = await Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
          settings: {
            extensions: [
              this.registry.snapshot().extension("guild")!,
              this.codingTools,
              this.codemodeExtension,
            ],
            // Decision 12: automatic background compaction on (built-in default
            // thresholds), steering/follow-ups on (the inbox boundary places
            // queued inputs; "one-at-a-time" keeps turn semantics).
            compaction: { enabled: true },
            steeringMode: "one-at-a-time",
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
          env: async (target) => {
            // M4 executor selection: the chat's bound machine (machine dispatch
            // over the hub), an agent session's workspace dir
            // (workspaces/<org>/<name>), or the per-conversation sandbox the M3
            // runtime used for regular chats.
            const kind = await this.executorKind(Number(target.conversationId));
            if (kind === "machine") {
              const dispatch = this.workerScope?.dispatch ?? this.dispatch();
              if (!dispatch) throw new Error("machine-bound chat has no dispatch host");
              const chatId = (await this.chatOfConversation(Number(target.conversationId)))!;
              const chat = await this.pool.query<{
                machine_id: string;
                machine_label: string | null;
                org_id: string;
                project_folder: string | null;
              }>(
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
                dispatch,
              });
            }
            // Agent-session workspaces and plain chats: the server-side
            // sandbox (envForConversation picks runner / in-process / refused).
            const chatId = await this.chatOfConversation(Number(target.conversationId));
            if (chatId === null) {
              // Unmapped conversations have no org to sandbox under; only the
              // in-process executor serves them.
              if (this.config.sandbox.mode !== "inprocess-unsafe")
                throw new Error("no chat is bound to this conversation");
              const dir = `${sandboxRoot()}/${target.conversationId}`;
              await mkdir(dir, { recursive: true });
              return new NodeExecutionEnv({ cwd: dir });
            }
            const chat = await this.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
            const env = await this.envForConversation(Number(target.conversationId), chat.rows[0]!.org_id, { materialize: true });
            await this.materializeAttachmentsForTurn(chatId, chat.rows[0]!.org_id, env);
            return env;
          },
          onReport: (error) => this.log.warn({ err: error }, "harness extension failure"),
        },
        BACKGROUND_CONTEXT,
      );
      void harness.closed.then(() =>
        this.log.info({ durable: durable.diagnostics() }, "durable storage lifetime closed"),
      );
      return { harness, storage, watches: new Map() };
    } catch (error) {
      await durable.close(BACKGROUND_CONTEXT).catch(() => {});
      throw error;
    }
  }

  private async initializeHarness(): Promise<void> {
    const harness = this.harness!;
    // The worker's mapping was bootstrapped for exactly its chat; loading
    // the full table here would attach foreign conversations' watches, and
    // the scoped harness refuses them by design.
    for (const id of this.chatToConversation.values()) {
      this.bridge.forget(String(id));
      this.integrationsRuntime.forget(id);
      this.userMcpRuntime.forget(id);
      this.skillsRuntime.forget(id);
    }
    this.providerChats.clear();
    if (!this.workerScope) await this.loadMapping();
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
    if (this.workerScope) await this.refreshOrgModels(await this.orgOfChat(this.workerScope.chatId));
    else await this.refreshAllOrgModels();
    // Tool provisioning rides the same path a submit uses: a re-driven run
    // (crash or deploy restart) must issue new integration/MCP calls
    // against a provisioned surface, not the fresh process's core-only
    // registry.
    const pendingChats = new Set((await this.chatsWithPendingWork()).map((row) => row.chatId));
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
    // Never-delivered commands of past failed submits (the durable wedge
    // left two pending rows forever) — swept at startup and on every
    // submit; the sweep failing must not block the turn.
    await this.sweepExpiredCommands();
    this.harnessOpenedAt = Date.now();
  }

  /** Provisions one resumed conversation's tools — the submit path's
   *  provisioning, keyed by chat. */
  private async provisionResumedConversation(chatId: string, conversationId: string | number): Promise<void> {
    const chat = await this.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
    if (chat.rows[0] === undefined) return;
    const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return;
    await this.provisionTurnTools(conversation, chatId, chat.rows[0].org_id);
  }

  /** The reopen backoff ladder (first attempt immediate, then capped). */
  private static readonly REOPEN_DELAYS_MS = [0, 1_000, 5_000, 30_000];

  /** pi-durable's reopen loop with backoff. The backoff resets after ten
   *  minutes of stable running, so an isolated transient failure costs one
   *  reopen instead of a permanent 30s recovery tail. Concurrent failures
   *  (the old and the new harness both settling) collapse into one loop. */
  private async scheduleReopen(error: unknown): Promise<void> {
    if (this.stopped) return;
    {
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
  }

  /** Fails turn commands whose delivery never happened (pending = the
   *  accept committed but the submit threw — the two run back to back). */
  private async sweepExpiredCommands(): Promise<void> {
    try {
      const swept = await this.turnCommands.sweepExpired(15 * 60);
      if (swept > 0) this.log.warn({ swept }, "expired pending turn commands failed by sweep");
    } catch (error) {
      this.log.warn({ err: error }, "turn command sweep failed");
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
  private attachWatch(chatId: string, conversationId: number): Promise<void> {
    return this.watchOpening.run(chatId, () => this.attachWatchOnce(chatId, conversationId));
  }

  private async attachWatchOnce(chatId: string, conversationId: number): Promise<void> {
    const existing = this.watches.get(chatId);
    if (existing) {
      await existing.stop().catch(() => {});
      this.watches.delete(chatId);
    }
    const key = String(conversationId);
    this.bridge.bind(key, chatId, await this.orgOfChat(chatId));
    const sessionId = await this.harness!.commit(
      async (tx) => (await tx.doc(ProviderDoc, conversationId as ConversationId)).sessionId,
      BACKGROUND_CONTEXT,
    );
    this.providerChats.set(sessionId, { chatId, conversationId });
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
          await this.turnCommands.submitted(record.requestId, `sub:${record.id}`);
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
        while (!this.stopped && !closed && this.harness === harness) {
          await new Promise((resolve) => setTimeout(resolve, 250));
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
    const row = await this.pool.query<{ org_id: string; archived_at: Date | null }>(
      "SELECT org_id,archived_at FROM chats WHERE id=$1",
      [chatId],
    );
    if (!row.rows[0]) return;
    if (row.rows[0].archived_at === null && (await drainIdleInbox(conversation))) harness.resume();
    await this.chats.reconcileGenerating(row.rows[0].org_id, chatId);
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
      const conversation = await this.harness!.conversation(known as ConversationId, BACKGROUND_CONTEXT);
      if (conversation) return conversation;
      this.chatToConversation.delete(chatId);
      await this.pool.query("DELETE FROM chat_conversations WHERE chat_id = $1", [chatId]);
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
    this.chatToConversation.set(chatId, id);
    if (!this.watches.has(chatId)) await this.attachWatch(chatId, id);
    const conversation = await this.harness!.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("mapped conversation does not exist");
    void orgId;
    return conversation;
  }

  /** The per-turn tool provisioning submit and resume share: resolve the
   *  org's enabled integrations + the chat owner's MCP servers into
   *  extensions + tools and configure the conversation with them. Submit
   *  runs it before admission; resume runs it before the re-driven run —
   *  a resumed run must see the same tool surface a submitted one gets
   *  (the fresh process's registry carries only the base extensions). */
  /** Seeds the workspace config files when absent, reads them, and builds
   *  the thread's instructions. A broken volume never fails a turn: the
   *  prompt falls back to the runtime block alone. */
  private async agentInstructionsFor(
    agent: Agent,
    projectInstructions?: string,
    machineBound = false,
    chatId?: string,
  ): Promise<string> {
    const dir = agentWorkspaceDir(this.config.agentWorkspaceWriteRoot, agent.org_id, agent.id);
    let config: AgentConfigFiles;
    try {
      await seedAgentWorkspace(dir, agent);
      config = await readAgentConfig(dir);
    } catch (error) {
      this.log.warn({ err: error, agentId: agent.id }, "agent config files unavailable");
      config = { files: new Map(), missing: CONFIG_FILES.filter((f) => f.required).map((f) => f.name), identity: { name: null, vibe: null, emoji: null, avatar: null } };
    }
    const spawnedBy = chatId === undefined ? undefined : await this.spawnedByFor(chatId);
    return composeAgentInstructions(agent, config, projectInstructions, machineBound, spawnedBy);
  }

  /** The tree context of a spawned child thread, or undefined for a root. */
  private async spawnedByFor(
    chatId: string,
  ): Promise<{ parent_name: string; depth: number; can_spawn: boolean } | undefined> {
    const res = await this.pool.query<{
      thread_id: string;
      parent_thread_id: string | null;
      depth: number;
      parent_name: string | null;
    }>(
      `SELECT t.id AS thread_id, t.parent_thread_id, t.depth, pa.name AS parent_name
       FROM agent_threads t
       LEFT JOIN agent_threads pt ON pt.id = t.parent_thread_id
       LEFT JOIN agents pa ON pa.id = pt.agent_id
       WHERE t.chat_id = $1`,
      [chatId],
    );
    const row = res.rows[0];
    if (row === undefined || row.parent_thread_id === null) return undefined;
    const children = await this.agents.childCount(row.thread_id);
    return {
      parent_name: row.parent_name ?? "another agent",
      depth: Number(row.depth),
      can_spawn: Number(row.depth) < this.config.agentMaxDepth && children < this.config.agentMaxChildrenPerNode,
    };
  }

  private async provisionTurnTools(
    conversation: Conversation,
    chatId: string,
    orgId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Integration connector tools are opt-in for agents: the agent's tool
    // allowlist narrows the integration surface before the extension is
    // installed, so unselected tools are neither declared nor callable.
    // Plain chats keep the full surface.
    const agentRef = await agentThreadForChat(this.pool, chatId);
    const agent = agentRef === null ? null : await this.agents.fetchAgent(agentRef.agent_id);
    const prepared = await this.integrationsRuntime.prepareTurn(
      Number(conversation.id),
      chatId,
      orgId,
      agent === null || agent.tools_mode === "all" ? undefined : new Set<string>(agent.tools),
    );
    const userPrepared = await this.userMcpRuntime.prepareTurn(Number(conversation.id), chatId, orgId, signal);
    // Reconcile the complete desired selection, including an empty surface.
    // Persisted choices may outlive this process's provisioning caches.
    const base = this.baseConfiguration();
    const machineBound = (await this.executorKind(Number(conversation.id))) === "machine";
    // The agent's allowlist narrows the direct coding and skill tools the
    // same way it narrows integrations. Codemode itself is always present:
    // it is the only path to the script-only tools.
    const baseTools = directBaseTools(
      machineBound
        ? base.tools.filter((tool) => !(CODING_TOOL_NAMES as readonly string[]).includes(tool.name))
        : base.tools,
      agent,
    );
    const agentTools = await this.agentToolsForChat(chatId);
    // The plain names keep their behavior; only their descriptions change,
    // so the model sees which environment each set acts on.
    const machineTools = machineBound ? createMachineTools() : [];
    // A project-bound chat runs the plain coding tools on the user's
    // machine, so the agent gets a second set bound to its own sandbox.
    // They are outside the allowlist: the workspace is the agent's memory,
    // not an optional capability.
    const workspaceTools = machineBound
      ? createAgentWorkspaceTools(await this.envForConversation(Number(conversation.id), orgId))
      : [];
    // Tools resolve through installed extensions; configure stores names.
    // The agent tools are per conversation, so their extension is installed
    // under a chat-scoped name and listed with the other extensions.
    const agentExtension =
      agentTools.length === 0
        ? null
        : { name: `guild-agent-tools:${chatId}`, tools: agentTools };
    if (agentExtension !== null) this.registry.install(agentExtension);
    const machineExtension =
      machineTools.length === 0 ? null : { name: `guild-machine-tools:${chatId}`, tools: machineTools };
    if (machineExtension !== null) this.registry.install(machineExtension);
    const workspaceExtension =
      workspaceTools.length === 0
        ? null
        : { name: `guild-agent-workspace-tools:${chatId}`, tools: workspaceTools };
    if (workspaceExtension !== null) this.registry.install(workspaceExtension);
    await conversation.configure(
      {
        extensions: [
          ...base.extensions,
          ...(agentExtension === null ? [] : [agentExtension]),
          ...(machineExtension === null ? [] : [machineExtension]),
          ...(workspaceExtension === null ? [] : [workspaceExtension]),
          ...prepared.extensions,
          ...userPrepared.extensions,
        ],
        tools: [
          ...baseTools,
          ...machineTools,
          ...prepared.tools,
          ...userPrepared.tools,
          ...agentTools,
          ...workspaceTools,
        ],
        ...(agent === null
          ? {}
          : {
              instructions: await this.agentInstructionsFor(
                agent,
                this.projectInstructions.get(Number(conversation.id)),
                workspaceTools.length > 0,
                chatId,
              ),
            }),
      },
      BACKGROUND_CONTEXT,
    );
  }

  /** Makes a plain chat an agent chat: the caller's personal agent adopts it
   *  on the first turn, so every conversation has an agent. Idempotent — a
   *  chat that already belongs to an agent keeps it. Returns the agent whose
   *  model and tools the turn must use, or null when the org has no model. */
  async adoptChatAgent(
    chatId: string,
    orgId: string,
    userId: string,
    title: string,
  ): Promise<{ agent_id: string; thread_id: string; model: string } | null> {
    const existing = await agentThreadForChat(this.pool, chatId);
    if (existing !== null) {
      const agent = await this.agents.fetchAgent(existing.agent_id);
      return { agent_id: agent.id, thread_id: existing.thread_id, model: agent.model };
    }
    const personal = await this.agents.ensurePersonalAgentFor(orgId, userId);
    if (personal === null) return null;
    const threadId = uuidv7();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, kind)
       VALUES ($1, $2, $3, $4, $5, false, 'thread')
       ON CONFLICT (chat_id) DO NOTHING
       RETURNING id`,
      [threadId, personal.id, userId, chatId, title],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      // A concurrent turn adopted it first.
      const again = await agentThreadForChat(this.pool, chatId);
      if (again === null) throw new Error("chat adoption lost its thread");
      const agent = await this.agents.fetchAgent(again.agent_id);
      return { agent_id: agent.id, thread_id: again.thread_id, model: agent.model };
    }
    return { agent_id: personal.id, thread_id: id, model: personal.model };
  }

  /** Binds a chat to a chosen agent (the composer's agent picker). A chat
   *  that already has a thread keeps its transcript and changes agent; a
   *  plain chat gets a thread on the chosen agent. */
  async bindChatAgent(
    chatId: string,
    userId: string,
    agentId: string,
    title: string,
    user: UserRow,
  ): Promise<{ agent_id: string; thread_id: string; model: string }> {
    const { agent } = await this.agents.requireAccess(user, agentId, "use");
    const existing = await agentThreadForChat(this.pool, chatId);
    if (existing !== null) {
      if (existing.agent_id !== agent.id && !(await this.agentSwitchAllowed(chatId))) {
        throw new ThreadAgentLocked();
      }
      if (existing.agent_id !== agent.id) {
        await this.pool.query(
          `UPDATE agent_threads SET agent_id = $2, kind = 'thread', last_activity_at = now()
           WHERE chat_id = $1`,
          [chatId, agent.id],
        );
      }
      return { agent_id: agent.id, thread_id: existing.thread_id, model: agent.model };
    }
    const threadId = uuidv7();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, kind)
       VALUES ($1, $2, $3, $4, $5, false, 'thread')
       ON CONFLICT (chat_id) DO NOTHING
       RETURNING id`,
      [threadId, agent.id, userId, chatId, title],
    );
    if (inserted.rows[0] === undefined) {
      const again = await agentThreadForChat(this.pool, chatId);
      if (again === null) throw new Error("agent binding lost its thread");
      return { agent_id: again.agent_id, thread_id: again.thread_id, model: agent.model };
    }
    return { agent_id: agent.id, thread_id: threadId, model: agent.model };
  }

  /** The agent bound to a chat, for the composer's chip. */
  async chatAgent(chatId: string): Promise<Agent | null> {
    const ref = await agentThreadForChat(this.pool, chatId);
    return ref === null ? null : this.agents.fetchAgent(ref.agent_id);
  }

  /** A thread keeps the agent that owns it when it is that agent's Main
   *  thread or a run transcript. Ordinary threads move with the picker. */
  async agentSwitchAllowed(chatId: string): Promise<boolean> {
    const res = await this.pool.query<{ kind: string }>(
      `SELECT kind FROM agent_threads WHERE chat_id = $1`,
      [chatId],
    );
    const kind = res.rows[0]?.kind;
    return kind === undefined || (kind !== "default" && kind !== "routine_run" && kind !== "delegated");
  }

  /** Delivers one terminal child run to its parent thread. The run-settle
   *  path calls the same object through the lifecycle. */
  async deliverChildResult(input: ChildRunFinished): Promise<void> {
    await this.childDelivery.deliver(input);
  }

  /** Places one drained child-result batch as a steer input: merge into a
   *  pending unplaced steer item, else submit a new steer. Never enqueues a
   *  follow-up turn. */
  async deliverChildSteer(chatId: string, orgId: string, text: string, model: string | null): Promise<void> {
    await this.start();
    const conversation = await this.conversationForChat(chatId, orgId);
    const pending = await conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const item = inbox.items.find((candidate) => candidate.mode === "steer");
      return item === undefined ? null : Number(item.id);
    }, BACKGROUND_CONTEXT);
    if (pending !== null && (await appendToPendingSteer(conversation, pending, text))) {
      await this.reconcileConversation(chatId, Number(conversation.id));
      return;
    }
    await this.submitTurn(chatId, orgId, {
      orgId,
      requestId: uuidv7(),
      content: text,
      images: [],
      model,
      sendMode: "steer",
    });
  }

  /** Archiving a chat closes its agent-thread subtree: in-flight runs stop
   *  and deliveries to and from the subtree stop. */
  async closeChatSubtree(chatId: string): Promise<void> {
    const row = await this.pool.query<{ id: string }>("SELECT id FROM agent_threads WHERE chat_id = $1", [chatId]);
    if (row.rows[0] !== undefined) await this.agents.closeSubtree(row.rows[0].id);
  }

  /** A user stop of a child chat is a delivered cancellation: mark its
   *  running runs cancelled, then wake the parent with cancelled/user. */
  private async cancelChildOnStop(chatId: string): Promise<void> {
    const thread = await this.pool.query<{ id: string; parent_thread_id: string | null }>(
      "SELECT id, parent_thread_id FROM agent_threads WHERE chat_id = $1",
      [chatId],
    );
    const row = thread.rows[0];
    if (row === undefined || row.parent_thread_id === null) return;
    const runs = await this.pool.query<{ id: string; started_at: string }>(
      `UPDATE agent_runs
       SET status = 'cancelled', finished_at = now()
       WHERE thread_id = $1 AND status IN ('queued', 'running')
       RETURNING id,
         to_char(COALESCE(started_at, created_at) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at`,
      [row.id],
    );
    for (const run of runs.rows) {
      const finalText = await assistantTextForRun(this.pool, chatId, run.started_at).catch(() => "");
      await this.childDelivery
        .deliver({
          child_thread_id: row.id,
          run_id: run.id,
          status: "cancelled",
          reason: "user",
          final_text: finalText,
        })
        .catch((error: unknown) => this.log.warn({ err: error, chatId, runId: run.id }, "cancel delivery failed"));
    }
  }

  /** The chat's running agent run id, cached briefly: every model call in
   *  the turn carries it as the trace id. Null for plain chats. */
  private async runningRunId(chatId: string): Promise<string | null> {
    const cached = this.runIdCache.get(chatId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 2_000) return cached.id;
    const run = await this.agents.runningRunForChat(chatId).catch(() => null);
    const id = run?.id ?? null;
    this.runIdCache.set(chatId, { id, at: now });
    return id;
  }

  /** Opens the run row for an adopted chat turn; the run lifecycle closes it
   *  from the transcript like any other agent turn. */
  async beginChatRun(agentId: string, threadId: string, userId: string): Promise<string> {
    const run = await this.agents.createRun({
      agent_id: agentId,
      user_id: userId,
      thread_id: threadId,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    return run.id;
  }

  /** The conversation tools that exist only for agent threads: send_message,
   *  conversations_search and conversation_read, filtered by the agent's
   *  tool allowlist. Plain chats get none. */
  private async agentToolsForChat(chatId: string): Promise<ToolRegistration[]> {
    const ref = await agentThreadForChat(this.pool, chatId);
    this.log.info({ chatId, agentId: ref?.agent_id ?? null }, "agent tools lookup");
    if (ref === null) return [];
    const agent = await this.agents.fetchAgent(ref.agent_id);
    const subagents = await subagentsContextForChat({
      pool: this.pool,
      store: this.agents,
      agent,
      chatId,
      maxDepth: this.config.agentMaxDepth,
      maxChildrenPerNode: this.config.agentMaxChildrenPerNode,
      runtime: {
        submitTurn: (childChatId, childOrgId, input) =>
          this.submitTurn(childChatId, childOrgId, {
            orgId: input.orgId,
            requestId: input.requestId,
            content: input.content,
            images: input.images,
            model: input.model,
          }),
        stopChat: (childChatId) => this.stopChat(childChatId),
        canStopChat: (childChatId) => this.canStopChat(childChatId),
      },
    });
    const sendFile =
      subagents === null || this.objects === undefined
        ? undefined
        : {
            attachments: this.attachments,
            objects: this.objects,
            agent,
            run: subagents.parentRun,
            chatId,
            workspaceRoot: this.config.agentWorkspaceWriteRoot,
          };
    const tools = createAgentTools({
      pool: this.pool,
      store: this.agents,
      threads: this.threads,
      agent,
      userId: ref.user_id,
      ...(subagents === null ? {} : { subagents }),
      ...(sendFile === undefined ? {} : { sendFile }),
    });
    this.log.info({ chatId, agentId: agent.id, tools: tools.map((tool) => tool.name) }, "agent tools resolved");
    return tools;
  }

  /** Submits a user turn into the chat's conversation: the model provider
   *  for the org is refreshed from the gateway routes, the agent's model is
   *  configured, and the input is durably admitted (queued in the inbox when
   *  busy — steering/follow-up semantics, decision 12). */
  submitTurn(chatId: string, orgId: string, input: SubmitTurnInput): Promise<number> {
    // A fresh turn starts a new run (the caller creates it before this
    // call), so the cached run id from the previous turn is stale.
    this.runIdCache.delete(chatId);
    // A worker admitting another chat's turn (delegation) must not open the
    // workspace-turn row: the target chat's own worker owns that run.
    if (!(this.workerScope !== undefined && chatId !== this.workerScope.chatId)) {
      void this.conflicts.beginTurn(chatId).catch((error: unknown) => {
        this.log.warn({ err: error, chatId }, "agent turn journal start failed");
      });
    }
    return this.admissions
      .run(chatId, (signal) => this.admitTurn(chatId, orgId, input, signal))
      .catch(async (error) => {
        if (error instanceof AdmissionCancelled) {
          await this.turnCommands.settleCancelledById(input.requestId, chatId);
          await this.threads.deleteQueuedEvent(chatId, input.requestId);
          await this.chats.reconcileGenerating(orgId, chatId);
        }
        throw error;
      });
  }

  private async admitTurn(chatId: string, orgId: string, input: SubmitTurnInput, signal: AbortSignal): Promise<number> {
    if (this.workerScope !== undefined && chatId !== this.workerScope.chatId) {
      if (this.workerScope.remoteSubmit === undefined) {
        throw new Error("this worker cannot admit turns for another chat");
      }
      return this.workerScope.remoteSubmit(chatId, orgId, input);
    }
    if (this.supervisor) {
      // Worker mode: the full admission path (conversation bootstrap,
      // configure, integrations, submit) runs in the worker; the server
      // keeps only the projections the routes own.
      return this.supervisor.submit(chatId, input);
    }
    await this.sweepExpiredCommands();
    const conversation = await this.conversationForChat(chatId, orgId);
    await this.refreshOrgModels(orgId);
    const owner = await this.chats.ownerOf(chatId);
    // Integrations (M8) + user MCP: the shared per-turn provisioning (the
    // same call the resume path makes before a re-driven run) — the org's
    // enabled plugins resolve into a snapshot, the per-org extension
    // carries their tools, and the conversation's agent selection + tool
    // allow-list are refreshed (role-filtered like the Rust disclosure
    // filter). User MCP servers: the chat owner's enabled servers declare
    // their tools the same way (one extension + bare registrations).
    // Empty desired selections clear previously configured dynamic tools.
    this.projectInstructions.set(Number(conversation.id), input.agentsMd ?? "");
    await this.provisionTurnTools(conversation, chatId, orgId, signal);
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
      owner === null ? null : await this.skillsRuntime.invocationDirective(orgId, input.content, input.skillsIndex);
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
      },
      BACKGROUND_CONTEXT,
    );
    await this.reconcileConversation(chatId, Number(conversation.id));
    return Number(submission.id);
  }

  /** Changes only inbox placement; the submission and its visible echo keep identity. */
  async steerQueued(chatId: string, submissionId: number): Promise<boolean> {
    if (this.supervisor) return this.supervisor.steer(chatId, submissionId);
    await this.start();
    const id = this.chatToConversation.get(chatId);
    if (id === undefined) return false;
    const conversation = await this.harness!.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return false;
    const promoted = await conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const item = inbox.items.find((item) => Number(item.id) === submissionId);
      if (!item || item.mode === "write") return false;
      item.mode = "steer";
      return true;
    }, BACKGROUND_CONTEXT);
    if (promoted) await this.reconcileConversation(chatId, id);
    return promoted;
  }

  /** Withdraws one queued (not yet placed) submission — the desktop
   *  queued-chip trash button's backend. Returns the pi-durable abort
   *  outcome: "aborted" removes the inbox item; "already_placed"/"settled"
   *  mean the input just reached a boundary (the caller reports 409 and
   *  the client refreshes); "not_found" = gone already, nothing to do. */
  async withdrawQueued(chatId: string, submissionId: number): Promise<string> {
    if (this.supervisor) return this.supervisor.withdraw(chatId, submissionId);
    await this.start();
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return "not_found";
    const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return "not_found";
    return this.harness!.abortSubmission(
      submissionId as SubmissionId,
      BACKGROUND_CONTEXT,
      conversationId as ConversationId,
    );
  }

  /** Registers/refreshes every org's loopback provider (startup path: the
   *  resumed runs of a restart resolve models without a fresh submit). */
  private async refreshAllOrgModels(): Promise<void> {
    const orgs = await this.pool.query<{ id: string }>("SELECT id FROM orgs");
    for (const org of orgs.rows) {
      await this.refreshOrgModels(org.id).catch((error) =>
        this.log.warn({ err: error, orgId: org.id }, "org model refresh failed"),
      );
    }
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
      {
        selfBaseUrl: this.config.selfBaseUrl,
        internalKey: this.config.internalKey,
        traceHeaders: async (sessionId) => {
          const source = sessionId === undefined ? undefined : this.providerChats.get(sessionId);
          if (!source) return {};
          const owner = await this.chats.ownerOf(source.chatId);
          const runId = await this.runningRunId(source.chatId);
          return {
            "x-guild-chat-id": source.chatId,
            "x-guild-conversation-id": String(source.conversationId),
            "x-guild-cause": "conversation-request",
            ...(runId !== null ? { "x-guild-run-id": runId } : {}),
            ...(owner ? { "x-guild-user-id": owner.user_id } : {}),
          };
        },
      },
      orgId,
      infos,
    );
  }

  /** Whether this process can stop the chat's in-flight turn. A worker
   *  owns exactly one chat; another chat needs the remoteStop IPC that does
   *  not exist yet. */
  canStopChat(chatId: string): boolean {
    return this.workerScope === undefined || this.workerScope.chatId === chatId;
  }

  /** Stops the chat's in-flight generation: withdraws queued inputs, aborts
   *  the ordinary ownership scope, and waits until it is idle. */
  async stopChat(chatId: string): Promise<void> {
    this.admissions.cancel(chatId);
    await this.cancelChildOnStop(chatId).catch((error: unknown) => {
      this.log.warn({ err: error, chatId }, "child cancel marking failed");
    });
    if (this.supervisor) {
      await this.supervisor.stop(chatId);
      return;
    }
    await this.start();
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return;
    const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return;
    await conversation
      .abort(BACKGROUND_CONTEXT)
      .catch((error) => this.log.warn({ err: error, chatId }, "abort failed"));
    await this.chats.setGenerating(await this.orgOfChat(chatId), chatId, false);
  }

  /** Starts a conversation-owned compaction and returns its durable task identity. */
  async compactChat(chatId: string): Promise<number | null> {
    if (this.supervisor) return this.supervisor.compact(chatId);
    await this.start();
    const conversationId = this.chatToConversation.get(chatId);
    if (conversationId === undefined) return null;
    const conversation = await this.harness!.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return null;
    return Number(await conversation.compact(undefined, BACKGROUND_CONTEXT));
  }

  /** Wires the live-frame fan-out (the member-socket feed forwarder). The
   *  bridge emits into it; without a sink the frames are simply dropped. */
  setStreamSink(sink: GenerationStreamSink | null): void {
    this.bridge.setStream(sink);
    this.supervisor?.setStreamSink(sink);
  }

  /** Live streaming buffers of a conversation (the ThreadState frame's
   *  text/thinking). */
  liveBuffers(chatId: string): LiveBuffers {
    if (this.supervisor) return this.supervisor.liveBuffers(chatId);
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
    await this.admissions.close();
    await this.supervisor?.close();
    await this.host.close();
    await this.reopening;
    for (const id of this.chatToConversation.values()) {
      this.bridge.forget(String(id));
      this.integrationsRuntime.forget(id);
      this.userMcpRuntime.forget(id);
      this.skillsRuntime.forget(id);
    }
    this.chatToConversation.clear();
    this.providerChats.clear();
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
