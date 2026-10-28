// Skill tools (Task 5): the read_skill/search_skills/push_skill execute
// handlers driven directly with stub deps — no DB, no harness — plus the
// new store surfaces (RegistryStore.searchSkills, ChatStore.ownerOf)
// against a disposable database.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { SkillRuntime, descriptionFromSkillMd, type SkillRuntimeDeps } from "../../harness/skills.js";
import { packBundle } from "../../platform/bundle.js";
import { ApiError } from "../../platform/errors.js";
import { RegistryStore } from "../../platform/store/registry.js";
import { ChatStore } from "../../platform/store/chats.js";
import { createM5TestEnv, type M5TestEnv } from "../platform/m5-harness.js";

const ORG = "org-1";
const USER = "user-1";
const CHAT = "chat-1";
const API = { conversationId: 7, callId: "call-1" } as unknown as ToolExecutionApi;
const CTX = {} as Context;

interface Recorded {
  installs: Array<{ orgId: string; userId: string; slug: string; version: string | null }>;
  emitted: Array<{ orgId: string; kind: string; payload: unknown }>;
  reads: Array<Record<string, unknown>>;
  materialized: Array<Record<string, unknown>>;
  upserts: Array<{ orgId: string; kind: string; slug: string; version: string; description: string }>;
  puts: Array<{ key: string; bytes: Buffer }>;
}

interface FakeOptions {
  control?: Record<string, unknown> | null;
  dir?: string;
  meta?: Record<string, unknown> | null;
  versions?: Array<{ version: string }>;
  install?: { slug: string; pinned_version: string | null; installed_at: string } | null;
  gate?: "allow" | "forbidden";
  search?: Array<{
    slug: string;
    description: string;
    latest_version: string | null;
    review_status: string;
    publisher?: string | null;
    published_at?: string | null;
    owner_kind?: "user" | "team" | null;
    owner_label?: string | null;
    forked_from?: string | null;
  }>;
  executor?: "machine" | "server" | null;
  /** Extra files served from the object store on a registry read. */
  bundleFiles?: Record<string, string>;
}

function fakeDeps(options: FakeOptions): { deps: SkillRuntimeDeps; recorded: Recorded } {
  const recorded: Recorded = { installs: [], emitted: [], reads: [], materialized: [], upserts: [], puts: [] };
  const control =
    options.control === undefined
      ? {
          owner_user_id: null,
          owner_team_id: "team-1",
          owner_label: "CSM",
          maintainer_gated: false,
          tombstoned: false,
          latest_version: "v2",
          description: "A skill",
          forked_from: null,
        }
      : options.control;
  const meta =
    options.meta === undefined
      ? {
          manifest: { kind: "skill", slug: "hello", version: "v2", description: "A skill" },
          object_key: "skills/hello/v2/sha",
          bundle_sha256: "cafe",
          publisher: USER,
          publisher_label: "Dana Levi",
          published_at: "2026-05-12T09:00:00.000Z",
          skill_md_text: "# Deploy\nRun the deploy checklist.",
          files: [
            { path: "scripts/run.sh", size: 12, sha256: "deadbeef" },
            { path: "manifest.json", size: 95, sha256: "beefcafe" },
          ],
        }
      : options.meta;
  const deps: SkillRuntimeDeps = {
    log: { warn: () => {} },
    registry: {
      itemControl: async () => (control as never) ?? null,
      getVersionMeta: async (_orgId, _kind, _slug, _version) => (meta as never) ?? null,
      publishGate: async () => {
        if (options.gate === "forbidden") throw ApiError.forbidden();
      },
      itemVersions: async () => (options.versions ?? [{ version: "v1" }]) as never,
      upsertVersion: async (orgId, kind, slug, version, description) => {
        recorded.upserts.push({ orgId, kind, slug, version, description });
      },
      searchSkills: async (_orgId, q) => (options.search ?? []).filter((r) => r.slug.includes(q)) as never,
    },
    skills: {
      install: async (orgId, userId, slug, version) => {
        recorded.installs.push({ orgId, userId, slug, version });
        return { slug, pinned_version: version, installed_at: "2026-01-01T00:00:00.000Z" };
      },
      byUserAndSlug: async () => options.install ?? null,
      listForUser: async () => (options.install ? [options.install] : []),
    },
    events: {
      emit: async (orgId, kind, payload) => {
        recorded.emitted.push({ orgId, kind, payload });
        return { id: "e1", org_id: orgId, kind, payload, created_at: "2026-01-01T00:00:00.000Z" };
      },
    },
    teams: { isMember: async () => true },
    objects: {
      put: async (key, bytes) => {
        recorded.puts.push({ key, bytes });
      },
      ...(options.bundleFiles === undefined
        ? {}
        : {
            get: async () =>
              await packBundle(
                Object.fromEntries(
                  Object.entries(options.bundleFiles!).map(([file, body]) => [file, Buffer.from(body, "utf8")]),
                ),
              ),
          }),
    },
    skillReads: {
      record: async (event) => {
        recorded.reads.push(event as unknown as Record<string, unknown>);
      },
    },
    chatOfConversation: async () => CHAT,
    chatOwner: async () => ({ orgId: ORG, userId: USER, role: "member" }),
    executorKind: async () => options.executor ?? null,
    conversationEnv: async () => new NodeExecutionEnv({ cwd: options.dir ?? "/nonexistent" }),
    materialize: async (args) => {
      recorded.materialized.push(args as unknown as Record<string, unknown>);
    },
  };
  return { deps, recorded };
}

