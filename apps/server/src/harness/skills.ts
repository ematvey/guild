// The skills runtime (spec §1/§3): the three agent tools over the org
// skill registry — read_skill (install-on-use, pinned reads), search_skills
// (catalog query), push_skill (workspace tree → next version) — plus the
// per-turn surfaces the guild extension consumes: the combined prompt
// index section, the per-conversation index stash, and the machine sync
// hook (the fleet push over the hub).
//
// Tool failures are RESULTS the model sees (isError text), never thrown
// 403/404s. The publish path mirrors the HTTP publish internals
// (platform/http/registry.ts publishBundleBytes): content-addressed key,
// the gate re-checked inside upsertVersion's row-lock transaction, object
// put, and the org event — the arch layers forbid importing the HTTP
// module from a service, so the shape is kept in step by convention.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { ApiError } from "../platform/errors.js";
import { packBundle, parseBundle } from "../platform/bundle.js";
import { validateManifest, type Manifest } from "../platform/registry-manifest.js";
import type { ObjectStore } from "../platform/s3.js";
import type { RegistryItemRow } from "../platform/store/registry.js";
import type { SkillReadEvent, SkillReadSink } from "../platform/skillReads.js";
import type { EventStore } from "../platform/store/events.js";
import type { RegistryStore } from "../platform/store/registry.js";
import type { MachineRow, MachineStore } from "../platform/store/machines.js";
import type { SkillStore } from "../platform/store/skills.js";
import type { MachineRequestResult } from "../hub/index.js";
import type { TeamStore } from "../platform/store/teams.js";
import type { ExecutorKind } from "../machines/dispatch.js";

export interface SkillRuntimeDeps {
  log: { warn(message: string): void };
  registry: Pick<
    RegistryStore,
    "itemControl" | "getVersionMeta" | "publishGate" | "itemVersions" | "upsertVersion" | "searchSkills"
  >;
  skills: Pick<SkillStore, "install" | "byUserAndSlug" | "listForUser">;
  events: Pick<EventStore, "emit">;
  teams: Pick<TeamStore, "isMember">;
  /** Object store: the push path's bundle put + the materialization
   *  path's bundle get; get absent/unconfigured → no materialization. */
  objects: (Pick<ObjectStore, "put"> & Partial<Pick<ObjectStore, "get">>) | undefined;
  /** ClickHouse skill-read sink; absent → reads are not recorded. */
  skillReads: Pick<SkillReadSink, "record"> | undefined;
  /** conversationId → chat id (the chat mapping). */
  chatOfConversation(conversationId: number): Promise<string | null>;
  /** chatId → the owner's org/user/role (the tool caller's identity). */
  chatOwner(chatId: string): Promise<{ orgId: string; userId: string; role: string } | null>;
  /** Where the conversation's tools execute (machine dispatch vs the
   *  server-side workspace/sandbox). */
  executorKind(conversationId: number): Promise<ExecutorKind>;
  /** The server-side directory the conversation's files live under (the
   *  agent-session workspace for executor "server", the per-conversation
   *  sandbox otherwise); the push path reads `skills/<slug>` under it. */
  conversationDir(conversationId: number, orgId: string): Promise<string>;
  /** Task 7's sandbox materialization (install-on-use, executor
   *  "server"); absent → skipped. */
  materialize?(args: {
    conversationId: number;
    chatId: string;
    orgId: string;
    slug: string;
    version: string;
  }): Promise<void>;
  /** The hub's control-plane request to a machine's executor socket (the
   *  skills fleet sync push; the machine fs_read op rides the same seam
   *  later); absent → syncs stay no-ops. */
  machineRequest?(args: {
    machineId: string;
    orgId: string;
    op: string;
    payload: unknown;
  }): Promise<MachineRequestResult>;
  /** Hub liveness (LiveHub.machineOnline); absent → every listed machine
   *  is attempted and the offline reply is the failure signal. */
  machineOnline?(machineId: string): boolean;
  /** The durable machine registry (the sync fan-out's recipient list);
   *  absent → syncs stay no-ops. */
  machines?: Pick<MachineStore, "listForUser">;
  /** This server's own base URL (config.selfBaseUrl) — the bundle-fetch
   *  URL each sync entry carries; absent → entries carry no url. */
  selfBaseUrl?: string;
}

interface ChatIdentity {
  chatId: string;
  orgId: string;
  userId: string;
  role: string;
}

