// promptFiles: the agent config files (AGENTS.md or its override, plus
// MEMORY.md) that seed the workspace and ride the system prompt. The server
// owns the volume path, so no sandbox round trip is needed; a read is one
// small file open.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedFiles } from "./templates.js";

/** Total prompt budget across every config file: the same 32 KiB rule the
 *  desktop applies to its project chain. */
export const TOTAL_MAX_CHARS = 32 * 1024;

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
 *  existing file is never overwritten — the agent may have edited it. The
 *  `memories/` directory is created empty. Returns the names it wrote. */
export async function seedAgentWorkspace(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "memories"), { recursive: true });
  const written: string[] = [];
  for (const file of seedFiles()) {
    const target = path.join(dir, file.path);
    try {
      await readFile(target);
      continue;
    } catch {
      // absent: write the template
    }
    await writeFile(target, file.text, { flag: "wx" }).catch((error: { code?: string }) => {
      if (error.code !== "EEXIST") throw error;
    });
    written.push(file.path);
  }
  return written;
}

/** Reads the config files under the caps. A missing workspace directory
 *  reads as every file missing. */
export async function readAgentConfig(dir: string): Promise<AgentConfigFiles> {
  const files = new Map<string, string>();
  const missing: string[] = [];
  const read = async (name: string): Promise<string | null> => {
    try {
      return await readFile(path.join(dir, name), "utf8");
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
    `${open}\n${cut}\n\n` +
    `(truncated at ${limit} characters — read the file for the rest)\n</agent_workspace_file>`
  );
}

