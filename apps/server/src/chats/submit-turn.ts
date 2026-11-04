// Turn submission: validates a turn request, adopts or binds the chat's
// agent, resolves the route and project binding, journals the turn command,
// and submits the message to the durable conversation as a member-message
// input; its thread row is projected when the inbox places it.
// The thread routes (POST /api/v1/threads/:id/turns and its
// /api/v1/gateway/chat alias) and the agent turn routes share it.

import type { ChatsCtx, GatewayCtx, IdentityCtx } from "../platform/route-contexts.js";
import type { ObjectStore } from "../platform/s3.js";
import { ApiError } from "../platform/errors.js";
import { sortedJson } from "../platform/domain/json.js";
import { isUuid, uuidv7 } from "../platform/time.js";
import type { MessageAttachment } from "../platform/domain/thread-events.js";
import { modalityOf } from "../platform/domain/mime.js";
import type { UserRow } from "../platform/store/identity.js";
import type { ChatRow } from "../platform/store/chats.js";
import { ThreadAgentLocked } from "../harness/runtime.js";
import { buildTurnText, loadMediaMap } from "./turn-text.js";
import { memberMessageEntry } from "./member-message.js";

export async function submitTurn(
  chats: ChatsCtx,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
  user: UserRow,
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
  const chatIdRaw: unknown = pathChatId ?? body["chat_id"];
  if (chatIdRaw === undefined) throw ApiError.badRequest("chat_id is required");
  if (typeof chatIdRaw !== "string" || !isUuid(chatIdRaw)) throw ApiError.badRequest("chat_id must be a UUID");
  if (body["model"] === undefined) throw ApiError.badRequest("model is required");
  if (typeof body["model"] !== "string") throw ApiError.badRequest("model must be a string");
  if (body["messages"] === undefined) throw ApiError.badRequest("messages is required");
  if (!Array.isArray(body["messages"])) throw ApiError.badRequest("messages must be an array");
  if (body["server_workspace"] !== undefined && body["server_workspace"] !== null) {
    throw ApiError.badRequest("server_workspace is reserved for workspace agent sessions");
  }

  const chatId = chatIdRaw.toLowerCase();
  // Every conversation belongs to an agent. A plain chat is adopted by the
  // caller's personal agent on its first turn; from then on the turn runs
  // with the agent's model and tools, and the run lifecycle closes the run.
  const chat = preloadedChat ?? (await chats.chats.getOwnChat(user.org_id, chatId, user));
  const requestedAgent = typeof body["agent_id"] === "string" ? body["agent_id"] : null;
  const messages = body["messages"] as { role?: unknown; content?: unknown }[];
  if (body["client_tools"] !== undefined && typeof body["client_tools"] !== "boolean") {
    throw ApiError.badRequest("client_tools must be a boolean");
  }
  if (body["send_mode"] !== undefined && body["send_mode"] !== null && typeof body["send_mode"] !== "string") {
    throw ApiError.badRequest("send_mode must be a string");
  }

  const commandId =
    body["user_message_id"] === undefined || body["user_message_id"] === null
      ? uuidv7()
      : validateUuid(String(body["user_message_id"]));
  // The idempotency check runs before any binding: a duplicate delivery must
  // not move the chat to another agent, change the project binding or steer
  // another running command. The material is the request as sent (requested
  // model and agent), so it does not depend on what the binding resolves.
  const request = canonicalChatRequest(body, chatId, commandId);
  const existing = await chats.turnCommands.existing(commandId, user.org_id, user.id, chatId, request);
  if (existing) return commandAck(existing);

  const adopted =
    requestedAgent === null
      ? await chats.runtime.adoptChatAgent(chatId, user.org_id, user.id, chat.title ?? "")
      : await chats.runtime
          .bindChatAgent(chatId, user.id, requestedAgent, chat.title ?? "", user)
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

  const userMessage = [...messages].reverse().find((m) => m?.role === "user")?.content ?? "";
  const userMessageText = typeof userMessage === "string" ? userMessage : "";
  if (userMessageText === "" && userMessage !== "") {
    // Non-string content blocks: not part of the chat turn contract (the
    // desktop sends plain text; media rides on attachments).
    throw ApiError.badRequest("message content must be a string");
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
    // A missing route fails later at submission time; the visible message must
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
  // Reserve "generating" before the submission: a capture taken in the
  // pre-turn window must already say generating, or its socket delivery
  // lands after the HTTP response and clobbers the client's optimistic busy
  // (the Working indicator blinks off). A failed accept or submit recomputes
  // the flag from durable work, so it never clears a turn another request
  // started meanwhile.
  await chats.chats.reserveGenerating(user.org_id, chatId);
  const sendMode =
    body["send_mode"] === "steer" ? ("steer" as const) : body["send_mode"] === "queue" ? ("queue" as const) : undefined;
  let command;
  try {
    command = await chats.turnCommands.accept(commandId, user.org_id, user.id, chatId, request, payload);
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
      // The thread row is projected from this entry when the inbox places
      // the message; until then it is in the chat's queue.
      entry: memberMessageEntry({ message_id: commandId, text: content, attachments: chips }),
    });
    await chats.turnCommands.submitted(commandId, `sub:${submissionId}`);
    // Name the thread from the first message while the turn runs; the run
    // lifecycle retries once if this call fails.
    if (adopted !== null && (chat.title ?? "").trim() === "") {
      void chats.runtime.generateThreadTitle(chatId, adopted.thread_id).catch(() => {});
    }
  } catch (error) {
    // The delivery failed after the accept committed. A turn the
    // conversation admitted stands (the failure came after it); one it never
    // admitted leaves the thread with its command, so the thread shows only
    // what the agent has and a retry under the same id starts over.
    const admitted = await chats.runtime.discardUnsent(chatId, commandId).catch(() => undefined);
    if (admitted === undefined) await chats.turnCommands.failUnsubmitted(commandId).catch(() => {});
    if (admitted === undefined || admitted === null) {
      await chats.chats.reconcileGenerating(user.org_id, chatId).catch(() => {});
      throw error;
    }
    await chats.turnCommands.submitted(commandId, `sub:${admitted}`);
  }
  await chats.chats.reconcileGenerating(user.org_id, chatId);
  const refreshed = await chats.turnCommands.existing(commandId, user.org_id, user.id, chatId, request);
  // An admitted turn implies the accept committed, so `command` is set.
  return commandAck(refreshed ?? command!);
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

