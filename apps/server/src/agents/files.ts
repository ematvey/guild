// Read-only file browser over one agent's workspace subtree:
// <agentWorkspaceRoot>/agents/<orgId>/<agentId>. Paths are relative,
// containment is checked after realpath, and symlinks are opaque — listed
// with their flag but never traversed.

import { Readable } from "node:stream";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../platform/errors.js";
import { agentWorkspaceDir } from "./workspace-config.js";
import { openWorkspaceFile, readWorkspaceFile, WorkspaceFsError } from "./workspace-fs.js";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const HIDDEN_NAMES = new Set([".guild", ".git", "node_modules"]);

export interface AgentFileEntry {
  name: string;
  /** Path relative to the agent workspace root (POSIX separators). */
  path: string;
  kind: "file" | "dir" | "other";
  size: number;
  mtime: string;
  symlink: boolean;
}

export interface AgentDirListing {
  /** Directory that the entries belong to. */
  path: string;
  entries: AgentFileEntry[];
  /** Set when the requested path named a file: the entries are its parent
   *  folder, and this is the file's own path. */
  file?: string;
}

export interface AgentTextFile {
  path: string;
  size: number;
  mtime: string;
  text: string;
}

export interface AgentDownload {
  name: string;
  size: number;
  mtime: string;
  stream: Readable;
}

function badPath(message = "invalid path"): ApiError {
  return ApiError.badRequest(message);
}

/** Maps a workspace-fs refusal onto the route's errors: a missing path is a
 *  404, every other refusal a 400. */
function apiErrorOf(error: unknown, tooLarge: string): unknown {
  if (!(error instanceof WorkspaceFsError)) return error;
  switch (error.reason) {
    case "not_found":
      return ApiError.notFound("no such path");
    case "too_large":
      return badPath(tooLarge);
    case "not_file":
      return badPath("not a file");
    default:
      return badPath(error.message);
  }
}

/** Relative path from the query string: rejects absolute paths, `..`
 *  segments and NUL bytes. */
export function normalizeRelativePath(input: string | undefined): string {
  const raw = (input ?? "").replaceAll("\\", "/");
  if (raw.includes("\u0000")) throw badPath("path contains a NUL byte");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw badPath("absolute paths are not allowed");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw badPath("parent traversal is not allowed");
    parts.push(part);
  }
  return parts.join("/");
}

function kindOf(stats: { isDirectory(): boolean; isFile(): boolean }): AgentFileEntry["kind"] {
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

function entryFor(rel: string, stats: Awaited<ReturnType<typeof lstat>>, symlink: boolean): AgentFileEntry {
  return {
    name: path.basename(rel),
    path: rel,
    kind: symlink ? "other" : kindOf(stats),
    size: Number(stats.size),
    mtime: stats.mtime.toISOString(),
    symlink,
  };
}

/** Resolves the root and proves it exists. */
async function realRootOf(root: string): Promise<string> {
  return realpath(root).catch(() => {
    throw ApiError.notFound("no such path");
  });
}

/** Proves the real path stays under the resolved root. Callers run it only
 *  after the symlink check, so a symlink can never redirect the read. */
async function assertContained(realRoot: string, abs: string): Promise<void> {
  const realAbs = await realpath(abs).catch(() => {
    throw ApiError.notFound("no such path");
  });
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw badPath("path escapes the agent workspace");
  }
}

/** Refuses any path whose segments include a symlink. */
async function assertNoSymlink(root: string, rel: string): Promise<void> {
  if (rel === "") return;
  let current = root;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      throw ApiError.notFound("no such path");
    }
    if (stats.isSymbolicLink()) throw badPath("symlink paths are not followed");
  }
}

/** Resolves a relative path inside one agent workspace under the read policy:
 *  lexical containment, no symlink on any segment, and a real path under the
 *  resolved root. */
export async function resolveAgentReadPath(
  workspaceRoot: string,
  orgId: string,
  agentId: string,
  relPath: string | undefined,
): Promise<{ root: string; realRoot: string; rel: string; abs: string }> {
  const rel = normalizeRelativePath(relPath);
  const root = agentWorkspaceDir(workspaceRoot, orgId, agentId);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw badPath("path escapes the agent workspace");
  const realRoot = await realRootOf(root);
  await assertNoSymlink(root, rel);
  await assertContained(realRoot, abs);
  return { root, realRoot, rel, abs };
}

export class AgentFiles {
  constructor(private readonly workspaceRoot: string) {}

  private rootFor(orgId: string, agentId: string): string {
    return agentWorkspaceDir(this.workspaceRoot, orgId, agentId);
  }

