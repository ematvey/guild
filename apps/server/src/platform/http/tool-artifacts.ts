// Tool-artifact endpoints: download spilled tool results and list a chat's
// artifacts — symmetric to the attachments endpoints. Clients never hold S3 credentials; the local engine fetches
// through GET /api/v1/tool_artifacts/{id}.

import type { FastifyInstance } from "fastify";
import type { ChatsCtx, IdentityCtx, InfraContext } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { sortedJson } from "../domain/json.js";
import { parseUuidParam, queryParam, requireUser, sendJson } from "./error.js";
import { contentDisposition } from "../domain/mime.js";
import { previewReply, verifyPreviewLink } from "./preview-link.js";
import { toolArtifactObjectKey } from "../store/tool-artifacts.js";
import type { UserRow } from "../store/identity.js";

export function registerToolArtifactRoutes(
  app: FastifyInstance,
  chats: ChatsCtx,
  auth: IdentityCtx,
  infra: InfraContext,
): void {
  /** Lists a chat's artifacts: the machine-originated fetch path (the chat's
   *  executor machine — an org-shared machine serves chats it does not own)
   *  reads beside the owner/admin gate. */
  app.get("/api/v1/chats/:chatId/tool_artifacts", async (req, reply) => {
    const user = await requireUser(auth, req);
    const chatId = parseUuidParam(req, "chatId");
    await readableByExecutor(chats, user.org_id, chatId, user);
    const rows = await chats.toolArtifacts.listForChat(user.org_id, chatId);
    // Rows render with sorted keys at every level.
    return sendJson(
      reply,
      rows.map((r) => sortedJson(r)),
    );
  });

  app.get("/api/v1/tool_artifacts/:id", async (req, reply) => {
    const id = parseUuidParam(req, "id");
    const signed = queryParam(req, "preview");
    if (signed !== undefined) {
      verifyPreviewLink(auth.config.jwtSecret, "artifact", id, signed);
      const row = await chats.toolArtifacts.getById(id);
      const key = toolArtifactObjectKey(row.org_id, row.id, row.filename);
      return previewReply(reply, await infra.objects.get(key), row);
    }
    const user = await requireUser(auth, req);
    // Org-scoped: a foreign org's artifact 404s here.
    const row = await chats.toolArtifacts.get(user.org_id, id);
    // The artifact rides a chat, so the chat's owner predicate applies (the
    // same check as the attachments download); the chat's executor machine
    // also reads — spill prefetch and first-touch fetch.
    await readableByExecutor(chats, user.org_id, row.chat_id, user);
    const key = toolArtifactObjectKey(row.org_id, row.id, row.filename);
    let bytes: Buffer;
    try {
      bytes = await infra.objects.get(key);
    } catch (error) {
      throw ApiError.internal(`object store read failed: ${String(error)}`);
    }
    const mode = queryParam(req, "inline") === "1" ? "inline" : "attachment";
    return reply
      .status(200)
      .type(row.content_type)
      .header("content-disposition", contentDisposition(row.filename, mode))
      .header("x-content-type-options", "nosniff")
      .send(bytes);
  });
}

/** The chat's bound machine (project machine first, else the chat's) reads
 *  with its owner's member token; everyone else passes the chat's read
 *  gate. */
async function readableByExecutor(chats: ChatsCtx, orgId: string, chatId: string, user: UserRow): Promise<void> {
  const machineId = await chats.chats.executorMachineOf(orgId, chatId);
  if (machineId !== null) {
    try {
      const owner = await chats.machines.ownerOf(machineId);
      if (owner !== null && owner[0] === user.id && owner[1] === orgId) return;
    } catch (error) {
      chats.sockets.log(`machine read gate failed for ${machineId}: ${String(error)}`);
    }
  }
  await chats.chats.getChat(orgId, chatId, user);
}
