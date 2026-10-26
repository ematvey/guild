// Thread routes: the thread lifecycle (create/list/patch/archive, project
// binding, read markers, approval policy) and the turn surface (submit,
// stop, compact, approval decisions, queued-chip withdraw, engine append).
// Primary since 2026-10-15: /api/v1/threads/* — the domain rename staged in
// (the wire FIELD names stay "chat"-shaped until the desktop release can
// follow; see PLAN). Every /api/v1/chats… and /api/v1/gateway/chat… route
// is a deprecated alias riding the same handler, kept until the desktop
// release ships the new transport paths and is retired after.
//
// The machines routes stay proxied until the hub lane (M5): the connection
// dot and fs dispatch need the real machine registry.
//
// Thread events stream over the member WS (ThreadState / SyncBegin /
// LiveFrame frames). The additive SSE endpoint (GET /api/v1/threads/{id}/
// stream, aliased at /api/v1/chats/{id}/thread/stream) serves the same
// ThreadState frames from the pi-durable watch.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatsCtx, GatewayCtx, IdentityCtx } from "../route-contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError, DESERIALIZE_PREFIX, RAW_BODY, TextError, sortedJson } from "../errors.js";
import { parseUuidParam, queryParam, requireJsonBody, requireUser } from "./error.js";
import { uuidv7 } from "../time.js";
import { threadEventRowWire, threadEventWire, type MessageAttachment, type ThreadEventRow } from "../domain/thread-events.js";
import { buildTurnText, loadMediaMap } from "../../chats/turn-text.js";
import type { UserRow } from "../store/identity.js";
import type { ChatRow } from "../store/chats.js";
import { modalityOf } from "../domain/mime.js";
import { ThreadAgentLocked } from "../../harness/runtime.js";

// ---------------------------------------------------------------------------
// Wire shapes (serde field order / skip rules)
// ---------------------------------------------------------------------------

/** The hub-aware online flag for a chat row's bound machine — the same
 *  truth the workspace push and GET /api/v1/machines use. Null
 *  binding → false (the flag is hub-coupled only when a machine exists). */
export function machineOnlineOf(chats: ChatsCtx, row: { machine_id: string | null }): boolean {
  return row.machine_id !== null && chats.hub.machineOnline(row.machine_id);
}

/** protocol::api::Chat (struct serialization). */
export function chatWire(row: {
  id: string;
  org_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  machine_id: string | null;
  machine_label: string | null;
  generating: boolean;
  /** List rows only: this chat or a descendant has a queued/running run. */
  working?: boolean;
  unread?: boolean;
  blocked?: boolean;
  project_id: string | null;
  project_name?: string | null;
  project_machine_label?: string | null;
  /** List rows only: the chat's latest thread event (RFC3339), falling back
   *  to created_at — the sidebar's recent-activity sort key. Single-chat
   *  responses omit it (their key order is wire-pinned). */
  last_activity_at?: string;
  /** List rows only: what the chat's thread is. */
  type?: string;
  archived?: boolean;
  deleted?: boolean;
  /** Hub-computed liveness of the bound machine; callers must pass it —
   *  a hardcoded false desyncs this surface from the ws push and the
   *  machines list (the "offline" banner vs green pin mismatch). */
  machine_online?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    org_id: row.org_id,
    user_id: row.user_id,
  };
  if (row.title !== null) out.title = row.title;
  out.created_at = row.created_at;
  if (row.machine_id !== null) out.machine_id = row.machine_id;
  if (row.machine_label !== null) out.machine_label = row.machine_label;
  out.generating = row.generating;
  if (row.working !== undefined) out.working = row.working;
  out.unread = row.unread ?? false;
  if (row.blocked !== undefined) out.blocked = row.blocked;
  if (row.last_activity_at !== undefined) out.last_activity_at = row.last_activity_at;
  if (row.type !== undefined) out.type = row.type;
  if (row.archived !== undefined) out.archived = row.archived;
  if (row.deleted !== undefined) out.deleted = row.deleted;
  if (row.project_id !== null) out.project_id = row.project_id;
  if (row.project_name) out.project_name = row.project_name;
  if (row.project_machine_label) out.project_machine_label = row.project_machine_label;
  out.machine_online = row.machine_online ?? false;
  return out;
}

/** The thread list rows (http/feed.rs thread_list) — hub-aware online
 *  flags, identical to the workspace push's chat rows. */
async function threadList(chats: ChatsCtx, orgId: string, userId: string, archived: boolean): Promise<unknown[]> {
  const rows = archived ? await chats.chats.listArchivedChats(orgId, userId) : await chats.chats.listChats(orgId, userId);
  return rows.map((row) =>
    chatWire({
      id: row.id,
      org_id: row.org_id,
      user_id: row.user_id,
      title: row.title,
      created_at: row.created_at,
      machine_id: row.machine_id,
      machine_label: row.machine_label,
      generating: row.generating,
      working: row.working,
      unread: row.unread,
      blocked: row.blocked,
      project_id: row.project_id,
      project_name: row.project_name,
      project_machine_label: row.project_machine_label,
      last_activity_at: row.last_activity_at,
      type: row.type,
      archived: row.archived,
      deleted: row.deleted,
      machine_online: machineOnlineOf(chats, row),
    }),
  );
}

