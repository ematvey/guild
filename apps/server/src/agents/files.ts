// Read-only file browser over one agent's workspace subtree:
// <agentWorkspaceRoot>/agents/<orgId>/<agentId>. Paths are relative,
// containment is checked after realpath, and symlinks are opaque — listed
// with their flag but never traversed.

import { createReadStream, type ReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../platform/errors.js";

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
  stream: ReadStream;
}

function badPath(message = "invalid path"): ApiError {
  return ApiError.badRequest(message);
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

export class AgentFiles {
  constructor(private readonly workspaceRoot: string) {}

  private rootFor(orgId: string, agentId: string): string {
    return path.resolve(this.workspaceRoot, "agents", orgId, agentId);
  }

  /** Resolves a relative path inside the agent root (lexical containment)
   *  and resolves the root itself for the realpath check. */
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
    const realRoot = await realpath(root).catch(() => {
      throw ApiError.notFound("no such path");
    });
    return { root, realRoot, rel, abs };
  }

  /** Proves the real path stays under the resolved root. Callers run it only
   *  after the symlink check, so a symlink can never redirect the read. */
  private async assertContained(realRoot: string, abs: string): Promise<void> {
    const realAbs = await realpath(abs).catch(() => {
      throw ApiError.notFound("no such path");
    });
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
      throw badPath("path escapes the agent workspace");
    }
  }

  /** Refuses any path whose segments include a symlink. */
  private async assertNoSymlink(root: string, rel: string): Promise<void> {
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
    const { root, realRoot, rel, abs } = await this.resolvePath(orgId, agentId, relPath);
    await this.assertNoSymlink(root, rel);
    await this.assertContained(realRoot, abs);
    const target = await lstat(abs).catch(() => {
      throw ApiError.notFound("no such path");
    });
    // A file path lists the folder that holds it, so one request answers both
    // "which folder am I in" and "what sits next to this file".
    if (!target.isDirectory()) {
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const parentAbs = path.dirname(abs);
      await this.assertNoSymlink(root, parentRel);
      await this.assertContained(realRoot, parentAbs);
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
    await this.assertNoSymlink(root, rel);
    await this.assertContained(realRoot, abs);
    return entryFor(rel, target, false);
  }

  /** Reads a text file up to 1 MiB; binary files are rejected. */
  async readText(orgId: string, agentId: string, relPath?: string): Promise<AgentTextFile> {
    const { root, realRoot, rel, abs } = await this.resolvePath(orgId, agentId, relPath);
    await this.assertNoSymlink(root, rel);
    await this.assertContained(realRoot, abs);
    const stats = await lstat(abs).catch(() => {
      throw ApiError.notFound("no such path");
    });
    if (!stats.isFile()) throw badPath("not a file");
    if (stats.size > MAX_TEXT_BYTES) throw badPath("file is larger than 1 MiB");
    const handle = await open(abs, "r");
    try {
      const buffer = Buffer.alloc(Number(stats.size));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
        throw badPath("not a text file");
      }
      return {
        path: rel,
        size: Number(stats.size),
        mtime: stats.mtime.toISOString(),
        text: buffer.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }

  /** Opens a streamed download up to 64 MiB. */
  async streamDownload(orgId: string, agentId: string, relPath?: string): Promise<AgentDownload> {
    const { root, realRoot, rel, abs } = await this.resolvePath(orgId, agentId, relPath);
    await this.assertNoSymlink(root, rel);
    await this.assertContained(realRoot, abs);
    const stats = await lstat(abs).catch(() => {
      throw ApiError.notFound("no such path");
    });
    if (!stats.isFile()) throw badPath("not a file");
    if (stats.size > MAX_DOWNLOAD_BYTES) throw badPath("file is larger than 64 MiB");
    return {
      name: path.basename(rel),
      size: Number(stats.size),
      mtime: stats.mtime.toISOString(),
      stream: createReadStream(abs),
    };
  }
}
