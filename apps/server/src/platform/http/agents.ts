import { runStepsWire } from "../../agents/store/runs.js";
import { ensureCoordinationThread, coordinationSettings } from "../../agents/coordination.js";
// Agent HTTP surface: CRUD and lifecycle, thread index, read-only files,
// runs/activity, the inbox and conversation search. Every route resolves the
// caller through the session and checks agent visibility/role before it
// touches a store.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatsCtx, GatewayCtx, IdentityCtx, InfraContext } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { canReadOwned, readsWholeOrg } from "../domain/access.js";
import { sortedJson } from "../domain/json.js";
import { parseUuidParam, queryParam, requireUser } from "./error.js";
import { submitTurn } from "../../chats/submit-turn.js";
import type { ObjectStore } from "../s3.js";
import { rm } from "node:fs/promises";
import { agentWorkspaceDir } from "../../agents/workspace-config.js";
import { AgentFiles } from "../../agents/files.js";
import { runRoutineNow } from "../../agents/scheduler.js";
import { createRoutine, deleteRoutine, getRoutine, updateRoutine } from "../../agents/routines.js";
import { search } from "../../agents/search.js";
import { resolveIntegrations } from "../../integrations/plugins.js";
import { toolCurate } from "../../integrations/policy.js";
import { IntegrationAccessStore } from "../store/integration-access.js";
import type { AgentIntegrationEntry } from "../domain/integration-access.js";
import { isToolClass } from "../domain/tool-class.js";
import { agentWire } from "../../hub/agent-state.js";
import type { Agent as WireAgent } from "@guild/wire/rest";
import {
  refuseDeletingAgent,
  wireThread,
  type ActivityFilters,
  type RunFilters,
  type UpdateAgentInput,
} from "../../agents/store.js";
import { cancelThread, closeThread } from "../../agents/subagents.js";
import { chatSubagentNodes, chatTreeFacts } from "../../agents/tree.js";
import { MAX_AGENT_DESCRIPTION_CHARS } from "../../agents/types.js";
import { installSpecialists } from "../../agents/specialists.js";
import { noticeEntry } from "../../chats/notice.js";
import type {
  Agent,
  AgentRoutineDelivery,
  AgentRoutineKind,
  AgentRunStatus,
  AgentStatus,
  AgentThread,
  AgentToolName,
  AgentTrigger,
  AgentVisibility,
} from "../../agents/types.js";

/** Built-in agent tools, in form order. Names match the runtime's tool
 *  registrations. */
const AGENT_TOOL_CATALOG = [
  {
    name: "read",
    label: "Read file",
    group: "Workspace",
    description: "Read a file from the agent workspace.",
    safe: true,
  },
  {
    name: "write",
    label: "Write file",
    group: "Workspace",
    description: "Create or overwrite a workspace file.",
    safe: true,
  },
  {
    name: "edit",
    label: "Edit file",
    group: "Workspace",
    description: "Apply a targeted edit to a workspace file.",
    safe: true,
  },
  {
    name: "bash",
    label: "Shell / list files",
    group: "Workspace",
    description: "Run shell commands in the workspace (includes listing files).",
    safe: true,
  },
  {
    name: "conversations_search",
    label: "Search conversations",
    group: "Memory",
    description: "Search this agent's own thread history.",
    safe: true,
  },
  {
    name: "conversations_list",
    label: "List conversations",
    group: "Memory",
    description: "List this agent's own threads with type and archive filters, sorted and paginated.",
    safe: true,
  },
  {
    name: "conversation_read",
    label: "Read conversation",
    group: "Memory",
    description: "Read a bounded excerpt from one of the agent's threads.",
    safe: true,
  },
  {
    name: "send_message",
    label: "Send message",
    group: "Messaging",
    description: "Open a new thread with a message to the user.",
    safe: true,
  },
  {
    name: "schedule_reminder",
    label: "Schedule reminder",
    group: "Routines",
    description: "Schedule a one-shot reminder for this agent.",
    safe: true,
  },
  {
    name: "list_routines",
    label: "List routines",
    group: "Routines",
    description: "List this agent's routines and their schedules.",
    safe: true,
  },
  {
    name: "create_routine",
    label: "Create routine",
    group: "Routines",
    description: "Create a recurring routine from a cron or interval schedule.",
    safe: true,
  },
  {
    name: "update_routine",
    label: "Update routine",
    group: "Routines",
    description: "Change a routine's schedule, prompt or enabled state.",
    safe: true,
  },
  {
    name: "delete_routine",
    label: "Delete routine",
    group: "Routines",
    description: "Delete a routine and stop its schedule.",
    safe: true,
  },
  {
    name: "subagents",
    label: "Subagents",
    group: "Agents",
    description:
      "Discover agents with list_agents, then spawn child threads and send, read, list, cancel or close them.",
    safe: false,
  },
  {
    name: "send_file",
    label: "Send file",
    group: "Files",
    description: "Attach a workspace file to the turn's response.",
    safe: false,
  },
  {
    name: "list_apps",
    label: "List apps",
    group: "Apps",
    description: "List the Guild Apps this member can open, with their data functions.",
    safe: true,
  },
  {
    name: "read_app",
    label: "Read app",
    group: "Apps",
    description: "Read one App's manifest and functions, and write its page into the workspace.",
    safe: true,
  },
  {
    name: "publish_app",
    label: "Publish app",
    group: "Apps",
    description:
      "Publish a workspace HTML page as an App that reads Integration data through named functions, run as each viewer.",
    safe: false,
  },
  {
    name: "set_app_access",
    label: "Share app",
    group: "Apps",
    description: "Replace who may open and edit an App.",
    safe: false,
  },
  {
    name: "call_app",
    label: "Call app function",
    group: "Apps",
    description: "Run one data function of an App as the member; a function that writes asks them first.",
    safe: false,
  },
];

