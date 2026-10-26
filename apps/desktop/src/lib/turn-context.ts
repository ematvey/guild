//! The AGENTS.md instruction chain (Codex semantics, codex-rs
//! `core/src/agents_md.rs`) and the turn assembly that combines it with
//! the skills index. The global config-dir file (`AGENTS.override.md`
//! beats `AGENTS.md`), then one file per directory from the git root down
//! to the working dir (override beats plain, empty files stop the dir's
//! contribution), under a shared 32 KiB budget with byte truncation.

import { parentOf, type BridgeFs } from "./fs-bridge";
import {
  disabledPaths,
  discoverSkills,
  installedOrgSkills,
  mentionBlock,
  mentionExpansions,
  merge,
  promptIndex,
  type OrgSkillsApi,
  type SkillEntry,
} from "./skills";

export interface PreparedTurn {
  prompt: string;
  index: string;
  instructions?: string;
}


/** Byte length (the Rust budget checks are byte-based). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** UTF-8-safe truncation to `max` bytes (Rust's char-boundary slice). */
function truncateBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  const bytes = new TextEncoder().encode(s);
  return new TextDecoder().decode(bytes.slice(0, max));
}

// ---------- AGENTS.md (Codex semantics) ----------

const AGENTS_MD_FILENAME = "AGENTS.md";
const AGENTS_OVERRIDE_FILENAME = "AGENTS.override.md";
/** Codex's `project_doc_max_bytes` default. */
export const PROJECT_DOC_MAX_BYTES = 32 * 1024;

export interface DocEntry {
  path: string;
  contents: string;
}

/** The global instructions: override beats plain, first non-empty wins. */
export async function loadGlobalAgentsMd(
  fs: BridgeFs,
  configDir: string,
): Promise<DocEntry | null> {
  for (const name of [AGENTS_OVERRIDE_FILENAME, AGENTS_MD_FILENAME]) {
    const path = `${configDir}/${name}`;
    const text = await fs.readText(undefined, path);
    if (text !== null && text.trim() !== "") return { path, contents: text };
  }
  return null;
}

/** The nearest ancestor (inclusive) holding `.git`; else the start itself. */
async function projectRoot(
  fs: BridgeFs,
  projectDir: string,
): Promise<string> {
  let cur: string | null = projectDir;
  while (cur) {
    if (await fs.exists(projectDir, `${cur}/.git`)) return cur;
    cur = parentOf(cur);
  }
  return projectDir;
}

/** Directories from the project root down to cwd (inclusive), in that order. */
async function searchDirs(fs: BridgeFs, projectDir: string): Promise<string[]> {
  const root = await projectRoot(fs, projectDir);
  const dirs: string[] = [];
  let cur: string | null = projectDir;
  while (cur) {
    dirs.push(cur);
    if (cur === root) break;
    cur = parentOf(cur);
  }
  dirs.reverse();
  return dirs;
}

/**
 * The project AGENTS.md chain: at most one file per directory (override
 * beats plain; an empty file stops that dir's contribution), root → cwd,
 * shared byte budget with truncation. Unreadable files are skipped.
 */
export async function projectAgentDocs(
  fs: BridgeFs,
  projectDir: string,
  maxBytes = PROJECT_DOC_MAX_BYTES,
): Promise<DocEntry[]> {
  projectDir = projectDir.replaceAll("\\", "/").replace(/\/$/, "");
  const out: DocEntry[] = [];
  let remaining = maxBytes;
  for (const dir of await searchDirs(fs, projectDir)) {
    if (remaining === 0) break;
    for (const name of [AGENTS_OVERRIDE_FILENAME, AGENTS_MD_FILENAME]) {
      const path = `${dir}/${name}`;
      const text = await fs.readText(projectDir, path);
      if (text === null) continue;
      if (text.trim() === "") break; // the dir contributed an empty file — stop
      const truncated = truncateBytes(text, remaining);
      remaining -= byteLength(truncated);
      out.push({ path, contents: truncated });
      break; // one file per directory: the first existing candidate wins
    }
  }
  // MEMORY.md rides alongside the chain, read once at the project root.
  if (remaining > 0) {
    const memoryPath = `${projectDir}/MEMORY.md`;
    const memory = await fs.readText(projectDir, memoryPath);
    if (memory !== null && memory.trim() !== "") {
      const truncated = truncateBytes(memory, remaining);
      remaining -= byteLength(truncated);
      out.push({ path: memoryPath, contents: truncated });
    }
  }
  return out;
}

/**
 * One-call turn preparation (the old daemon `skills.prepare_turn`):
 * expands `/name` mentions into the prompt, renders the skills index, and
 * assembles the AGENTS.md instructions. Everything best-effort — context
 * assembly never blocks a turn.
 */
export async function prepareTurn(
  fs: BridgeFs,
  scopes: { configDir: string | null; home: string | null },
  prompt: string,
  projectDir?: string,
  orgApi?: OrgSkillsApi,
): Promise<PreparedTurn> {
  const { configDir, home } = scopes;
  if (!configDir || !home) {
    // Browser mode: no local files. Installed org skills still mention-
    // expand (bodies fetched per turn, cached); the index stays empty —
    // the server renders the org portion (installs with pin markers)
    // itself, and a client-sent local list would strip those markers.
    const org = await installedOrgSkills(orgApi, null);
    const mentions = await mentionExpansions(fs, projectDir, prompt, org, orgApi);
    const expanded = mentionBlock(mentions);
    return { prompt: expanded === null ? prompt : `${prompt}${expanded}`, index: "" };
  }
  // Org installs merge first: a locally-materialized copy (real
  // frontmatter description) wins the name collision.
  const merged: SkillEntry[] = [];
  for (const e of await installedOrgSkills(orgApi, home)) merge(merged, e);
  for (const e of await discoverSkills(fs, projectDir, configDir, home)) merge(merged, e);
  const disabled = await disabledPaths(fs, projectDir, configDir, home);
  const enabled = merged.filter((s) => !disabled.has(s.path));
  const index = promptIndex(enabled);
  const mentions = await mentionExpansions(fs, projectDir, prompt, enabled, orgApi);
  const expanded = mentionBlock(mentions);
  const finalPrompt =
    expanded === null ? prompt : `${prompt}${expanded}`;
  // The project chain in pi's context syntax: one tagged block per file,
  // path included, so the model can tell a root file from a subdirectory
  // one. The server wraps the blocks in its `<project_context>` section.
  const docs: DocEntry[] = [];
  const global = await loadGlobalAgentsMd(fs, configDir);
  if (global) docs.push(global);
  if (projectDir) docs.push(...(await projectAgentDocs(fs, projectDir)));
  const instructions =
    docs.length === 0
      ? undefined
      : docs
          .map((d) => `<project_instructions path="${d.path.replaceAll('"', "&quot;")}">\n${d.contents.trim()}\n</project_instructions>`)
          .join("\n\n");
  return { prompt: finalPrompt, index, instructions };
}