function text(result: ToolExecutionResult): string {
  const block = (result.output as Array<{ type: string; text?: string }> | undefined)?.[0];
  return block?.text ?? "";
}

function makeRuntime(deps: SkillRuntimeDeps): SkillRuntime {
  return new SkillRuntime(deps);
}

// ------------------------------------------------------------------ read_skill

describe("read_skill", () => {
  it("404-texts a missing slug", async () => {
    const { deps } = fakeDeps({ control: null });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "ghost" }, API, CTX,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no such skill/i);
  });

  it("404-texts a tombstoned skill", async () => {
    const { deps } = fakeDeps({ control: { tombstoned: true, latest_version: "v1", description: "x", owner_user_id: null, owner_team_id: null, maintainer_gated: false, forked_from: null } });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no such skill|unpublished/i);
  });

  it("reads the pinned version, lists extra files, records the read", async () => {
    const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
    const { deps, recorded } = fakeDeps({ install, executor: "server" });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBeFalsy();
    const body = text(result);
    expect(body).toContain(
      "Provenance: hello — version v1, published by Dana Levi, on 2026-05-12, owner team CSM, bundle sha256 cafe.",
    );
    expect(body).toContain("# Deploy");
    // No object-store read here, so the extra file stays a name + hash.
    expect(body).toContain("Additional files not shown inline (binary, or over the output budget):");
    expect(body).toContain("- scripts/run.sh (sha256 deadbeef)");
    // manifest.json is bundle metadata installs never materialize — agents
    // must not be pointed at a file that cannot exist locally.
    expect(body).not.toContain("manifest.json");
    expect(recorded.installs).toHaveLength(0);
    expect(recorded.materialized).toHaveLength(0);
    expect(recorded.reads).toEqual([
      expect.objectContaining({ slug: "hello", chat_id: CHAT, user_id: USER, org_id: ORG, bundle_sha256: "cafe" }),
    ]);
  });

  it("serves the latest version for an unpinned install, and the pin when one is set", async () => {
    const unpinned = fakeDeps({
      install: { slug: "hello", pinned_version: null, installed_at: "2026-01-01T00:00:00.000Z" },
    });
    const readUnpinned = makeRuntime(unpinned.deps).tools().find((t) => t.name === "read_skill")!;
    const latest = await (readUnpinned.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(text(latest)).toContain("version v2");
    // An existing install is not re-installed by a read.
    expect(unpinned.recorded.installs).toHaveLength(0);

    const pinned = fakeDeps({
      install: { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" },
    });
    const readPinned = makeRuntime(pinned.deps).tools().find((t) => t.name === "read_skill")!;
    const atPin = await (readPinned.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(text(atPin)).toContain("version v1");
    expect(text(atPin)).toContain("newer version (v2)");
  });

  it("serves a registry skill's extra files inline, so no copy is needed on disk", async () => {
    const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
    const { deps } = fakeDeps({
      install,
      executor: "server",
      bundleFiles: {
        "manifest.json": '{"kind":"skill","slug":"hello","version":"v1","description":"A skill"}',
        "SKILL.md": "# Deploy\nRun the deploy checklist.",
        "scripts/run.sh": "echo deploy\n",
      },
    });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    const body = text(result);
    expect(body).toContain("--- scripts/run.sh ---");
    expect(body).toContain("echo deploy");
    expect(body).not.toContain("not shown inline");
  });

  it("installs on first use, emits skill.installed, materializes into the server sandbox", async () => {
    const { deps, recorded } = fakeDeps({ install: null, executor: "server" });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBeFalsy();
    // Installed without a pin: the row follows the latest version.
    expect(recorded.installs).toEqual([{ orgId: ORG, userId: USER, slug: "hello", version: null }]);
    expect(recorded.emitted).toEqual([
      expect.objectContaining({ orgId: ORG, kind: "skill.installed" }),
    ]);
    expect(recorded.materialized).toEqual([
      expect.objectContaining({ conversationId: 7, chatId: CHAT, orgId: ORG, slug: "hello", version: "v2" }),
    ]);
    expect(text(result)).not.toMatch(/sync/i);
  });

  it("notes the syncing state on a machine right after install-on-use", async () => {
    const { deps } = fakeDeps({ install: null, executor: "machine" });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/sync/i);
  });

  it("notes a newer version when pinned behind latest", async () => {
    const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
    const { deps } = fakeDeps({ install, executor: "server" });
    const runtime = makeRuntime(deps);
    const read = runtime.tools().find((t) => t.name === "read_skill")!;
    const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/a newer version \(v2\) exists — ask the user before updating\./);
  });
});

