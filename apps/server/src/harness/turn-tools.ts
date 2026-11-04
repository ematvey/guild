// Per-turn tool provisioning: the org's enabled integrations, the chat
// owner's MCP servers, the agent's conversation tools, and the machine and
// workspace tool sets resolve into the conversation's extensions, tools and
// (for an agent thread) instructions. Submit runs it before admission;
// resume runs it before a re-driven run — a resumed run must see the same
// tool surface a submitted one gets.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { PlatformPool } from "../platform/db.js";
import type { ObjectStore } from "../platform/s3.js";
import type { AttachmentStore } from "../platform/store/attachments.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { ConversationMapStore } from "../platform/store/conversations.js";
import type { IdentityStore } from "../platform/store/identity.js";
import type { ThreadStore } from "../platform/store/thread.js";
import type { AgentStore } from "../agents/store.js";
import type { Agent } from "../agents/types.js";
import type { ThreadBinding } from "../agents/thread-binding.js";
import { agentThreadForChat } from "../agents/workspace.js";
import {
  CONFIG_FILES,
  agentWorkspaceDir,
  readAgentConfig,
  seedAgentWorkspace,
  type AgentConfigFiles,
} from "../agents/workspace-config.js";
import { subagentsContextForChat } from "../agents/subagents.js";
import { createAgentTools } from "../agents/tools.js";
import { CODING_TOOL_NAMES, type IntegrationsRuntime } from "./integrations.js";
import type { UserMcpRuntime } from "./user-mcp.js";
import type { ConversationExecutors } from "./executors.js";
import { createAgentWorkspaceTools, createMachineTools, directBaseTools } from "./agent-tools.js";
import { composeAgentInstructions } from "./instructions.js";
import type { SubmitTurnInput } from "./turn-backend.js";

export interface TurnToolDeps {
  readonly config: Pick<Config, "agentWorkspaceWriteRoot" | "agentMaxDepth" | "agentMaxChildrenPerNode">;
  /** The agent-thread reads of the agents lane. */
  readonly pool: PlatformPool;
  readonly log: Logger;
  readonly registry: Registry;
  /** The base extensions every configure starts from, with their tools. */
  base(): { extensions: readonly Extension[]; tools: readonly ToolRegistration[] };
  readonly agents: AgentStore;
  readonly threads: ThreadStore;
  /** The chat owner lookup the subagent tools resolve the requester by. */
  readonly chats: Pick<ChatStore, "ownerOf">;
  readonly identity: Pick<IdentityStore, "getUser">;
  readonly attachments: AttachmentStore;
  readonly objects?: ObjectStore;
  readonly conversations: Pick<ConversationMapStore, "projectInstructions">;
  readonly binding: Pick<ThreadBinding, "threadContext" | "spawnedBy">;
  readonly integrations: Pick<IntegrationsRuntime, "prepareTurn">;
  readonly userMcp: Pick<UserMcpRuntime, "prepareTurn">;
  readonly executors: Pick<ConversationExecutors, "executorKind" | "envFor">;
  /** The turn controls the subagent tools drive on child chats. */
  readonly turns: {
    submitTurn(chatId: string, orgId: string, input: SubmitTurnInput): Promise<number>;
    deliverMessage(chatId: string, orgId: string, text: string, model: string | null): Promise<void>;
    stopChat(chatId: string): Promise<void>;
    canStopChat(chatId: string): boolean;
  };
}

/** The chat-scoped extensions provisioning installs: agent tools, machine
 *  tools, and the agent's own workspace tools. */
export function chatExtensionNames(chatId: string): [string, string, string] {
  return [`guild-agent-tools:${chatId}`, `guild-machine-tools:${chatId}`, `guild-agent-workspace-tools:${chatId}`];
}

export class TurnTools {
  constructor(private readonly deps: TurnToolDeps) {}