/** The enabled integration tools an agent may be granted. Names are the
 *  runtime's namespaced tool names (`<slug>_<tool>`), the same strings an
 *  agent's `tools` array stores. Resolution is live: a broken or unreachable
 *  integration is skipped rather than failing the catalog. */
async function traitToolCatalog(
  gateway: GatewayCtx,
  orgId: string,
): Promise<
  {
    name: string;
    label: string;
    group: string;
    description: string;
    safe: boolean;
  }[]
> {
  let turns;
  try {
    turns = await resolveIntegrations(gateway, orgId, () => {});
  } catch {
    return [];
  }
  // Only Trait tools join the built-in catalog: they are Guild's generic
  // tools, whatever Integration serves them. An Integration's own tools
  // reach an agent through its Integration list.
  const tools: {
    name: string;
    label: string;
    group: string;
    description: string;
    safe: boolean;
  }[] = [];
  const seen = new Set(AGENT_TOOL_CATALOG.map((tool) => tool.name));
  for (const turn of turns) {
    for (const info of turn.tools) {
      if (info.trait === undefined || seen.has(info.spec.name)) continue;
      if (!toolCurate(turn.rowConfig, info.raw).enabled) continue;
      seen.add(info.spec.name);
      tools.push({
        name: info.spec.name,
        label: info.trait === "web_search" ? "Web search" : "Web fetch",
        group: "Web",
        description: info.spec.description,
        safe: false,
      });
    }
  }
  return tools;
}

const VISIBILITIES = new Set<AgentVisibility>(["private", "org"]);
const AGENT_STATUSES = new Set<AgentStatus>(["active", "archived", "deleting", "deleted"]);
const RUN_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "silent",
  "skipped",
  "cancelled",
]);
const TRIGGERS = new Set<AgentTrigger>(["message", "routine", "manual", "delegation"]);

function sendJson(reply: FastifyReply, value: unknown): FastifyReply {
  return reply.type("application/json").send(JSON.stringify(sortedJson(value)));
}

function jsonBody(req: FastifyRequest): Record<string, unknown> {
  return req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw ApiError.badRequest(`${name} must be a string`);
  return value;
}

/** Nullable string: the forms send null for an unused field; the API treats
 *  it as absent rather than a type error. */
function nullableString(body: Record<string, unknown>, name: string): string | undefined {
  if (body[name] === null) return undefined;
  return optionalString(body, name);
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = optionalString(body, name);
  if (value === undefined || value.trim() === "") throw ApiError.badRequest(`missing ${name}`);
  return value;
}

function visibilityField(body: Record<string, unknown>): AgentVisibility | undefined {
  const value = optionalString(body, "visibility");
  if (value === undefined) return undefined;
  if (!VISIBILITIES.has(value as AgentVisibility)) throw ApiError.badRequest("invalid visibility");
  return value as AgentVisibility;
}

