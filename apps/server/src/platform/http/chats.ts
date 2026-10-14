// Chat routes: chat CRUD + thread read/append + approval override + read
// markers +
// project binding, and the gateway turn-submission routes (POST
// /api/v1/gateway/chat → a pi-durable submission; stop/compact/approval
// decision). The machines routes stay proxied until the hub lane (M5): the
// connection dot and fs dispatch need the real machine registry.
//
// Chat events stream over the member WS in the Rust server (ThreadState /
// SyncBegin / LiveFrame frames); M5 owns that socket. The additive SSE
// endpoint below (GET /api/v1/chats/{id}/thread/stream) serves the same
// ThreadState frames from the pi-durable watch — the M5 lane reuses the
// frame builders for the byte-compat member socket.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ChatsCtx, GatewayCtx, IdentityCtx } from "../contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError, DESERIALIZE_PREFIX, RAW_BODY, TextError, sortedJson } from "../errors.js";
import { parseUuidParam, queryParam, requireJsonBody, requireUser } from "./error.js";
import { uuidv7 } from "../time.js";
import { threadEventRowWire, threadEventWire, type MessageAttachment, type ThreadEventRow } from "../domain/thread-events.js";
import { buildTurnText, loadMediaMap } from "../../chats/turn-text.js";
import type { UserRow } from "../store/identity.js";
import { modalityOf } from "../../chats/turn-text.js";

// ---------------------------------------------------------------------------
// Wire shapes (serde field order / skip rules)
// ---------------------------------------------------------------------------

/** The hub-aware online flag for a chat row's bound machine — the same
 *  truth threadListSnapshot (ws push) and GET /api/v1/machines use. Null
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
  unread?: boolean;
  project_id: string | null;
  project_name?: string | null;
  project_machine_label?: string | null;
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
  out.unread = row.unread ?? false;
  if (row.project_id !== null) out.project_id = row.project_id;
  if (row.project_name) out.project_name = row.project_name;
  if (row.project_machine_label) out.project_machine_label = row.project_machine_label;
  out.machine_online = row.machine_online ?? false;
  return out;
}

/** The thread list rows (http/feed.rs thread_list) — hub-aware online
 *  flags, identical to the ws push's threadListSnapshot. */
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
      unread: row.unread,
      project_id: row.project_id,
      project_name: row.project_name,
      project_machine_label: row.project_machine_label,
      machine_online: machineOnlineOf(chats, row),
    }),
  );
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
  app.post("/api/v1/chats", async (req, reply) => {
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
    return reply.status(200).send(chatWire({ ...chat, unread: false, machine_online: machineOnlineOf(chats, chat) }));
  });

  app.get("/api/v1/chats", async (req, reply) => {
    const user = await requireUser(auth, req);
    const archived = ["1", "true"].includes(queryParam(req, "archived") ?? "");
    const list = await threadList(chats, user.org_id, user.id, archived);
    return reply.status(200).send(JSON.stringify({ chats: list }));
  });

  app.get("/api/v1/chats/:id/thread", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    return reply.status(200).type("application/json").send(await threadBody(chats, gateway, user, chatId));
  });

  app.post("/api/v1/chats/:id/thread", async (req, reply) => {
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
  });

  app.post("/api/v1/chats/:id/project", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const raw = body["project_id"];
    const projectId = typeof raw === "string" && raw !== "" ? validateUuid(raw) : null;
    const chat = await chats.chats.setProject(user.org_id, chatId, user, projectId);
    return reply.status(200).send(chatWire({ ...chat, machine_online: machineOnlineOf(chats, chat) }));
  });

  app.get("/api/v1/chats/:id/approval", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    const approval = await chats.chats.approval(user.org_id, user.id, chatId);
    return reply.status(200).send(JSON.stringify({ default: approval?.default ?? null }));
  });

  app.post("/api/v1/chats/:id/approval", async (req, reply) => {
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
  });

  app.post("/api/v1/chats/:id/read", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.markRead(user.org_id, chatId, user);
    return reply.status(200).send(JSON.stringify({ ok: true }));
  });

  app.patch("/api/v1/chats/:id", async (req, reply) => {
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
      // Archiving must also end any in-flight generation, or an archived
      // chat keeps spinning where the user can no longer reach it.
      await chats.runtime.stopChat(chatId).catch(() => {});
      await chats.turnCommands.cancelAllWaiting(chatId);
    }
    return reply.status(200).send(chatWire({ ...chat, unread: false, machine_online: machineOnlineOf(chats, chat) }));
  });

  // --- Gateway chat commands (the M3 flip of gateway.rs's chat half) ---

  app.post("/api/v1/gateway/chat", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    return reply.status(200).type("application/json").send(await submitTurn(chats, gateway, auth, objects, user, req, body));
  });

  app.post("/api/v1/gateway/chat/:id/stop", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    await chats.turnCommands.cancelWaitingHead(chatId);
    await chats.runtime.stopChat(chatId);
    return reply.status(200).send(JSON.stringify({ stopped: true }));
  });

  app.post("/api/v1/gateway/chat/:id/approvals/*", async (req, reply) => {
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
  });

  app.post("/api/v1/gateway/chat/:id/compact", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "id");
    await chats.chats.getChat(user.org_id, chatId, user);
    await chats.runtime.compactChat(chatId);
    return reply.status(200).send(JSON.stringify({ ok: true }));
  });
}

// ---------------------------------------------------------------------------
// Turn submission (the submit_turn core)
// ---------------------------------------------------------------------------

async function submitTurn(
  chats: ChatsCtx,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
  user: UserRow,
  req: FastifyRequest,
  body: Record<string, unknown>,
): Promise<string> {
  // Required fields (serde rejection text, line/column = raw body length).
  const rawLength = ((req as never as Record<symbol, string>)[RAW_BODY]?.length as number | undefined) ?? 0;
  void rawLength;
  const chatIdRaw = body["chat_id"];
  if (chatIdRaw === undefined) throw missingField(req, "chat_id");
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
  const model = body["model"] as string;
  const messages = body["messages"] as { role?: unknown; content?: unknown }[];
  if (body["client_tools"] !== undefined && typeof body["client_tools"] !== "boolean") {
    throw invalidTypeText(req, "client_tools");
  }
  if (body["send_mode"] !== undefined && body["send_mode"] !== null && typeof body["send_mode"] !== "string") {
    throw invalidTypeText(req, "send_mode");
  }

  // Org scoping: the chat must belong to the caller's org.
  const chat = await chats.chats.getChat(user.org_id, chatId, user);

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
  let command;
  try {
    command = await chats
      .turnCommands
      .accept(commandId, user.org_id, user.id, chatId, request, payload, { content, attachments: chips });
    const submissionId = await chats.runtime.submitTurn(chatId, user.org_id, {
      orgId: user.org_id,
      requestId: commandId,
      content,
      images,
      model,
      ...(skillsIndex !== undefined ? { skillsIndex } : {}),
    });
    await chats.turnCommands.submitted(commandId, `sub:${submissionId}`);
  } catch (error) {
    await chats.chats.setGenerating(user.org_id, chatId, priorGenerating);
    throw error;
  }
  await chats.chats.setGenerating(user.org_id, chatId, true);
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
