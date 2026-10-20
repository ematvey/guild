// Agent HTTP surface: CRUD and lifecycle, thread index, read-only files,
// runs/activity, the inbox and conversation search. Every route resolves the
// caller through the session and checks agent visibility/role before it
// touches a store.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatsCtx, GatewayCtx, IdentityCtx, InfraContext } from "../platform/contexts.js";
import { ApiError, sortedJson } from "../platform/errors.js";
import { parseUuidParam, queryParam, requireUser } from "../platform/http/error.js";
import { submitTurn } from "../platform/http/chats.js";
import type { ObjectStore } from "../platform/s3.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { AgentFiles } from "./files.js";
import { runRoutineNow } from "./scheduler.js";
import { AgentStore, type ActivityFilters, type RunFilters, type UpdateAgentInput } from "./store.js";
import type {
  Agent,
  AgentRoutineKind,
  AgentRunStatus,
  AgentStatus,
  AgentThread,
  AgentToolName,
  AgentTrigger,
  AgentVisibility,
} from "./types.js";


/** Built-in agent tools, in form order. Names match the runtime's tool
 *  registrations. */
const AGENT_TOOL_CATALOG = [
  { name: "read", label: "Read file", group: "Workspace", description: "Read a file from the agent workspace.", safe: true },
  { name: "write", label: "Write file", group: "Workspace", description: "Create or overwrite a workspace file.", safe: true },
  { name: "edit", label: "Edit file", group: "Workspace", description: "Apply a targeted edit to a workspace file.", safe: true },
  { name: "bash", label: "Shell / list files", group: "Workspace", description: "Run shell commands in the workspace (includes listing files).", safe: true },
  { name: "conversations_search", label: "Search conversations", group: "Memory", description: "Search this agent's own thread history.", safe: true },
  { name: "conversation_read", label: "Read conversation", group: "Memory", description: "Read a bounded excerpt from one of the agent's threads.", safe: true },
  { name: "send_message", label: "Send message", group: "Messaging", description: "Open a new thread with a message to the user.", safe: true },
  { name: "schedule_reminder", label: "Schedule reminder", group: "Routines", description: "Schedule a one-shot reminder for this agent.", safe: true },
  { name: "delegate", label: "Delegate", group: "Agents", description: "Delegate a task to another agent and collect its result.", safe: false },
  { name: "release_artifacts", label: "Release artifacts", group: "Agents", description: "Release delegated artifact staging for a run.", safe: false },
  { name: "web_search", label: "Web search", group: "Web", description: "Search the web.", safe: false },
  { name: "codemode", label: "Codemode", group: "Advanced", description: "Run a JavaScript tool-orchestration script.", safe: false },
];

const VISIBILITIES = new Set<AgentVisibility>(["private", "team", "org"]);
const AGENT_STATUSES = new Set<AgentStatus>(["active", "archived", "deleting", "deleted"]);
const RUN_STATUSES = new Set<AgentRunStatus>(["queued", "running", "succeeded", "failed", "silent", "skipped"]);
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

