// Per-turn attachment materialization: the bytes of the attachments on the
// inputs a turn takes are written under /tmp/attachments/<runId>/ in the
// sandbox. Object storage stays the truth; the directory is a turn-scoped
// cache, wiped at the start of the next turn. An input placed later in the
// turn (a steer, a child result) adds its files to the same directory.

import path from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { attachmentObjectKey, safeFilename, type AttachmentRow } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";

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

/** Wipes the previous turn's directory, then writes this turn's files. An
 *  empty attachment list still wipes, so a later turn cannot read the
 *  previous turn's files. Returns the directory when at least one file was
 *  written. */
export async function materializeTurnAttachments(args: MaterializeAttachmentsArgs): Promise<string | null> {
  const root = args.root ?? ATTACHMENTS_ROOT;
  const removed = await args.env.remove(root, { recursive: true, force: true }, args.context);
  if (!removed.ok) throw removed.error;
  if (args.rows.length === 0) return null;
  const dir = path.posix.join(root, args.runId);
  const created = await args.env.createDir(dir, { recursive: true }, args.context);
  if (!created.ok) throw created.error;
  await writeRows(args, dir);
  return dir;
}

/** Adds files to the turn's directory without wiping it: the attachments of
 *  an input placed after the turn's files were first written. */
export async function addTurnAttachments(args: MaterializeAttachmentsArgs): Promise<void> {
  if (args.rows.length === 0) return;
  const dir = path.posix.join(args.root ?? ATTACHMENTS_ROOT, args.runId);
  const created = await args.env.createDir(dir, { recursive: true }, args.context);
  if (!created.ok) throw created.error;
  await writeRows(args, dir);
}

async function writeRows(args: MaterializeAttachmentsArgs, dir: string): Promise<void> {
  for (const row of args.rows) {
    const bytes = await args.objects.get(attachmentObjectKey(args.orgId, row.id, row.filename));
    const name = safeFilename(row.filename) ?? row.id;
    const written = await args.env.writeFile(path.posix.join(dir, name), bytes, args.context);
    if (!written.ok) throw written.error;
  }
}
