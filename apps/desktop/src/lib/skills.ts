//! Skills discovery, the prompt index, `/name` expansion and the org
//! installs merge, over the fs bridge. Discovery order: config scope → user
//! `~/.agents` → repo chain (git root → cwd) → legacy `.guild`; later
//! entries win a name collision. The index budget is 8000 bytes with
//! description clipping at 120/60/24 then tail-dropping with an omission
//! notice.

import { parentOf, type BridgeFs } from "./fs-bridge";


/** UTF-8 byte length: the index and instruction budgets count bytes. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface SkillEntry {
  name: string;
  description: string;
  /** Full path to SKILL.md (the agent reads it with read_file). */
  path: string;
  /** Installed-org marker (browser sessions): no local file exists, so
   *  mention expansion fetches GET /api/v1/skills/:slug/source pinned at
   *  this version. Machine installs instead carry the real sync path
   *  (~/.agents/skills/<slug>/SKILL.md) and no marker. */
  org?: { version: string };
}

export interface SkillListEntry extends SkillEntry {
  /** user | repo | legacy */
  scope: string;
  provenance: Record<string, string> | null;
  installed: boolean;
  /** snake_case, as the local skills panel reads it. */
  published_by_me: boolean;
  disabled: boolean;
}

// ---------- installed org skills (spec §2.3) ----------

/** One row of GET /api/v1/skills/installs (the fields the assembly uses). */
export interface OrgInstall {
  slug: string;
  /** The pinned version, or null when the install follows the latest. */
  pinned_version: string | null;
}

/**
 * The org-skills HTTP surface the assembly needs, kept out of this module
 * (the real implementation lives where apiUrl/getToken live — transport):
 * the caller's installs, and a skill's SKILL.md body at the caller's pin.
 * Uninstalled org skills are the agent's discovery surface (index +
 * search_skills) and never ride this — they are not mentionable.
 */
export interface OrgSkillsApi {
  installs(): Promise<OrgInstall[] | null>;
  skillBody(slug: string, version?: string): Promise<string | null>;
}

/**
 * The installed-org skill entries (spec §2.3 — mentions cover local +
 * installed org only): machine sessions map each install to its canonical
 * sync path so the local-file expansion reads it unchanged (a
 * locally-materialized copy wins the merge — its frontmatter description
 * is real); browser sessions carry the source marker instead (expansion
 * fetches the body). Uninstalled org skills never appear.
 */
export async function installedOrgSkills(
  api: OrgSkillsApi | undefined,
  home: string | null,
): Promise<SkillEntry[]> {
  const installs = api ? await api.installs() : null;
  if (installs === null) return [];
  const out: SkillEntry[] = [];
  for (const install of installs) {
    if (typeof install?.slug !== "string" || install.slug === "") continue;
    out.push(
      home !== null
        ? { name: install.slug, description: "", path: `${home}/.agents/skills/${install.slug}/SKILL.md` }
        : { name: install.slug, description: "", path: "", org: { version: install.pinned_version ?? "latest" } },
    );
  }
  return out;
}

// ---------- skills ----------

/** Frontmatter `name`/`description` (guild-core::registry::parse_frontmatter).
 *  `description` reads single-line plain/quoted values and YAML block
 *  scalars (`>`, `|-`, `>+`, … — indented lines fold with spaces for `>`
 *  and keep newlines for `|`); `name` stays single-line. */
export function parseFrontmatter(
  body: string,
  fallbackName: string,
): { name: string; description: string } {
  let name = fallbackName;
  let description = "";
  if (body.startsWith("---")) {
    const front = body.slice(3).split("---")[0] ?? "";
    const lines = front.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("name:")) {
        name = line.slice(5).trim().replace(/^"|"$/g, "");
      } else if (line.startsWith("description:")) {
        const inline = line.slice(12).trim();
        const block = /^(?:>|\|)[+-]?$/.exec(inline);
        if (block !== null) {
          // Block scalar: the indented (or blank) lines under the key are
          // the value; `>` folds with spaces, `|` keeps line breaks.
          const literal = inline[0] === "|";
          const parts: string[] = [];
          let blanks = 0;
          for (let j = i + 1; j < lines.length; j++) {
            const raw = lines[j]!;
            if (raw.trim() === "") {
              blanks += 1;
              continue;
            }
            if (!/^\s/.test(raw)) break;
            if (parts.length > 0) parts.push(literal ? "\n".repeat(blanks + 1) : blanks > 0 ? "\n" : " ");
            blanks = 0;
            parts.push(raw.trim());
          }
          description = parts.join(" ").trim();
        } else {
          description = inline.replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1");
        }
        // One line — the description feeds single-line index entries.
        description = description.replace(/\s+/g, " ").trim();
      }
    }
  }
  return { name, description };
}