const INDEX_LIMIT = 200;
/** The combined section's byte budget (spec §2.1) — the client's local
 *  lines + the org portion together. */
const SECTION_BUDGET = 8192;
/** Headroom for the overflow line, so it never pushes past the budget. */
const OVERFLOW_RESERVE = 96;
/** Uninstalled org descriptions clip at this many chars (client parity). */
const DESCRIPTION_CLIP = 120;

const SECTION_HEADER = "# Available skills";
const SECTION_GUIDANCE =
  "When a task matches a skill, read it with read_skill and follow it. Skills marked installed are on this machine " +
  "(their files are readable with read_file); if one shows a newer version, ask the user before updating.";

/** The client `skills_index`'s skill lines, verbatim: its own `# Available
 *  skills` header, its guidance sentence, and blank lines are stripped. */
function localLinesOf(index: string | undefined): string[] {
  if (index === undefined || index.trim() === "") return [];
  const lines: string[] = [];
  for (const raw of index.split("\n")) {
    const line = raw.trim();
    if (line === "" || line === SECTION_HEADER || line.startsWith("When a task matches a skill")) continue;
    lines.push(line);
  }
  return lines;
}

/** The slug a local line carries (`- slug: …`), null when the line is not
 *  a skill entry — used to keep a locally-listed slug out of the org list. */
function localSlugOf(line: string): string | null {
  const match = /^- ([^:]+):/.exec(line);
  return match === null ? null : match[1]!.trim();
}

function clipDescription(description: string): string {
  return description.length > DESCRIPTION_CLIP ? `${description.slice(0, DESCRIPTION_CLIP)}…` : description;
}

export class SkillRuntime {
  private readonly lastIndex = new Map<ConversationId, string>();
  private readonly readSkill: ToolRegistration;
  private readonly searchSkills: ToolRegistration;
  private readonly pushSkill: ToolRegistration;

  constructor(private readonly deps: SkillRuntimeDeps) {
    this.readSkill = defineTool({
      name: "read_skill",
      description:
        "Read an available skill by name. Returns the skill's SKILL.md and the list of additional files it ships. " +
        "First read of an org skill installs it for you (pinned to the current version).",
      parameters: Type.Object({ slug: Type.String({ description: "The skill's slug" }) }),
      replay: "safe",
      outputLimits: { maxBytes: 256 * 1024 },
      execute: (args, api) => this.read(args.slug, api),
    });
    this.searchSkills = defineTool({
      name: "search_skills",
      description: "Search the org's skill catalog by keyword (matches slugs, descriptions, and skill bodies).",
      parameters: Type.Object({ query: Type.String({ description: "Search keywords (empty lists everything)" }) }),
      replay: "safe",
      outputLimits: { maxBytes: 16 * 1024 },
      execute: (args, api) => this.search(args.query, api),
    });
    this.pushSkill = defineTool({
      name: "push_skill",
      description:
        "Publish the local skills/<slug> directory as the skill's next version. The skill must be installed first " +
        "(read_skill), and maintainer-gated skills only accept pushes from the owner, the owner team, or an admin.",
      parameters: Type.Object({ slug: Type.String({ description: "The skill's slug" }) }),
      replay: "safe",
      outputLimits: { maxBytes: 4 * 1024 },
      execute: (args, api) => this.push(args.slug, api),
    });
  }

  tools(): ToolRegistration[] {
    return [this.readSkill, this.searchSkills, this.pushSkill];
  }

  /** The combined skills prompt section (spec §2.1): the conversation's
   *  stashed client `skills_index` lines first (the machine's local
   *  skills), then the org's catalog — installed skills with their pin
   *  (+ update-available) markers, then uninstalled skills clipped with
   *  the (org) marker, most-recently-updated first — under one 8192-byte
   *  budget whose overflow line points at search_skills. A slug the local
   *  lines already list never repeats. null only when BOTH halves are
   *  empty (no stash and the org has no skills); a store failure renders
   *  the section without the org portion (logged) and never throws. */
  async indexSection(orgId: string, userId: string, localIndex?: string): Promise<string | null> {
    const localLines = localLinesOf(localIndex);
    const localSlugs = new Set(localLines.map(localSlugOf).filter((slug): slug is string => slug !== null));
    let orgLines: string[] | null;
    try {
      const items = await this.deps.registry.searchSkills(orgId, "", INDEX_LIMIT);
      orgLines = items.length === 0 ? null : await this.orgLines(orgId, items, userId, localSlugs);
    } catch (error) {
      this.deps.log.warn(`skills index render failed: ${(error as Error).message}`);
      orgLines = null;
    }
    if (localLines.length === 0 && orgLines === null) return null;
    const lines = [SECTION_HEADER, SECTION_GUIDANCE, ...localLines];
    if (orgLines !== null) {
      let dropped = 0;
      for (let i = 0; i < orgLines.length; i++) {
        if (Buffer.byteLength([...lines, orgLines[i]!].join("\n"), "utf8") + OVERFLOW_RESERVE > SECTION_BUDGET) {
          dropped = orgLines.length - i;
          break;
        }
        lines.push(orgLines[i]!);
      }
      if (dropped > 0) lines.push(`(${dropped} more org skills — use search_skills)`);
    }
    return lines.join("\n");
  }

