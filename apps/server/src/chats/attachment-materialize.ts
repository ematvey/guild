// Per-turn attachment materialization: the bytes of the attachments on the
// inputs a turn takes are written under /tmp/attachments/<runId>/ in the
// sandbox. Object storage stays the truth. Each active Run keeps its own
// cache, including files from later inputs. Finished Runs can be pruned
// using their durable status, including after executor restart.

import path from "node:path";
import type { Context } from "@earendil-works/chord";
import type { DirReader, ExecutionEnv } from "@earendil-works/pi-durable/env";
import { attachmentObjectKey, safeFilename, type AttachmentRow } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";
import { isUuid } from "../platform/time.js";

export const ATTACHMENTS_ROOT = "/tmp/attachments";
const SWEEP_GRACE_MS = 5 * 60_000;

// A reader belongs to one sandbox connection. Closing the connection also
// closes its remote reader. A new executor starts an independent scan.
const sweeps = new WeakMap<ExecutionEnv, { root: string; reader: DirReader | null; busy: boolean }>();

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

/** Examine one directory page per Turn. Keep the cursor so live or recent
 *  entries on the first page do not hide reclaimable later pages. */
export async function pruneTurnAttachments(
  env: ExecutionEnv,
  context: Context,
  removableRunIds: (ids: string[], settledBefore: Date) => Promise<string[]>,
  root = ATTACHMENTS_ROOT,
): Promise<void> {
  const sweep = sweeps.get(env) ?? { root, reader: null, busy: false };
  if (sweep.busy) return;
  sweeps.set(env, sweep);
  sweep.busy = true;
  try {
    if (sweep.root !== root || !(await directoryExists(env, root, context))) {
      const reader = sweep.reader;
      sweep.root = root;
      sweep.reader = null;
      await reader?.close(context);
      return;
    }
    if (sweep.reader === null) {
      const opened = await env.openDirReader(root, context);
      if (!opened.ok) {
        if (opened.error.code === "not_found") return;
        throw opened.error;
      }
      sweep.reader = opened.value;
    }
    const reader = sweep.reader;
    const page = await reader.next(64, context);
    if (!page.ok || page.value.done) {
      sweep.reader = null;
      await reader.close(context);
    }
    if (!page.ok) throw page.error;

    const settledBefore = new Date(Date.now() - SWEEP_GRACE_MS);
    const candidates = new Map(
      page.value.entries
        .filter((entry) => entry.kind === "directory" && isUuid(entry.name) && entry.mtimeMs < settledBefore.getTime())
        .map((entry) => [entry.name, entry.mtimeMs]),
    );
    if (candidates.size === 0) return;
    for (const runId of await removableRunIds([...candidates.keys()], settledBefore)) {
      const dir = turnAttachmentDir(runId, root);
      const current = await env.fileInfo(dir, context);
      // A directory changed since the scan can belong to a fresh writer.
      if (!current.ok || current.value.kind !== "directory" || current.value.mtimeMs !== candidates.get(runId))
        continue;
      const removed = await env.remove(dir, { recursive: true, force: true }, context);
      if (!removed.ok) throw removed.error;
    }
  } finally {
    sweep.busy = false;
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