  /** Resolves a relative path inside the agent root (lexical containment)
   *  and resolves the root itself. The final segment may be a symlink: the
   *  metadata reads report it instead of following it. */
  private async resolvePath(orgId: string, agentId: string, relPath: string | undefined): Promise<{
    root: string;
    realRoot: string;
    rel: string;
    abs: string;
  }> {
    const rel = normalizeRelativePath(relPath);
    const root = this.rootFor(orgId, agentId);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw badPath("path escapes the agent workspace");
    const realRoot = await realRootOf(root);
    return { root, realRoot, rel, abs };
  }

  async listDir(orgId: string, agentId: string, relPath?: string, showHidden = false): Promise<AgentDirListing> {
    // An agent that has not run yet has no directory on the volume: that is
    // an empty workspace, not an error. The sandbox creates the directory on
    // the agent's first turn.
    const rootDir = this.rootFor(orgId, agentId);
    const present = await lstat(rootDir).catch(() => null);
    if (present === null) {
      const rel = normalizeRelativePath(relPath);
      if (rel !== "") throw ApiError.notFound("no such path");
      return { path: "", entries: [] };
    }
    const { root, realRoot, rel, abs } = await resolveAgentReadPath(this.workspaceRoot, orgId, agentId, relPath);
    const target = await lstat(abs).catch(() => {
      throw ApiError.notFound("no such path");
    });
    // A file path lists the folder that holds it, so one request answers both
    // "which folder am I in" and "what sits next to this file".
    if (!target.isDirectory()) {
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const parentAbs = path.dirname(abs);
      await assertNoSymlink(root, parentRel);
      await assertContained(realRoot, parentAbs);
      return { path: parentRel, entries: await this.entriesOf(parentAbs, parentRel, showHidden), file: rel };
    }
    return { path: rel, entries: await this.entriesOf(abs, rel, showHidden) };
  }

  private async entriesOf(dir: string, rel: string, showHidden: boolean): Promise<AgentFileEntry[]> {
    const names = await readdir(dir);
    const entries: AgentFileEntry[] = [];
    for (const name of names) {
      if (!showHidden && (name.startsWith(".") || HIDDEN_NAMES.has(name))) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childAbs = path.join(dir, name);
      const stats = await lstat(childAbs);
      entries.push(entryFor(childRel, stats, stats.isSymbolicLink()));
    }
    entries.sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async statPath(orgId: string, agentId: string, relPath?: string): Promise<AgentFileEntry> {
    const { root, realRoot, rel, abs } = await this.resolvePath(orgId, agentId, relPath);
    const target = await lstat(abs).catch(() => {
      throw ApiError.notFound("no such path");
    });
    if (target.isSymbolicLink()) return entryFor(rel, target, true);
    await assertNoSymlink(root, rel);
    await assertContained(realRoot, abs);
    return entryFor(rel, target, false);
  }

  /** Reads a text file up to 1 MiB; binary files are rejected. */
  async readText(orgId: string, agentId: string, relPath?: string): Promise<AgentTextFile> {
    const rel = normalizeRelativePath(relPath);
    const { bytes, stats } = await readWorkspaceFile(this.rootFor(orgId, agentId), rel, {
      maxBytes: MAX_TEXT_BYTES,
      overflow: "refuse",
    }).catch((error: unknown) => {
      throw apiErrorOf(error, "file is larger than 1 MiB");
    });
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
      throw badPath("not a text file");
    }
    return {
      path: rel,
      size: bytes.length,
      mtime: stats.mtime.toISOString(),
      text: bytes.toString("utf8"),
    };
  }

  /** Opens a streamed download up to 64 MiB. The stream reads the opened
   *  descriptor, never the path, and stops at the size it reports. */
  async streamDownload(orgId: string, agentId: string, relPath?: string): Promise<AgentDownload> {
    const rel = normalizeRelativePath(relPath);
    const { handle, stats } = await openWorkspaceFile(this.rootFor(orgId, agentId), rel).catch((error: unknown) => {
      throw apiErrorOf(error, "file is larger than 64 MiB");
    });
    const size = Number(stats.size);
    if (size > MAX_DOWNLOAD_BYTES || size === 0) await handle.close();
    if (size > MAX_DOWNLOAD_BYTES) throw badPath("file is larger than 64 MiB");
    return {
      name: path.basename(rel),
      size,
      mtime: stats.mtime.toISOString(),
      stream: size === 0 ? Readable.from([]) : handle.createReadStream({ start: 0, end: size - 1, autoClose: true }),
    };
  }
}