// --------------------------------------------- read_skill — local tree first

describe("read_skill local-first", () => {
  it("reads the LOCAL skills/<slug> tree when present — no install, no org read, no materialization", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-read-local-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello", "scripts"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "SKILL.md"), "# Local body\nFrom the workspace tree.", "utf8");
      writeFileSync(path.join(dir, "skills", "hello", "scripts", "run.sh"), "echo hi\n", "utf8");
      const { deps, recorded } = fakeDeps({ dir, executor: "server" });
      const runtime = makeRuntime(deps);
      const read = runtime.tools().find((t) => t.name === "read_skill")!;
      const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      const body = text(result);
      expect(body).toContain("Local skill");
      expect(body).toContain("From the workspace tree.");
      expect(body).toContain("Additional files (read with read_file):");
      expect(body).toContain("- scripts/run.sh");
      expect(body).not.toContain("sha256");
      // A local read is a workspace read, not an org read: no install
      // record, no skill.installed event, no skill_reads row, no sync.
      expect(recorded.installs).toHaveLength(0);
      expect(recorded.reads).toHaveLength(0);
      expect(recorded.emitted).toHaveLength(0);
      expect(recorded.materialized).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local-wins: notes the org registry's latest version alongside the local body", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-read-over-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "SKILL.md"), "# Local body\n", "utf8");
      const { deps, recorded } = fakeDeps({ dir, executor: "server" });
      const runtime = makeRuntime(deps);
      const read = runtime.tools().find((t) => t.name === "read_skill")!;
      const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      const body = text(result);
      expect(body).toContain("# Local body");
      expect(body).not.toContain("# Deploy");
      expect(body).toContain(
        "the org registry has hello at v2 (owner team CSM) — pushing publishes your local tree as the next version",
      );
      expect(recorded.installs).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a local tree WITHOUT SKILL.md falls through to the org path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-read-nomd-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "notes.txt"), "no manifest here", "utf8");
      const { deps, recorded } = fakeDeps({ dir, executor: "server" });
      const runtime = makeRuntime(deps);
      const read = runtime.tools().find((t) => t.name === "read_skill")!;
      const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain("# Deploy");
      expect(recorded.reads).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a tombstoned org twin carries no version note on a local read", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-read-tomb-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "SKILL.md"), "# Local body\n", "utf8");
      const { deps } = fakeDeps({
        dir,
        control: { tombstoned: true, latest_version: "v2", description: "x", owner_user_id: null, owner_team_id: null, maintainer_gated: false, forked_from: null },
      });
      const runtime = makeRuntime(deps);
      const read = runtime.tools().find((t) => t.name === "read_skill")!;
      const result = await (read.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      expect(text(result)).not.toContain("the org registry has");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("descriptionFromSkillMd", () => {
  it("takes the first non-empty, non-heading line", () => {
    expect(descriptionFromSkillMd("# Title\n\nDeploy the service safely.\nMore text.\n")).toBe(
      "Deploy the service safely.",
    );
  });

  it("prefers the frontmatter's folded block scalar", () => {
    const md = [
      "---",
      "name: hubspot-investigate",
      "description: >-",
      "  Investigate how OUR HubSpot portal works and how it is structured. Use this",
      "  skill for any question about the CRM: objects, pipelines, record volumes.",
      "---",
      "",
      "# Investigate our HubSpot",
    ].join("\n");
    expect(descriptionFromSkillMd(md)).toBe(
      "Investigate how OUR HubSpot portal works and how it is structured. Use this " +
        "skill for any question about the CRM: objects, pipelines, record volumes.",
    );
  });

  it("reads literal block scalars, quoted and bare-key values", () => {
    const literal = "---\ndescription: |\n  First line.\n  Second line.\n---\nbody";
    expect(descriptionFromSkillMd(literal)).toBe("First line.\nSecond line.");
    expect(descriptionFromSkillMd('---\ndescription: "Quoted text"\n---\n')).toBe("Quoted text");
    expect(descriptionFromSkillMd("---\ndescription:\n  plain continuation\n  lines here\n---\n")).toBe(
      "plain continuation lines here",
    );
  });

  it("falls back to the body when the frontmatter has no description", () => {
    expect(descriptionFromSkillMd("---\nname: x\n---\n\nBody line first.")).toBe("Body line first.");
  });

  it("skips heading-only openings and empty text yields empty", () => {
    expect(descriptionFromSkillMd("# Title\n## Sub\n\nReal line here.")).toBe("Real line here.");
    expect(descriptionFromSkillMd("\n\n   \n")).toBe("");
    expect(descriptionFromSkillMd("")).toBe("");
  });

  it("truncates at 200 chars on a word boundary", () => {
    const long = `A ${"word ".repeat(60)}tail`; // > 200 chars, single paragraph
    const out = descriptionFromSkillMd(`# T\n${long}\n`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(" ")).toBe(false);
    expect(out.startsWith("A word")).toBe(true);
    expect(long.startsWith(out)).toBe(true);
    // A word longer than the budget is hard-cut.
    expect(descriptionFromSkillMd("x".repeat(250)).length).toBe(200);
  });
});

describe("search_skills", () => {
  it("lists hits and points at read_skill", async () => {
    const { deps } = fakeDeps({
      search: [{ slug: "hello-skill", description: "A skill", latest_version: "v2", review_status: "approved" }],
    });
    const runtime = makeRuntime(deps);
    const search = runtime.tools().find((t) => t.name === "search_skills")!;
    const result = await (search.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { query: "hello" }, API, CTX,
    );
    expect(result.isError).toBeFalsy();
    const body = text(result);
    expect(body).toContain("- hello-skill: A skill (v2)");
    expect(body).toContain("(use read_skill to read a skill)");
  });

  it("carries the publisher, date and owner of every hit", async () => {
    const { deps } = fakeDeps({
      search: [
        {
          slug: "hello-skill",
          description: "A skill",
          latest_version: "v2",
          review_status: "approved",
          publisher: "Dana Levi",
          published_at: "2026-05-12T09:00:00.000Z",
          owner_kind: "team",
          owner_label: "CSM",
          forked_from: "ops-base@v1",
        },
      ],
    });
    const runtime = makeRuntime(deps);
    const search = runtime.tools().find((t) => t.name === "search_skills")!;
    const result = await (search.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { query: "hello" }, API, CTX,
    );
    expect(text(result)).toContain(
      "- hello-skill: A skill (v2)\n  published by Dana Levi, on 2026-05-12, owner team CSM, forked from ops-base@v1",
    );
  });

  it("renders the empty-result line", async () => {
    const { deps } = fakeDeps({ search: [] });
    const runtime = makeRuntime(deps);
    const search = runtime.tools().find((t) => t.name === "search_skills")!;
    const result = await (search.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { query: "nope" }, API, CTX,
    );
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe('No org skills match "nope".');
  });
});

// ------------------------------------------------------------------ push_skill

describe("push_skill", () => {
  it("pushes a BRAND-NEW slug: v1, derived description, registry.published, no install precondition", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-push-new-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "SKILL.md"), "# Deploy\n\nRun the deploy checklist.\n", "utf8");
      const { deps, recorded } = fakeDeps({ dir, executor: "server", control: null, install: null, versions: [] });
      const runtime = makeRuntime(deps);
      const push = runtime.tools().find((t) => t.name === "push_skill")!;
      const result = await (push.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain("new org skill (now in the catalog)");
      expect(recorded.upserts).toEqual([
        { orgId: ORG, kind: "skill", slug: "hello", version: "v1", description: "Run the deploy checklist." },
      ]);
      expect(recorded.emitted.map((e) => e.kind)).toContain("registry.published");
      expect(recorded.puts).toHaveLength(1);
      // Publish auto-installs for the pusher, unpinned.
      expect(recorded.installs).toEqual([{ orgId: ORG, userId: USER, slug: "hello", version: null }]);
      expect(recorded.emitted.map((e) => e.kind)).toContain("skill.installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not available from a machine", async () => {
    const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
    const { deps } = fakeDeps({ install, executor: "machine" });
    const runtime = makeRuntime(deps);
    const push = runtime.tools().find((t) => t.name === "push_skill")!;
    const result = await (push.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/pushing from a machine is not available yet/);
  });

  it("reports gate refusals as error results, not throws", async () => {
    const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
    const { deps, recorded } = fakeDeps({ install, executor: "server", gate: "forbidden" });
    const runtime = makeRuntime(deps);
    const push = runtime.tools().find((t) => t.name === "push_skill")!;
    const result = await (push.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
      { slug: "hello" }, API, CTX,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not permitted/);
    expect(recorded.upserts).toHaveLength(0);
    expect(recorded.puts).toHaveLength(0);
  });

  it("publishes the sandbox tree as the next version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-push-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello", "scripts"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "SKILL.md"), "# Deploy\nRun the checklist.", "utf8");
      writeFileSync(path.join(dir, "skills", "hello", "scripts", "run.sh"), "echo hi\n", "utf8");
      const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
      const { deps, recorded } = fakeDeps({ install, executor: "server", versions: [{ version: "v1" }] });
      (deps as unknown as { conversationEnv: () => Promise<NodeExecutionEnv> }).conversationEnv = async () => new NodeExecutionEnv({ cwd: dir });
      const runtime = makeRuntime(deps);
      const push = runtime.tools().find((t) => t.name === "push_skill")!;
      const result = await (push.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain("v2");
      expect(recorded.upserts).toEqual([
        { orgId: ORG, kind: "skill", slug: "hello", version: "v2", description: "A skill" },
      ]);
      expect(recorded.puts).toHaveLength(1);
      expect(recorded.emitted.map((e) => e.kind)).toContain("registry.updated");
      // The bundle carries the collected tree (SKILL.md + the extra file).
      const bundle = recorded.puts[0]!.bytes;
      expect(bundle.length).toBeGreaterThan(0);
    expect(bundle.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("publishes max+1 across a version gap (v1,v3 → v4, never an overwrite)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-push-gap-"));
    try {
      mkdirSync(path.join(dir, "skills", "hello"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "hello", "SKILL.md"), "# Deploy\nRun the checklist.", "utf8");
      const install = { slug: "hello", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
      const { deps, recorded } = fakeDeps({
        install,
        executor: "server",
        versions: [{ version: "v1" }, { version: "v3" }],
      });
      (deps as unknown as { conversationEnv: () => Promise<NodeExecutionEnv> }).conversationEnv = async () => new NodeExecutionEnv({ cwd: dir });
      const runtime = makeRuntime(deps);
      const push = runtime.tools().find((t) => t.name === "push_skill")!;
      const result = await (push.execute as (args: unknown, api: ToolExecutionApi, ctx: Context) => Promise<ToolExecutionResult>)(
        { slug: "hello" }, API, CTX,
      );
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain("v4");
      expect(recorded.upserts).toEqual([
        { orgId: ORG, kind: "skill", slug: "hello", version: "v4", description: "A skill" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------- runtime-level surfaces

describe("SkillRuntime surfaces", () => {
  it("indexSection renders the combined catalog with install marks", async () => {
    const install = { slug: "hello-skill", pinned_version: "v1", installed_at: "2026-01-01T00:00:00.000Z" };
    const { deps } = fakeDeps({
      install,
      search: [
        { slug: "hello-skill", description: "A skill", latest_version: "v2", review_status: "approved" },
        { slug: "other-skill", description: "Another", latest_version: "v1", review_status: "draft" },
      ],
    });
    const runtime = makeRuntime(deps);
    const section = await runtime.indexSection(ORG, USER);
    expect(section).toContain("- hello-skill: A skill (installed, pinned v1, update available: v2)");
    expect(section).toContain("- other-skill: Another (org)");
  });

  it("indexSection is null when the org has no skills", async () => {
    const { deps } = fakeDeps({ search: [] });
    const runtime = makeRuntime(deps);
    expect(await runtime.indexSection(ORG, USER)).toBeNull();
  });

  it("syncUser is a no-op (Task 8 fills it) and noteTurnInput stashes the index", async () => {
    const { deps } = fakeDeps({});
    const runtime = makeRuntime(deps);
    await expect(runtime.syncUser(ORG, USER)).resolves.toBeUndefined();
    runtime.noteTurnInput(7, "index text");
    expect(runtime.stashedIndex(7)).toBe("index text");
    expect(runtime.stashedIndex(8)).toBeUndefined();
  });
});

// ------------------------------------------------ new store surfaces (real DB)

describe("store surfaces", () => {
  let env: M5TestEnv | undefined;
  let registry: RegistryStore;
  let chats: ChatStore;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    env = await createM5TestEnv();
    registry = new RegistryStore(env.db);
    chats = new ChatStore(env.db);
    await env.db.query("INSERT INTO orgs (id, name) VALUES (gen_random_uuid(), 'skill-tools-org')");
    const u = await env.db.query<{ id: string; org_id: string }>(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       SELECT gen_random_uuid(), id, 'skill-tools@example.test', '', 'member', 'managed' FROM orgs WHERE name = 'skill-tools-org'
       RETURNING id, org_id`,
    );
    userId = u.rows[0]!.id;
    orgId = u.rows[0]!.org_id;
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("searchSkills matches slug/description/SKILL.md and hides tombstoned", async () => {
    const seed = async (slug: string, description: string, md: string | null, tombstoned = false) => {
      const item = await env!.db.query<{ id: string }>(
        `INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version, tombstoned_at)
         VALUES (gen_random_uuid(), $1, 'skill', $2, $3, 'v1', $4) RETURNING id`,
        [orgId, slug, description, tombstoned ? new Date() : null],
      );
      await env!.db.query(
        `INSERT INTO registry_versions (id, item_id, version, manifest, object_key, skill_md_text)
         VALUES (gen_random_uuid(), $1, 'v1', '{}', 'k', $2)`,
        [item.rows[0]!.id, md],
      );
    };
    await seed("deploy-helper", "Deploy checklist helper", "Run the deploy checklist carefully.");
    await seed("log-tailer", "Tails logs", "The word needle appears here.");
    await seed("ghost-skill", "Deploy helper ghost", null, true);

    expect((await registry.searchSkills(orgId, "deploy")).map((r) => r.slug)).toEqual(["deploy-helper"]);
    expect((await registry.searchSkills(orgId, "needle")).map((r) => r.slug)).toEqual(["log-tailer"]);
    // Empty-q listing: most-recently-updated first (log-tailer was seeded
    // later), so the index's discovery surface leads with fresh work.
    expect((await registry.searchSkills(orgId, "")).map((r) => r.slug)).toEqual(["log-tailer", "deploy-helper"]);
    expect((await registry.searchSkills(orgId, "nothing-matches-this")).length).toBe(0);
  });

  it("searchSkills carries the latest version's publisher, date, owner and fork origin", async () => {
    const item = await env!.db.query<{ id: string }>(
      `INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version, owner_user_id, forked_from)
       VALUES (gen_random_uuid(), $1, 'skill', 'provenance-skill', 'Has provenance', 'v2', $2, 'base-skill@v1')
       RETURNING id`,
      [orgId, userId],
    );
    await env!.db.query(
      `INSERT INTO registry_versions (id, item_id, version, manifest, object_key, published_by, published_at)
       VALUES (gen_random_uuid(), $1, 'v2', '{}', 'k', $2, '2026-05-12T09:00:00Z')`,
      [item.rows[0]!.id, userId],
    );
    const [row] = await registry.searchSkills(orgId, "provenance-skill");
    // The label is the display name, falling back to the email.
    expect(row).toMatchObject({
      slug: "provenance-skill",
      publisher: "skill-tools@example.test",
      owner_kind: "user",
      owner_label: "skill-tools@example.test",
      forked_from: "base-skill@v1",
    });
    expect(row!.published_at).toBe("2026-05-12T09:00:00Z");
    // The agent tools read the same provenance from the item's control row.
    const control = await registry.itemControl(orgId, "skill", "provenance-skill");
    expect(control?.owner_label).toBe("skill-tools@example.test");
    const meta = await registry.getVersionMeta(orgId, "skill", "provenance-skill", "v2");
    expect(meta?.publisher_label).toBe("skill-tools@example.test");
    expect(meta?.published_at).toBe("2026-05-12T09:00:00Z");
  });

  it("ownerOf resolves the chat's org and owner account, null when absent", async () => {
    const c = await env!.db.query<{ id: string }>(
      `INSERT INTO chats (id, org_id, user_id, title) VALUES (gen_random_uuid(), $1, $2, 't') RETURNING id`,
      [orgId, userId],
    );
    const owner = await chats.ownerOf(c.rows[0]!.id);
    expect(owner).toEqual({
      org_id: orgId,
      user_id: userId,
      email: "skill-tools@example.test",
      display_name: null,
      role: "member",
    });
    expect(await chats.ownerOf("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
