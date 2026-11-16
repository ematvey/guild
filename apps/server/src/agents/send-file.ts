// send_file: snapshots one file of the call's environment into object storage
// and records an agent-authored attachment bound to the running turn. Turn end
// publishes the row onto the assistant event.

import { createHash } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { attachmentObjectKey, safeFilename, type AttachmentStore } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";
import { uuidv7 } from "../platform/time.js";
import type { Agent } from "./types.js";
import { relativeDestination } from "../platform/domain/paths.js";
import { contentTypeOf } from "../platform/domain/mime.js";
import { structured } from "../harness/tool-schema.js";
import { withMachineTarget } from "../harness/agent-tools.js";

const MAX_SEND_BYTES = 64 * 1024 * 1024;

export interface SendFileContext {
  attachments: Pick<AttachmentStore, "createAgentFile">;
  objects: Pick<ObjectStore, "put">;
  agent: Agent;
  chatId: string;
  /** One call on a machine the chat's owner paired: the `machine` target of
   *  a send. It throws `MachineTargetError` when the call is not theirs. */
  machineEnv(request: { machine: string; cwd?: string }): Promise<ExecutionEnv>;
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

/** Reads the file out of the call's environment, hashes it and uploads it,
 *  then inserts the pending attachment row. A failed upload throws here,
 *  inside the tool call, before the turn ends. */
export async function sendFile(
  context: SendFileContext,
  args: { path: string; as?: string },
  env: ExecutionEnv,
  callContext: Context,
): Promise<SendFileResult> {
  const rel = relativeDestination(args.path);
  if (!rel.ok) throw new SendFileError(rel.reason);
  const filename = safeFilename((args.as ?? path.posix.basename(rel.path)).trim());
  if (filename === null) throw new SendFileError("bad filename");
  const absolute = getOrThrow(await env.absolutePath(rel.path, callContext));
  // A link is refused: a link planted inside the sandbox never resolves here.
  const opened = await env.openBinaryReader(absolute, { noFollow: true }, callContext);
  if (!opened.ok) throw new SendFileError(`could not read ${rel.path}: ${opened.error.message}`);
  const reader = opened.value;
  let bytes: Buffer;
  try {
    const info = getOrThrow(await reader.info(callContext));
    if (info.size > MAX_SEND_BYTES) throw new SendFileError("file is larger than 64 MiB");
    const read = await reader.read(0, info.size, callContext);
    if (!read.ok) throw new SendFileError(`could not read ${rel.path}: ${read.error.message}`);
    bytes = Buffer.from(read.value);
  } finally {
    await reader.close(callContext);
  }
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
    sourcePath: rel.path,
  });
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    sha256,
    source_path: rel.path,
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
  output: [
    {
      type: "text",
      text: JSON.stringify({
        error: "send_file_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    },
  ],
  isError: true,
});

export function createSendFileTool(context: SendFileContext): ToolRegistration {
  return withMachineTarget(
    defineTool({
      name: "send_file",
      description:
        "Attach a file from a working folder to this turn's response. The file is read and uploaded immediately, so " +
        "later edits do not change what the user receives. `path` is relative to the working folder. Without " +
        "`machine` the file is read from the chat's own environment; `machine` names a paired machine and `cwd` the " +
        "folder on it.",
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file to send, relative to the working folder" }),
        as: Type.Optional(Type.String({ description: "Optional filename shown to the user" })),
      }),
      structuredOutputSchema: output,
      replay: "unsafe",
      callers: ["tools"],
      outputLimits: { maxBytes: 8 * 1024 },
      execute: async (args, api, callContext) => {
        try {
          const env = api.env;
          if (env === undefined) return errorResult(new SendFileError("no execution environment is configured"));
          const result = await sendFile(
            context,
            { path: args.path, ...(args.as === undefined ? {} : { as: args.as }) },
            env,
            callContext,
          );
          return { structuredOutput: structured(result) };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    { envFor: (_api, request) => context.machineEnv(request) },
  );
}
