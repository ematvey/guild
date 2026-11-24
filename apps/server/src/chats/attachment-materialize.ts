// Per-turn attachment materialization: the bytes of the attachments on the
// inputs a turn takes are written under /tmp/attachments/<runId>/ in the
// sandbox. Object storage stays the truth. Each active Run keeps its own
// cache, including files from later inputs. Finished Runs can be pruned
// using their durable status, including after executor restart.

import path from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { attachmentObjectKey, safeFilename, type AttachmentRow } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";
import { isUuid } from "../platform/time.js";

export const ATTACHMENTS_ROOT = "/tmp/attachments";

export interface MaterializeAttachmentsArgs {
  env: ExecutionEnv;
  objects: Pick<ObjectStore, "get">;
  orgId: string;
  runId: string;
  rows: readonly AttachmentRow[];
  context: Context;
  /** Test seam; production uses /tmp/attachments. */
  root?: string;
}

export function turnAttachmentDir(runId: string, root = ATTACHMENTS_ROOT): string {
  return path.posix.join(root, runId);
}

/** Writes a new batch into this Run's directory, preserving earlier inputs. */
export async function materializeTurnAttachments(args: MaterializeAttachmentsArgs): Promise<string | null> {
  if (args.rows.length === 0) return null;
  const root = args.root ?? ATTACHMENTS_ROOT;
  const dir = turnAttachmentDir(args.runId, root);
  await directoryExists(args.env, root, args.context);
  if (!(await directoryExists(args.env, dir, args.context))) {
    const created = await args.env.createDir(dir, { recursive: true }, args.context);
    if (!created.ok) throw created.error;
  }
  await writeRows(args, dir);
  return dir;
}

/** Reclaim a bounded batch of caches. Directory names are only candidates;
 *  a Run's durable state determines whether it can be removed. */
export async function pruneTurnAttachments(
  env: ExecutionEnv,
  context: Context,
  finishedRunIds: (ids: string[]) => Promise<string[]>,
  root = ATTACHMENTS_ROOT,
): Promise<void> {
  if (!(await directoryExists(env, root, context))) return;
  const opened = await env.openDirReader(root, context);
  if (!opened.ok) {
    if (opened.error.code === "not_found") return;
    throw opened.error;
  }
  const reader = opened.value;
  try {
    const page = await reader.next(64, context);
    if (!page.ok) throw page.error;
    const runIds = page.value.entries
      .filter((entry) => entry.kind === "directory" && isUuid(entry.name))
      .map((entry) => entry.name);
    if (runIds.length === 0) return;
    for (const runId of await finishedRunIds(runIds)) {
      const removed = await env.remove(turnAttachmentDir(runId, root), { recursive: true, force: true }, context);
      if (!removed.ok) throw removed.error;
    }
  } finally {
    await reader.close(context);
  }
}

async function directoryExists(env: ExecutionEnv, dir: string, context: Context): Promise<boolean> {
  const info = await env.fileInfo(dir, context);
  if (!info.ok) {
    if (info.error.code === "not_found") return false;
    throw info.error;
  }
  // fileInfo uses lstat. Never traverse a substituted attachment directory.
  if (info.value.kind !== "directory") throw new Error("Attachment cache path is not a directory");
  return true;
}

async function writeRows(args: MaterializeAttachmentsArgs, dir: string): Promise<void> {
  for (const row of args.rows) {
    const bytes = await args.objects.get(attachmentObjectKey(args.orgId, row.id, row.filename));
    const name = safeFilename(row.filename) ?? row.id;
    const written = await args.env.writeFile(path.posix.join(dir, name), bytes, args.context);
    if (!written.ok) throw written.error;
  }
}