  /** Resolves the turn's tool surface and configures the conversation with
   *  it, including an empty surface: persisted choices may outlive this
   *  process's provisioning caches. */
  async provision(conversation: Conversation, chatId: string, orgId: string, signal?: AbortSignal): Promise<void> {
    const deps = this.deps;
    const conversationId = Number(conversation.id);
    // Integration connector tools are opt-in for agents: the agent's tool
    // allowlist narrows the integration surface before the extension is
    // installed, so unselected tools are neither declared nor callable.
    // Plain chats keep the full surface.
    const agentRef = await agentThreadForChat(deps.pool, chatId);
    const agent = agentRef === null ? null : await deps.agents.fetchAgent(agentRef.agent_id);
    const prepared = await deps.integrations.prepareTurn(
      conversationId,
      chatId,
      orgId,
      agent === null || agent.tools_mode === "all" ? undefined : new Set<string>(agent.tools),
    );
    const userPrepared = await deps.userMcp.prepareTurn(conversationId, chatId, orgId, signal);
    const base = deps.base();
    const machineBound = (await deps.executors.executorKind(conversationId)) === "machine";
    // The agent's allowlist narrows the direct coding and skill tools the
    // same way it narrows integrations. Codemode itself is always present:
    // it is the only path to the script-only tools.
    const baseTools = directBaseTools(
      machineBound
        ? base.tools.filter((tool) => !(CODING_TOOL_NAMES as readonly string[]).includes(tool.name))
        : base.tools,
      agent,
    );
    const agentTools = await this.agentTools(chatId);
    // The plain names keep their behavior; only their descriptions change,
    // so the model sees which environment each set acts on.
    const machineTools = machineBound ? createMachineTools() : [];
    // A project-bound chat runs the plain coding tools on the user's
    // machine, so the agent gets a second set bound to its own sandbox.
    // They are outside the allowlist: the workspace is the agent's memory,
    // not an optional capability.
    const workspaceTools = machineBound
      ? createAgentWorkspaceTools(await deps.executors.envFor(conversationId, orgId))
      : [];
    // Tools resolve through installed extensions; configure stores names.
    // The agent tools are per conversation, so their extension is installed
    // under a chat-scoped name and listed with the other extensions.
    const names = chatExtensionNames(chatId);
    const scoped = [
      { name: names[0], tools: agentTools },
      { name: names[1], tools: machineTools },
      { name: names[2], tools: workspaceTools },
    ].filter((extension) => extension.tools.length > 0);
    for (const extension of scoped) deps.registry.install(extension);
    await conversation.configure(
      {
        extensions: [...base.extensions, ...scoped, ...prepared.extensions, ...userPrepared.extensions],
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
              instructions: await this.agentInstructions(
                agent,
                await deps.conversations.projectInstructions(chatId),
                workspaceTools.length > 0,
                chatId,
              ),
            }),
      },
      BACKGROUND_CONTEXT,
    );
  }

  /** Seeds the workspace config files when absent, reads them, and builds
   *  the thread's instructions. A broken volume never fails a turn: the
   *  prompt falls back to the runtime block alone. */
  private async agentInstructions(
    agent: Agent,
    projectInstructions: string | undefined,
    machineBound: boolean,
    chatId: string,
  ): Promise<string> {
    const dir = agentWorkspaceDir(this.deps.config.agentWorkspaceWriteRoot, agent.org_id, agent.id);
    let config: AgentConfigFiles;
    try {
      await seedAgentWorkspace(dir);
      config = await readAgentConfig(dir);
    } catch (error) {
      this.deps.log.warn({ err: error, agentId: agent.id }, "agent config files unavailable");
      config = { files: new Map(), missing: CONFIG_FILES.filter((f) => f.required).map((f) => f.name) };
    }
    const spawnedBy = await this.deps.binding.spawnedBy(chatId);
    const thread = (await this.deps.binding.threadContext(chatId)) ?? undefined;
    const canDelegate =
      spawnedBy === undefined ? agent.tools_mode === "all" || agent.tools.includes("subagents") : spawnedBy.can_spawn;
    return composeAgentInstructions(agent, config, projectInstructions, machineBound, spawnedBy, canDelegate, thread);
  }

  /** The conversation tools that exist only for agent threads: send_message,
   *  conversations_search and conversation_read, filtered by the agent's
   *  tool allowlist. Plain chats get none. */
  private async agentTools(chatId: string): Promise<ToolRegistration[]> {
    const deps = this.deps;
    const ref = await agentThreadForChat(deps.pool, chatId);
    deps.log.debug({ chatId, agentId: ref?.agent_id ?? null }, "agent tools lookup");
    if (ref === null) return [];
    const agent = await deps.agents.fetchAgent(ref.agent_id);
    const subagents = await subagentsContextForChat({
      pool: deps.pool,
      chats: deps.chats,
      identity: deps.identity,
      store: deps.agents,
      threads: deps.threads,
      agent,
      chatId,
      maxDepth: deps.config.agentMaxDepth,
      maxChildrenPerNode: deps.config.agentMaxChildrenPerNode,
      runtime: {
        submitTurn: (childChatId, childOrgId, input) =>
          deps.turns.submitTurn(childChatId, childOrgId, {
            orgId: input.orgId,
            requestId: input.requestId,
            content: input.content,
            images: input.images,
            model: input.model,
          }),
        stopChat: (childChatId) => deps.turns.stopChat(childChatId),
        canStopChat: (childChatId) => deps.turns.canStopChat(childChatId),
      },
    });
    const sendFile =
      subagents === null || deps.objects === undefined
        ? undefined
        : {
            attachments: deps.attachments,
            objects: deps.objects,
            agent,
            run: subagents.parentRun,
            chatId,
            workspaceRoot: deps.config.agentWorkspaceWriteRoot,
          };
    const tools = createAgentTools({
      pool: deps.pool,
      store: deps.agents,
      threads: deps.threads,
      agent,
      userId: ref.user_id,
      chatId,
      deliverMessage: (targetChatId, orgId, text, model) => deps.turns.deliverMessage(targetChatId, orgId, text, model),
      ...(subagents === null ? {} : { subagents }),
      ...(sendFile === undefined ? {} : { sendFile }),
    });
    deps.log.debug({ chatId, agentId: agent.id, tools: tools.map((tool) => tool.name) }, "agent tools resolved");
    return tools;
  }
}
