// Thread routes: the thread lifecycle (create/list/patch/archive/delete,
// project binding, read markers, approval policy) and the turn surface
// (submit, stop, compact, approval decisions, queued-chip withdraw, engine
// append). /api/v1/threads/* is the primary surface; /api/v1/chats… and
// /api/v1/gateway/chat… are aliases riding the same handlers, kept while
// installed desktop clients still call them.
//
// Reads go through the chat store's read gate (owner or org admin); every
// write goes through the owner-only, not-deleted write gate.
//
// Thread events stream over the member WS (ThreadState / SyncBegin /
// LiveFrame frames).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatsCtx, GatewayCtx, IdentityCtx } from "../route-contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError } from "../errors.js";
import { sortedJson } from "../domain/json.js";
import { parseUuidParam, queryParam, requireJsonBody, requireUser, sendJson } from "./error.js";
import { threadEventRowObject, type ThreadEventRow } from "../domain/thread-events.js";
import type { UserRow } from "../store/identity.js";
import type { Chat } from "@guild/wire/rest";
import { chatWire } from "../../chats/chat-wire.js";
import { DEFAULT_CONTEXT_WINDOW, contextUsage } from "../../chats/context-usage.js";
import { compactionStatus } from "../../chats/compaction.js";
import { ThreadAgentLocked } from "../../harness/runtime.js";
import { optionalUuidField, submitTurn } from "../../chats/submit-turn.js";

/** The thread list rows — hub-aware online flags, identical to the
 *  workspace push's chat rows. */
async function threadList(chats: ChatsCtx, orgId: string, userId: string, archived: boolean): Promise<Chat[]> {
  const rows = archived
    ? await chats.chats.listArchivedChats(orgId, userId)
    : await chats.chats.listChats(orgId, userId);
  return rows.map((row) => chatWire(chats.hub, row));
}

/** The row one chat response carries: the same list row the sidebar gets,
 *  so every chat read and write answers one shape. */
async function chatResponse(chats: ChatsCtx, orgId: string, userId: string, chatId: string): Promise<Chat> {
  const row = await chats.chats.getChatListRow(orgId, userId, chatId);
  if (!row) throw ApiError.notFound("no such chat");
  return chatWire(chats.hub, row);
}

const APPROVAL_EXPIRED_REASON = "expired — no turn was waiting for this approval";

