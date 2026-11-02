// promptFiles: the agent config files (AGENTS.md or its override, plus
// MEMORY.md) that seed the workspace and ride the system prompt. The server
// owns the volume path, so no sandbox round trip is needed; reads and writes
// go through workspace-fs, which refuses the symlinks and non-regular files
// the sandbox may plant.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { seedFiles } from "./templates.js";
import { ensureWorkspaceDir, readWorkspaceFile, writeWorkspaceFile, WorkspaceFsError } from "./workspace-fs.js";

/** Total prompt budget across every config file: the same 32 KiB rule the
 *  desktop applies to its project chain. */
export const TOTAL_MAX_CHARS = 32 * 1024;

/** Byte cap on one config file read. A UTF-8 character is at most four
 *  bytes, so the cap never cuts text the prompt budget would show. */
export const CONFIG_MAX_BYTES = TOTAL_MAX_CHARS * 4;

/** The config files, in prompt order, with whether a missing one is noted.
 *  The override shadows the plain AGENTS.md. */
export const CONFIG_FILES: ReadonlyArray<{ name: string; required: boolean }> = [
  { name: "AGENTS.override.md", required: false },
  { name: "AGENTS.md", required: true },
  { name: "MEMORY.md", required: false },
];

export interface AgentConfigFiles {
  /** File name → text, only for files that exist. */
  files: Map<string, string>;
  /** Required files that are absent. */
  missing: string[];
}

/** The agent workspace subpath, relative to the workspace volume. */
export function agentWorkspaceSubpath(orgId: string, agentId: string): string {
  return `agents/${orgId}/${agentId}`;
}

export function agentWorkspaceDir(writeRoot: string, orgId: string, agentId: string): string {
  return path.resolve(writeRoot, agentWorkspaceSubpath(orgId, agentId));
}

/** Seeds the workspace with the template files it does not have yet. An
 *  existing entry is never overwritten — the agent may have edited it — and
 *  one the sandbox replaced with a symlink is left alone. The `memories/`
 *  directory is created empty. Returns the names it wrote. */
export async function seedAgentWorkspace(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  await ensureWorkspaceDir(dir, "memories").catch(ignoreRefusal);
  const written: string[] = [];
  for (const file of seedFiles()) {
    const wrote = await writeWorkspaceFile(dir, file.path, file.text, { exclusive: true }).catch((error: unknown) => {
      ignoreRefusal(error);
      return false;
    });
    if (wrote) written.push(file.path);
  }
  return written;
}

function ignoreRefusal(error: unknown): void {
  if (!(error instanceof WorkspaceFsError)) throw error;
}

/** Reads the config files, each capped at `CONFIG_MAX_BYTES`; a capped file
 *  ends with a truncation marker. A symlink, a non-regular file or a missing
 *  workspace directory reads as absent. */
export async function readAgentConfig(dir: string): Promise<AgentConfigFiles> {
  const files = new Map<string, string>();
  const missing: string[] = [];
  const read = async (name: string): Promise<string | null> => {
    try {
      const { bytes, truncated } = await readWorkspaceFile(dir, name, {
        maxBytes: CONFIG_MAX_BYTES,
        overflow: "truncate",
      });
      const text = bytes.toString("utf8");
      return truncated ? `${text}\n\n(truncated at ${CONFIG_MAX_BYTES} bytes — read the file for the rest)` : text;
    } catch {
      return null;
    }
  };
  // One AGENTS file per directory: the override shadows the plain file.
  let agents: string | null = null;
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    agents = await read(name);
    if (agents !== null) {
      files.set(name, agents);
      break;
    }
  }
  if (agents === null) missing.push("AGENTS.md");
  const memory = await read("MEMORY.md");
  if (memory !== null) files.set("MEMORY.md", memory);
  return { files, missing };
}

/** The agent's workspace path inside its sandbox (the sandbox cwd). */
export const AGENT_WORKSPACE_PATH = "/workspace";

/** The prompt block for one file: tagged with its full path, trimmed,
 *  capped, with a truncation marker that tells the agent the rest is on
 *  disk. The tag carries the path so the model can name the file it edits. */
export function renderFileBlock(name: string, text: string, budget: number): string {
  const body = text.trim();
  const limit = budget;
  const open = `<agent_workspace_file path="${AGENT_WORKSPACE_PATH}/${name}">`;
  if (body.length <= limit) return `${open}\n${body}\n</agent_workspace_file>`;
  const cut = body.slice(0, limit);
  return (
    `${open}\n${cut}\n\n` + `(truncated at ${limit} characters — read the file for the rest)\n</agent_workspace_file>`
  );
}
