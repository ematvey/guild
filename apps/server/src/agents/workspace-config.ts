// promptFiles: the agent config files (AGENTS.md, MEMORY.md) that seed the
// workspace and ride the system prompt. The server owns the volume path, so
// no sandbox round trip is needed; a read is one small file open.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedFiles } from "./templates.js";

/** Per-file prompt cap; a longer file is cut with a marker. */
export const FILE_MAX_CHARS = 8 * 1024;
/** Total prompt budget across every config file. */
export const TOTAL_MAX_CHARS = 24 * 1024;

/** The seeded files, in prompt order, with whether a missing one is noted. */
export const CONFIG_FILES: ReadonlyArray<{ name: string; required: boolean }> = [
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
  for (const entry of CONFIG_FILES) {
    let text: string;
    try {
      text = await readFile(path.join(dir, entry.name), "utf8");
    } catch {
      if (entry.required) missing.push(entry.name);
      continue;
    }
    files.set(entry.name, text);
  }
  return { files, missing };
}

/** The agent's workspace path inside its sandbox (the sandbox cwd). */
export const AGENT_WORKSPACE_PATH = "/workspace";

/** The prompt block for one file: tagged with its full path, trimmed,
 *  capped, with a truncation marker that tells the agent the rest is on
 *  disk. The tag carries the path so the model can name the file it edits. */
export function renderFileBlock(name: string, text: string, budget: number): string {
  const body = text.trim();
  const limit = Math.min(FILE_MAX_CHARS, budget);
  const open = `<agent_workspace_file path="${AGENT_WORKSPACE_PATH}/${name}">`;
  if (body.length <= limit) return `${open}\n${body}\n</agent_workspace_file>`;
  const cut = body.slice(0, limit);
  return (
    `${open}\n${cut}\n\n` +
    `(truncated at ${limit} characters — read the file for the rest)\n</agent_workspace_file>`
  );
}

