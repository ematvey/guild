// Attachment endpoints:
// upload bytes into object storage and reference them from a chat.

import type { FastifyInstance } from "fastify";
import type { IdentityCtx } from "../contexts.js";
import type { InfraContext } from "../contexts.js";
import { ApiError, sortedJson } from "../errors.js";
import { parseUuidParam, requireUser } from "./error.js";
import { attachmentObjectKey, safeFilename } from "../store/attachments.js";
import { getChatOwned } from "../store/chats.js";
import { uuidv7 } from "../time.js";

function queryOne(req: { url: string }, name: string): string | undefined {
  const url = new URL(req.url, "http://local");
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

export function registerAttachmentRoutes(app: FastifyInstance, ctx: IdentityCtx, infra: InfraContext): void {
  app.post("/api/v1/chats/:chatId/attachments", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const chatId = parseUuidParam(req, "chatId");
    const rawFilename = queryOne(req, "filename");
    const filename = rawFilename === undefined ? null : safeFilename(rawFilename);
    if (filename === null) throw ApiError.badRequest("bad filename");
    const contentType = queryOne(req, "content_type") ?? "application/octet-stream";
    // chat must belong to the caller's org
    const chat = await getChatOwned(infra.pool, user.org_id, chatId, user);
    const id = uuidv7();
    const key = attachmentObjectKey(user.org_id, id, filename);
    const bytes = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === "string" ? req.body : []);
    try {
      await infra.objects.put(key, bytes);
    } catch (error) {
      throw ApiError.internal(`object store write failed: ${(error as Error).message}`);
    }
    const row = await ctx.attachments.create(
      id,
      user.org_id,
      chat.id,
      filename,
      contentType,
      bytes.length,
      key,
    );
    return reply.status(200).send(sortedJson(row));
  });

  app.get("/api/v1/chats/:chatId/attachments", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const chatId = parseUuidParam(req, "chatId");
    await getChatOwned(infra.pool, user.org_id, chatId, user);
    const rows = await ctx.attachments.list(user.org_id, chatId);
    return reply
      .status(200)
      .send({ attachments: rows.map((r) => sortedJson(r)) });
  });

  app.get("/api/v1/attachments/:id", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const id = parseUuidParam(req, "id");
    const row = await ctx.attachments.get(user.org_id, id);
    // The attachment rides a chat, so the chat's owner predicate applies:
    // org scoping alone would let a member pull another member's uploads.
    await getChatOwned(infra.pool, user.org_id, row.chat_id, user);
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