/** GET /api/v1/chats/{id}/thread body. */
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
  return JSON.stringify({
    context: { max, model, tokens },
    events: events.map(threadEventRowObject),
  });
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
  const createThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    const rawTitle = body["title"];
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
      throw ApiError.badRequest("title must be a string");
    }
    const title = typeof rawTitle === "string" && rawTitle.trim() !== "" ? rawTitle.trim() : null;
    const projectId = optionalUuidField(body, "project_id");
    const created = projectId
      ? await chats.chats.createChatForProject(user.org_id, user.id, title, projectId)
      : await chats.chats.createChat(user.org_id, user.id, title, null);
    return reply.status(200).send(await chatResponse(chats, user.org_id, user.id, created.id));
  };
  // Deprecated alias (the desktop transport lags releases): POST /api/v1/chats.
  app.post("/api/v1/chats", createThread);
  app.post("/api/v1/threads", createThread);

  const listThreads = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const archived = ["1", "true"].includes(queryParam(req, "archived") ?? "");
    const list = await threadList(chats, user.org_id, user.id, archived);
    return sendJson(reply, { chats: list });
  };
  // Deprecated alias: GET /api/v1/chats.
  app.get("/api/v1/chats", listThreads);
  app.get("/api/v1/threads", listThreads);

  const threadRead = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    return reply
      .status(200)
      .type("application/json")
      .send(await threadBody(chats, gateway, user, chatId));
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
    return reply
      .status(200)
      .type("application/json")
      .send(JSON.stringify({ events: page.rows.map(threadEventRowObject), has_more: page.hasMore }));
  };
  app.get("/api/v1/threads/:id/events", threadEventsPage);
  app.get("/api/v1/chats/:id/events", threadEventsPage);

  app.get("/api/v1/threads/:id/context", async (req) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    const usage = await contextUsage(chats.pool, user.org_id, chatId);
    const model = queryParam(req, "model") || usage?.model || null;
    const max =
      model === null
        ? null
        : ((await gateway.gatewayStore.contextWindow(user.org_id, model)) ?? DEFAULT_CONTEXT_WINDOW);
    // The measurement may come from a route the chat has since left, or from
    // one an admin retired: the alias names it for the tooltip, and a null
    // alias keeps the tooltip from naming a model it cannot identify.
    const usageModel = usage?.model ?? null;
    const usageModelAlias = usageModel === null ? null : await gateway.gatewayStore.aliasOf(user.org_id, usageModel);
    return { tokens: usage?.tokens ?? null, max, model, usage_model: usageModel, usage_model_alias: usageModelAlias };
  });

  const stopTurn = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    await chats.turnCommands.cancelWaitingHead(chatId);
    await chats.runtime.stopChat(chatId);
    return sendJson(reply, { stopped: true });
  };
  // Deprecated alias: POST /api/v1/gateway/chat/:id/stop.
  app.post("/api/v1/gateway/chat/:id/stop", stopTurn);
  app.post("/api/v1/threads/:id/stop", stopTurn);

  const setThreadProject = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const raw = body["project_id"];
    const projectId = typeof raw === "string" && raw !== "" ? optionalUuidField(body, "project_id") : null;
    await chats.chats.setProject(user.org_id, chatId, user, projectId);
    return reply.status(200).send(await chatResponse(chats, user.org_id, user.id, chatId));
  };
  // Deprecated alias: POST /api/v1/chats/:id/project.
  app.post("/api/v1/chats/:id/project", setThreadProject);
  app.post("/api/v1/threads/:id/project", setThreadProject);

  const approvalMode = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const approval = await chats.chats.approval(user.org_id, user, chatId);
    return sendJson(reply, { default: approval?.default ?? null });
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
    await chats.chats.setApproval(user.org_id, user, chatId, policy);
    return sendJson(reply, { default: responseMode });
  };
  // Deprecated alias: POST /api/v1/chats/:id/approval.
  app.post("/api/v1/chats/:id/approval", setApprovalMode);
  app.post("/api/v1/threads/:id/approval", setApprovalMode);

  const markThreadRead = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.markRead(user.org_id, chatId, user);
    return sendJson(reply, { ok: true });
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
      throw ApiError.badRequest("title must be a string");
    }
    // An absent title keeps the current one; null or a blank string clears it.
    const title =
      rawTitle === undefined
        ? undefined
        : typeof rawTitle === "string" && rawTitle.trim() !== ""
          ? rawTitle.trim()
          : null;
    const archived = typeof body["archived"] === "boolean" ? body["archived"] : undefined;
    await chats.chats.updateChat(user.org_id, chatId, user, title, archived ?? null);
    if (archived === true) {
      // Archiving closes the agent-thread subtree first: descendants stop
      // and deliveries stop. Then the in-flight generation is ended, or an
      // archived chat keeps spinning where the user can no longer reach it.
      await chats.runtime.closeChatSubtree(chatId).catch(() => {});
      await chats.runtime.stopChat(chatId).catch(() => {});
      await chats.turnCommands.cancelAllWaiting(chatId);
    }
    return reply.status(200).send(await chatResponse(chats, user.org_id, user.id, chatId));
  };
  // Deprecated alias: PATCH /api/v1/chats/:id (rename/archive).
  app.patch("/api/v1/chats/:id", patchThread);
  app.patch("/api/v1/threads/:id", patchThread);

  // Deletion is separate from archiving: a deleted chat and every chat in
  // its agent-thread subtree leave every list, the subtree closes, and the
  // rows stay for the transcripts. The store closes and marks the subtree in
  // one transaction; then each chat's in-flight generation ends.
  const deleteThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const { descendants } = await chats.chats.deleteChat(user.org_id, chatId, user);
    for (const id of [chatId, ...descendants]) {
      if (!chats.runtime.canStopChat(id)) continue;
      await chats.runtime.stopChat(id).catch(() => {});
    }
    return reply.status(200).send(await chatResponse(chats, user.org_id, user.id, chatId));
  };
  app.delete("/api/v1/chats/:id", deleteThread);
  app.delete("/api/v1/threads/:id", deleteThread);

  // The desktop sends the turn body with chat_id inside; the thread API
  // takes the chat from the path — both reach the same submit core.
  // Deprecated alias: POST /api/v1/gateway/chat (chat_id in the body).
  app.post("/api/v1/gateway/chat", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    return reply
      .status(200)
      .type("application/json")
      .send(await submitTurn(chats, gateway, auth, objects, user, body));
  });
  // The composer's agent picker: reads and sets the chat's agent. Setting it
  // before the first turn binds the chat; afterwards it moves the existing
  // thread (and its transcript) to the chosen agent.
  app.get("/api/v1/threads/:chatId/agent", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "chatId");
    const chat = await chats.chats.getChat(user.org_id, chatId, user);
    // Switching is a write: only the owner may, even when an admin reads.
    return sendJson(reply, {
      agent: await chats.runtime.chatAgent(chatId),
      switcheable: chat.user_id === user.id && (await chats.runtime.agentSwitchAllowed(chatId)),
    });
  });

  app.post("/api/v1/threads/:chatId/agent", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "chatId");
    const body = requireJsonBody(req);
    const agentId = body["agent_id"];
    if (typeof agentId !== "string" || agentId.trim() === "") {
      throw ApiError.badRequest("agent_id is required");
    }
    const chat = await chats.chats.getOwnChat(user.org_id, chatId, user);
    let bound: { thread_id: string };
    try {
      bound = await chats.runtime.bindChatAgent(chatId, user.id, agentId, chat.title ?? "", user);
    } catch (error) {
      if (error instanceof ThreadAgentLocked) {
        throw ApiError.conflict("thread_agent_locked", error.message);
      }
      throw error;
    }
    return sendJson(reply, { agent: await chats.runtime.chatAgent(chatId), thread_id: bound.thread_id });
  });

  app.post("/api/v1/threads/:chatId/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    const chatId = parseUuidParam(req, "chatId");
    return reply
      .status(200)
      .type("application/json")
      .send(await submitTurn(chats, gateway, auth, objects, user, body, chatId));
  });

  /** Withdraws one queued (not yet placed) mid-turn send — the desktop
   *  queued-chip trash button. It leaves the chat's queue, and never had a
   *  thread row; a placed or settled input is reported 409 (the chip is
   *  already transitioning to a delivered message on the client). */
  const withdrawPending = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const messageId = parseUuidParam(req, "messageId");
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    const command = await chats.turnCommands.byId(messageId, chatId);
    if (!command) throw ApiError.notFound("no such message");
    if (command.status !== "pending" && command.status !== "submitted") {
      throw ApiError.conflict("already_settled", "message already settled");
    }
    if (command.invocation_id?.startsWith("sub:")) {
      const outcome = await chats.runtime.withdrawQueued(chatId, Number(command.invocation_id.slice(4)));
      if (outcome !== "aborted" && outcome !== "not_found") {
        throw ApiError.conflict("already_placed", "message already placed — refresh to see it delivered");
      }
    }
    await chats.turnCommands.settleCancelledById(messageId, chatId);
    return sendJson(reply, { withdrawn: true });
  };
  // Deprecated alias: DELETE /api/v1/gateway/chat/:id/pending/:messageId.
  app.delete("/api/v1/gateway/chat/:id/pending/:messageId", withdrawPending);
  app.delete("/api/v1/threads/:id/pending/:messageId", withdrawPending);

  app.post("/api/v1/threads/:id/pending/:messageId/steer", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const messageId = parseUuidParam(req, "messageId");
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    const command = await chats.turnCommands.byId(messageId, chatId);
    if (!command) throw ApiError.notFound("no such message");
    if (!command.invocation_id?.startsWith("sub:")) {
      throw ApiError.conflict("not_admitted", "message admission is still pending — retry shortly");
    }
    const changed = await chats.runtime.steerQueued(chatId, Number(command.invocation_id.slice(4)));
    if (!changed) throw ApiError.conflict("already_placed", "message already placed — refresh to see it delivered");
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
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    const body = requireJsonBody(req);
    if (typeof body["approved"] !== "boolean") {
      throw ApiError.badRequest("missing approved");
    }
    const approved = body["approved"];
    const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;

    // The call settles once. A recorded decision is echoed verbatim (late
    // clicks are idempotent). With a live turn, the decision is journaled
    // and the suspended approval gate picks it up within its poll interval.
    // With no live turn the call is orphaned: the expired marker is
    // journaled so a reload shows the settled card.
    const { row, appended } = await chats.threads.settleApproval(chatId, callId, (generating) =>
      generating
        ? {
            type: "approval_decision",
            call_id: callId,
            approved,
            ...(reason !== undefined ? { reason } : {}),
            expired: false,
          }
        : {
            type: "approval_decision",
            call_id: callId,
            approved: false,
            reason: APPROVAL_EXPIRED_REASON,
            expired: true,
          },
    );
    const decision = row.event as Extract<ThreadEventRow["event"], { type: "approval_decision" }>;
    if (appended && !decision.expired) {
      return sendJson(reply, sortedJson({ ok: true, settled: false }));
    }
    return reply.status(200).send(
      JSON.stringify(
        sortedJson({
          ok: true,
          settled: true,
          approved: decision.approved,
          reason: decision.reason ?? null,
          expired: decision.expired,
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
    await chats.chats.getOwnChat(user.org_id, chatId, user);
    const taskId = await chats.runtime.compactChat(chatId);
    // A thread_state whose seq is above this one was captured after the
    // task existed: its `compacting` flag reports this compaction, so a
    // client that sees it lowered before this answer arrives ends its line.
    const seq = await chats.threads.watermark();
    return reply.status(200).send({ ok: true, task_id: taskId, seq });
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
    const status = await compactionStatus(chats.pool, chatId, taskId);
    if (!status) throw ApiError.notFound("no such compaction");
    return reply.send(status);
  });
}
