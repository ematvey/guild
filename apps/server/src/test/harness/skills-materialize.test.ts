// Sandbox materialization (Task 7): SkillRuntime.materializeIntoSandbox +
// the single-skill materializeSkill helper, driven with stub deps — a temp
// sandbox root, an in-memory object store, and a registry meta stub. The
// env-factory wiring in runtime.ts rides on these two methods (spec §3:
// the chat's installed skills land under the sandbox root before the
// turn's tools run; a broken bundle never blocks the turn).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { packBundle } from "../../platform/bundle.js";
import { SkillRuntime, type SkillRuntimeDeps } from "../../harness/skills.js";

const ORG = "org-1";
const USER = "user-1";

interface MetaRow {
  manifest: unknown;
  object_key: string;
  bundle_sha256: string | null;
  publisher: string | null;
  skill_md_text: string | null;
  files: Array<{ path: string; size: number; sha256: string }> | null;
}

interface InstallRow {
  slug: string;
  pinned_version: string;
  installed_at: string;
}

interface Fixture {
  runtime: SkillRuntime;
  warns: string[];
  objects: Map<string, Buffer>;
  metas: Map<string, MetaRow>;
  installs: InstallRow[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeFixture(): Fixture {
  const objects = new Map<string, Buffer>();
  const metas = new Map<string, MetaRow>();
  const installs: InstallRow[] = [];
  const warns: string[] = [];
  const deps: SkillRuntimeDeps = {
    log: { warn: (m) => warns.push(m) },
    registry: {
      itemControl: async () => null,
      getVersionMeta: async (_orgId, _kind, slug, version) => metas.get(`${slug}@${version}`) ?? null,
      publishGate: async () => {},
      itemVersions: async () => [],
      upsertVersion: async () => {},
      searchSkills: async () => [],
    },
    skills: {
      install: async () => {
        throw new Error("not used here");
      },
      byUserAndSlug: async () => null,
      listForUser: async () => installs,
    },
    events: { emit: async () => {
      throw new Error("not used here");
    } },
    teams: { isMember: async () => false },
    objects: {
      get: async (key) => {
        const bytes = objects.get(key);
        if (bytes === undefined) throw new Error(`no object: ${key}`);
        return bytes;
      },
      put: async (key, bytes) => {
        objects.set(key, bytes);
      },
    },
    skillReads: undefined,
    chatOfConversation: async () => null,
    chatOwner: async () => null,
    executorKind: async () => null,
    conversationEnv: async () => new NodeExecutionEnv({ cwd: "/nonexistent" }),
  };
  return { runtime: new SkillRuntime(deps), warns, objects, metas, installs };
}

/** Seeds one install + a packed bundle for it (manifest.json + SKILL.md +
 *  one nested extra file), the way publish leaves the rows behind. */
function seedSkill(fx: Fixture, slug: string, version: string, md: string, extra: Record<string, string> = {}): void {
  const files: Record<string, Buffer | string> = {
    "manifest.json": JSON.stringify({ kind: "skill", slug, version, description: "d" }),
    "SKILL.md": md,
    ...extra,
  };
  const bundle = packBundle(files);
  const key = `registry/${ORG}/skill/${slug}/${version}/bundle.tar.gz`;
  fx.objects.set(key, bundle);
  fx.metas.set(`${slug}@${version}`, {
    manifest: { kind: "skill", slug, version, description: "d" },
    object_key: key,
    bundle_sha256: sha256(bundle),
    publisher: USER,
    skill_md_text: md,
    files: Object.entries(files).map(([p, content]) => ({
      path: p,
      size: Buffer.byteLength(content as string),
      sha256: sha256(Buffer.from(content as string)),
    })),
  });
  fx.installs.push({ slug, pinned_version: version, installed_at: "2026-01-01T00:00:00.000Z" });
}

const roots: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "guild-materialize-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});

describe("materializeIntoSandbox", () => {
  it("writes each installed skill's SKILL.md + extra files under <root>/skills/<slug>", async () => {
    seedSkill(fx, "hello", "v2", "# Deploy\nRun the checklist.", { "scripts/run.sh": "echo hi\n" });
    seedSkill(fx, "other", "v1", "# Other");
    const root = newRoot();
    await fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }));
    expect(readFileSync(path.join(root, "skills", "hello", "SKILL.md"), "utf8")).toBe("# Deploy\nRun the checklist.");
    expect(readFileSync(path.join(root, "skills", "hello", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    expect(readFileSync(path.join(root, "skills", "other", "SKILL.md"), "utf8")).toBe("# Other");
    // manifest.json stays out of the sandbox (push_skill would re-collect it).
    expect(existsSync(path.join(root, "skills", "hello", "manifest.json"))).toBe(false);
    expect(fx.warns).toEqual([]);
  });

  it("is a silent no-op when the user has no installs", async () => {
    const root = newRoot();
    await fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }));
    expect(existsSync(path.join(root, "skills"))).toBe(false);
    expect(fx.warns).toEqual([]);
  });