/** A single-chat response keeps the pinned Chat wire: type, archive and
 *  deletion are thread facts that the tree endpoint and the list rows carry,
 *  not fields of this object. */
function plainChatWire(chats: ChatsCtx, row: ChatRow): Record<string, unknown> {
  return chatWire({
    id: row.id,
    org_id: row.org_id,
    user_id: row.user_id,
    title: row.title,
    created_at: row.created_at,
    machine_id: row.machine_id,
    machine_label: row.machine_label,
    generating: row.generating,
    unread: false,
    project_id: row.project_id,
    machine_online: machineOnlineOf(chats, row),
  });
}

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** GET /api/v1/chats/{id}/thread body: serde_json::json! → sorted keys. */
async function threadBody(chats: ChatsCtx, gateway: GatewayCtx, user: UserRow, chatId: string): Promise<string> {
  const events = await chats.threads.listEvents(user.org_id, chatId);
  let tokens = 0;
  let model: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!.event;
    if (ev.type === "assistant_message") {
      tokens = ev.usage.tokens_in ?? 0;
      model = ev.model;
      break;
    }
  }
  const max =
    model === null
      ? DEFAULT_CONTEXT_WINDOW
      : ((await gateway.gatewayStore.contextWindow(user.org_id, model)) ?? DEFAULT_CONTEXT_WINDOW);
  // serde_json::json! renders the outer + context maps sorted (BTreeMap);
  // each event row interpolates as a Value — sorted keys at every level.
  const contextModel = model === null ? "null" : JSON.stringify(model);
  return `{"context":{"max":${max},"model":${contextModel},"tokens":${tokens}},"events":[${events
    .map(threadEventRowWire)
    .join(",")}]}`;
}

