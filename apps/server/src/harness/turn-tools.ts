import { guardMemoryTool } from "../agents/conflict.js";
// Per-turn tool provisioning: the org's enabled integrations, the chat
// owner's MCP servers, the agent's conversation tools, and the machine and
// workspace tool sets resolve into the conversation's extensions, tools and
// (for an agent thread) instructions. Submit runs it before admission;
// resume runs it before a re-driven run — a resumed run must see the same
// tool surface a submitted one gets.

import { coordinationRole } from "../agents/coordination.js";
import { coordinatorTools, coordinatorInstructions } from "../agents/coordinator-tools.js";
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
import type { TeamStore } from "../platform/store/teams.js";
import type { UsageReports } from "../platform/store/usage.js";
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
import { agentMessageEntry } from "../chats/agent-message.js";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { subagentsContextForChat } from "../agents/subagents.js";
import { createAgentTools } from "../agents/tools.js";
import type { PublishAppContext } from "../agents/publish-app.js";
import type { AppToolsContext } from "../agents/app-tools.js";
import type { AppStore } from "../platform/store/apps.js";
import type { AccessStore } from "../platform/store/access.js";
import { createGuildTools, guildToolsAllowed } from "../agents/guild-tools.js";
import { CODING_TOOL_NAMES, type IntegrationsRuntime } from "./integrations.js";
import type { UserMcpRuntime } from "./user-mcp.js";
import type { ConversationExecutors } from "./executors.js";
import type { MachineTargets } from "../machines/targets.js";
import { createRoutedCodingTools, directBaseTools } from "./agent-tools.js";
import { composeAgentInstructions, type MachineContext } from "./instructions.js";
import { shellOf } from "../machines/targets.js";
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
  readonly chats: Pick<ChatStore, "ownerOf" | "getChat" | "listOrgChats" | "orgChatCounts" | "machineBinding">;
  readonly identity: Pick<IdentityStore, "getUser" | "listUsers">;
  readonly teams: Pick<TeamStore, "listTeams" | "listMembers">;
  /** The org usage reports; absent when the process has no ClickHouse. */
  readonly usageReports?: UsageReports;
  readonly attachments: AttachmentStore;
  readonly objects?: ObjectStore;
  readonly conversations: Pick<ConversationMapStore, "projectInstructions">;
  readonly binding: Pick<ThreadBinding, "threadContext" | "spawnedBy">;
  readonly integrations: Pick<IntegrationsRuntime, "prepareTurn"> & Partial<Pick<IntegrationsRuntime, "authorizeTool">>;
  readonly userMcp: Pick<UserMcpRuntime, "prepareTurn">;
  readonly executors: Pick<ConversationExecutors, "envFor">;
  /** The member's paired machines: the per-call environment a coding tool
   *  resolves when the call names one. */
  readonly machines: Pick<MachineTargets, "envFor">;
  /** The App and Access stores, the reach check `publish_app` runs on each
   *  data function, and the member call the App tools run; absent in
   *  processes that store no Apps. */
  readonly apps?: {
    apps: Pick<AppStore, "publish" | "page" | "listVisible" | "getVisible">;
    access: Pick<AccessStore, "entries" | "replace">;
    checkFunction: PublishAppContext["checkFunction"];
    functionGate: AppToolsContext["functionGate"];
    callFunction: AppToolsContext["callFunction"];
  };
  /** The turn controls the subagent tools drive on child chats. */
  readonly turns: {
    submitTurn(chatId: string, orgId: string, input: SubmitTurnInput): Promise<number>;
    /** Writes an entry into another chat's conversation. */
    writeEntry(chatId: string, entry: EntryDraft): Promise<void>;
    stopChat(chatId: string): Promise<void>;
    canStopChat(chatId: string): boolean;
  };
}

/** The chat-scoped extensions provisioning installs: agent tools and the
 *  file tools with their per-call machine target. */
export function chatExtensionNames(chatId: string): [string, string] {
  return [`guild-agent-tools:${chatId}`, `guild-file-tools:${chatId}`];
}

export class TurnTools {
  constructor(private readonly deps: TurnToolDeps) {}

