// The agent workspace config files: seeding from the templates and reading
// them back for the system prompt. The server owns the volume path, so no
// sandbox round trip is needed; a read is one small file open.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedFiles } from "./templates.js";

/** Per-file prompt cap; a longer file is cut with a marker. */
export const FILE_MAX_CHARS = 8 * 1024;
/** Total prompt budget across every config file. */
export const TOTAL_MAX_CHARS = 24 * 1024;

/** The seeded files, in prompt order, with whether a missing one is noted. */
export const CONFIG_FILES: ReadonlyArray<{ name: string; required: boolean }> = [
  { name: "IDENTITY.md", required: true },
  { name: "SOUL.md", required: true },
  { name: "AGENTS.md", required: true },
  { name: "USER.md", required: false },
  { name: "MEMORY.md", required: false },
  { name: "BOOTSTRAP.md", required: false },
];

export interface AgentIdentity {
  name: string | null;
  vibe: string | null;
  emoji: string | null;
  avatar: string | null;
}

export interface AgentConfigFiles {
  /** File name → text, only for files that exist. */
  files: Map<string, string>;
  /** Required files that are absent. */
  missing: string[];
  identity: AgentIdentity;
}

export function agentWorkspaceDir(writeRoot: string, orgId: string, agentId: string): string {
  return path.resolve(writeRoot, "agents", orgId, agentId);
}

/** Placeholder text in parentheses is a template hint, not a value. */
function cleanValue(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || /^\(.*\)$/.test(value)) return null;
  return value;
}

/** Parses the one-line identity: `- Name: X | Vibe: Y | Emoji: Z`. Later
 *  occurrences win, and the `- Label: value` form is accepted on its own
 *  line too, so a hand-written file still parses. */
export function parseIdentity(text: string): AgentIdentity {
  const out: AgentIdentity = { name: null, vibe: null, emoji: null, avatar: null };
  const keys: Record<string, keyof AgentIdentity> = {
    name: "name",
    vibe: "vibe",
    theme: "vibe",
    creature: "vibe",
    emoji: "emoji",
    avatar: "avatar",
  };
  for (const line of text.split("\n")) {
    for (const raw of line.split("|")) {
      // Markdown emphasis around a label (`- **Name:** Echo`) is decoration.
      const match = /^\s*-?\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(raw.replaceAll("*", ""));
      if (match === null) continue;
      const key = keys[match[1]!.toLowerCase()];
      if (key === undefined) continue;
      const value = cleanValue(match[2]!);
      if (value !== null) out[key] = value;
    }
  }
  return out;
}

/** Seeds the workspace with the template files it does not have yet. An
 *  existing file is never overwritten — the agent may have edited it. The
 *  `memories/` directory is created empty. Returns the names it wrote. */
export async function seedAgentWorkspace(dir: string, agent: { name: string }): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "memories"), { recursive: true });
  const written: string[] = [];
  for (const file of seedFiles(agent.name)) {
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

/** The identity line alone — the UI reads name, vibe and emoji from it. */
export async function readIdentity(dir: string): Promise<AgentIdentity> {
  try {
    return parseIdentity(await readFile(path.join(dir, "IDENTITY.md"), "utf8"));
  } catch {
    return { name: null, vibe: null, emoji: null, avatar: null };
  }
}

/** Reads the config files under the caps, plus the parsed identity. A
 *  missing workspace directory reads as every file missing. */
export async function readAgentConfig(dir: string): Promise<AgentConfigFiles> {
  const files = new Map<string, string>();
  const missing: string[] = [];
  let identity: AgentIdentity = { name: null, vibe: null, emoji: null, avatar: null };
  for (const entry of CONFIG_FILES) {
    let text: string;
    try {
      text = await readFile(path.join(dir, entry.name), "utf8");
    } catch {
      if (entry.required) missing.push(entry.name);
      continue;
    }
    files.set(entry.name, text);
    if (entry.name === "IDENTITY.md") identity = parseIdentity(text);
  }
  return { files, missing, identity };
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

