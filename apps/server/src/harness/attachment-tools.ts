// download_attachment: writes one attachment of this chat, or a file one of
// its child results carries, from object storage into the conversation's
// execution environment. That environment is
// the chat's sandbox for a plain chat and the bound project folder for a
// machine-bound chat, so one tool delivers into both.

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ConversationId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { attachmentObjectKey, type AttachmentRow, type AttachmentStore } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";

/** Default destination folder, relative to the environment's working directory. */
const DEFAULT_DIR = "attachments";

export interface DownloadAttachmentDeps {
  attachments: Pick<AttachmentStore, "reachableFromChat">;
  objects: Pick<ObjectStore, "get">;
  chatOfConversation(conversationId: ConversationId): Promise<string | null>;
  orgOfConversation(conversationId: ConversationId): Promise<string | null>;
}

/** One line per attachment, for the error text that teaches the model what it
 *  can pick from. */
function describe(rows: readonly AttachmentRow[]): string {
  return rows.map((row) => `${row.id}  ${row.filename}  (${row.content_type}, ${row.size_bytes} bytes)`).join("\n");
}

/** The row the call names, or the text that explains why none was chosen. */
function pick(
  rows: readonly AttachmentRow[],
  id: string | undefined,
  filename: string | undefined,
): AttachmentRow | string {
  if (id !== undefined) {
    const byId = rows.find((row) => row.id === id);
    return byId ?? `no attachment with id ${id} in this chat`;
  }
  if (filename !== undefined) {
    const exact = rows.filter((row) => row.filename === filename);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return `several attachments are named ${filename}; pick one by id:\n${describe(exact)}`;
    const loose = rows.filter((row) => row.filename.toLowerCase().includes(filename.toLowerCase()));
    if (loose.length === 1) return loose[0]!;
    if (loose.length > 1) return `${filename} matches several attachments; pick one by id:\n${describe(loose)}`;
    return `no attachment named ${filename} in this chat`;
  }
  return `pass attachment_id or filename. This chat has:\n${describe(rows)}`;
}

/** The filename as one path segment: an uploaded name never chooses a folder. */
function leafName(filename: string): string {
  return filename.split(/[\\/]/).pop() || "attachment";
}

const fail = (message: string): ToolExecutionResult => ({
  output: [{ type: "text", text: message }],
  isError: true,
});

export function createDownloadAttachmentTool(deps: DownloadAttachmentDeps): ToolRegistration {
  return defineTool({
    name: "download_attachment",
    description:
      "Download an attachment of this chat, or a file a child thread's result carries, into the working folder. The " +
      "file is written into the chat's sandbox, or into the bound project folder when the chat runs on a machine. Pass " +
      "`filename` or `attachment_id`; call it with neither to list what this chat can download.",
    parameters: Type.Object({
      attachment_id: Type.Optional(Type.String({ description: "Attachment id from the list" })),
      filename: Type.Optional(
        Type.String({ description: "Filename of the attachment (exact, or a unique part of it)" }),
      ),
      path: Type.Optional(
        Type.String({
          description: `Destination path relative to the working folder. Default: ${DEFAULT_DIR}/<filename>`,
        }),
      ),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 4 * 1024 },
    execute: async (args, api, context) => {
      try {
        const chatId = await deps.chatOfConversation(api.conversationId);
        if (chatId === null) return fail("this conversation has no chat");
        const orgId = await deps.orgOfConversation(api.conversationId);
        if (orgId === null) return fail("this conversation has no org");
        const rows = await deps.attachments.reachableFromChat(orgId, chatId);
        if (rows.length === 0) return fail("this chat has no attachments");
        const picked = pick(rows, args.attachment_id, args.filename);
        if (typeof picked === "string") return fail(picked);
        const env = api.env;
        if (env === undefined) return fail("no execution environment is configured");
        const target = args.path ?? `${DEFAULT_DIR}/${leafName(picked.filename)}`;
        const absolute = getOrThrow(await env.absolutePath(target, context));
        const bytes = await deps.objects.get(attachmentObjectKey(orgId, picked.id, picked.filename));
        const written = await env.writeFile(absolute, bytes, context);
        if (!written.ok) throw written.error;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const details: JsonValue = {
          id: picked.id,
          filename: picked.filename,
          content_type: picked.content_type,
          size_bytes: bytes.length,
          sha256,
          path: target,
          absolute_path: absolute,
        };
        return {
          output: [
            {
              type: "text",
              text: `Saved ${picked.filename} (${bytes.length} bytes, ${picked.content_type}) to ${target}\nsha256: ${sha256}`,
            },
          ],
          details,
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
