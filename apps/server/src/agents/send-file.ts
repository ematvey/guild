// send_file: snapshots one workspace file into object storage and records an
// agent-authored attachment bound to the running turn. Turn end publishes the
// row onto the assistant event.

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { attachmentObjectKey, safeFilename, type AttachmentStore } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";
import { uuidv7 } from "../platform/time.js";
import type { Agent, AgentRun } from "./types.js";
import { resolveAgentReadPath } from "./files.js";

const MAX_SEND_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
};

function contentTypeOf(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export interface SendFileContext {
  attachments: Pick<AttachmentStore, "createAgentFile">;
  objects: Pick<ObjectStore, "put">;
  agent: Agent;
  run: AgentRun;
  chatId: string;
  /** The agent workspace volume as this process sees it. */
  workspaceRoot: string;
}

export interface SendFileResult {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  source_path: string;
}

export class SendFileError extends Error {}

/** Reads, hashes and uploads the file, then inserts the pending attachment
 *  row. A failed upload throws here, inside the tool call, before the turn
 *  ends. */
export async function sendFile(context: SendFileContext, args: { path: string; as?: string }): Promise<SendFileResult> {
  const { abs, rel } = await resolveAgentReadPath(context.workspaceRoot, context.agent.org_id, context.agent.id, args.path);
  if (rel === "") throw new SendFileError("path must name a file");
  const stats = await lstat(abs).catch(() => null);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) throw new SendFileError("not a regular file");
  if (Number(stats.size) > MAX_SEND_BYTES) throw new SendFileError("file is larger than 64 MiB");
  const filename = safeFilename((args.as ?? path.basename(rel)).trim());
  if (filename === null) throw new SendFileError("bad filename");
  const bytes = await readFile(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contentType = contentTypeOf(filename);
  const id = uuidv7();
  const key = attachmentObjectKey(context.agent.org_id, id, filename);
  await context.objects.put(key, bytes);
  const row = await context.attachments.createAgentFile({
    id,
    orgId: context.agent.org_id,
    chatId: context.chatId,
    filename,
    contentType,
    sizeBytes: bytes.length,
    objectKey: key,
    authorId: context.agent.id,
    sourcePath: rel,
  });
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    sha256,
    source_path: rel,
  };
}

const output = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  content_type: Type.String(),
  size_bytes: Type.Number(),
  sha256: Type.String(),
  source_path: Type.String(),
});

const errorResult = (error: unknown): ToolExecutionResult => ({
  output: [{ type: "text", text: JSON.stringify({ error: "send_file_failed", message: error instanceof Error ? error.message : String(error) }) }],
  isError: true,
});

export function createSendFileTool(context: SendFileContext): ToolRegistration {
  return defineTool({
    name: "send_file",
    description:
      "Attach a file from your workspace to this turn's response. The file is read and uploaded immediately, so later edits " +
      "do not change what the user receives. Use a path relative to your workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path of the file to send" }),
      as: Type.Optional(Type.String({ description: "Optional filename shown to the user" })),
    }),
    structuredOutputSchema: output,
    replay: "unsafe",
    callers: ["tools"],
    outputLimits: { maxBytes: 8 * 1024 },
    execute: async (args) => {
      try {
        const result = await sendFile(context, {
          path: args.path,
          ...(args.as === undefined ? {} : { as: args.as }),
        });
        return { structuredOutput: result as unknown as JsonValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