  /** The org portion's lines: installs with pin/update markers first, then
   *  uninstalled skills (clipped, (org) marker) — locally-listed slugs
   *  excluded. */
  private async orgLines(orgId: string, items: RegistryItemRow[], userId: string, exclude: Set<string>): Promise<string[]> {
    const pins = new Map((await this.deps.skills.listForUser(orgId, userId)).map((i) => [i.slug, i.pinned_version]));
    const installed: string[] = [];
    const uninstalled: string[] = [];
    for (const item of items) {
      if (exclude.has(item.slug)) continue;
      const pin = pins.get(item.slug);
      if (pin === undefined) {
        uninstalled.push(`- ${item.slug}: ${clipDescription(item.description)} (org)`);
      } else {
        const update = item.latest_version !== null && item.latest_version !== pin ? `, update available: ${item.latest_version}` : "";
        installed.push(`- ${item.slug}: ${item.description} (installed, pinned ${pin}${update})`);
      }
    }
    return [...installed, ...uninstalled];
  }

  /** Remembers the index text a turn was prepared with (the guild
   *  extension's section reuses it; Task 8 diffs it for machine sync). */
  noteTurnInput(conversationId: number, skillsIndex: string): void {
    this.lastIndex.set(conversationId as ConversationId, skillsIndex);
  }

  /** The conversation's last stashed index text. */
  stashedIndex(conversationId: number): string | undefined {
    return this.lastIndex.get(conversationId as ConversationId);
  }

  /** The fleet sync push (spec §4): the user's install list is the
   *  machine's desired state — every install becomes
   *  `{ slug, version, bundle_sha256, url }` (the bundle URL under this
   *  server's own base, fetched by the machine with its own auth), and the
   *  machine converges by fetching newer bundles and dropping
   *  locally-held slugs the list omits — an uninstall's row is gone, so
   *  absence is the removal signal and no removed tombstones are tracked.
   *  One push per machine row the hub reports live; the pushes are
   *  fire-and-forget — syncUser returns once they are dispatched, and a
   *  per-machine failure is logged without touching the other machines
   *  (the ClickHouse sink's never-throw discipline, per machine). No
   *  machine store, no machines, or a store failure → silent no-op
   *  (logged).
   *
   *  Zero installs push an empty `skills` list — a meaningful "you should
   *  have nothing" frame that converges a machine still holding the last
   *  uninstalled skill — EXCEPT at connect time: `opts.skipWhenEmpty`
   *  (set by the ws connect seam only) keeps the machine-connect frame
   *  stream free of sync traffic for skill-less users (the WS golden
   *  replay pins that stream byte-exactly). */
  async syncUser(orgId: string, userId: string, opts?: { skipWhenEmpty?: boolean }): Promise<void> {
    const machines = this.deps.machines;
    if (machines === undefined) return;
    let rows: MachineRow[];
    try {
      rows = await machines.listForUser(orgId, userId);
    } catch (error) {
      this.deps.log.warn(`skills sync skipped: machine list failed: ${(error as Error).message}`);
      return;
    }
    if (rows.length === 0) return;
    let installs: Array<{ slug: string; pinned_version: string }>;
    try {
      installs = await this.deps.skills.listForUser(orgId, userId);
    } catch (error) {
      this.deps.log.warn(`skills sync skipped: install list failed: ${(error as Error).message}`);
      return;
    }
    const skills: Array<{ slug: string; version: string; bundle_sha256: string; url?: string }> = [];
    for (const install of installs) {
      try {
        const meta = await this.deps.registry.getVersionMeta(orgId, "skill", install.slug, install.pinned_version);
        if (meta === null) {
          this.deps.log.warn(`skills sync: ${install.slug}@${install.pinned_version} has no version row — entry dropped`);
          continue;
        }
        skills.push({
          slug: install.slug,
          version: install.pinned_version,
          bundle_sha256: meta.bundle_sha256 ?? "",
          ...(this.deps.selfBaseUrl !== undefined
            ? { url: `${this.deps.selfBaseUrl}/api/v1/registry/skill/${install.slug}/${install.pinned_version}/bundle` }
            : {}),
        });
      } catch (error) {
        this.deps.log.warn(`skills sync: ${install.slug} meta lookup failed: ${(error as Error).message}`);
      }
    }
    const payload = { skills };
    // Connect-time only: zero installs → no push, so the machine connect
    // frame stream stays free of sync traffic for skill-less users (the
    // WS golden replay pins that stream). Change triggers (install/pin/
    // uninstall) always push — the empty list is the converge frame.
    if (skills.length === 0 && opts?.skipWhenEmpty === true) return;
    for (const row of rows) {
      if (this.deps.machineOnline?.(row.machine_id) === false) continue;
      const pending = this.deps.machineRequest?.({
        machineId: row.machine_id,
        orgId,
        op: "skills.sync_v1",
        payload,
      });
      if (pending === undefined) continue;
      void pending
        .then((result) => {
          if (!result.ok) {
            const detail = result.error.message !== undefined ? `: ${result.error.message}` : "";
            this.deps.log.warn(`skills sync push to ${row.machine_id} failed (${result.error.kind}${detail})`);
          }
        })
        .catch((error) => {
          this.deps.log.warn(`skills sync push to ${row.machine_id} failed: ${(error as Error).message}`);
        });
    }
  }

