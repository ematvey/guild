// Server-side file access inside an agent workspace. The agent's sandbox
// writes the same volume the server reads, so every path under a workspace
// is hostile: any segment may be a symlink, the file may be a device or a
// FIFO, and a segment may be swapped between a check and an open.
//
// Every open here walks the parent segments with lstat (no symlinks, only
// directories), opens the final segment with O_NOFOLLOW|O_NONBLOCK, then
// proves the opened descriptor is a regular file whose real path is inside
// the workspace root (via /proc/self/fd/N on Linux, the path elsewhere).
// Reads are capped in bytes.

import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type WorkspaceFsReason = "bad_path" | "not_found" | "symlink" | "not_file" | "escape" | "too_large";

export class WorkspaceFsError extends Error {
  constructor(
    readonly reason: WorkspaceFsReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFsError";
  }
}

const fail = (reason: WorkspaceFsReason, message: string): never => {
  throw new WorkspaceFsError(reason, message);
};

/** Splits a workspace-relative path into segments: no absolute paths, no
 *  `..`, no NUL bytes, at least one segment. */
function segmentsOf(rel: string): string[] {
  if (rel.includes("\u0000")) fail("bad_path", "path contains a NUL byte");
  if (rel.startsWith("/")) fail("bad_path", "absolute paths are not allowed");
  const parts = rel.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) fail("bad_path", "parent traversal is not allowed");
  if (parts.length === 0) fail("bad_path", "path must name a file");
  return parts;
}

async function realRootOf(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return fail("not_found", "no such path");
  }
}

function inside(realRoot: string, candidate: string): boolean {
  return candidate.startsWith(realRoot + path.sep);
}

/** Walks the directory segments under the root with lstat. A symlink or a
 *  non-directory refuses the path; an absent segment is created when
 *  `create` is set and refuses it otherwise. */
async function walkParents(root: string, dirs: string[], create: boolean): Promise<string> {
  let current = root;
  for (const segment of dirs) {
    current = path.join(current, segment);
    let stats = await lstat(current).catch(() => null);
    if (stats === null && create) {
      await mkdir(current).catch((error: { code?: string }) => {
        if (error.code !== "EEXIST") throw error;
      });
      stats = await lstat(current).catch(() => null);
    }
    if (stats === null) fail("not_found", "no such path");
    if (stats!.isSymbolicLink()) fail("symlink", "symlink paths are not followed");
    if (!stats!.isDirectory()) fail("not_found", "no such path");
  }
  return current;
}

/** The real path of an open descriptor. */
async function realPathOfHandle(handle: FileHandle, abs: string): Promise<string> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    return realpath(abs);
  }
}

/** Proves the descriptor is a regular file inside the root; closes it and
 *  throws otherwise. */
async function verifyOpened(handle: FileHandle, realRoot: string, abs: string): Promise<Stats> {
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) fail("not_file", "not a regular file");
    const real = await realPathOfHandle(handle, abs).catch(() => fail("not_found", "no such path"));
    if (!inside(realRoot, real)) fail("escape", "path escapes the agent workspace");
    return stats;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === "ELOOP" || code === "EMLINK") fail("symlink", "symlink paths are not followed");
  if (code === "ENOENT" || code === "ENOTDIR") fail("not_found", "no such path");
  if (code === "ENXIO") fail("not_file", "not a regular file");
  if (code === "EISDIR") fail("not_file", "not a regular file");
  throw error;
}

export interface OpenedWorkspaceFile {
  handle: FileHandle;
  stats: Stats;
}

/** Opens a regular file under the root for reading. The caller closes the
 *  handle. */
export async function openWorkspaceFile(root: string, rel: string): Promise<OpenedWorkspaceFile> {
  const segments = segmentsOf(rel);
  const realRoot = await realRootOf(root);
  const parent = await walkParents(root, segments.slice(0, -1), false);
  const abs = path.join(parent, segments.at(-1)!);
  const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(openError);
  const stats = await verifyOpened(handle, realRoot, abs);
  return { handle, stats };
}

export interface WorkspaceRead {
  bytes: Buffer;
  stats: Stats;
  /** The file is larger than the cap and `bytes` is its head. */
  truncated: boolean;
}

/** Reads a regular file under the root, at most `maxBytes`. With
 *  `overflow: "refuse"` a larger file throws `too_large`; with "truncate"
 *  the head is returned and `truncated` is set. */
export async function readWorkspaceFile(
  root: string,
  rel: string,
  options: { maxBytes: number; overflow: "refuse" | "truncate" },
): Promise<WorkspaceRead> {
  const { handle, stats } = await openWorkspaceFile(root, rel);
  try {
    const size = Number(stats.size);
    if (size > options.maxBytes && options.overflow === "refuse") {
      fail("too_large", `file is larger than ${options.maxBytes} bytes`);
    }
    const want = Math.min(size, options.maxBytes);
    const buffer = Buffer.alloc(want);
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await handle.read(buffer, filled, want - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { bytes: buffer.subarray(0, filled), stats, truncated: size > options.maxBytes };
  } finally {
    await handle.close();
  }
}

/** Writes a regular file under the root, creating absent parent directories.
 *  With `exclusive` an existing entry (file, symlink or anything else) is
 *  left alone and the call returns false. A symlink at any segment refuses
 *  the write. */
export async function writeWorkspaceFile(
  root: string,
  rel: string,
  data: string | Buffer,
  options: { exclusive?: boolean } = {},
): Promise<boolean> {
  const segments = segmentsOf(rel);
  const realRoot = await realRootOf(root);
  const parent = await walkParents(root, segments.slice(0, -1), true);
  const abs = path.join(parent, segments.at(-1)!);
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    (options.exclusive === true ? constants.O_EXCL : 0);
  let handle: FileHandle;
  try {
    handle = await open(abs, flags, 0o644);
  } catch (error) {
    if (options.exclusive === true && (error as { code?: string }).code === "EEXIST") return false;
    return openError(error);
  }
  await verifyOpened(handle, realRoot, abs);
  try {
    await handle.truncate(0);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return true;
}

/** Creates a directory (and absent parents) under the root, refusing any
 *  symlink segment. */
export async function ensureWorkspaceDir(root: string, rel: string): Promise<void> {
  const segments = segmentsOf(rel);
  await realRootOf(root);
  await walkParents(root, segments, true);
}