function toolsField(body: Record<string, unknown>): AgentToolName[] | undefined {
  const value = body["tools"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
    throw ApiError.badRequest("tools must be an array of strings");
  }
  return value as AgentToolName[];
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
  const store = new AgentStore(infra.pool);
  const files = new AgentFiles(infra.config.agentWorkspaceRoot);

  /** The built-in tool catalog the creation/settings forms offer. Integration
   *  and MCP tools are added by the runtime; this endpoint is the stable
   *  built-in surface. */
  app.get("/api/v1/agents/tools", async (req, reply) => {
    await requireUser(auth, req);
    return sendJson(reply, { tools: AGENT_TOOL_CATALOG });
  });

  async function agentTurn(
    req: FastifyRequest,
    reply: FastifyReply,
    user: Awaited<ReturnType<typeof requireUser>>,
    agent: Agent,
    thread: AgentThread,
  ): Promise<FastifyReply> {
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
    // route fails before a run row is created.
    await gateway.gatewayStore.resolveRoute(agent.org_id, agent.model, gateway.masterKey());
    const run = await store.createRun({
      agent_id: agent.id,
      thread_id: thread.id,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    try {
      const chat = await chats.chats.getChatInOrg(agent.org_id, thread.chat_id);
      const ack = await submitTurn(
        chats,
        gateway,
        auth,
        objects,
        user,
        req,
        {
          model: agent.model,
          messages: [{ role: "user", content: message }],
          attachment_ids: attachmentIds,
        },
        thread.chat_id,
        chat,
      );
      await store.deriveThreadTitle(agent.id, thread.id, message);
      await store.touchThread(agent.id, thread.id);
      return reply.type("application/json").send(ack);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await store
        .updateRun(run.id, {
          status: "failed",
          error_code: "turn_submit_failed",
          error_message: text,
          finished_at: new Date().toISOString(),
        })
        .catch(() => {});
      throw error;
    }
  }

  app.post("/api/v1/agents", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = jsonBody(req);
    const agent = await store.create(user, {
      name: requiredString(body, "name"),
      instructions: optionalString(body, "instructions"),
      model: requiredString(body, "model"),
      tools: toolsField(body),
      visibility: visibilityField(body),
      resources: resourcesField(body),
    });
    return sendJson(reply, { agent, access: await store.access(user, agent) });
  });

  app.get("/api/v1/agents", async (req, reply) => {
    const user = await requireUser(auth, req);
    const status = queryParam(req, "status");
    if (status !== undefined && status !== "" && !AGENT_STATUSES.has(status as AgentStatus)) {
      throw ApiError.badRequest("invalid status");
    }
    const agents = await store.list(user, {
      includeArchived: queryParam(req, "include_archived") === "1",
      status: status === undefined || status === "" ? undefined : (status as AgentStatus),
    });
    return sendJson(reply, { agents });
  });

  app.get("/api/v1/agents/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const agent = await store.get(user, agentId);
    return sendJson(reply, { agent, access: await store.access(user, agent) });
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
    const instructions = optionalString(body, "instructions");
    if (instructions !== undefined) patch.instructions = instructions;
    const model = optionalString(body, "model");
    if (model !== undefined) {
      if (model.trim() === "") throw ApiError.badRequest("model must not be empty");
      patch.model = model;
    }
    const tools = toolsField(body);
    if (tools !== undefined) patch.tools = tools;
    const visibility = visibilityField(body);
    if (visibility !== undefined) patch.visibility = visibility;
    const resources = resourcesField(body);
    if (resources !== undefined) patch.resources = resources;
    const agent = await store.update(user, agentId, patch);
    return sendJson(reply, { agent });
  });

  app.post("/api/v1/agents/:id/archive", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agent = await store.archive(user, parseUuidParam(req, "id"));
    return sendJson(reply, { agent });
  });

  app.post("/api/v1/agents/:id/restore", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agent = await store.restore(user, parseUuidParam(req, "id"));
    return sendJson(reply, { agent });
  });

  app.delete("/api/v1/agents/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agent = await store.markDeleted(user, parseUuidParam(req, "id"));
    return sendJson(reply, { agent });
  });

  app.get("/api/v1/agents/:id/export", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "manage");
    const bundle = await store.export(agent.org_id, agentId);
    return sendJson(reply, { export: bundle });
  });

  app.post("/api/v1/agents/:id/purge", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "manage");
    if (agent.status !== "deleting") {
      throw ApiError.badRequest("agent is not in the deletion grace period");
    }
    const force = queryParam(req, "force") === "1" && (user.role === "admin" || user.role === "owner");
    const due = agent.purge_after === null || Date.parse(agent.purge_after) <= Date.now();
    if (!due && !force) throw ApiError.badRequest("the deletion grace period has not elapsed");
    await store.purge(user, agentId);
    await rm(path.join(infra.config.agentWorkspaceWriteRoot, "agents", agent.org_id, agentId), {
      recursive: true,
      force: true,
    }).catch(() => {});
    return sendJson(reply, { purged: true });
  });

  app.get("/api/v1/agents/:id/threads", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    return sendJson(reply, { threads: await store.listThreads(agentId) });
  });

  app.post("/api/v1/agents/:id/threads", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    const body = jsonBody(req);
    const title = optionalString(body, "title") ?? "";
    return sendJson(reply, { thread: await store.createThread(agentId, title) });
  });

  app.get("/api/v1/agents/:id/threads/:threadId", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const threadId = parseUuidParam(req, "threadId");
    await store.requireAccess(user, agentId, "use");
    return sendJson(reply, { thread: await store.getThread(agentId, threadId) });
  });

  app.patch("/api/v1/agents/:id/threads/:threadId", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const threadId = parseUuidParam(req, "threadId");
    await store.requireAccess(user, agentId, "use");
    const title = requiredString(jsonBody(req), "title");
    return sendJson(reply, { thread: await store.renameThread(agentId, threadId, title) });
  });

  app.post("/api/v1/agents/:id/threads/:threadId/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const threadId = parseUuidParam(req, "threadId");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const thread = await store.getThread(agentId, threadId);
    return agentTurn(req, reply, user, agent, thread);
  });

  app.post("/api/v1/agents/:id/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "use");
    const requested = optionalString(jsonBody(req), "thread_id");
    if (requested !== undefined && requested.trim() !== "") {
      const thread = await store.getThread(agentId, requested);
      return agentTurn(req, reply, user, agent, thread);
    }
    const threads = await store.listThreads(agentId);
    const thread = threads.find((item) => item.kind === "default") ?? threads[0];
    if (thread === undefined) throw ApiError.notFound("no such thread");
    return agentTurn(req, reply, user, agent, thread);
  });

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
    return sendJson(reply, { routines: await store.listRoutines(agentId) });
  });

  app.post("/api/v1/agents/:id/routines", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "manage");
    const body = jsonBody(req);
    const kind = routineKindField(body) ?? "cron";
    const routine = await store.createRoutine(agentId, {
      name: requiredString(body, "name"),
      kind,
      schedule: optionalString(body, "schedule"),
      timezone: optionalString(body, "timezone"),
      run_at: optionalString(body, "run_at"),
      prompt: requiredString(body, "prompt"),
      enabled: booleanField(body, "enabled"),
    });
    return sendJson(reply, { routine });
  });

  app.get("/api/v1/agents/:id/routines/:rid", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    return sendJson(reply, { routine: await store.getRoutine(agentId, parseUuidParam(req, "rid")) });
  });

  app.patch("/api/v1/agents/:id/routines/:rid", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "manage");
    const body = jsonBody(req);
    const routine = await store.updateRoutine(agentId, parseUuidParam(req, "rid"), {
      name: optionalString(body, "name"),
      kind: routineKindField(body),
      schedule: optionalString(body, "schedule"),
      timezone: optionalString(body, "timezone"),
      run_at: optionalString(body, "run_at"),
      prompt: optionalString(body, "prompt"),
      enabled: booleanField(body, "enabled"),
    });
    return sendJson(reply, { routine });
  });

  app.delete("/api/v1/agents/:id/routines/:rid", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "manage");
    await store.deleteRoutine(agentId, parseUuidParam(req, "rid"));
    return sendJson(reply, { deleted: true });
  });

  app.post("/api/v1/agents/:id/routines/:rid/run", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    const { agent } = await store.requireAccess(user, agentId, "manage");
    requireActiveAgent(agent);
    const routine = await store.getRoutine(agentId, parseUuidParam(req, "rid"));
    const run = await runRoutineNow(
      { pool: infra.pool, store, runtime: chats.runtime },
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
    await store.getRoutine(agentId, routineId);
    return sendJson(reply, {
      runs: await store.listRoutineRuns(agentId, routineId, {
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
      status: statusFilter(req),
      trigger: triggerFilter(req),
      limit: limitParam(req),
      before: queryParam(req, "before"),
    };
    return sendJson(reply, { runs: await store.listRuns(agentId, filters) });
  });

  app.get("/api/v1/runs/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const run = await store.getRun(parseUuidParam(req, "id"));
    await store.requireAccess(user, run.agent_id, "use");
    const steps = await store.runSteps(run);
    const files = steps.flatMap((step) => (step.type === "file" ? (step.paths ?? []) : []));
    return sendJson(reply, {
      run: {
        ...run,
        steps: steps.map((step) => ({
          kind: step.type === "assistant_text" ? "assistant" : step.type === "tool_call" ? "tool" : "file",
          name: step.name ?? null,
          status: step.is_error === true ? "error" : "ok",
          detail:
            step.text ?? (step.type === "file" ? (step.paths ?? []).join("\n") : null),
          at: step.ts,
          is_error: step.is_error ?? null,
        })),
        files,
      },
    });
  });

  app.get("/api/v1/runs/:id/children", async (req, reply) => {
    const user = await requireUser(auth, req);
    const run = await store.getRun(parseUuidParam(req, "id"));
    await store.requireAccess(user, run.agent_id, "use");
    return sendJson(reply, { children: await store.childRuns(run.id) });
  });

  app.get("/api/v1/runs/:id/artifacts", async (req, reply) => {
    const user = await requireUser(auth, req);
    const run = await store.getRun(parseUuidParam(req, "id"));
    await store.requireAccess(user, run.agent_id, "use");
    const artifacts = await store.listArtifacts(run.id);
    return sendJson(reply, {
      run_id: run.id,
      artifacts,
      staged: artifacts.filter((artifact) => artifact.status === "staged").length,
      inboxed: artifacts.filter((artifact) => artifact.status === "inbox").length,
      released: artifacts.filter((artifact) => artifact.status === "released").length,
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
    return sendJson(reply, { activity: await store.listActivity(user.org_id, filters, user) });
  });

  app.get("/api/v1/inbox", async (req, reply) => {
    const user = await requireUser(auth, req);
    return sendJson(reply, { notices: await store.listNotices(user.id, user.org_id) });
  });

  app.post("/api/v1/inbox/:id/read", async (req, reply) => {
    const user = await requireUser(auth, req);
    const notice = await store.markNoticeRead(user.id, parseUuidParam(req, "id"));
    return sendJson(reply, { notice });
  });

  app.post("/api/v1/inbox/:id/unread", async (req, reply) => {
    const user = await requireUser(auth, req);
    const notice = await store.markNoticeUnread(user.id, parseUuidParam(req, "id"));
    return sendJson(reply, { notice });
  });

  app.get("/api/v1/agents/:id/search", async (req, reply) => {
    const user = await requireUser(auth, req);
    const agentId = parseUuidParam(req, "id");
    await store.requireAccess(user, agentId, "use");
    const query = queryParam(req, "q") ?? "";
    return sendJson(reply, { results: await store.searchThreads(agentId, query) });
  });
}