  // ------------------------------------------------- sandbox materialization

  /** Materializes the user's installed org skills into a server-side
   *  executor directory (spec §3): each install's pinned-version bundle is
   *  fetched from object storage via the version's object key, parsed with
   *  parseBundle, and written to `<sandboxRoot>/skills/<slug>/` (SKILL.md
   *  plus every extra file; identical files are left untouched). Failures
   *  are logged and skipped — a broken bundle never blocks a turn. No
   *  installs, no object store, or a store failure → silent no-op. */
  async materializeIntoSandbox(orgId: string, userId: string, sandboxRoot: string): Promise<void> {
    if (this.deps.objects?.get === undefined) return;
    let installs: Array<{ slug: string; pinned_version: string }>;
    try {
      installs = await this.deps.skills.listForUser(orgId, userId);
    } catch (error) {
      this.deps.log.warn(`skill materialization skipped: list installs failed: ${(error as Error).message}`);
      return;
    }
    for (const install of installs) {
      try {
        await this.materializeSkill(orgId, install.slug, install.pinned_version, sandboxRoot);
      } catch (error) {
        this.deps.log.warn(`skill ${install.slug} materialization failed: ${(error as Error).message}`);
      }
    }
  }

  /** Materializes ONE skill's pinned bundle into `<root>/skills/<slug>/`.
   *  Throws (the callers catch): the read_skill install-on-use dep wraps
   *  this with the conversation dir, materializeIntoSandbox with the loop.
   *  The bundle's manifest.json stays out of the sandbox — push_skill
   *  rebuilds it, and a materialized copy would shadow the fresh manifest
   *  on the next push. */
  async materializeSkill(orgId: string, slug: string, version: string, root: string): Promise<void> {
    const objects = this.deps.objects;
    if (objects?.get === undefined) throw new Error("no object store is configured");
    const meta = await this.deps.registry.getVersionMeta(orgId, "skill", slug, version);
    if (meta === null) throw new Error(`no such skill version: ${slug}@${version}`);
    const bundle = await objects.get(meta.object_key);
    if (meta.bundle_sha256 !== null && meta.bundle_sha256 !== "") {
      const sha256 = createHash("sha256").update(bundle).digest("hex");
      if (sha256 !== meta.bundle_sha256) {
        throw new Error(`skill ${slug}@${version} bundle sha mismatch (expected ${meta.bundle_sha256}, got ${sha256})`);
      }
    }
    const parsed = await parseBundle(bundle);
    for (const entry of parsed.entries) {
      if (!entry.file || entry.path === "manifest.json") continue;
      const dest = path.join(root, "skills", slug, entry.path);
      let existing: Buffer | undefined;
      try {
        existing = await readFile(dest);
      } catch {
        existing = undefined;
      }
      if (existing !== undefined && existing.equals(entry.content!)) continue;
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, entry.content!);
    }
  }

  // ------------------------------------------------------------------ tools

  private async identity(api: ToolExecutionApi): Promise<ChatIdentity | null> {
    const chatId = await this.deps.chatOfConversation(Number(api.conversationId));
    if (chatId === null) return null;
    const owner = await this.deps.chatOwner(chatId);
    if (owner === null) return null;
    return { chatId, orgId: owner.orgId, userId: owner.userId, role: owner.role };
  }

  private textResult(text: string, isError = false): ToolExecutionResult {
    return { content: [{ type: "text", text }], isError };
  }

  private errorResult(text: string): ToolExecutionResult {
    return this.textResult(text, true);
  }

  private async read(slug: string, api: ToolExecutionApi): Promise<ToolExecutionResult> {
    const id = await this.identity(api);
    if (id === null) return this.errorResult("no chat is bound to this conversation");
    const { orgId, userId } = id;
    const control = await this.deps.registry.itemControl(orgId, "skill", slug);
    if (control === null) return this.errorResult(`no such skill: ${slug}`);
    if (control.tombstoned) return this.errorResult(`skill ${slug} is unpublished`);
    const install = await this.deps.skills.byUserAndSlug(orgId, userId, slug);
    const version = install?.pinned_version ?? control.latest_version;
    if (version === null) return this.errorResult(`skill ${slug} has no published version`);
    let justInstalled = false;
    if (install === null) {
      await this.deps.skills.install(orgId, userId, slug, version);
      justInstalled = true;
      // Best-effort fan-out: the event feeds the activity feed, syncUser
      // (Task 8) reaches the user's machines, and Task 7's materialization
      // (executor "server") drops the files into the current sandbox — a
      // failure in any of them never blocks the read.
      try {
        await this.deps.events.emit(orgId, "skill.installed", { slug, version, user_id: userId });
      } catch (error) {
        this.deps.log.warn(`skill.installed emit failed: ${(error as Error).message}`);
      }
      await this.syncUser(orgId, userId);
      if ((await this.deps.executorKind(Number(api.conversationId))) === "server") {
        try {
          await this.deps.materialize?.({
            conversationId: Number(api.conversationId),
            chatId: id.chatId,
            orgId,
            slug,
            version,
          });
        } catch (error) {
          this.deps.log.warn(`skill materialize failed: ${(error as Error).message}`);
        }
      }
    }
    const meta = await this.deps.registry.getVersionMeta(orgId, "skill", slug, version);
    if (meta === null) return this.errorResult(`no such skill version: ${slug}@${version}`);
    try {
      const event: SkillReadEvent = {
        ts: new Date(),
        org_id: orgId,
        user_id: userId,
        team_id: null,
        slug,
        bundle_sha256: meta.bundle_sha256 ?? "",
        chat_id: id.chatId,
      };
      await this.deps.skillReads?.record(event); // the sink drops its own failures
    } catch (error) {
      this.deps.log.warn(`skill read record failed: ${(error as Error).message}`);
    }
    const parts: string[] = [];
    if (meta.skill_md_text !== null && meta.skill_md_text !== "") {
      parts.push(meta.skill_md_text);
    } else {
      parts.push(`(no SKILL.md text was recorded for ${slug}@${version})`);
    }
    const files = meta.files ?? [];
    if (files.length > 0) {
      parts.push(
        `Additional files (read with read_file):\n${files.map((f) => `- ${f.path} (sha256 ${f.sha256})`).join("\n")}`,
      );
    }
    if (justInstalled && (await this.deps.executorKind(Number(api.conversationId))) === "machine") {
      parts.push("Note: the skill was just installed — its additional files are still syncing to your machine and may not be readable yet.");
    }
    if (control.latest_version !== null && control.latest_version !== version) {
      parts.push(`Note: a newer version (${control.latest_version}) exists — ask the user before updating.`);
    }
    return this.textResult(parts.join("\n\n"));
  }

  private async search(query: string, api: ToolExecutionApi): Promise<ToolExecutionResult> {
    const id = await this.identity(api);
    if (id === null) return this.errorResult("no chat is bound to this conversation");
    const q = query.trim();
    const items = await this.deps.registry.searchSkills(id.orgId, q);
    if (items.length === 0) return this.textResult(`No org skills match "${q}".`);
    const lines = items.map((item) => `- ${item.slug}: ${item.description} (${item.latest_version ?? "no versions"})`);
    return this.textResult(`${lines.join("\n")}\n(use read_skill to read a skill)`);
  }

  private async push(slug: string, api: ToolExecutionApi): Promise<ToolExecutionResult> {
    const id = await this.identity(api);
    if (id === null) return this.errorResult("no chat is bound to this conversation");
    const { orgId, userId, role } = id;
    const install = await this.deps.skills.byUserAndSlug(orgId, userId, slug);
    if (install === null) return this.errorResult(`pull the skill with read_skill before pushing (${slug})`);
    const executor = await this.deps.executorKind(Number(api.conversationId));
    if (executor === "machine") {
      return this.errorResult("pushing from a machine is not available yet");
    }
    if (this.deps.objects === undefined) {
      return this.errorResult("pushing is unavailable: the object store is not configured");
    }
    const objects = this.deps.objects;
    const control = await this.deps.registry.itemControl(orgId, "skill", slug);
    if (control !== null && control.tombstoned) {
      return this.errorResult(`skill ${slug} is unpublished — ask an owner to republish it first`);
    }
    const isTeamMember =
      control?.owner_team_id != null ? await this.deps.teams.isMember(orgId, control.owner_team_id, userId) : false;
    try {
      await this.deps.registry.publishGate(orgId, "skill", slug, userId, role, isTeamMember);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        return this.errorResult(
          `not permitted: pushing ${slug} requires the maintainer gate's owner, owner team, or an admin`,
        );
      }
      throw error;
    }
    const collected = await this.collectTree(orgId, Number(api.conversationId), slug);
    if (typeof collected === "string") return this.errorResult(collected);
    if (!collected.has("SKILL.md")) {
      return this.errorResult(`the skills/${slug} directory has no SKILL.md`);
    }
    const versions = await this.deps.registry.itemVersions(orgId, "skill", slug);
    const version = `v${versions.length + 1}`;
    const description = control?.description ?? "";
    const manifest: Manifest = { kind: "skill", slug, version, description };
    try {
      validateManifest(manifest);
    } catch (error) {
      return this.errorResult(`invalid skill push: ${(error as Error).message}`);
    }
    const files: Record<string, Buffer> = {
      "manifest.json": Buffer.from(JSON.stringify(manifest)),
      ...Object.fromEntries(collected),
    };
    const mdText = collected.get("SKILL.md")!.toString("utf8");
    const bundle = packBundle(files);
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    // Content-addressed key, same shape as the HTTP publish internals — a
    // republish with different bytes never overwrites a superseded release.
    const key = `registry/${orgId}/skill/${slug}/${version}/${sha256}.tar.gz`;
    const skill = {
      md_text: mdText,
      files: Object.entries(files).map(([p, content]) => ({
        path: p,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    };
    await this.deps.registry.upsertVersion(
      orgId, "skill", slug, version, description, manifest, key, sha256, userId, skill,
      { userId, role, isTeamMember },
    );
    try {
      await objects.put(key, bundle);
    } catch (error) {
      return this.errorResult(`object store write failed: ${(error as Error).message}`);
    }
    try {
      await this.deps.events.emit(orgId, control !== null ? "registry.updated" : "registry.published", {
        kind: "skill",
        slug,
        version,
        user_id: userId,
      });
    } catch (error) {
      this.deps.log.warn(`registry.updated emit failed: ${(error as Error).message}`);
    }
    await this.syncUser(orgId, userId);
    const extra = collected.size - 1;
    return this.textResult(
      `Pushed ${slug} ${version} (SKILL.md + ${extra} additional file${extra === 1 ? "" : "s"}).`,
    );
  }

  /** Reads every regular file under the conversation's `skills/<slug>`
   *  directory into memory (relative path → bytes). Returns an error text
   *  when the directory is missing or unreadable. */
  private async collectTree(
    orgId: string,
    conversationId: number,
    slug: string,
  ): Promise<Map<string, Buffer> | string> {
    const root = path.join(await this.deps.conversationDir(conversationId, orgId), "skills", slug);
    const files = new Map<string, Buffer>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relPath);
        } else if (entry.isFile()) {
          files.set(relPath, await readFile(path.join(dir, entry.name)));
        }
      }
    };
    try {
      await walk(root, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return `no skills/${slug} directory in this conversation's workspace — create it (with SKILL.md) before pushing`;
      }
      return `could not read skills/${slug}: ${(error as Error).message}`;
    }
    if (files.size === 0) {
      return `no skills/${slug} directory in this conversation's workspace — create it (with SKILL.md) before pushing`;
    }
    return files;
  }
}
