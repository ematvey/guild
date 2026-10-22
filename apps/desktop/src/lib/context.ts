//! Context assembly (unification spec §3 item 2 / phase 2): skills
//! discovery + index, `/name` expansion, and the AGENTS.md instruction
//! chain — the logic that used to live in the daemon's Rust
//! (`app-server/src/skills.rs` + `agents_md.rs`), now on the client where
//! the files are. Rust only touches bytes via the allowlisted `fs.*`
//! bridge; everything here is discovery logic over that bridge.
//!
//! Semantics are ported to the letter from the Rust implementations:
//! - skills: config scope → user `~/.agents` → repo chain (git root →
//!   cwd) → legacy `.guild`; later entries win a name collision; the index
//!   budget is 8000 bytes with description clipping at 120/60/24 then
//!   tail-dropping with an omission notice.
//! - AGENTS.md (Codex semantics, codex-rs `core/src/agents_md.rs`): the
//!   global config-dir file (`AGENTS.override.md` beats `AGENTS.md`),
//!   then one file per directory from the git root down to the working
//!   dir (override beats plain, empty files stop the dir's contribution),
//!   under a shared 32 KiB budget with byte-truncation.
//!
//! Browser mode (no daemon) has no local files: every assembly returns
//! empty and the prompt passes through untouched.

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
  /** snake_case: the UI consumes the old Rust wire shape. */
  published_by_me: boolean;
  disabled: boolean;
}

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

// ---------- the fs bridge ----------

/** What a directory entry looks like over the bridge. */
export interface DirEntry {
  name: string;
  kind: "dir" | "file" | "other";
}

/**
 * The daemon-side file bridge. Browser mode returns empty results —
 * there are no local files there (server-side AGENTS.md for web chats is
 * phase 5a, machine-mediated).
 */
export interface BridgeFs {
  scopes(): Promise<{ configDir: string | null; home: string | null }>;
  readText(projectDir: string | undefined, path: string): Promise<string | null>;
  listDir(projectDir: string | undefined, path: string): Promise<DirEntry[]>;
  exists(projectDir: string | undefined, path: string): Promise<boolean>;
  writeText(projectDir: string | undefined, path: string, body: string): Promise<boolean>;
}

const emptyFs: BridgeFs = {
  scopes: async () => ({ configDir: null, home: null }),
  readText: async () => null,
  listDir: async () => [],
  exists: async () => false,
  writeText: async () => false,
};

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
function merge(out: SkillEntry[], e: SkillEntry): void {
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

function parentOf(dir: string): string | null {
  const normalized = dir.replaceAll("\\", "/").replace(/\/$/, "");
  if (/^[a-z]:$/i.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized)) return null;
  const i = normalized.lastIndexOf("/");
  if (i <= 0) return null;
  const parent = normalized.slice(0, i);
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
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

/** Paths disabled in `{config_dir}/settings.json` under `skillsDisabled`. */
export async function disabledPaths(
  fs: BridgeFs,
  projectDir: string | undefined,
  configDir: string,
  home: string,
): Promise<Set<string>> {
  const body = await fs.readText(projectDir, `${configDir}/settings.json`);
  if (body === null) return new Set();
  let v: any;
  try {
    v = JSON.parse(body);
  } catch {
    return new Set();
  }
  const map = v?.skillsDisabled;
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
  let v: any = {};
  const body = await fs.readText(undefined, `${configDir}/settings.json`);
  if (body !== null) {
    try {
      v = JSON.parse(body);
    } catch {
      v = {};
    }
  }
  if (typeof v.skillsDisabled !== "object" || v.skillsDisabled === null) {
    v.skillsDisabled = {};
  }
  v.skillsDisabled[skillPath] = enabled;
  return fs.writeText(undefined, `${configDir}/settings.json`, JSON.stringify(v, null, 2) + "\n");
}

// ---------- the live bridge over the daemon RPC ----------

/** The real bridge: `fs.*` verbs over the app-process RPC channel. */
export function daemonFs(rpcCall: (method: string, params: any, timeoutMs?: number) => Promise<any>): BridgeFs {
  const call = async (method: string, params: Record<string, unknown>): Promise<any> => {
    try {
      const res = await rpcCall(method, params, 15_000);
      return res?.result ?? null;
    } catch {
      return null;
    }
  };
  return {
    scopes: async () => {
      const r = await call("fs.scopes", {});
      return { configDir: r?.config_dir ?? null, home: r?.home ?? null };
    },
    readText: async (projectDir, path) => {
      const r = await call("fs.read_text", { ...(projectDir ? { project_dir: projectDir } : {}), path });
      return r?.content ?? null;
    },
    listDir: async (projectDir, path) => {
      const r = await call("fs.list_dir", { ...(projectDir ? { project_dir: projectDir } : {}), path });
      return r?.entries ?? [];
    },
    exists: async (projectDir, path) => {
      const r = await call("fs.exists", { ...(projectDir ? { project_dir: projectDir } : {}), path });
      return r?.exists === true;
    },
    writeText: async (projectDir, path, body) => {
      const r = await call("fs.write_text", { ...(projectDir ? { project_dir: projectDir } : {}), path, body });
      return r?.ok === true;
    },
  };
}

/** Browser-mode bridge: no local files, everything empty. */
export const browserFs: BridgeFs = emptyFs;
