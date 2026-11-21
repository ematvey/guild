// download: writes one file of this chat into a working folder. A chat file is
// an attachment or a tool result the server spilled; both are rows in object
// storage, and both are reachable by id or by filename. The destination is the
// call's environment — the chat's own, or a machine the call names.

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ConversationId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { attachmentObjectKey, type AttachmentStore } from "../platform/store/attachments.js";
import { toolArtifactObjectKey, type ToolArtifactStore } from "../platform/store/tool-artifacts.js";
import { relativeDestination, isProtectedMemoryPath } from "../platform/domain/paths.js";
import type { ObjectStore } from "../platform/s3.js";
import { withMachineTarget } from "./agent-tools.js";

export interface DownloadDeps {
  attachments: Pick<AttachmentStore, "reachableFromChat">;
  artifacts: Pick<ToolArtifactStore, "listForChat">;
  objects: Pick<ObjectStore, "get">;
  chatOfConversation(conversationId: ConversationId): Promise<string | null>;
  orgOfConversation(conversationId: ConversationId): Promise<string | null>;
  /** One call on a machine the chat's owner paired: the `machine` target of
   *  a download. It throws `MachineTargetError` when the call is not theirs
   *  to make. */
  machineEnv(conversationId: ConversationId, request: { machine: string; cwd?: string }): Promise<ExecutionEnv>;
}

/** One file this chat can download: an attachment or a spilled tool result. */
interface ChatFile {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Object-storage key of its bytes. */
  key: string;
}

/** One line per file, for the list and for the ambiguity errors. */
function describe(files: readonly ChatFile[]): string {
  return files
    .map((file) => `${file.id}  ${file.filename}  (${file.content_type}, ${file.size_bytes} bytes)`)
    .join("\n");
}

/** Every file of the chat, in one list: the user's and agents' attachments,
 *  then the tool results the server spilled. */
async function chatFiles(deps: DownloadDeps, orgId: string, chatId: string): Promise<ChatFile[]> {
  const [attachments, artifacts] = await Promise.all([
    deps.attachments.reachableFromChat(orgId, chatId),
    deps.artifacts.listForChat(orgId, chatId),
  ]);
  return [
    ...attachments.map((row) => ({
      id: row.id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      key: attachmentObjectKey(orgId, row.id, row.filename),
    })),
    ...artifacts.map((row) => ({
      id: row.id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      key: toolArtifactObjectKey(orgId, row.id, row.filename),
    })),
  ];
}

/** The file the call names, or the text that explains why none was chosen.
 *  An id wins; then an exact filename; then a unique part of one. */
function pick(files: readonly ChatFile[], wanted: string): ChatFile | string {
  const byId = files.find((file) => file.id === wanted);
  if (byId !== undefined) return byId;
  const exact = files.filter((file) => file.filename === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return `several files are named ${wanted}; pick one by id:\n${describe(exact)}`;
  const loose = files.filter((file) => file.filename.toLowerCase().includes(wanted.toLowerCase()));
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1) return `${wanted} matches several files; pick one by id:\n${describe(loose)}`;
  return `no file named ${wanted} in this chat`;
}

/** One file written into an environment: the caller's path, and where it
 *  resolved. */
export interface WrittenFile {
  path: string;
  absolute: string;
}

/** Writes bytes where the caller says, inside the working folder. The one
 *  place a tool puts a chat file into an environment: the download tool and
 *  the integration tools that carry bytes both come through here. */
export async function writeIntoEnv(
  env: ExecutionEnv,
  path: string,
  bytes: Uint8Array,
  context: Context,
  options: { overwrite?: boolean } = {},
): Promise<{ ok: true; value: WrittenFile } | { ok: false; reason: string }> {
  const destination = relativeDestination(path);
  if (!destination.ok) return { ok: false, reason: destination.reason };
  if (isProtectedMemoryPath(destination.path)) {
    return {
      ok: false,
      reason: "Protected memory must be reconciled with the read/edit/write tools. Download to another path first.",
    };
  }
  const absolute = getOrThrow(await env.absolutePath(destination.path, context));
  if (options.overwrite !== true) {
    const existing = await env.fileInfo(absolute, context);
    if (existing.ok) return { ok: false, reason: `${destination.path} already exists; pass overwrite: true` };
  }
  const written = await env.writeFile(absolute, bytes, context);
  if (!written.ok) return { ok: false, reason: `could not write ${destination.path}: ${written.error.message}` };
  return { ok: true, value: { path: destination.path, absolute } };
}

const fail = (message: string): ToolExecutionResult => ({
  output: [{ type: "text", text: message }],
  isError: true,
});

export function createDownloadTool(deps: DownloadDeps): ToolRegistration {
  return withMachineTarget(
    defineTool({
      name: "download",
      description:
        "Download one file of this chat into a working folder. A file is an attachment the user sent, or a large " +
        "tool result the server saved. `file` names it by id or by filename, and `path` is where it goes. Without " +
        "`machine` the file lands in the chat's own environment: the sandbox, or the project folder when the chat runs " +
        "on a machine. `machine` names a paired machine and `cwd` the folder on it.",
      parameters: Type.Object({
        file: Type.String({ description: "File id, or filename (exact, or a unique part of it)." }),
        path: Type.String({ description: "Destination path relative to the working folder." }),
        overwrite: Type.Optional(
          Type.Boolean({ description: "Replace the destination when it already exists. Default: false." }),
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
          const files = await chatFiles(deps, orgId, chatId);
          const picked = pick(files, args.file);
          if (typeof picked === "string") return fail(picked);
          const env = api.env;
          if (env === undefined) return fail("no execution environment is configured");
          const bytes = await deps.objects.get(picked.key);
          const written = await writeIntoEnv(env, args.path ?? "", bytes, context, {
            overwrite: args.overwrite === true,
          });
          if (!written.ok) return fail(written.reason);
          const target = written.value.path;
          const absolute = written.value.absolute;
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
    }),
    { envFor: (api, request) => deps.machineEnv(api.conversationId, request) },
  );
}