/** The request in canonical form (fixed field order, defaults filled,
 *  absent optionals skipped) — the turn-command idempotency material. A
 *  retry with the same id must produce identical material. The model is the
 *  one requested, not the one the agent binding resolves, and the requested
 *  agent rides along, so the same id sent to another agent conflicts. */
function canonicalChatRequest(body: Record<string, unknown>, chatId: string, commandId: string): unknown {
  const messages = (body["messages"] as unknown[] | undefined)?.map((m) => sortedJson(m)) ?? [];
  const out: Record<string, unknown> = {};
  // The resolved id (client-sent or minted) always rides the material.
  out.user_message_id = commandId;
  out.chat_id = chatId;
  out.model = body["model"];
  if (typeof body["agent_id"] === "string") out.agent_id = body["agent_id"].toLowerCase();
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

function validateUuid(value: string): string {
  if (!isUuid(value)) throw ApiError.badRequest("invalid uuid");
  return value.toLowerCase();
}

/** An optional UUID body field, lowercased (null when absent). */
export function optionalUuidField(body: Record<string, unknown>, field: string): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  return validateUuid(String(raw));
}

function optionalUuidArrayField(body: Record<string, unknown>, field: string): string[] {
  const raw = body[field];
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => validateUuid(String(id)));
}