  /** Resolves the turn's tool surface and configures the conversation with
   *  it, including an empty surface: persisted choices may outlive this
   *  process's provisioning caches. */
  async provision(conversation: Conversation, chatId: string, orgId: string, signal?: AbortSignal): Promise<void> {
    const deps = this.deps;
    const conversationId = Number(conversation.id);
    // The agent's Integration list and Trait allowlist narrow the
    // integration surface before the extension is installed, so tools
    // outside them are neither declared nor callable.
    const agentRef = await agentThreadForChat(deps.pool, chatId);
    const agent = agentRef === null ? null : await deps.agents.fetchAgent(agentRef.agent_id);
    const role = await coordinationRole(deps.pool, chatId);
    const coordinationOnly = role?.execution_role === "coordinator" || role?.execution_role === "reflection";
    const prepared = coordinationOnly
      ? { extensions: [], tools: [] }
      : await deps.integrations.prepareTurn(conversationId, chatId, orgId);
    const userPrepared =
      coordinationOnly || (agent !== null && !agent.is_personal)
        ? { extensions: [], tools: [] }
        : await deps.userMcp.prepareTurn(conversationId, chatId, orgId, signal);
    const base = deps.base();
    // The agent's allowlist narrows the direct coding and skill tools the
    // same way it narrows integrations. Codemode itself is always present:
    // it is the only path to the script-only tools.
    const allowed = coordinationOnly
      ? base.tools.filter((t) =>
          (role?.execution_role === "reflection"
            ? ["codemode", "read", "write", "edit"]
            : ["codemode", "read", "write", "edit", "bash"]
          ).includes(t.name),
        )
      : directBaseTools(base.tools, agent);
    const coding = (tool: ToolRegistration): boolean => (CODING_TOOL_NAMES as readonly string[]).includes(tool.name);
    const baseTools = allowed.filter((tool) => !coding(tool));
    const agentTools = role?.execution_role === "reflection" ? [] : await this.agentTools(chatId, conversationId);
    // The file tools carry a per-call `machine` target; without it they act
    // on the conversation's own environment, the agent's workspace.
    const owner = await deps.chats.ownerOf(chatId);
    const routedTools = createRoutedCodingTools({
      chatId,
      orgId,
      userId: owner?.user_id ?? "",
      envFor: (request) => {
        if (coordinationOnly) throw new Error("This role can execute only in its Agent Workspace");
        return deps.machines.envFor(request);
      },
    });
    const codingAllowed = new Set(allowed.filter(coding).map((tool) => tool.name));
    const machineTools = routedTools
      .filter((tool) => codingAllowed.has(tool.name))
      .map((tool) =>
        agent === null || agentRef === null
          ? tool
          : guardMemoryTool(
              tool,
              deps.pool,
              agentWorkspaceDir(deps.config.agentWorkspaceWriteRoot, agent.org_id, agent.id),
              agentRef.thread_id,
              async () => (await deps.agents.runs.runningRunForChat(chatId))?.id ?? null,
            ),
      );
    // Tools resolve through installed extensions; configure stores names.
    // The agent tools are per conversation, so their extension is installed
    // under a chat-scoped name and listed with the other extensions.
    const names = chatExtensionNames(chatId);
    const scoped = [
      { name: names[0], tools: agentTools },
      { name: names[1], tools: machineTools },
    ].filter((extension) => extension.tools.length > 0);
    for (const extension of scoped) deps.registry.install(extension);
    await conversation.configure(
      {
        extensions: [...base.extensions, ...scoped, ...prepared.extensions, ...userPrepared.extensions],
        tools: [...baseTools, ...machineTools, ...prepared.tools, ...userPrepared.tools, ...agentTools],
        ...(agent === null
          ? {}
          : {
              instructions:
                (role?.execution_role === "coordinator" ? `${coordinatorInstructions(agent)}\n\n` : "") +
                (await this.agentInstructions(
                  agent,
                  await deps.conversations.projectInstructions(chatId),
                  await this.machineContext(chatId),
                  chatId,
                )),
            }),
      },
      BACKGROUND_CONTEXT,
    );
  }

  /** The machine the user's message came from, as the prompt names it: the
   *  chat's binding, its OS and the shell a `command` runs in. Null for a
   *  chat whose tools run in the server sandbox. */
  private async machineContext(chatId: string): Promise<MachineContext | null> {
    const binding = await this.deps.chats.machineBinding(chatId);
    if (binding === null) return null;
    return {
      name: binding.machine_label ?? binding.machine_id,
      os:
        binding.os === null
          ? null
          : binding.os_version === null || binding.os_version === ""
            ? binding.os
            : `${binding.os} ${binding.os_version}`,
      shell: shellOf(binding.os),
      projectFolder: binding.project_folder,
    };
  }