/** Pre-rendered thread event rows (byte-exact ThreadEventRow serialization). */
export function rawRows(events: readonly ThreadEventRow[]): { __raw: string }[] {
  return events.map((row) => ({ __raw: threadEventRowWire(row) }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerChatsRoutes(
  app: FastifyInstance,
  chats: ChatsCtx,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
): void {
  // The thread API: /api/v1/threads is the primary surface (2026-10-15
  // domain rename, staged — the wire field names stay "chat"-shaped until
  // the desktop release can follow); /api/v1/chats… aliases remain.
  const createThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    const rawTitle = body["title"];
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
      throw invalidTypeText(req, "title");
    }
    const title = typeof rawTitle === "string" && rawTitle.trim() !== "" ? rawTitle.trim() : null;
    const projectId = optionalUuidField(body, "project_id");
    const chat = projectId
      ? await chats.chats.createChatForProject(user.org_id, user.id, title, projectId)
      : await chats.chats.createChat(user.org_id, user.id, title, null);
    return reply.status(200).send(plainChatWire(chats, chat));
  };
  // Deprecated alias (the desktop transport lags releases): POST /api/v1/chats.
  app.post("/api/v1/chats", createThread);
  app.post("/api/v1/threads", createThread);

  const listThreads = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const archived = ["1", "true"].includes(queryParam(req, "archived") ?? "");
    const list = await threadList(chats, user.org_id, user.id, archived);
    return reply.status(200).send(JSON.stringify({ chats: list }));
  };
  // Deprecated alias: GET /api/v1/chats.
  app.get("/api/v1/chats", listThreads);
  app.get("/api/v1/threads", listThreads);

  // --- Thread API (2026-10-15): the turn/thread surface lives under
  // /api/v1/threads/:id — the resource is the thread, turns are its
  // subresource, and /api/v1/gateway is freed for the OpenAI/Anthropic
  // API-gateway surface. The /api/v1/gateway/chat… paths stay as
  // deprecated aliases (the desktop embeds its transport and lags
  // releases); they are the same handlers, byte-identical contracts.

  const threadRead = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    return reply.status(200).type("application/json").send(await threadBody(chats, gateway, user, chatId));
  };
  // Deprecated alias: GET /api/v1/chats/:id/thread.
  app.get("/api/v1/chats/:id/thread", threadRead);
  app.get("/api/v1/threads/:id", threadRead);

  // One older page of the durable log: the client renders the ThreadState
  // tail window and prepends earlier pages as the reader scrolls up.
  const threadEventsPage = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const rawBefore = queryParam(req, "before");
    const beforeSeq = rawBefore === undefined ? undefined : Number(rawBefore);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      throw ApiError.badRequest("invalid before");
    }
    const rawLimit = queryParam(req, "limit");
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw ApiError.badRequest("invalid limit");
    }
    const page = await chats.threads.listEventPage(user.org_id, chatId, { beforeSeq, limit });
    return reply.status(200).type("application/json").send(
      `{"events":[${page.rows.map(threadEventRowWire).join(",")}],"has_more":${page.hasMore}}`,
    );
  };
  app.get("/api/v1/threads/:id/events", threadEventsPage);
  app.get("/api/v1/chats/:id/events", threadEventsPage);

  app.get("/api/v1/threads/:id/context", async (req) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const usage = await chats.threads.contextUsage(user.org_id, chatId);
    const model = queryParam(req, "model") || usage?.model || null;
    const max = model === null ? null :
      (await gateway.gatewayStore.contextWindow(user.org_id, model)) ?? DEFAULT_CONTEXT_WINDOW;
    // The measurement may come from a route the chat has since left, or from
    // one an admin retired: the alias names it for the tooltip, and a null
    // alias keeps the tooltip from naming a model it cannot identify.
    const usageModel = usage?.model ?? null;
    const usageModelAlias = usageModel === null
      ? null
      : await gateway.gatewayStore.aliasOf(user.org_id, usageModel);
    return { tokens: usage?.tokens ?? null, max, model, usage_model: usageModel, usage_model_alias: usageModelAlias };
  });

  const stopTurn = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    await chats.turnCommands.cancelWaitingHead(chatId);
    await chats.runtime.stopChat(chatId);
    return reply.status(200).send(JSON.stringify({ stopped: true }));
  };
  // Deprecated alias: POST /api/v1/gateway/chat/:id/stop.
  app.post("/api/v1/gateway/chat/:id/stop", stopTurn);
  app.post("/api/v1/threads/:id/stop", stopTurn);

  const appendThreadEvent = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const body = requireJsonBody(req);
    const event = coerceThreadEvent(body);
    // Engine-path turn join: `turn: 0` means "join the latest turn"; the
    // server assigns the real turn number.
    let resolved = event;
    if (event.type === "tool_result" && event.turn === 0) {
      const turn = await chats.threads.latestTurn(chatId);
      resolved = { ...event, turn: Math.max(1, turn) } as typeof event;
    }
    const row = await chats.threads.appendEvent(chatId, resolved);
    // json! → sorted outer keys; the event keeps its serde variant order.
    return reply
      .status(200)
      .send(`{"created_at":${JSON.stringify(row.created_at)},"event":${threadEventWire(row.event)},"id":${JSON.stringify(row.id)},"seq":${row.seq}}`);
  };
  // Deprecated alias: POST /api/v1/chats/:id/thread (the engine-path append).
  app.post("/api/v1/chats/:id/thread", appendThreadEvent);
  app.post("/api/v1/threads/:id/events", appendThreadEvent);

  const setThreadProject = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const raw = body["project_id"];
    const projectId = typeof raw === "string" && raw !== "" ? validateUuid(raw) : null;
    const chat = await chats.chats.setProject(user.org_id, chatId, user, projectId);
    return reply.status(200).send(plainChatWire(chats, chat));
  };
  // Deprecated alias: POST /api/v1/chats/:id/project.
  app.post("/api/v1/chats/:id/project", setThreadProject);
  app.post("/api/v1/threads/:id/project", setThreadProject);

  const approvalMode = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const approval = await chats.chats.approval(user.org_id, user.id, chatId);
    return reply.status(200).send(JSON.stringify({ default: approval?.default ?? null }));
  };
  // Deprecated alias: GET|POST /api/v1/chats/:id/approval (the per-chat
  // approval policy). GET:
  app.get("/api/v1/chats/:id/approval", approvalMode);
  app.get("/api/v1/threads/:id/approval", approvalMode);

  const setApprovalMode = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const mode = body["default"];
    let policy: Record<string, unknown> | null;
    let responseMode: string | null;
    if (mode === undefined || mode === null || mode === "default") {
      policy = null;
      responseMode = null;
    } else if (mode === "ask" || mode === "approve_for_me" || mode === "full_access") {
      policy = { default: mode };
      responseMode = mode;
    } else {
      throw ApiError.badRequest(
        `unknown approval mode ${String(mode)} — expected ask, approve_for_me, full_access, or default`,
      );
    }
    await chats.chats.setApproval(user.org_id, user.id, chatId, policy);
    return reply.status(200).send(JSON.stringify({ default: responseMode }));
  };
  // Deprecated alias: POST /api/v1/chats/:id/approval.
  app.post("/api/v1/chats/:id/approval", setApprovalMode);
  app.post("/api/v1/threads/:id/approval", setApprovalMode);

  const markThreadRead = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.markRead(user.org_id, chatId, user);
    return reply.status(200).send(JSON.stringify({ ok: true }));
  };
  // Deprecated alias: POST /api/v1/chats/:id/read.
  app.post("/api/v1/chats/:id/read", markThreadRead);
  app.post("/api/v1/threads/:id/read", markThreadRead);

  const patchThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const rawTitle = body["title"];
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
      throw invalidTypeText(req, "title");
    }
    const title = typeof rawTitle === "string" ? rawTitle.trim() : undefined;
    const effectiveTitle = title !== undefined && title !== "" ? title : title === "" ? null : undefined;
    const archived = typeof body["archived"] === "boolean" ? body["archived"] : undefined;
    const chat = await chats.chats.updateChat(user.org_id, chatId, user, effectiveTitle ?? undefined, archived ?? null);
    if (archived === true) {
      // Archiving closes the agent-thread subtree first: descendants stop
      // and deliveries stop. Then the in-flight generation is ended, or an
      // archived chat keeps spinning where the user can no longer reach it.
      await chats.runtime.closeChatSubtree(chatId).catch(() => {});
      await chats.runtime.stopChat(chatId).catch(() => {});
      await chats.turnCommands.cancelAllWaiting(chatId);
    }
    return reply.status(200).send(plainChatWire(chats, chat));
  };
  // Deprecated alias: PATCH /api/v1/chats/:id (rename/archive).
  app.patch("/api/v1/chats/:id", patchThread);
  app.patch("/api/v1/threads/:id", patchThread);

  // Deletion is separate from archiving: a deleted chat leaves every list,
  // its subtree stops, and the row stays for the transcript.
  const deleteThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const chat = await chats.chats.deleteChat(user.org_id, chatId, user);
    await chats.runtime.closeChatSubtree(chatId).catch(() => {});
    await chats.runtime.stopChat(chatId).catch(() => {});
    return reply.status(200).send(
      chatWire({
        id: chat.id,
        org_id: chat.org_id,
        user_id: chat.user_id,
        title: chat.title,
        created_at: chat.created_at,
        machine_id: chat.machine_id,
        machine_label: chat.machine_label,
        generating: chat.generating,
        unread: false,
        project_id: chat.project_id,
        archived: chat.archived,
        deleted: chat.deleted,
        machine_online: machineOnlineOf(chats, chat),
      }),
    );
  };
  app.delete("/api/v1/chats/:id", deleteThread);
  app.delete("/api/v1/threads/:id", deleteThread);

  // --- Gateway chat commands (the M3 flip of gateway.rs's chat half) ---

  // The desktop sends the turn body with chat_id inside; the thread API
  // takes the chat from the path — both reach the same submit core.
  // Deprecated alias: POST /api/v1/gateway/chat (chat_id in the body).
  app.post("/api/v1/gateway/chat", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    return reply.status(200).type("application/json").send(await submitTurn(chats, gateway, auth, objects, user, req, body));
  });
  // The composer's agent picker: reads and sets the chat's agent. Setting it
  // before the first turn binds the chat; afterwards it moves the existing
  // thread (and its transcript) to the chosen agent.
  app.get("/api/v1/threads/:chatId/agent", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "chatId");
    await chats.chats.getChat(user.org_id, chatId, user);
    return reply.type("application/json").send(
      JSON.stringify({
        agent: await chats.runtime.chatAgent(chatId),
        switcheable: await chats.runtime.agentSwitchAllowed(chatId),
      }),
    );
  });

  app.post("/api/v1/threads/:chatId/agent", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "chatId");
    const body = requireJsonBody(req);
    const agentId = body["agent_id"];
    if (typeof agentId !== "string" || agentId.trim() === "") {
      throw ApiError.badRequest("agent_id is required");
    }
    const chat = await chats.chats.getChat(user.org_id, chatId, user);
    let bound: { thread_id: string };
    try {
      bound = await chats.runtime.bindChatAgent(chatId, user.id, agentId, chat.title ?? "", user);
    } catch (error) {
      if (error instanceof ThreadAgentLocked) {
        throw ApiError.conflict("thread_agent_locked", error.message);
      }
      throw error;
    }
    return reply
      .type("application/json")
      .send(JSON.stringify({ agent: await chats.runtime.chatAgent(chatId), thread_id: bound.thread_id }));
  });

  app.post("/api/v1/threads/:chatId/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    const chatId = parseUuidParam(req, "chatId");
    return reply.status(200).type("application/json").send(await submitTurn(chats, gateway, auth, objects, user, req, body, chatId));
  });

  /** Withdraws one queued (not yet placed) mid-turn send — the desktop
   *  queued-chip trash button. The never-delivered echo leaves the thread
   *  log; a placed or settled input is reported 409 (the chip is already
   *  transitioning to a delivered message on the client). */
  const withdrawPending = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const messageId = parseUuidParam(req, "messageId");
    await chats.chats.getChat(user.org_id, chatId, user);
    const command = await chats.turnCommands.byId(messageId, chatId);
    if (!command) throw ApiError.notFound("no such message");
    if (command.status !== "pending" && command.status !== "submitted") {
      throw ApiError.conflict("already_settled", "message already settled");
    }
    if (command.invocation_id !== null && command.invocation_id.startsWith("sub:")) {
      const outcome = await chats.runtime.withdrawQueued(chatId, Number(command.invocation_id.slice(4)));
      if (outcome !== "aborted" && outcome !== "not_found") {
        throw ApiError.conflict("already_placed", "message already placed — refresh to see it delivered");
      }
    }
    await chats.turnCommands.settleCancelledById(messageId, chatId);
    await chats.threads.deleteQueuedEvent(chatId, messageId);
    return reply.status(200).send(JSON.stringify({ withdrawn: true }));
  };
  // Deprecated alias: DELETE /api/v1/gateway/chat/:id/pending/:messageId.
  app.delete("/api/v1/gateway/chat/:id/pending/:messageId", withdrawPending);
  app.delete("/api/v1/threads/:id/pending/:messageId", withdrawPending);

  app.post("/api/v1/threads/:id/pending/:messageId/steer", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const messageId = parseUuidParam(req, "messageId");
    await chats.chats.getChat(user.org_id, chatId, user);
    const command = await chats.turnCommands.byId(messageId, chatId);
    if (!command) throw ApiError.notFound("no such message");
    if (!command.invocation_id?.startsWith("sub:")) {
      throw ApiError.conflict("not_admitted", "message admission is still pending — retry shortly");
    }
    const changed = await chats.runtime.steerQueued(chatId, Number(command.invocation_id.slice(4)));
    if (!changed) throw ApiError.conflict("already_placed", "message already placed — refresh to see it delivered");
    await chats.threads.setQueuedMode(chatId, messageId, "steer");
    return reply.send({ steering: true });
  });

  const resolveApproval = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    // Nested (codemode) call ids carry a `/` (`<parent>/<key>`): older
    // clients pass it unencoded, so take the wildcard remainder whole and
    // decode it.
    const raw = (req.params as Record<string, string>)["*"] ?? "";
    const callId = decodeURIComponent(raw);
    await chats.chats.getChat(user.org_id, chatId, user);
    const body = requireJsonBody(req);
    if (typeof body["approved"] !== "boolean") {
      throw ApiError.badRequest("missing approved");
    }
    const approved = body["approved"] as boolean;
    const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
    void approved;
    void reason; // live-gate forwarding arrives with the M4 approval lane

    // Recorded decision: echo it verbatim (late clicks are idempotent).
    const events = await chats.threads.listEvents(user.org_id, chatId);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!.event;
      if (ev.type === "approval_decision" && ev.call_id === callId) {
        return reply.status(200).send(
          JSON.stringify(
            sortedJson({
              ok: true,
              settled: true,
              approved: ev.approved,
              reason: ev.reason ?? null,
              expired: ev.expired,
            }),
          ),
        );
      }
    }

    // Live turn: the M4 approval gate's tool task polls the journaled
    // decision (the block/resume contract) — appending it here resolves the
    // suspended gate within the poll interval.
    const generating = await chats.chats.isGenerating(user.org_id, chatId);
    if (generating) {
      await chats.threads.appendEvent(chatId, {
        type: "approval_decision",
        call_id: callId,
        approved,
        ...(reason !== undefined ? { reason } : {}),
        expired: false,
      });
      return reply.status(200).send(JSON.stringify(sortedJson({ ok: true, settled: false })));
    }
    // Orphaned call (no recorded decision, no live turn): journal the
    // expired marker so a reload shows the settled card.
    const APPROVAL_EXPIRED_REASON = "expired — no turn was waiting for this approval";
    await chats
      .threads
      .appendEvent(chatId, { type: "approval_decision", call_id: callId, approved: false, reason: APPROVAL_EXPIRED_REASON, expired: true });
    return reply.status(200).send(
      JSON.stringify(
        sortedJson({
          ok: true,
          settled: true,
          approved: false,
          reason: APPROVAL_EXPIRED_REASON,
          expired: true,
        }),
      ),
    );
  };
  // Deprecated alias: POST /api/v1/gateway/chat/:id/approvals/*.
  app.post("/api/v1/gateway/chat/:id/approvals/*", resolveApproval);
  app.post("/api/v1/threads/:id/approvals/*", resolveApproval);

  const compactTurn = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const taskId = await chats.runtime.compactChat(chatId);
    return reply.status(200).send({ ok: true, task_id: taskId });
  };
  // Deprecated alias: POST /api/v1/gateway/chat/:id/compact.
  app.post("/api/v1/gateway/chat/:id/compact", compactTurn);
  app.post("/api/v1/threads/:id/compact", compactTurn);
  app.get("/api/v1/threads/:id/compactions/:taskId", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const rawTaskId = (req.params as { taskId: string }).taskId;
    const taskId = Number(rawTaskId);
    if (!/^\d+$/.test(rawTaskId) || !Number.isSafeInteger(taskId) || taskId < 1) {
      throw ApiError.badRequest("invalid compaction task ID");
    }
    const status = await chats.chats.compactionStatus(chatId, taskId);
    if (!status) throw ApiError.notFound("no such compaction");
    return reply.send(status);
  });
}