function descriptionField(body: Record<string, unknown>): string | undefined {
  const value = optionalString(body, "description");
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_AGENT_DESCRIPTION_CHARS) {
    throw ApiError.badRequest(`description must be at most ${MAX_AGENT_DESCRIPTION_CHARS} characters`);
  }
  return trimmed;
}

function toolsField(body: Record<string, unknown>): AgentToolName[] | undefined {
  const value = body["tools"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
    throw ApiError.badRequest("tools must be an array of strings");
  }
  return value as AgentToolName[];
}

/** The `integrations` body field: the agent's whole Integration list. */
function integrationsField(body: Record<string, unknown>): AgentIntegrationEntry[] | undefined {
  const value = body["integrations"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw ApiError.badRequest("integrations must be an array");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const entry = item as Record<string, unknown> | null;
    if (entry === null || typeof entry !== "object" || typeof entry["slug"] !== "string") {
      throw ApiError.badRequest("each integration needs a slug");
    }
    if (!isToolClass(entry["ceiling"])) throw ApiError.badRequest("ceiling must be read, write or admin");
    if (seen.has(entry["slug"])) throw ApiError.badRequest(`integration ${entry["slug"]} is listed twice`);
    seen.add(entry["slug"]);
    return { slug: entry["slug"], ceiling: entry["ceiling"] };
  });
}

function toolsModeField(body: Record<string, unknown>): "selected" | "all" | undefined {
  const value = body["tools_mode"];
  if (value === undefined) return undefined;
  if (value !== "selected" && value !== "all") throw ApiError.badRequest("invalid tools_mode");
  return value;
}

function generativeUiField(body: Record<string, unknown>): boolean | undefined {
  const value = body["generative_ui"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw ApiError.badRequest("invalid generative_ui");
  return value;
}

function resourcesField(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = body["resources"];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.badRequest("resources must be an object");
  }
  return value as Record<string, unknown>;
}

function statusFilter(req: FastifyRequest): AgentRunStatus | undefined {
  const value = queryParam(req, "status");
  if (value === undefined || value === "") return undefined;
  if (!RUN_STATUSES.has(value as AgentRunStatus)) throw ApiError.badRequest("invalid status");
  return value as AgentRunStatus;
}

function triggerFilter(req: FastifyRequest): AgentTrigger | undefined {
  const value = queryParam(req, "trigger");
  if (value === undefined || value === "") return undefined;
  if (!TRIGGERS.has(value as AgentTrigger)) throw ApiError.badRequest("invalid trigger");
  return value as AgentTrigger;
}

function limitParam(req: FastifyRequest): number | undefined {
  const value = queryParam(req, "limit");
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw ApiError.badRequest("invalid limit");
  return parsed;
}

function showHidden(req: FastifyRequest): boolean {
  const value = queryParam(req, "show_hidden");
  return value === "1" || value === "true";
}

function booleanField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw ApiError.badRequest(`${name} must be a boolean`);
  return value;
}

function routineKindField(body: Record<string, unknown>): AgentRoutineKind | undefined {
  const value = optionalString(body, "kind");
  if (value === undefined) return undefined;
  if (value !== "cron" && value !== "once") throw ApiError.badRequest("kind must be cron or once");
  return value;
}

function routineDeliveryField(body: Record<string, unknown>): AgentRoutineDelivery | undefined {
  const value = optionalString(body, "delivery");
  if (value === undefined) return undefined;
  if (value !== "thread" && value !== "new_chat") throw ApiError.badRequest("delivery must be thread or new_chat");
  return value;
}

function requireActiveAgent(agent: Agent): void {
  if (agent.status !== "active") throw ApiError.conflict("agent_not_active", "agent is not active");
}

