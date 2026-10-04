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
  type Registry,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels, type MutableModels, type UserMessage } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import { applyPostgresMigrations, PgPoolDatabase, PostgresDurableStorage } from "../storage/postgres/index.js";
import type { PlatformPool } from "../platform/db.js";
import { GatewayStore } from "../platform/store/gateway.js";
import { ChatStore } from "../platform/store/chats.js";
import { ThreadStore } from "../platform/store/thread.js";
import { TurnCommandStore } from "../platform/store/turn_commands.js";
import { AgentSessionStore } from "../platform/store/agentSessions.js";
import { ToolArtifactStore } from "../platform/store/toolArtifacts.js";
import type { ObjectStore } from "../platform/s3.js";
import { MachineExecutionEnv, machineDispatch, type ExecutorKind, type MachineDispatchHost } from "../machines/dispatch.js";
import { execPolicy as loadExecPolicy, type ExecPolicy } from "../execpolicy/matcher.js";
import type { Config } from "../config.js";
import { createGuildExtension, ASSISTANT_PROMPT_KEY, type GuildExtensionDeps } from "./extension.js";
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

  constructor(
    private readonly config: Config,
    private readonly pool: PlatformPool,
    private readonly log: Logger,
    objects?: ObjectStore,
    private readonly hub?: MachineDispatchHost,
  ) {
    this.models = createModels();
    this.registry = createRegistry();
    this.threads = new ThreadStore(pool);
    this.chats = new ChatStore(pool);
    this.turnCommands = new TurnCommandStore(pool);
    this.gateway = new GatewayStore(pool);
    this.agentSessions = new AgentSessionStore(pool);
    this.toolArtifacts = new ToolArtifactStore(pool);
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
    // tools (spec decision 12: built-in coding tools enabled).
    this.registry.install(createGuildExtension(this.extensionDeps()));
    this.registry.install(CodingTools);
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
      currentModel: async (conversationId) => {
        await this.start();
        const conversation = await this.harness!.conversation(conversationId as never, BACKGROUND_CONTEXT);
        if (!conversation) return null;
        const agent = await conversation.agent(BACKGROUND_CONTEXT);
        return agent.model?.modelId ?? null;
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
    await applyPostgresMigrations(db);
    await applyChatMappingMigration(this.pool);
    this.storage = await PostgresDurableStorage.open(db);
    const harness = await Harness.open(this.storage, {
      models: this.models,
      registry: this.registry,
      settings: {
        extensions: [this.registry.snapshot().extension("guild")!, CodingTools],
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
        if (kind === "server") {
          const chatId = (await this.chatOfConversation(Number(target.conversationId)))!;
          const chat = await this.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
          const workspace = await this.agentSessions.workspaceForChat(chat.rows[0]!.org_id, chatId);
          return new NodeExecutionEnv({ cwd: `${this.config.dataDir}/workspaces/${chat.rows[0]!.org_id}/${workspace}` });
        }
        const sandboxDir = `${sandboxRoot()}/${target.conversationId}`;
        // NodeExecutionEnv.exec requires an existing cwd; the sandbox is
        // created lazily on first tool use.
        await mkdir(sandboxDir, { recursive: true });
        return new NodeExecutionEnv({ cwd: sandboxDir });
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
    const submission = await conversation.submit(
      { type: "input", content, requestId: input.requestId },
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

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const stream of this.watches.values()) {
      await stream.stop().catch(() => {});
    }
    this.watches.clear();
    if (this.harness) await this.harness.close(BACKGROUND_CONTEXT).catch(() => {});
    if (this.storage) await this.storage.close(BACKGROUND_CONTEXT).catch(() => {});
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