// ---------------------------------------------------------------------------
// Turn submission (the submit_turn core)
// ---------------------------------------------------------------------------

export async function submitTurn(
  chats: ChatsCtx,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
  user: UserRow,
  req: FastifyRequest,
  body: Record<string, unknown>,
  /** The thread API takes the chat from the path; the legacy
   *  /api/v1/gateway/chat alias keeps it in the body. */
  pathChatId?: string,
  /** Agent turn routes authorize through the agent grant and pass the
   *  thread's chat row, so the chat's own owner check does not apply. */
  preloadedChat?: ChatRow,
  /** Agent turn routes open their own run row before this call; only the
   *  chat route asks submitTurn to open one. */
  beginRun = true,
): Promise<string> {
  // Required fields (serde rejection text, line/column = raw body length).
  const rawLength = ((req as never as Record<symbol, string>)[RAW_BODY]?.length as number | undefined) ?? 0;
  void rawLength;
  let chatIdRaw: unknown = body["chat_id"];
  if (pathChatId !== undefined) {
    chatIdRaw = pathChatId;
  } else if (chatIdRaw === undefined) throw missingField(req, "chat_id");
  if (typeof chatIdRaw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatIdRaw)) {
    throw invalidTypeText(req, "chat_id");
  }
  if (body["model"] === undefined) throw missingField(req, "model");
  if (typeof body["model"] !== "string") throw invalidTypeText(req, "model");
  if (body["messages"] === undefined) throw missingField(req, "messages");
  if (!Array.isArray(body["messages"])) throw invalidTypeText(req, "messages");
  if (body["server_workspace"] !== undefined && body["server_workspace"] !== null) {
    throw ApiError.badRequest("server_workspace is reserved for workspace agent sessions");
  }

  const chatId = chatIdRaw.toLowerCase();
  // Every conversation belongs to an agent. A plain chat is adopted by the
  // caller's personal agent on its first turn; from then on the turn runs
  // with the agent's model and tools, and the run lifecycle closes the run.
  const chatRow = preloadedChat ?? (await chats.chats.getChat(user.org_id, chatId, user));
  const requestedAgent = typeof body["agent_id"] === "string" ? body["agent_id"] : null;
  const adopted =
    requestedAgent === null
      ? await chats.runtime.adoptChatAgent(chatId, user.org_id, user.id, chatRow.title ?? "")
      : await chats.runtime
          .bindChatAgent(chatId, user.id, requestedAgent, chatRow.title ?? "", user)
          .catch((error: unknown) => {
            if (error instanceof ThreadAgentLocked) {
              throw ApiError.conflict("thread_agent_locked", error.message);
            }
            throw error;
          });
  const model = await resolveTurnModel(
    gateway,
    user.org_id,
    adopted === null ? (body["model"] as string) : adopted.model,
  );
  const messages = body["messages"] as { role?: unknown; content?: unknown }[];
  if (body["client_tools"] !== undefined && typeof body["client_tools"] !== "boolean") {
    throw invalidTypeText(req, "client_tools");
  }
  if (body["send_mode"] !== undefined && body["send_mode"] !== null && typeof body["send_mode"] !== "string") {
    throw invalidTypeText(req, "send_mode");
  }

  // Org scoping: the chat must belong to the caller's org.
  const chat = chatRow;

  const commandId =
    body["user_message_id"] === undefined || body["user_message_id"] === null ? uuidv7() : validateUuid(String(body["user_message_id"]));
  // The canonical re-serialization of ChatCompletionRequest (struct order,
  // defaults filled, None skipped) — the idempotency key material.
  const request = canonicalChatRequest(body, chatId, model, commandId);
  const existing = await chats.turnCommands.existing(commandId, user.org_id, user.id, chatId, request);
  if (existing) {
    // A duplicate delivery must not change the project binding or steer
    // another running command.
    return commandAck(existing);
  }

  const userMessage =
    [...messages].reverse().find((m) => m?.role === "user")?.content ?? "";
  const userMessageText = typeof userMessage === "string" ? userMessage : "";
  if (userMessageText === "" && userMessage !== "") {
    // Non-string content blocks: not part of the chat turn contract (the
    // desktop sends plain text; media rides on attachments).
    throw invalidTypeText(req, "messages");
  }

  // Effective project binding (request wins, chat binding applies, machine
  // is project-derived).
  let machineId = chat.machine_id;
  let machineLabel = chat.machine_label;
  let projectId = optionalUuidField(body, "project_id");
  if (projectId !== null) {
    const project = await chats.chats.projectForBinding(user.org_id, projectId, user.id);
    if (project === undefined) throw ApiError.notFound("no such project");
    machineLabel = project.machine_label;
    machineId = project.machine_id;
  } else if (chat.project_id !== null) {
    const project = await chats.chats.projectForBinding(user.org_id, chat.project_id, user.id);
    if (project !== undefined) {
      machineLabel = project.machine_label;
      machineId = project.machine_id;
      if (chat.machine_id !== project.machine_id) {
        await chats.chats.setMachine(user.org_id, chatId, project.machine_id, machineLabel);
      }
      projectId = chat.project_id;
    }
  }

  // Arrival-turn user event (chips + inlined document text), gated by the
  // resolved route's modalities.
  const attachmentIds = optionalUuidArrayField(body, "attachment_ids");
  let routeModalities: string[] = [];
  try {
    const route = await gateway.gatewayStore.resolveRoute(user.org_id, model, gateway.masterKey());
    routeModalities = route.modalities;
  } catch {
    // A missing route fails later at submission time; the visible echo must
    // not depend on it.
  }
  const attachmentRows = await auth.attachments.list(user.org_id, chatId);
  const media = await loadMediaMap(objects, user.org_id, attachmentRows, [], attachmentIds);
  const { chips, inline } = buildTurnText(attachmentIds, media, attachmentRows, routeModalities);
  const content = [userMessageText, inline].filter((part) => part !== "").join("\n\n");
  const { images } = mediaPartsFor(routeModalities, chips, media);
  // The machine turn's client-assembled skills index (additive wire field;
  // the desktop sends it, browser clients do not).
  const skillsIndex = typeof body["skills_index"] === "string" ? body["skills_index"] : undefined;
  // The desktop's project instruction chain (global config-dir file + the
  // project's AGENTS.md chain). Additive like skills_index: the server
  // appends it to the agent's workspace instructions under its own cap.
  const agentsMd = typeof body["agents_md"] === "string" ? body["agents_md"] : undefined;

  const payload = {
    user_message_id: commandId,
    org_id: user.org_id,
    user_id: user.id,
    chat_id: chatId,
    model,
    user_message: userMessageText,
    client_tools: body["client_tools"] === true,
    project_id: projectId,
    machine_id: machineId,
    machine_label: machineLabel,
    attachment_ids: attachmentIds,
  };
  // Reserve "generating" before the accept's user_message echo: the capture
  // echoing the new message must already say generating, or its socket
  // delivery lands after the HTTP response and clobbers the client's
  // optimistic busy (the Working indicator blinks off in the pre-turn
  // window). A failed accept or submit restores the previous flag.
  const priorGenerating = await chats.chats.isGenerating(user.org_id, chatId);
  await chats.chats.setGenerating(user.org_id, chatId, true);
  const sendMode = body["send_mode"] === "steer" ? ("steer" as const) : body["send_mode"] === "queue" ? ("queue" as const) : undefined;
  let command;
  try {
    command = await chats
      .turnCommands
      .accept(commandId, user.org_id, user.id, chatId, request, payload, {
        content,
        attachments: chips,
        queued: priorGenerating,
        mode: sendMode,
      });
    // The run row exists before the turn is admitted; the lifecycle closes it
    // from the transcript.
    if (adopted !== null && beginRun) {
      await chats.runtime.beginChatRun(adopted.agent_id, adopted.thread_id, user.id);
    }
    const submissionId = await chats.runtime.submitTurn(chatId, user.org_id, {
      orgId: user.org_id,
      requestId: commandId,
      content,
      images,
      model,
      ...(sendMode !== undefined ? { sendMode } : {}),
      ...(skillsIndex !== undefined ? { skillsIndex } : {}),
      ...(agentsMd !== undefined ? { agentsMd } : {}),
    });
    await chats.turnCommands.submitted(commandId, `sub:${submissionId}`);
    // Name the thread from the first message while the turn runs; the run
    // lifecycle retries once if this call fails.
    if (adopted !== null && (chat.title ?? "").trim() === "") {
      void chats.runtime.generateThreadTitle(chatId, adopted.thread_id).catch(() => {});
    }
  } catch (error) {
    await chats.chats.setGenerating(user.org_id, chatId, priorGenerating);
    // The delivery failed after the accept committed: mark the command so
    // it stops claiming a pending turn (the echo stays — the user typed
    // it). The alternative was an immortal pending row.
    await chats.turnCommands.failUnsubmitted(commandId).catch(() => {});
    throw error;
  }
  await chats.chats.reconcileGenerating(user.org_id, chatId);
  const refreshed = await chats.turnCommands.existing(commandId, user.org_id, user.id, chatId, request);
  return commandAck(refreshed ?? command);
}