/** Scans `<dir>/skills/<name>/SKILL.md` and `<dir>/skills/<file>.md`, name-sorted. */
async function scanDir(
  fs: BridgeFs,
  projectDir: string | undefined,
  root: string,
): Promise<SkillEntry[]> {
  const skillsDir = `${root}/skills`;
  const entries = await fs.listDir(projectDir, skillsDir);
  const out: SkillEntry[] = [];
  for (const entry of entries) {
    // Dot-entries are never skills (install staging / backup dirs).
    if (entry.name.startsWith(".")) continue;
    const path = entry.kind === "dir" ? `${skillsDir}/${entry.name}/SKILL.md` : `${skillsDir}/${entry.name}`;
    const body = await fs.readText(projectDir, path);
    if (body === null) continue;
    const fallback =
      entry.kind === "dir" ? entry.name : entry.name.replace(/\.md$/, "");
    const { name, description } = parseFrontmatter(body, fallback);
    out.push({ name, description, path });
  }
  return out;
}

/** Later entries win a name collision (skills.rs `merge`). */
export function merge(out: SkillEntry[], e: SkillEntry): void {
  const existing = out.find((x) => x.name === e.name);
  if (existing) {
    existing.description = e.description;
    existing.path = e.path;
  } else {
    out.push(e);
  }
}

/**
 * Repo-scope roots: the directories from the cwd up to (and including) the
 * nearest ancestor holding `.git`; without a marker only the cwd itself
 * (skills.rs `repo_roots`, lowest precedence first).
 */
async function repoRoots(
  fs: BridgeFs,
  projectDir: string,
): Promise<string[]> {
  const levels: string[] = [];
  let atGit = false;
  let cur: string | null = projectDir;
  while (cur) {
    levels.push(cur);
    if (await fs.exists(projectDir, `${cur}/.git`)) {
      atGit = true;
      break;
    }
    const parent = parentOf(cur);
    cur = parent;
  }
  if (!atGit) levels.splice(1);
  return levels.reverse();
}

/** Skills visible to a turn, lowest precedence first (skills.rs discover_with_home). */
export async function discoverSkills(
  fs: BridgeFs,
  projectDir: string | undefined,
  configDir: string,
  home: string,
): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  if (projectDir) {
    projectDir = projectDir.replaceAll("\\", "/").replace(/\/$/, "");
    for (const e of await scanDir(fs, projectDir, `${projectDir}/.guild`)) merge(out, e);
  }
  for (const e of await scanDir(fs, projectDir, configDir)) merge(out, e);
  for (const e of await scanDir(fs, projectDir, `${home}/.agents`)) merge(out, e);
  if (projectDir) {
    for (const root of await repoRoots(fs, projectDir)) {
      for (const e of await scanDir(fs, projectDir, `${root}/.agents`)) merge(out, e);
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Paths disabled in `{config_dir}/settings.json` under `skillsDisabled`. */
export async function disabledPaths(
  fs: BridgeFs,
  projectDir: string | undefined,
  configDir: string,
  home: string,
): Promise<Set<string>> {
  const body = await fs.readText(projectDir, `${configDir}/settings.json`);
  if (body === null) return new Set();
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return new Set();
  }
  const map = isRecord(v) ? v.skillsDisabled : undefined;
  if (typeof map !== "object" || map === null) return new Set();
  const out = new Set<string>();
  for (const [p, on] of Object.entries(map)) {
    if (on === false) {
      out.add(typeof p === "string" && p.startsWith("~/") ? `${home}/${p.slice(2)}` : String(p));
    }
  }
  return out;
}

const INDEX_BUDGET = 8_000;

/**
 * The skills index injected into the system prompt (skills.rs prompt_index):
 * full descriptions while it fits, then clipping at 120/60/24 chars, then
 * dropping entries from the end with an omission notice.
 */
export function promptIndex(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const header =
    "\n# Available skills\nWhen a task matches a skill, read its SKILL.md with read_file and follow it.\n";
  const clipDesc = (e: SkillEntry, clip: number): string => {
    if (clip === Number.MAX_SAFE_INTEGER) return e.description;
    const cut = e.description.slice(0, clip);
    return cut.length < e.description.length ? `${cut}…` : cut;
  };
  const render = (list: SkillEntry[], clip: number, omitted?: number): string => {
    let s = header;
    for (const e of list) s += `- ${e.name}: ${clipDesc(e, clip)} (${e.path})\n`;
    if (omitted !== undefined) s += `(${omitted} skills omitted — index over budget)\n`;
    return s;
  };
  for (const clip of [Number.MAX_SAFE_INTEGER, 120, 60, 24]) {
    const s = render(skills, clip);
    if (byteLength(s) <= INDEX_BUDGET) return s;
  }
  let kept = [...skills];
  while (kept.length > 0) {
    kept = kept.slice(0, -1);
    const s = render(kept, 24, skills.length - kept.length);
    if (byteLength(s) <= INDEX_BUDGET) return s;
  }
  return header;
}

/**
 * `/name` mentions in the prompt, expanded with the full SKILL.md body
 * (skills.rs mention_expansions): the token matches the composer's
 * mention detection (lowercase/digit/hyphen after a word-start `/`).
 */
export async function mentionExpansions(
  fs: BridgeFs,
  projectDir: string | undefined,
  prompt: string,
  skills: SkillEntry[],
  orgApi?: OrgSkillsApi,
): Promise<Array<{ skill: SkillEntry; body: string }>> {
  const names = new Set<string>();
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i] === "/" && (i === 0 || /\s/.test(prompt[i - 1]))) {
      let end = i + 1;
      while (end < prompt.length && /[a-z0-9-]/.test(prompt[end])) end++;
      if (end > i + 1) names.add(prompt.slice(i + 1, end));
      i = end - 1;
    }
  }
  const out: Array<{ skill: SkillEntry; body: string }> = [];
  // Browser org skills fetch their body once per assembly (cached here);
  // a name expanded once never repeats (first entry wins, merge semantics).
  const fetched = new Map<string, string | null>();
  const expandedNames = new Set<string>();
  for (const e of skills) {
    if (!names.has(e.name) || expandedNames.has(e.name)) continue;
    let body: string | null;
    if (e.org) {
      if (!orgApi) continue;
      if (!fetched.has(e.name)) fetched.set(e.name, await orgApi.skillBody(e.name, e.org?.version));
      body = fetched.get(e.name)!;
    } else {
      body = await fs.readText(projectDir, e.path);
    }
    if (body !== null) {
      out.push({ skill: e, body });
      expandedNames.add(e.name);
    }
  }
  return out;
}

