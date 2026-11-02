// Attachment endpoints:
// upload bytes into object storage and reference them from a chat.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import type { InfraContext } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { sortedJson } from "../domain/json.js";
import { parseUuidParam, requireUser, queryParam } from "./error.js";
import { attachmentObjectKey, safeFilename } from "../store/attachments.js";
import type { ChatStore } from "../store/chats.js";
import { uuidv7 } from "../time.js";

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** MIME type token pair, no parameters: keeps the stored value echo-safe in
 *  the download's Content-Type header. */
const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function safeContentType(raw: string): string {
  const value = raw.trim();
  if (value.length > 128 || !MIME_RE.test(value)) throw ApiError.badRequest("bad content type");
  return value.toLowerCase();
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  ctx: IdentityCtx,
  infra: InfraContext,
  chats: ChatStore,
): void {
  // Deprecated alias: /api/v1/chats/:chatId/attachments (the thread-domain
  // rename — /api/v1/threads/:chatId/attachments is primary).
  const uploadAttachment = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(ctx, req);
    const chatId = parseUuidParam(req, "chatId");
    const rawFilename = queryParam(req, "filename");
    const filename = rawFilename === undefined ? null : safeFilename(rawFilename);
    if (filename === null) throw ApiError.badRequest("bad filename");
    const contentType = safeContentType(queryParam(req, "content_type") ?? "application/octet-stream");
    // An upload writes into the conversation: the owner's alone.
    const chat = await chats.getOwnChat(user.org_id, chatId, user);
    const id = uuidv7();
    const key = attachmentObjectKey(user.org_id, id, filename);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : []);
    try {
      await infra.objects.put(key, bytes);
    } catch (error) {
      throw ApiError.internal(`object store write failed: ${(error as Error).message}`);
    }
    const row = await ctx.attachments.create(
      id,
      user.org_id,
      chat.id,
      user.id,
      filename,
      contentType,
      bytes.length,
      key,
    );
    return reply.status(200).send(sortedJson(row));
  };
  app.post("/api/v1/chats/:chatId/attachments", { bodyLimit: MAX_ATTACHMENT_BYTES }, uploadAttachment);
  app.post("/api/v1/threads/:chatId/attachments", { bodyLimit: MAX_ATTACHMENT_BYTES }, uploadAttachment);

  // Deprecated alias: GET /api/v1/chats/:chatId/attachments.
  const listAttachments = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(ctx, req);
    const chatId = parseUuidParam(req, "chatId");
    await chats.getChat(user.org_id, chatId, user);
    const rows = await ctx.attachments.list(user.org_id, chatId);
    return reply.status(200).send({ attachments: rows.map((r) => sortedJson(r)) });
  };
  app.get("/api/v1/chats/:chatId/attachments", listAttachments);
  app.get("/api/v1/threads/:chatId/attachments", listAttachments);

  app.get("/api/v1/attachments/:id", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const id = parseUuidParam(req, "id");
    const row = await ctx.attachments.get(user.org_id, id);
    // The attachment rides a chat, so the chat's read gate applies: org
    // scoping alone would let a member pull another member's uploads.
    await chats.getChat(user.org_id, row.chat_id, user);
    const key = attachmentObjectKey(row.org_id, row.id, row.filename);
    let bytes: Buffer;
    try {
      bytes = await infra.objects.get(key);
    } catch (error) {
      throw ApiError.internal(`object store read failed: ${(error as Error).message}`);
    }
    return reply
      .status(200)
      .type(row.content_type)
      .header("content-disposition", `attachment; filename="${row.filename}"`)
      .send(bytes);
  });
}