/** The model-facing image parts of the arrival turn (data URIs), gated by
 *  the route's modalities. */
function mediaPartsFor(
  modalities: string[],
  chips: MessageAttachment[],
  media: Map<string, { mime: string; b64: string }>,
): { images: { mimeType: string; data: string }[] } {
  const images: { mimeType: string; data: string }[] = [];
  if (!modalities.includes("image")) return { images };
  for (const chip of chips) {
    if (modalityOf(chip.content_type) !== "image") continue;
    const m = media.get(chip.id);
    if (!m) continue;
    images.push({ mimeType: m.mime, data: m.b64 });
  }
  return { images };
}

function commandAck(command: { id: string; status: string; invocation_id: string | null }): string {
  return JSON.stringify(
    sortedJson({
      accepted: true,
      user_message_id: command.id,
      generation_id: command.id,
      queued: command.status === "pending",
      invocation_id: command.invocation_id,
      status: command.status,
    }),
  );
}

/** The route this turn runs on: the requested model while the org still has
 *  it, else the default (first enabled) route. A chat carries no pinned
 *  model, so a client whose catalog predates an admin's route change — an
 *  open tab, an older desktop bundle — keeps working instead of failing the
 *  turn on a model that no longer exists. An org with no routes keeps the
 *  request as sent, so the submission fails with the route error. */