export function registerAgentRoutes(
  app: FastifyInstance,
  auth: IdentityCtx,
  infra: InfraContext,
  chats: ChatsCtx,
  gateway: GatewayCtx,
  objects: ObjectStore,
): void {
  const store = chats.runtime.agents;
  const files = new AgentFiles(infra.config.agentWorkspaceRoot);
  const integrationAccess = new IntegrationAccessStore(infra.pool);

  app.post("/api/v1/chats/:id/surface", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    const thread = await store.threads.threadByChatId(chatId);
    if (thread !== null) await store.threads.surfaceThread(thread.id, user.id);
    return sendJson(reply, { surfaced: true });
  });

  app.post("/api/v1/assistant", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = jsonBody(req);
    const agent =
      typeof body["agent_id"] === "string"
        ? (await store.requireAccess(user, body["agent_id"], "use")).agent
        : await store.ensurePersonalAgentFor(user.org_id, user.id);
    if (agent === null) throw ApiError.badRequest("Configure a model before opening Assistant");
    if (!coordinationSettings(agent).enabled) throw ApiError.badRequest("Coordination is not enabled for this Agent");
    refuseDeletingAgent(agent);
    const thread = await ensureCoordinationThread(store, agent, user.id, "inbox");
    return sendJson(reply, { agent_id: agent.id, chat_id: thread.chat_id, thread_id: thread.id });
  });

  /** Agents on the wire, with their Integration warnings. */
  const wire = async (orgId: string, agents: Agent[]): Promise<WireAgent[]> => {
    const context = await integrationAccess.context(orgId);
    return agents.map((agent) => agentWire(agent, context));
  };
  /** One agent as the caller sees it, `can_manage` included: the REST
   *  response and the `agent_list` frame agree on it. */
  const wireOne = async (agent: Agent, viewer: Awaited<ReturnType<typeof requireUser>>): Promise<WireAgent> => {
    const row = (await wire(agent.org_id, [agent]))[0]!;
    return {
      ...row,
      can_manage: (await store.access(viewer, agent)).can_manage,
    };
  };

  /** Replaces an agent's Integration list as `user`, then re-reads it. */
  const setIntegrations = async (
    user: Awaited<ReturnType<typeof requireUser>>,
    agent: Agent,
    entries: AgentIntegrationEntry[],
  ): Promise<Agent> => {
    const self = await integrationAccess.member(user.org_id, user.id);
    await integrationAccess.setAgentIntegrations(agent.org_id, agent.id, entries, {
      id: user.id,
      role: user.role,
      team_ids: self?.team_ids ?? new Set(),
    });
    return store.fetchAgent(agent.id);
  };

  /** The built-in tool catalog the creation/settings forms offer. Integration
   *  and MCP tools are added by the runtime; this endpoint is the stable
   *  built-in surface. */
  app.get("/api/v1/agents/tools", async (req, reply) => {
    const user = await requireUser(auth, req);
    return sendJson(reply, {
      tools: [...AGENT_TOOL_CATALOG, ...(await traitToolCatalog(gateway, user.org_id))],
    });
  });

  /** Installs the org-wide specialist pack. Admin or owner only; the model
   *  defaults to the first enabled route, the same default personal agents
   *  and new chats resolve to. */
  app.post("/api/v1/agents/specialists", async (req, reply) => {
    const user = await requireUser(auth, req);
    if (user.role !== "admin") throw ApiError.adminRequired();
    const body = jsonBody(req);
    const requested = optionalString(body, "model");
    if (requested !== undefined && requested.trim() === "") throw ApiError.badRequest("model must not be empty");
    const model = requested ?? (await gateway.gatewayStore.listModels(user.org_id))[0]?.model;
    if (model === undefined) throw ApiError.badRequest("no enabled model for this org");
    const result = await installSpecialists(
      {
        store,
        workspaceRoot: infra.config.agentWorkspaceWriteRoot,
        access: integrationAccess,
      },
      { orgId: user.org_id, ownerUserId: user.id, model },
    );
    return sendJson(reply, result);
  });

  async function agentTurn(
    req: FastifyRequest,
    reply: FastifyReply,
    user: Awaited<ReturnType<typeof requireUser>>,
    agent: Agent,
    thread: AgentThread,
  ): Promise<FastifyReply> {
    refuseDeletingAgent(agent);
    const body = jsonBody(req);
    const message = requiredString(body, "message");
    const rawAttachments = body["attachment_ids"];
    if (
      rawAttachments !== undefined &&
      (!Array.isArray(rawAttachments) || rawAttachments.some((value) => typeof value !== "string"))
    ) {
      throw ApiError.badRequest("attachment_ids must be an array of strings");
    }
    const attachmentIds = (rawAttachments ?? []) as string[];
    // The agent's model must resolve to an enabled gateway route; a missing
    // route fails before the turn is submitted. The run row opens with the
    // pi-durable run that takes the message.
    await gateway.gatewayStore.resolveRoute(agent.org_id, agent.model, gateway.masterKey());
    const chat = await chats.chats.getChatInOrg(agent.org_id, thread.chat_id);
    const ack = await submitTurn(
      chats,
      gateway,
      auth,
      objects,
      user,
      {
        model: agent.model,
        messages: [{ role: "user", content: message }],
        attachment_ids: attachmentIds,
        ...(typeof body["user_message_id"] === "string" ? { user_message_id: body["user_message_id"] } : {}),
        ...(body["send_mode"] === "steer" || body["send_mode"] === "queue" ? { send_mode: body["send_mode"] } : {}),
      },
      thread.chat_id,
      chat,
    );
    await store.threads.deriveThreadTitle(agent.id, thread.id, message);
    await store.threads.touchThread(agent.id, thread.id);
    return reply.type("application/json").send(ack);
  }

  app.post("/api/v1/agents", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = jsonBody(req);
    const agent = await store.create(user, {
      name: requiredString(body, "name"),
      description: descriptionField(body),
      model: requiredString(body, "model"),
      tools: toolsField(body),
      tools_mode: toolsModeField(body),
      generative_ui: generativeUiField(body),
      visibility: visibilityField(body),
      resources: resourcesField(body),
    });
    // An `all`-tools Agent derives its Integrations; a submitted list is ignored.
    const entries = agent.tools_mode === "all" ? undefined : integrationsField(body);
    const created = entries === undefined || entries.length === 0 ? agent : await setIntegrations(user, agent, entries);
    return sendJson(reply, {
      agent: await wireOne(created, user),
      access: await store.access(user, created),
    });
  });

  app.get("/api/v1/agents", async (req, reply) => {
    const user = await requireUser(auth, req);
    const status = queryParam(req, "status");
    if (status !== undefined && status !== "" && !AGENT_STATUSES.has(status as AgentStatus)) {
      throw ApiError.badRequest("invalid status");
    }
    // The personal agent exists from the first visit.
    await store.ensurePersonalAgent(user);
    const agents = await store.list(user, {
      includeArchived: queryParam(req, "include_archived") === "1",
      status: status === undefined || status === "" ? undefined : (status as AgentStatus),
    });
    return sendJson(reply, { agents: await wire(user.org_id, agents) });
  });

  app.get("/api/v1/agents/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const agent = await store.get(user, agentId);
    return sendJson(reply, {
      agent: await wireOne(agent, user),
      access: await store.access(user, agent),
    });
  });

  app.patch("/api/v1/agents/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const body = jsonBody(req);
    const patch: UpdateAgentInput = {};
    const name = optionalString(body, "name");
    if (name !== undefined) {
      if (name.trim() === "") throw ApiError.badRequest("name must not be empty");
      patch.name = name;
    }
    const description = descriptionField(body);
    if (description !== undefined) patch.description = description;
    const model = optionalString(body, "model");
    if (model !== undefined) {
      if (model.trim() === "") throw ApiError.badRequest("model must not be empty");
      patch.model = model;
    }
    const tools = toolsField(body);
    if (tools !== undefined) patch.tools = tools;
    const toolsMode = toolsModeField(body);
    if (toolsMode !== undefined) patch.tools_mode = toolsMode;
    const generativeUi = generativeUiField(body);
    if (generativeUi !== undefined) patch.generative_ui = generativeUi;
    const visibility = visibilityField(body);
    if (visibility !== undefined) patch.visibility = visibility;
    const resources = resourcesField(body);
    if (resources !== undefined) patch.resources = resources;
    const entries = integrationsField(body);
    let agent = await store.update(user, agentId, patch);
    // An `all`-tools Agent derives its Integrations; a submitted list is ignored.
    if (entries !== undefined && agent.tools_mode !== "all") agent = await setIntegrations(user, agent, entries);
    return sendJson(reply, { agent: await wireOne(agent, user) });
  });

  /** Stops the turns of an agent that just left service (archived or
   *  deleting): its runs are cancelled and each chat they drove is stopped. */
  const stopAgentWork = async (agentId: string): Promise<void> => {
    for (const chatId of await store.lifecycle.cancelAgentRuns(agentId)) {
      if (!chats.runtime.canStopChat(chatId)) continue;
      await chats.runtime.stopChat(chatId).catch((error: unknown) => {
        app.log.warn({ err: error, chatId }, "stopping an agent's turn failed");
      });
    }
  };

  app.post("/api/v1/agents/:id/archive", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agent = await store.lifecycle.archive(user, parseUuidParam(req, "id"));
    await stopAgentWork(agent.id);
    return sendJson(reply, { agent: await wireOne(agent, user) });
  });

  app.post("/api/v1/agents/:id/restore", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agent = await store.lifecycle.restore(user, parseUuidParam(req, "id"));
    return sendJson(reply, { agent: await wireOne(agent, user) });
  });

  app.delete("/api/v1/agents/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agent = await store.lifecycle.markDeleted(user, parseUuidParam(req, "id"));
    await stopAgentWork(agent.id);
    return sendJson(reply, { agent: await wireOne(agent, user) });
  });

  app.get("/api/v1/agents/:id/export", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "manage");
    const bundle = await store.lifecycle.export(agent.org_id, agentId);
    return sendJson(reply, { export: bundle });
  });

  app.post("/api/v1/agents/:id/purge", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "manage");
    if (agent.status !== "deleting") {
      throw ApiError.badRequest("agent is not in the deletion grace period");
    }
    const force = queryParam(req, "force") === "1" && user.role === "admin";
    const due = agent.purge_after === null || Date.parse(agent.purge_after) <= Date.now();
    if (!due && !force) throw ApiError.badRequest("the deletion grace period has not elapsed");
    await store.lifecycle.purge(user, agentId);
    await rm(agentWorkspaceDir(infra.config.agentWorkspaceWriteRoot, agent.org_id, agentId), {
      recursive: true,
      force: true,
    }).catch((error: unknown) => {
      app.log.warn({ err: error, agentId }, "agent workspace removal failed");
    });
    return sendJson(reply, { purged: true });
  });

  app.get("/api/v1/agents/:id/threads", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    const threads = (await store.threads.displayThreads(agentId, user.id)).map(wireThread);
    return sendJson(reply, { threads });
  });

  app.post("/api/v1/agents/:id/threads", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "use");
    refuseDeletingAgent(agent);
    const body = jsonBody(req);
    const title = optionalString(body, "title") ?? "";
    return sendJson(reply, {
      thread: wireThread({
        ...(await store.threads.createThread(agentId, user.id, title)),
        archived: false,
        deleted: false,
      }),
    });
  });

  app.get("/api/v1/agents/:id/threads/:threadId", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const threadId = parseUuidParam(req, "threadId");
    await store.requireAccess(user, agentId, "use");
    return sendJson(reply, {
      thread: wireThread(await store.threads.getThread(agentId, user.id, threadId)),
    });
  });

  app.patch("/api/v1/agents/:id/threads/:threadId", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const threadId = parseUuidParam(req, "threadId");
    await store.requireAccess(user, agentId, "use");
    const title = requiredString(jsonBody(req), "title");
    return sendJson(reply, {
      thread: wireThread(await store.threads.renameThread(agentId, user.id, threadId, title)),
    });
  });

  app.post("/api/v1/agents/:id/threads/:threadId/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const threadId = parseUuidParam(req, "threadId");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const thread = await store.threads.getThread(agentId, user.id, threadId);
    return agentTurn(req, reply, user, agent, thread);
  });

  app.post("/api/v1/agents/:id/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const requested = optionalString(jsonBody(req), "thread_id");
    if (requested !== undefined && requested.trim() !== "") {
      const thread = await store.threads.getThread(agentId, user.id, requested);
      return agentTurn(req, reply, user, agent, thread);
    }
    // A turn without a thread names a new thread of the caller's own: a
    // shared agent never posts into another user's conversation, and reading
    // an agent never creates a thread.
    refuseDeletingAgent(agent);
    requiredString(jsonBody(req), "message");
    const thread = await store.threads.createThread(agentId, user.id, "");
    return agentTurn(req, reply, user, agent, thread);
  });

  /** The chat header's tree facts, behind the chat's read gate. */
  const chatTree = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const tree = await chatTreeFacts(infra.pool, chatId, user.id);
    if (tree === null) throw ApiError.notFound("no such chat");
    return sendJson(reply, tree);
  };
  app.get("/api/v1/chats/:id/tree", chatTree);
  app.get("/api/v1/threads/:id/tree", chatTree);

  /** The chat's thread subtree with each node's latest run status. The chat
   *  view renders the running part below its transcript. */
  const chatSubagents = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    return sendJson(reply, {
      chat_id: chatId,
      nodes: await chatSubagentNodes(infra.pool, chatId),
    });
  };
  app.get("/api/v1/chats/:id/subagents", chatSubagents);

  /** Stop or close the thread behind a chat, from the chat's own UI. Both
   *  are writes: only the chat's owner passes the gate, as for every other
   *  chat write. A chat with no thread row has nothing to act on. `close`
   *  marks the subtree closed, which also drops late results. */
  const threadAction = (action: "cancel" | "close") => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    const thread = await store.threads.threadByChatId(chatId);
    if (thread === null) throw ApiError.notFound("no such thread");
    // Closing is a child-only act: the root thread is the conversation the
    // caller is having, and stopping its turn is `cancel`.
    if (action === "close" && thread.parent_thread_id === null) {
      throw ApiError.badRequest("the root thread cannot be closed");
    }
    const context = { store, runtime: chats.runtime, pool: infra.pool };
    if (action === "cancel") {
      return sendJson(reply, await cancelThread(context, thread.id));
    }
    const result = await closeThread(context, thread.id);
    // A close is a notice in the parent's conversation: the parent agent
    // learns the child takes no more sends, and the parent chat's closed
    // row (kept across a reload) is projected from it. A repeat close
    // writes nothing.
    if (result.closed > 0 && thread.parent_thread_id !== null) {
      const parent = await store.threads.threadById(thread.parent_thread_id);
      if (parent !== null) {
        const title = thread.title?.trim() || thread.id;
        await chats.runtime.writeEntry(
          parent.chat_id,
          noticeEntry(
            `The user closed child thread ${thread.id} ("${title}"): its turns are cancelled and it takes no more sends.`,
            { type: "child_closed", thread_id: thread.id },
          ),
        );
      }
    }
    return sendJson(reply, result);
  };
  app.post("/api/v1/threads/:id/cancel", threadAction("cancel"));
  app.post("/api/v1/threads/:id/close", threadAction("close"));

  app.get("/api/v1/agents/:id/files", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const listing = await files.listDir(agent.org_id, agentId, queryParam(req, "path"), showHidden(req));
    return sendJson(reply, listing);
  });

  app.get("/api/v1/agents/:id/files/content", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const file = await files.readText(agent.org_id, agentId, queryParam(req, "path"));
    return sendJson(reply, file);
  });

  app.get("/api/v1/agents/:id/files/download", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const download = await files.streamDownload(agent.org_id, agentId, queryParam(req, "path"));
    const safeName = download.name.replace(/["\\\r\n]/g, "_");
    reply
      .type("application/octet-stream")
      .header("content-length", download.size)
      .header("content-disposition", `attachment; filename="${safeName}"`);
    return reply.send(download.stream);
  });

  app.get("/api/v1/agents/:id/routines", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    return sendJson(reply, {
      routines: await store.runs.listRoutines(agentId),
    });
  });

  app.post("/api/v1/agents/:id/routines", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "manage");
    const body = jsonBody(req);
    const kind = routineKindField(body) ?? "cron";
    const routine = await createRoutine(infra.pool, agentId, {
      created_by_user_id: user.id,
      name: requiredString(body, "name"),
      kind,
      schedule: optionalString(body, "schedule"),
      timezone: optionalString(body, "timezone"),
      run_at: nullableString(body, "run_at"),
      prompt: requiredString(body, "prompt"),
      delivery: routineDeliveryField(body),
      enabled: booleanField(body, "enabled"),
    });
    return sendJson(reply, { routine });
  });

  app.get("/api/v1/agents/:id/routines/:rid", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    return sendJson(reply, {
      routine: await getRoutine(infra.pool, agentId, parseUuidParam(req, "rid")),
    });
  });

  app.patch("/api/v1/agents/:id/routines/:rid", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "manage");
    const body = jsonBody(req);
    const routine = await updateRoutine(infra.pool, agentId, parseUuidParam(req, "rid"), {
      name: optionalString(body, "name"),
      kind: routineKindField(body),
      schedule: optionalString(body, "schedule"),
      timezone: optionalString(body, "timezone"),
      run_at: nullableString(body, "run_at"),
      prompt: optionalString(body, "prompt"),
      delivery: routineDeliveryField(body),
      enabled: booleanField(body, "enabled"),
    });
    return sendJson(reply, { routine });
  });

  app.delete("/api/v1/agents/:id/routines/:rid", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "manage");
    await deleteRoutine(infra.pool, agentId, parseUuidParam(req, "rid"));
    return sendJson(reply, { deleted: true });
  });

  app.post("/api/v1/agents/:id/routines/:rid/run", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "manage");
    requireActiveAgent(agent);
    const routine = await getRoutine(infra.pool, agentId, parseUuidParam(req, "rid"));
    const run = await runRoutineNow(
      {
        pool: infra.pool,
        store,
        threads: chats.threads,
        runtime: chats.runtime,
      },
      agent,
      routine,
    );
    return sendJson(reply, { run });
  });

  app.get("/api/v1/agents/:id/routines/:rid/runs", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    const routineId = parseUuidParam(req, "rid");
    await getRoutine(infra.pool, agentId, routineId);
    return sendJson(reply, {
      runs: await store.runs.listRoutineRuns(agentId, routineId, {
        limit: limitParam(req),
        before: queryParam(req, "before"),
      }),
    });
  });

  app.get("/api/v1/agents/:id/runs", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    const filters: RunFilters = {
      userId: user.id,
      status: statusFilter(req),
      trigger: triggerFilter(req),
      limit: limitParam(req),
      before: queryParam(req, "before"),
    };
    return sendJson(reply, {
      runs: await store.runs.listRuns(agentId, filters),
    });
  });

  app.get("/api/v1/runs/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const run = await store.runs.getRun(parseUuidParam(req, "id"));
    if (!canReadOwned(user, run.user_id) || (run.internal && !readsWholeOrg(user))) {
      throw ApiError.notFound("no such run");
    }
    await store.fetchInOrg(user.org_id, run.agent_id);
    const steps = await store.runs.runSteps(run);
    const files = steps.flatMap((step) => (step.type === "file" ? (step.paths ?? []) : []));
    const thread =
      run.thread_id === null ? null : await infra.conversationHistory.threadOfRun(user.org_id, run.thread_id, readsWholeOrg(user));
    return sendJson(reply, {
      run: { ...run, steps: runStepsWire(steps), files },
      steps,
      thread,
    });
  });

  app.get("/api/v1/runs/:id/children", async (req, reply) => {
    const user = await requireUser(auth, req);
    const run = await store.runs.getRun(parseUuidParam(req, "id"));
    if (!canReadOwned(user, run.user_id) || (run.internal && !readsWholeOrg(user))) {
      throw ApiError.notFound("no such run");
    }
    await store.fetchInOrg(user.org_id, run.agent_id);
    const children = await store.runs.childRuns(run.id);
    return sendJson(reply, {
      children: children.filter((child) => canReadOwned(user, child.user_id) && (!child.internal || readsWholeOrg(user))),
    });
  });

  app.get("/api/v1/activity", async (req, reply) => {
    const user = await requireUser(auth, req);
    const filters: ActivityFilters = {
      agent_id: queryParam(req, "agent"),
      status: statusFilter(req),
      trigger: triggerFilter(req),
      since: queryParam(req, "since"),
      limit: limitParam(req),
    };
    const offset = queryParam(req, "offset");
    if (offset !== undefined && offset !== "") {
      const parsed = Number(offset);
      if (!Number.isInteger(parsed) || parsed < 0) throw ApiError.badRequest("invalid offset");
      filters.offset = parsed;
    }
    if (filters.agent_id !== undefined && filters.agent_id !== "") {
      await store.requireAccess(user, filters.agent_id, "use");
    }
    return sendJson(reply, {
      activity: await store.runs.listActivity(user.org_id, filters, user),
    });
  });

  app.get("/api/v1/inbox", async (req, reply) => {
    const user = await requireUser(auth, req);
    return sendJson(reply, {
      notices: await store.notices.listNotices(user.id, user.org_id),
    });
  });

  app.post("/api/v1/inbox/:id/read", async (req, reply) => {
    const user = await requireUser(auth, req);
    const notice = await store.notices.markNoticeRead(user.id, parseUuidParam(req, "id"));
    return sendJson(reply, { notice });
  });

  app.post("/api/v1/inbox/:id/unread", async (req, reply) => {
    const user = await requireUser(auth, req);
    const notice = await store.notices.markNoticeUnread(user.id, parseUuidParam(req, "id"));
    return sendJson(reply, { notice });
  });

  app.get("/api/v1/agents/:id/search", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    const query = queryParam(req, "q") ?? "";
    return sendJson(reply, {
      results: await search(infra.pool, { agentId, userId: user.id, query }),
    });
  });
}