  it("logs-and-continues on a broken bundle — the other skills still land", async () => {
    seedSkill(fx, "broken", "v1", "# Broken");
    fx.objects.set(`registry/${ORG}/skill/broken/v1/bundle.tar.gz`, Buffer.from("this is not gzip"));
    seedSkill(fx, "good", "v1", "# Good");
    const root = newRoot();
    await expect(fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }))).resolves.toBeUndefined();
    expect(existsSync(path.join(root, "skills", "good", "SKILL.md"))).toBe(true);
    expect(fx.warns.length).toBeGreaterThan(0);
    expect(fx.warns[0]).toMatch(/broken/);
  });

  it("logs-and-continues when the object or the version row is missing", async () => {
    fx.installs.push({ slug: "ghost-object", pinned_version: "v1", installed_at: "t" });
    fx.metas.set("ghost-object@v1", {
      manifest: {},
      object_key: "registry/missing/key.tar.gz",
      bundle_sha256: null,
      publisher: null,
      skill_md_text: null,
      files: null,
    });
    fx.installs.push({ slug: "ghost-version", pinned_version: "v9", installed_at: "t" });
    seedSkill(fx, "good", "v1", "# Good");
    const root = newRoot();
    await expect(fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }))).resolves.toBeUndefined();
    expect(existsSync(path.join(root, "skills", "good", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(root, "skills", "ghost-object"))).toBe(false);
    expect(existsSync(path.join(root, "skills", "ghost-version"))).toBe(false);
    expect(fx.warns.length).toBe(2);
  });

  it("skips a bundle whose bytes do not match the recorded sha256", async () => {
    seedSkill(fx, "tampered", "v1", "# Tampered");
    fx.objects.set(`registry/${ORG}/skill/tampered/v1/bundle.tar.gz`, packBundle({
      "manifest.json": "{}",
      "SKILL.md": "# Swapped",
    }));
    seedSkill(fx, "good", "v1", "# Good");
    const root = newRoot();
    await expect(fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }))).resolves.toBeUndefined();
    expect(existsSync(path.join(root, "skills", "tampered"))).toBe(false);
    expect(existsSync(path.join(root, "skills", "good", "SKILL.md"))).toBe(true);
  });

  it("overwrites an existing slug dir with new content but leaves identical files untouched", async () => {
    seedSkill(fx, "hello", "v1", "# V1 body");
    const root = newRoot();
    await fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }));
    const mdPath = path.join(root, "skills", "hello", "SKILL.md");
    expect(readFileSync(mdPath, "utf8")).toBe("# V1 body");
    // Age the file, then re-materialize unchanged: the identical file is
    // skipped (mtime stays aged), the stale extra file is replaced.
    utimesSync(mdPath, new Date(0), new Date(0));
    const runPath = path.join(root, "skills", "hello", "scripts", "run.sh");
    fx.objects.set(
      `registry/${ORG}/skill/hello/v1/bundle.tar.gz`,
      packBundle({
        "manifest.json": JSON.stringify({ kind: "skill", slug: "hello", version: "v1", description: "d" }),
        "SKILL.md": "# V1 body",
        "scripts/run.sh": "echo v1b\n",
      }),
    );
    fx.metas.set("hello@v1", {
      manifest: { kind: "skill", slug: "hello", version: "v1", description: "d" },
      object_key: `registry/${ORG}/skill/hello/v1/bundle.tar.gz`,
      bundle_sha256: sha256(fx.objects.get(`registry/${ORG}/skill/hello/v1/bundle.tar.gz`)!),
      publisher: USER,
      skill_md_text: "# V1 body",
      files: null,
    });
    await fx.runtime.materializeIntoSandbox(ORG, USER, new NodeExecutionEnv({ cwd: root }));
    expect(readFileSync(runPath, "utf8")).toBe("echo v1b\n");
    expect(statSync(mdPath).mtimeMs).toBe(0);
  });
});

describe("materializeSkill (the read_skill install-on-use dep)", () => {
  it("materializes a single skill into the given dir", async () => {
    seedSkill(fx, "solo", "v3", "# Solo", { "refs/a.md": "A" });
    const root = newRoot();
    await fx.runtime.materializeSkill(ORG, "solo", "v3", new NodeExecutionEnv({ cwd: root }));
    expect(readFileSync(path.join(root, "skills", "solo", "SKILL.md"), "utf8")).toBe("# Solo");
    expect(readFileSync(path.join(root, "skills", "solo", "refs", "a.md"), "utf8")).toBe("A");
  });

  it("throws for a missing object (the read_skill caller catches)", async () => {
    fx.installs.push({ slug: "ghost", pinned_version: "v1", installed_at: "t" });
    const root = newRoot();
    await expect(fx.runtime.materializeSkill(ORG, "ghost", "v1", new NodeExecutionEnv({ cwd: root }))).rejects.toThrow(/no object|no such skill version/);
  });
});