/** The context block appended to the prompt for `/name` mentions. */
export function mentionBlock(
  mentions: Array<{ skill: SkillEntry; body: string }>,
): string | null {
  if (mentions.length === 0) return null;
  let s = "\n\n---\nInvoked skills (follow their instructions):\n";
  for (const { skill, body } of mentions) {
    s += `\n### Skill: ${skill.name}${skill.path ? ` (${skill.path})` : ""}\n${body}\n`;
  }
  return s;
}

// ---------- skills UI (the manager's listing + toggles) ----------

/** Flat `key: value` sidecar (skills.rs SkillProvenance). */
async function readProvenance(
  fs: BridgeFs,
  projectDir: string | undefined,
  skillMdPath: string,
): Promise<Record<string, string> | null> {
  const dir = skillMdPath.slice(0, skillMdPath.lastIndexOf("/")) || "/";
  const body = await fs.readText(projectDir, `${dir}/agents/guild.yaml`);
  if (body === null) return null;
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Everything the skills manager needs, in one call (skills.rs list_with_home). */
export async function listSkills(
  fs: BridgeFs,
  scopes: { configDir: string | null; home: string | null },
  projectDir?: string,
): Promise<SkillListEntry[]> {
  const { configDir, home } = scopes;
  if (!configDir || !home) return [];
  const disabled = await disabledPaths(fs, projectDir, configDir, home);
  const out: SkillListEntry[] = [];
  for (const e of await discoverSkills(fs, projectDir, configDir, home)) {
    const inDir = (root: string) => (root ? e.path.startsWith(`${root}/`) : false);
    const scope = inDir(`${home}/.agents`)
      ? "user"
      : inDir(projectDir ? `${projectDir}/.guild` : "") || inDir(configDir)
        ? "legacy"
        : "repo";
    const provenance = await readProvenance(fs, projectDir, e.path);
    out.push({
      ...e,
      scope,
      provenance,
      installed: provenance?.["source"] === "registry" && provenance["published_by_me"] !== "true",
      published_by_me: provenance?.["published_by_me"] === "true",
      disabled: disabled.has(e.path),
    });
  }
  return out;
}

/** Writes the disabled-skill map back to settings.json (skills.rs set_disabled). */
export async function setSkillDisabled(
  fs: BridgeFs,
  scopes: { configDir: string | null },
  skillPath: string,
  enabled: boolean,
): Promise<boolean> {
  const { configDir } = scopes;
  if (!configDir) return false;
  let v: Record<string, unknown> = {};
  const body = await fs.readText(undefined, `${configDir}/settings.json`);
  if (body !== null) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) v = parsed;
    } catch {
      v = {};
    }
  }
  const disabled = isRecord(v.skillsDisabled) ? v.skillsDisabled : {};
  disabled[skillPath] = enabled;
  v.skillsDisabled = disabled;
  return fs.writeText(undefined, `${configDir}/settings.json`, JSON.stringify(v, null, 2) + "\n");
}