  /** Seeds the workspace config files when absent, reads them, and builds
   *  the thread's instructions. A broken volume never fails a turn: the
   *  prompt falls back to the runtime block alone. */
  private async agentInstructions(
    agent: Agent,
    projectInstructions: string | undefined,
    machine: MachineContext | null,
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
    return composeAgentInstructions(agent, config, projectInstructions, machine, spawnedBy, canDelegate, thread);
  }

  /** The conversation tools that exist only for agent threads: send_message,
   *  conversations_search and conversation_read, filtered by the agent's
   *  tool allowlist. Plain chats get none. */
  private async agentTools(chatId: string, conversationId: number): Promise<ToolRegistration[]> {
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
            ...(input.entry === undefined ? {} : { entry: input.entry }),
          }),
        writeEntry: (targetChatId, entry) => deps.turns.writeEntry(targetChatId, entry),
        stopChat: (childChatId) => deps.turns.stopChat(childChatId),
        canStopChat: (childChatId) => deps.turns.canStopChat(childChatId),
      },
    });
    const role = await coordinationRole(deps.pool, chatId);
    if (role?.execution_role === "coordinator") {
      if (subagents === null) return [];
      return coordinatorTools({ pool: deps.pool, store: deps.agents, agent, identity: deps.identity, subagents });
    }
    const sendFile =
      subagents === null || deps.objects === undefined
        ? undefined
        : {
            attachments: deps.attachments,
            objects: deps.objects,
            agent,
            chatId,
            machineEnv: (request: { machine: string; cwd?: string }) =>
              deps.machines.envFor({
                chatId,
                orgId: agent.org_id,
                userId: ref.user_id,
                machine: request.machine,
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
              }),
          };
    const member = deps.apps === undefined ? null : await deps.identity.getUser(ref.user_id);
    const tools = createAgentTools({
      pool: deps.pool,
      store: deps.agents,
      threads: deps.threads,
      agent,
      userId: ref.user_id,
      identity: deps.identity,
      coordinatorManaged: role?.coordinator_managed === true,
      chatId,
      deliverMessage: (targetChatId, orgId, text, model) =>
        deps.turns.writeEntry(targetChatId, agentMessageEntry(orgId, model, text)),
      ...(subagents === null ? {} : { subagents }),
      ...(sendFile === undefined ? {} : { sendFile }),
      ...(deps.apps === undefined || member === null
        ? {}
        : {
            publishApp: {
              apps: deps.apps.apps,
              checkFunction: deps.apps.checkFunction,
              agent,
              chatId,
              userId: ref.user_id,
              userRole: member.role,
              workspaceRoot: deps.config.agentWorkspaceWriteRoot,
            },
            appTools: {
              apps: deps.apps.apps,
              access: deps.apps.access,
              functionGate: async (orgId, userId, fn) => {
                const denied = await deps.integrations.authorizeTool?.(conversationId, fn.integration, fn.tool);
                return denied
                  ? { ok: false, reason: denied, class: null, alwaysAsk: false }
                  : deps.apps!.functionGate(orgId, userId, fn);
              },
              callFunction: async (input) => {
                const denied = await deps.integrations.authorizeTool?.(
                  conversationId,
                  input.fn.integration,
                  input.fn.tool,
                );
                if (denied) throw new Error(denied);
                return deps.apps!.callFunction(input);
              },
              agent,
              chatId,
              userId: ref.user_id,
              userRole: member.role,
              userEmail: member.email,
              workspaceRoot: deps.config.agentWorkspaceWriteRoot,
            },
          }),
    });
    tools.push(...(await this.guildTools(agent, ref.user_id)));
    deps.log.debug({ chatId, agentId: agent.id, tools: tools.map((tool) => tool.name) }, "agent tools resolved");
    return tools;
  }

  /** The org introspection tools: the admin's personal assistant reads the
   *  whole org's members, usage, threads and agents. Any other caller gets
   *  none, so the tools exist only where the org read is allowed. */
  private async guildTools(agent: Agent, ownerUserId: string): Promise<ToolRegistration[]> {
    if (!agent.is_personal) return [];
    const deps = this.deps;
    const owner = await deps.identity.getUser(ownerUserId);
    if (!guildToolsAllowed(agent, owner.role)) return [];
    return createGuildTools({
      pool: deps.pool,
      identity: deps.identity,
      teams: deps.teams,
      agents: deps.agents,
      chats: deps.chats,
      ...(deps.usageReports === undefined ? {} : { usage: deps.usageReports }),
      admin: owner,
    });
  }
}