async function resolveTurnModel(gateway: GatewayCtx, orgId: string, requested: string): Promise<string> {
  const routes = await gateway.gatewayStore.listModels(orgId);
  if (routes.length === 0) return requested;
  if (routes.some((route) => route.model === requested)) return requested;
  return routes[0]!.model;
}

/** Re-serializes the request the way serde renders ChatCompletionRequest
 *  (declaration order, defaults filled, None skipped) — the turn-command
 *  idempotency material. */
function canonicalChatRequest(body: Record<string, unknown>, chatId: string, model: string, commandId: string): unknown {
  const messages = (body["messages"] as unknown[] | undefined)?.map((m) => sortedJson(m)) ?? [];
  const out: Record<string, unknown> = {};
  // Rust: user_message_id.get_or_insert_with(now_v7) happens BEFORE the
  // canonical to_value — the resolved id always rides the material.
  out.user_message_id = commandId;
  out.chat_id = chatId;
  out.model = model;
  out.messages = messages;
  if (body["tools"] !== undefined && body["tools"] !== null) out.tools = sortedJson(body["tools"]);
  if (body["system"] !== undefined && body["system"] !== null) out.system = body["system"];
  out.client_tools = body["client_tools"] === true;
  if (body["project_id"] !== undefined && body["project_id"] !== null) {
    out.project_id = String(body["project_id"]).toLowerCase();
  }
  const attachmentIds = body["attachment_ids"];
  out.attachment_ids = Array.isArray(attachmentIds) ? attachmentIds.map((id) => String(id).toLowerCase()) : [];
  if (body["send_mode"] !== undefined && body["send_mode"] !== null) out.send_mode = body["send_mode"];
  if (body["server_workspace"] !== undefined && body["server_workspace"] !== null) {
    out.server_workspace = sortedJson(body["server_workspace"]);
  }
  if (body["skills_index"] !== undefined && body["skills_index"] !== null) out.skills_index = body["skills_index"];
  if (body["agents_md"] !== undefined && body["agents_md"] !== null) out.agents_md = body["agents_md"];
  return sortedJson(out);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function missingField(req: FastifyRequest, field: string): TextError {
  return new TextError(
    422,
    `${DESERIALIZE_PREFIX}missing field \`${field}\` at line 1 column ${(req as never as Record<symbol, string>)[RAW_BODY]?.length ?? 0}`,
  );
}

function invalidTypeText(req: FastifyRequest, _field: string): TextError {
  return new TextError(
    422,
    `${DESERIALIZE_PREFIX}invalid type at line 1 column ${(req as never as Record<symbol, string>)[RAW_BODY]?.length ?? 0}`,
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string): string {
  if (!UUID_RE.test(value)) throw ApiError.badRequest("invalid uuid");
  return value.toLowerCase();
}

function optionalUuidField(body: Record<string, unknown>, field: string): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  return validateUuid(String(raw));
}

function optionalUuidArrayField(body: Record<string, unknown>, field: string): string[] {
  const raw = body[field];
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => validateUuid(String(id)));
}

/** Lenient parse of a client-appended thread event (closed enum; unknown
 *  types are a bad request). */
function coerceThreadEvent(body: Record<string, unknown>): ThreadEventRow["event"] {
  const type = body["type"];
  switch (type) {
    case "user_message":
      return { type: "user_message", content: String(body["content"] ?? ""), attachments: (body["attachments"] as MessageAttachment[] | undefined) ?? [] };
    case "system_message":
      return { type: "system_message", content: String(body["content"] ?? "") };
    case "assistant_message":
      return {
        type: "assistant_message",
        turn: Number(body["turn"] ?? 0),
        step: Number(body["step"] ?? 0),
        blocks: (body["blocks"] ?? []) as never,
        usage: (body["usage"] ?? {}) as never,
        model: String(body["model"] ?? ""),
      };
    case "tool_result":
      return {
        type: "tool_result",
        turn: Number(body["turn"] ?? 0),
        step: Number(body["step"] ?? 0),
        call_id: String(body["call_id"] ?? ""),
        name: String(body["name"] ?? ""),
        content: String(body["content"] ?? ""),
        is_error: Boolean(body["is_error"]),
        images: (body["images"] as string[] | undefined) ?? [],
      };
    case "approval_request":
      return { type: "approval_request", call_id: String(body["call_id"] ?? ""), name: String(body["name"] ?? ""), arguments: String(body["arguments"] ?? "") };
    case "approval_decision":
      return {
        type: "approval_decision",
        call_id: String(body["call_id"] ?? ""),
        approved: Boolean(body["approved"]),
        expired: Boolean(body["expired"] ?? false),
      };
    default:
      throw ApiError.badRequest(`unknown thread event type ${String(type)}`);
  }
}
