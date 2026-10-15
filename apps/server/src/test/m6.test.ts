// M6 long-tail suites: registry (incl. integration install), releases,
// projects, teams, admin users/prompts/integration reads, and the web UI
// serving + Faro ingest, against a disposable guild_m6_test_* database and
// rustfs bucket.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createM6TestEnv, packBundle, type M6TestEnv } from "./platform/m6-harness.js";
import { hashPassword } from "../platform/crypto.js";
import { versionGt, toRfc3339Offset } from "../platform/http/releases.js";

const PASSWORD = "hunter226";

interface Env {
  env: M6TestEnv;
  adminToken: string;
  memberToken: string;
  adminId: string;
  memberId: string;
  orgId: string;
}

let e: Env;

beforeAll(async () => {
  const env = await createM6TestEnv();
  const orgId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `m6-admin-${suffix}@example.test`;
  const memberEmail = `m6-member-${suffix}@example.test`;
  const hash = await hashPassword(PASSWORD);
  await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'm6 test org')", [orgId]);
  await env.db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed')",
    [adminId, orgId, adminEmail, hash, memberId, memberEmail],
  );
  const login = async (email: string): Promise<string> => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    return (JSON.parse(res.body) as { token: string }).token;
  };
  e = {
    env,
    adminToken: await login(adminEmail),
    memberToken: await login(memberEmail),
    adminId,
    memberId,
    orgId,
  };
  // A registered machine for the member (project bindability).
  await env.db.query(
    "INSERT INTO machines (machine_id, org_id, user_id) VALUES ($1, $2, $3)",
    ["machine-1", orgId, memberId],
  );
}, 120_000);

afterAll(async () => {
  await e?.env.cleanup();
}, 60_000);

interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  raw: Buffer;
}

const inject = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  token: string,
  payload?: unknown,
): Promise<Reply> => {
  const isBuffer = Buffer.isBuffer(payload);
  return e.env.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined || isBuffer
        ? {}
        : { "content-type": "application/json" }),
      ...(isBuffer ? { "content-type": "application/octet-stream" } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  }) as unknown as Promise<Reply>;
};

function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------- registry

const SKILL_MANIFEST = {
  kind: "skill",
  slug: "hello-skill",
  version: "1.0.0",
  description: "A hello skill",
};

describe("M6 registry", () => {
  it("publishes a skill bundle, lists it and its versions", async () => {
    const bundle = await packBundle({
      "manifest.json": JSON.stringify(SKILL_MANIFEST),
      "SKILL.md": "---\nname: hello-skill\ndescription: A hello skill\n---\n# hello",
    });
    const res = await inject("POST", "/api/v1/registry/skill?slug=hello-skill&version=1.0.0", e.memberToken, bundle);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ slug: "hello-skill", version: "1.0.0" });

    const list = await inject("GET", "/api/v1/registry/skill", e.memberToken);
    expect(list.statusCode).toBe(200);
    const items = (json(list)["items"] ?? []) as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      slug: "hello-skill",
      description: "A hello skill",
      latest_version: "1.0.0",
      review_status: "draft",
    });

    const versions = await inject("GET", "/api/v1/registry/skill/hello-skill", e.memberToken);
    expect(versions.statusCode).toBe(200);
    const vrows = (json(versions)["versions"] ?? []) as Record<string, unknown>[];
    expect(vrows).toHaveLength(1);
    expect(vrows[0]!.version).toBe("1.0.0");
    expect(vrows[0]!.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid kinds and manifest/path mismatches", async () => {
    const bad = await inject("GET", "/api/v1/registry/other", e.memberToken);
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toEqual({ code: "bad_request", message: "kind must be skill, mcp, or integration" });

    const missing = await inject("POST", "/api/v1/registry/skill?slug=hello-skill", e.memberToken, Buffer.alloc(0));
    expect(missing.statusCode).toBe(400);
    expect(json(missing).error).toMatchObject({ message: "missing version query param" });

    const wrongSlug = await packBundle({ "manifest.json": JSON.stringify(SKILL_MANIFEST) });
    const slugRes = await inject("POST", "/api/v1/registry/skill?slug=nope&version=1.0.0", e.memberToken, wrongSlug);
    expect(slugRes.statusCode).toBe(400);
    expect(json(slugRes).error).toMatchObject({ message: "manifest slug hello-skill does not match query slug nope" });

    const noMd = await packBundle({ "manifest.json": JSON.stringify({ ...SKILL_MANIFEST, version: "2.0.0" }) });
    const mdRes = await inject("POST", "/api/v1/registry/skill?slug=hello-skill&version=2.0.0", e.memberToken, noMd);
    expect(mdRes.statusCode).toBe(400);
    expect(json(mdRes).error).toMatchObject({ message: "skill bundles must contain SKILL.md at the root" });
  });

  it("guards the review flow: approval binds version+hash, drift is a 409", async () => {
    const bare = await inject("POST", "/api/v1/registry/skill/hello-skill/review", e.adminToken, {
      status: "approved",
    });
    expect(bare.statusCode).toBe(400);
    expect(json(bare).error).toMatchObject({ message: "approval requires reviewed_version and reviewed_bundle_sha256" });

    const stale = await inject("POST", "/api/v1/registry/skill/hello-skill/review", e.adminToken, {
      status: "approved",
      reviewed_version: "9.9.9",
      reviewed_bundle_sha256: "ab".repeat(32),
    });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).error).toMatchObject({ code: "reviewed_version_stale" });

    const sha = ((json(await inject("GET", "/api/v1/registry/skill/hello-skill", e.memberToken))["versions"] ??
      []) as { bundle_sha256: string }[])[0]!.bundle_sha256;
    const wrongSha = await inject("POST", "/api/v1/registry/skill/hello-skill/review", e.adminToken, {
      status: "approved",
      reviewed_version: "1.0.0",
      reviewed_bundle_sha256: "ab".repeat(32),
    });
    expect(wrongSha.statusCode).toBe(409);
    expect(json(wrongSha).error).toMatchObject({ code: "reviewed_bundle_stale" });

    const ok = await inject("POST", "/api/v1/registry/skill/hello-skill/review", e.adminToken, {
      status: "approved",
      reviewed_version: "1.0.0",
      reviewed_bundle_sha256: sha,
    });
    expect(ok.statusCode).toBe(200);

    // Members can now download exactly the approved bundle.
    const dl = await inject("GET", "/api/v1/registry/skill/hello-skill/1.0.0/bundle", e.memberToken);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/gzip");

    // A republish the approval doesn't cover resets review to draft; and
    // skills are exempt from the review gate (spec §1.3: published =
    // live), so members download even never-reviewed skill versions.
    const bundle2 = await packBundle({
      "manifest.json": JSON.stringify({ ...SKILL_MANIFEST, version: "2.0.0" }),
      "SKILL.md": "hello",
    });
    const pub2 = await inject("POST", "/api/v1/registry/skill?slug=hello-skill&version=2.0.0", e.adminToken, bundle2);
    expect(pub2.statusCode).toBe(200);
    const dl2 = await inject("GET", "/api/v1/registry/skill/hello-skill/2.0.0/bundle", e.memberToken);
    expect(dl2.statusCode).toBe(200);

    // mcp keeps the gate: a member cannot download an unapproved mcp
    // bundle, and the approval covers exactly its reviewed bytes.
    const mcpBundle = await packBundle({
      "manifest.json": JSON.stringify({ kind: "mcp", slug: "gate-mcp", version: "1.0.0", description: "d" }),
      "README.md": "x",
    });
    const pubMcp = await inject("POST", "/api/v1/registry/mcp?slug=gate-mcp&version=1.0.0", e.adminToken, mcpBundle);
    expect(pubMcp.statusCode).toBe(200);
    const dlMcp = await inject("GET", "/api/v1/registry/mcp/gate-mcp/1.0.0/bundle", e.memberToken);
    expect(dlMcp.statusCode).toBe(403);
    const dl2admin = await inject("GET", "/api/v1/registry/skill/hello-skill/2.0.0/bundle", e.adminToken);
    expect(dl2admin.statusCode).toBe(200);

    // A new version resets the review status to draft (the approval bound
    // 1.0.0's bytes only).
    const items = (json(await inject("GET", "/api/v1/registry/skill", e.memberToken))["items"] ?? []) as {
      review_status: string;
    }[];
    expect(items[0]!.review_status).toBe("draft");
  });

  it("refuses republishing a superseded version", async () => {
    const again = await packBundle({
      "manifest.json": JSON.stringify({ ...SKILL_MANIFEST, version: "1.0.0" }),
      "SKILL.md": "hello",
    });
    const res = await inject("POST", "/api/v1/registry/skill?slug=hello-skill&version=1.0.0", e.memberToken, again);
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toMatchObject({ code: "version_superseded" });
  });

  it("installs a v2 MCP plugin: integration row, no trigger routines (dropped)", async () => {
    const manifest = {
      kind: "integration",
      slug: "test-mcp",
      version: "1.0.0",
      description: "Test MCP plugin",
      mcp: { url: "http://localhost:9999/mcp" },
      auth: { kind: "org_secret", secret_names: ["api_key"], identity_key: "email" },
      triggers: [{ kind: "webhook", name: "tick", trigger_config: {}, prompt: "do the thing", model: "test-model" }],
    };
    const bundle = await packBundle({ "manifest.json": JSON.stringify(manifest) });
    const pub = await inject("POST", "/api/v1/registry/integration?slug=test-mcp&version=1.0.0", e.adminToken, bundle);
    expect(pub.statusCode).toBe(200);
    const approve = await inject("POST", "/api/v1/registry/integration/test-mcp/review", e.adminToken, {
      status: "approved",
      reviewed_version: "1.0.0",
      reviewed_bundle_sha256: createHash("sha256").update(bundle).digest("hex"),
    });
    expect(approve.statusCode).toBe(200);

    const install = await inject("POST", "/api/v1/registry/integration/test-mcp/install", e.memberToken, {});
    expect(install.statusCode).toBe(200);
    const body = json(install) as unknown as {
      integration: Record<string, unknown>;
    };
    expect(body.integration.name).toBe("test-mcp");
    expect(body.integration.enabled).toBe(false);
    expect((body.integration.config as Record<string, unknown>).mcp).toEqual(manifest.mcp);
    // Routines are dropped: the install response carries no routines field
    // and the manifest triggers are ignored.
    expect(body).not.toHaveProperty("routines");

    // A second install is a no-op (row already exists).
    const again = await inject("POST", "/api/v1/registry/integration/test-mcp/install", e.memberToken, {});
    expect(again.statusCode).toBe(200);
  });
});

// --------------------------------------------------------------- releases

describe("M6 releases", () => {
  it("uploads an artifact as admin and lists it", async () => {
    const bytes = Buffer.from("fake-cli-binary-bytes");
    const res = await e.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/releases?version=0.5.34&kind=cli&platform=linux-x86_64&filename=guild-cli.tar.gz&notes=hello",
      headers: { authorization: `Bearer ${e.adminToken}`, "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body) as Record<string, unknown>;
    expect(row["version"]).toBe("0.5.34");
    expect(row["kind"]).toBe("cli");
    expect(row["platform"]).toBe("linux-x86_64");
    expect(row["filename"]).toBe("guild-cli.tar.gz");
    expect(row["content_type"]).toBe("application/octet-stream");
    expect(row["size_bytes"]).toBe(bytes.length);
    expect(row["sha256"]).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row["signature"]).toMatch(/^[0-9a-f]{128}$/);
    expect(row["notes"]).toBe("hello");
    expect(row["updater_signature"]).toBe("");
    expect(row["created_at"]).toMatch(/^2\d{3}-/);

    const list = await inject("GET", "/api/v1/releases", e.memberToken);
    expect(list.statusCode).toBe(200);
    expect(((json(list)["releases"] ?? []) as unknown[])).toHaveLength(1);
  });

  it("validates upload params", async () => {
    const admin = e.adminToken;
    const cases: [string, string][] = [
      ["missing version", "/api/v1/admin/releases?kind=cli&platform=linux-x86_64&filename=f.bin"],
      ["bad version", "/api/v1/admin/releases?version=bad%20version&kind=cli&platform=linux-x86_64&filename=f.bin"],
      ["bad kind", "/api/v1/admin/releases?version=1.0.0&kind=apk&platform=linux-x86_64&filename=f.bin"],
      ["unknown platform", "/api/v1/admin/releases?version=1.0.0&kind=cli&platform=atari2600&filename=f.bin"],
      ["bad filename", "/api/v1/admin/releases?version=1.0.0&kind=cli&platform=linux-x86_64&filename=.hidden"],
      ["missing filename", "/api/v1/admin/releases?version=1.0.0&kind=cli&platform=linux-x86_64"],
    ];
    for (const [, url] of cases) {
      const res = await e.env.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/octet-stream" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(400);
    }
    const member = await inject(
      "POST",
      "/api/v1/admin/releases?version=1.0.0&kind=cli&platform=linux-x86_64&filename=f.bin",
      e.memberToken,
      Buffer.from("x"),
    );
    expect(member.statusCode).toBe(403);
  });

  it("serves the verifying key and signs the digest verifiably", async () => {
    const key = await inject("GET", "/api/v1/releases/signing-key", e.memberToken);
    expect(key.statusCode).toBe(200);
    const body = json(key) as unknown as { public_key: string; algorithm: string };
    expect(body.algorithm).toBe("ed25519");
    expect(body.public_key).toMatch(/^[0-9a-f]{64}$/);

    const list = json(await inject("GET", "/api/v1/releases", e.memberToken)) as unknown as {
      releases: { id: string; sha256: string; signature: string }[];
    };
    const rel = list.releases[0]!;
    const vk = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(body.public_key, "hex")]),
      format: "der",
      type: "spki",
    });
    expect(cryptoVerify(null, Buffer.from(rel.sha256, "hex"), vk, Buffer.from(rel.signature, "hex"))).toBe(true);
  });

  it("hands out signed download URLs and falls back to bearer auth", async () => {
    const list = json(await inject("GET", "/api/v1/releases", e.memberToken)) as unknown as {
      releases: { id: string; filename: string; content_type: string }[];
    };
    const rel = list.releases.find((r) => r.filename === "guild-cli.tar.gz")!;
    const urlRes = await inject("GET", `/api/v1/releases/${rel.id}/download-url`, e.memberToken);
    expect(urlRes.statusCode).toBe(200);
    const { url } = json(urlRes) as unknown as { url: string; expires_at: number };
    const dl = await e.env.app.inject({ method: "GET", url });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("fake-cli-binary-bytes");
    expect(dl.headers["content-disposition"]).toContain("attachment");

    const noAuth = await e.env.app.inject({ method: "GET", url: `/api/v1/releases/${rel.id}/download` });
    expect(noAuth.statusCode).toBe(401);
    const bearer = await e.env.app.inject({
      method: "GET",
      url: `/api/v1/releases/${rel.id}/download`,
      headers: { authorization: `Bearer ${e.memberToken}` },
    });
    expect(bearer.statusCode).toBe(200);
  });

  it("renders the updater manifest only for signed desktop updater artifacts", async () => {
    const none = await inject("GET", "/api/v1/updates/latest.json", e.memberToken);
    expect(none.statusCode).toBe(204);

    const put = async (version: string, platform: string, filename: string, updaterSig: string): Promise<string> => {
      const res = await e.env.app.inject({
        method: "POST",
        url: `/api/v1/admin/releases?version=${version}&kind=desktop&platform=${platform}&filename=${filename}${updaterSig ? `&updater_sig=${encodeURIComponent(updaterSig)}` : ""}`,
        headers: { authorization: `Bearer ${e.adminToken}`, "content-type": "application/octet-stream" },
        payload: Buffer.from(`desktop-${version}-${platform}`),
      });
      expect(res.statusCode).toBe(200);
      return (JSON.parse(res.body) as { id: string }).id;
    };
    await put("0.6.0", "linux-x86_64", "guild_0.6.0_amd64.AppImage", "dW5pcXVlLXNpZ25hdHVyZQ==");
    await put("0.6.0", "linux-aarch64", "guild_0.6.0_arm64.AppImage", ""); // not updater-signable

    const manifest = await e.env.app.inject({ method: "GET", url: "/api/v1/updates/latest.json" });
    expect(manifest.statusCode).toBe(200);
    const body = JSON.parse(manifest.body) as {
      version: string;
      platforms: Record<string, { url: string; signature: string }>;
      pub_date: string;
    };
    expect(body.version).toBe("0.6.0");
    expect(Object.keys(body.platforms)).toEqual(["linux-x86_64"]);
    expect(body.platforms["linux-x86_64"]!.signature).toBe("dW5pcXVlLXNpZ25hdHVyZQ==");
    expect(body.platforms["linux-x86_64"]!.url).toContain("/api/v1/releases/");
    expect(body.pub_date).toMatch(/\+00:00$/);
    // The signed URL in the manifest downloads.
    const dl = await e.env.app.inject({ method: "GET", url: body.platforms["linux-x86_64"]!.url });
    expect(dl.statusCode).toBe(200);

    await put("0.7.0-beta.1", "linux-x86_64", "guild_0.7.0.AppImage", "sig2");
    const after = JSON.parse((await e.env.app.inject({ method: "GET", url: "/api/v1/updates/latest.json" })).body) as {
      version: string;
    };
    // A higher core number wins even as a prerelease; the prerelease-below-
    // release rule only applies at equal cores (unit-tested below).
    expect(after.version).toBe("0.7.0-beta.1");
  });

  it("orders versions by semver rules and renders pub_date like chrono to_rfc3339", () => {
    expect(versionGt("1.0.1", "1.0.0")).toBe(true);
    expect(versionGt("1.10.0", "1.9.0")).toBe(true);
    expect(versionGt("1.0.0", "1.0.0")).toBe(false);
    expect(versionGt("1.0.0+build.9", "1.0.0")).toBe(false);
    expect(versionGt("1.0.0", "1.0.0+build.9")).toBe(false);
    expect(versionGt("1.0.0", "1.0.0-beta")).toBe(true);
    expect(versionGt("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
    expect(versionGt("1.0.0-alpha", "1.0.0-beta")).toBe(false);
    expect(versionGt("1.0.0-1", "1.0.0-alpha")).toBe(false);
    expect(versionGt("1.0.0-alpha", "1.0.0-1")).toBe(true);
    expect(versionGt("1.0.0-beta.2.1", "1.0.0-beta.2")).toBe(true);
    expect(toRfc3339Offset("2026-10-03T23:57:44.123456Z")).toBe("2026-10-03T23:57:44.123456+00:00");
    expect(toRfc3339Offset("2026-10-03T23:57:44.000000Z")).toBe("2026-10-03T23:57:44+00:00");
  });
});

// --------------------------------------------------------------- projects

describe("M6 projects", () => {
  it("creates with a derived name, lists, updates, archives and deletes", async () => {
    const created = await inject("POST", "/api/v1/projects", e.memberToken, {
      folder: "C:\\code\\web",
      machine_id: "machine-1",
    });
    expect(created.statusCode).toBe(200);
    const project = JSON.parse(created.body) as Record<string, unknown>;
    // The name defaults to the folder's basename; wire shape in protocol
    // declaration order.
    expect(Object.keys(project)).toEqual(["id", "name", "folder", "machine_id", "machine_label", "created_at"]);
    expect(project["name"]).toBe("web");
    expect(project["machine_label"]).toBe("machine-1");
    const pid = project["id"] as string;

    const listed = await inject("GET", "/api/v1/projects", e.memberToken);
    expect(listed.statusCode).toBe(200);
    expect(((json(listed)["projects"] ?? []) as unknown[]).length).toBeGreaterThanOrEqual(1);

    const updated = await inject("PUT", `/api/v1/projects/${pid}`, e.memberToken, { name: "web2", folder: "C:\\code\\web2" });
    expect(updated.statusCode).toBe(200);
    expect((JSON.parse(updated.body) as Record<string, unknown>)["name"]).toBe("web2");

    // Owner-scoping: the list is per-user — another user (even an admin)
    // sees none of it. (Rust exposes no single-project GET; /:id is
    // PUT/DELETE only, so a GET there stays proxied to the Rust 405.)
    const adminList = await inject("GET", "/api/v1/projects", e.adminToken);
    expect(adminList.statusCode).toBe(200);
    expect(((json(adminList)["projects"] ?? []) as { id: string }[]).some((p) => p.id === pid)).toBe(false);

    const del = await inject("DELETE", `/api/v1/projects/${pid}`, e.memberToken);
    expect(del.statusCode).toBe(200);
    expect(json(del)).toEqual({ ok: true });
  });

  it("enforces one live project per (machine, folder), including case and separator variants", async () => {
    const folder = "C:\\code\\web";
    const first = await inject("POST", "/api/v1/projects", e.memberToken, { folder, machine_id: "machine-1" });
    expect(first.statusCode).toBe(200);
    const firstId = (JSON.parse(first.body) as { id: string }).id;

    const dup = await inject("POST", "/api/v1/projects", e.memberToken, { folder, machine_id: "machine-1" });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error).toMatchObject({ code: "folder_taken" });

    const folded = await inject("POST", "/api/v1/projects", e.memberToken, {
      folder: "c:\\CODE\\web\\",
      machine_id: "machine-1",
    });
    expect(folded.statusCode).toBe(409);

    // A different folder on the same machine, and the same folder on
    // another machine, bind fine.
    const other = await inject("POST", "/api/v1/projects", e.memberToken, {
      folder: "C:\\code\\api",
      machine_id: "machine-1",
    });
    expect(other.statusCode).toBe(200);

    // An unknown machine is refused.
    const unknownMachine = await inject("POST", "/api/v1/projects", e.memberToken, {
      folder: "C:\\x",
      machine_id: "no-such-machine",
    });
    expect(unknownMachine.statusCode).toBe(400);
    expect(json(unknownMachine).error).toMatchObject({ message: "unknown machine" });

    // Moving onto a held folder is a 409.
    const moveToHeld = await inject("PUT", `/api/v1/projects/${firstId}`, e.memberToken, { folder: "C:\\code\\api" });
    expect(moveToHeld.statusCode).toBe(409);

    // Archiving the holder frees the folder for a fresh project.
    const archive = await inject("PUT", `/api/v1/projects/${firstId}`, e.memberToken, { archived: true });
    expect(archive.statusCode).toBe(200);
    const free = await inject("POST", "/api/v1/projects", e.memberToken, { folder, machine_id: "machine-1" });
    expect(free.statusCode).toBe(200);
    const unarchive = await inject("PUT", `/api/v1/projects/${firstId}`, e.memberToken, { archived: false });
    expect(unarchive.statusCode).toBe(409);

    // Cleanup.
    await inject("DELETE", `/api/v1/projects/${firstId}`, e.memberToken);
    const freeId = (JSON.parse(free.body) as { id: string }).id;
    await inject("DELETE", `/api/v1/projects/${freeId}`, e.memberToken);
  });

  it("deleting a project unlinks its chats (folderless, machine binding cleared)", async () => {
    const created = await inject("POST", "/api/v1/projects", e.memberToken, {
      folder: "C:\\code\\unlink",
      machine_id: "machine-1",
    });
    const pid = (JSON.parse(created.body) as { id: string }).id;
    const chat = await e.env.db.query(
      "INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label) VALUES ($1, $2, $3, 't', $4, 'machine-1', 'machine-1') RETURNING id",
      [crypto.randomUUID(), e.orgId, e.memberId, pid],
    );
    const chatId = chat.rows[0]!.id as string;
    const del = await inject("DELETE", `/api/v1/projects/${pid}`, e.memberToken);
    expect(del.statusCode).toBe(200);
    const row = await e.env.db.query("SELECT project_id, machine_id, machine_label FROM chats WHERE id = $1", [chatId]);
    expect(row.rows[0]!.project_id).toBeNull();
    expect(row.rows[0]!.machine_id).toBeNull();
    expect(row.rows[0]!.machine_label).toBeNull();
    await e.env.db.query("DELETE FROM chats WHERE id = $1", [chatId]);
  });
});

// ------------------------------------------------------------------ teams

describe("M6 teams", () => {
  it("creates, renames, lists with member counts, deletes", async () => {
    const created = await inject("POST", "/api/v1/admin/teams", e.adminToken, { name: "platform" });
    expect(created.statusCode).toBe(200);
    const team = json(created) as unknown as { id: string; name: string };
    expect(team.name).toBe("platform");

    const dup = await inject("POST", "/api/v1/admin/teams", e.adminToken, { name: "platform" });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error).toMatchObject({ code: "team_taken" });

    const renamed = await inject("PUT", `/api/v1/admin/teams/${team.id}`, e.adminToken, { name: "platform2" });
    expect(renamed.statusCode).toBe(200);
    expect((json(renamed) as unknown as { name: string }).name).toBe("platform2");

    const listed = await inject("GET", "/api/v1/admin/teams", e.adminToken);
    const teams = (json(listed)["teams"] ?? []) as Record<string, unknown>[];
    expect(teams[0]).toMatchObject({ name: "platform2", member_count: 0 });

    const del = await inject("DELETE", `/api/v1/admin/teams/${team.id}`, e.adminToken);
    expect(del.statusCode).toBe(200);
  });

  it("manages members", async () => {
    const created = await inject("POST", "/api/v1/admin/teams", e.adminToken, { name: "members-team" });
    const teamId = ((json(created) as unknown as { id: string }).id);
    const add = await inject("POST", `/api/v1/admin/teams/${teamId}/members`, e.adminToken, { user_id: e.memberId });
    expect(add.statusCode).toBe(200);
    const addAgain = await inject("POST", `/api/v1/admin/teams/${teamId}/members`, e.adminToken, { user_id: e.memberId });
    expect(addAgain.statusCode).toBe(200); // idempotent

    const members = await inject("GET", `/api/v1/admin/teams/${teamId}/members`, e.adminToken);
    const list = (json(members)["members"] ?? []) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: e.memberId, email: expect.any(String), role: "member" });

    const foreignUser = await inject("POST", `/api/v1/admin/teams/${teamId}/members`, e.adminToken, {
      user_id: crypto.randomUUID(),
    });
    expect(foreignUser.statusCode).toBe(400);

    const remove = await inject("DELETE", `/api/v1/admin/teams/${teamId}/members/${e.memberId}`, e.adminToken);
    expect(remove.statusCode).toBe(200);
    const after = await inject("GET", `/api/v1/admin/teams/${teamId}/members`, e.adminToken);
    expect(((json(after)["members"] ?? []) as unknown[])).toHaveLength(0);
    await inject("DELETE", `/api/v1/admin/teams/${teamId}`, e.adminToken);
  });
});

// ------------------------------------------------------------ admin users

describe("M6 admin users + prompts", () => {
  it("creates, lists, updates and deletes managed users", async () => {
    const created = await inject("POST", "/api/v1/admin/users", e.adminToken, {
      email: `m6-user-${crypto.randomUUID().slice(0, 8)}@example.test`,
      password: PASSWORD,
      role: "member",
    });
    expect(created.statusCode).toBe(200);
    const user = json(created) as unknown as { id: string; email: string; role: string };
    expect(user.role).toBe("member");

    const short = await inject("POST", "/api/v1/admin/users", e.adminToken, {
      email: "x@example.test",
      password: "short",
    });
    expect(short.statusCode).toBe(400);

    // Password reset revokes the target's sessions.
    const loginRes = await e.env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: user.email, password: PASSWORD },
    });
    const token = (JSON.parse(loginRes.body) as { token: string }).token;
    const reset = await inject("PUT", `/api/v1/admin/users/${user.id}`, e.adminToken, { password: "newpassword1" });
    expect(reset.statusCode).toBe(200);
    const stale = await e.env.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stale.statusCode).toBe(401);

    const selfDemote = await inject("PUT", `/api/v1/admin/users/${e.adminId}`, e.adminToken, { role: "member" });
    expect(selfDemote.statusCode).toBe(400);

    const selfDel = await inject("DELETE", `/api/v1/admin/users/${e.adminId}`, e.adminToken);
    expect(selfDel.statusCode).toBe(400);
    expect(json(selfDel).error).toMatchObject({ message: "cannot delete yourself" });

    const del = await inject("DELETE", `/api/v1/admin/users/${user.id}`, e.adminToken);
    expect(del.statusCode).toBe(200);
  });

  it("stores the assistant and approval-policy prompts in org_kv", async () => {
    const before = await inject("GET", "/api/v1/admin/assistant-prompt", e.adminToken);
    expect(before.statusCode).toBe(200);
    expect(json(before)).toEqual({ prompt: null });

    const set = await inject("PUT", "/api/v1/admin/assistant-prompt", e.adminToken, { prompt: "You are terse." });
    expect(set.statusCode).toBe(200);
    expect(json(set)).toEqual({ ok: true });
    expect(json(await inject("GET", "/api/v1/admin/assistant-prompt", e.adminToken))).toEqual({ prompt: "You are terse." });

    const reset = await inject("PUT", "/api/v1/admin/assistant-prompt", e.adminToken, { prompt: "" });
    expect(reset.statusCode).toBe(200);
    expect(json(await inject("GET", "/api/v1/admin/assistant-prompt", e.adminToken))).toEqual({ prompt: null });

    const policy = json(await inject("GET", "/api/v1/admin/approval-policy-prompt", e.adminToken)) as unknown as {
      prompt: string | null;
      default: string;
    };
    expect(policy.prompt).toBeNull();
    expect(policy.default).toContain("safety gate");
    const setPolicy = await inject("PUT", "/api/v1/admin/approval-policy-prompt", e.adminToken, { prompt: "custom" });
    expect(setPolicy.statusCode).toBe(200);
    const memberSet = await inject("PUT", "/api/v1/admin/assistant-prompt", e.memberToken, { prompt: "x" });
    expect(memberSet.statusCode).toBe(403);
    await inject("PUT", "/api/v1/admin/approval-policy-prompt", e.adminToken, { prompt: "" });
  });
});

// ---------------------------------------------------- admin integrations

describe("M6 admin integrations (read paths)", () => {
  it("lists configured rows and the available catalog", async () => {
    // A configured compiled-in row (github) and an MCP-plugin row
    // (installed via the registry suite above).
    await e.env.db.query(
      "INSERT INTO integrations (id, org_id, name, config, enabled) VALUES ($1, $2, 'github', $3, true) ON CONFLICT (org_id, name) DO NOTHING",
      [crypto.randomUUID(), e.orgId, JSON.stringify({ token_config: "x" })],
    );
    const list = await inject("GET", "/api/v1/admin/integrations", e.adminToken);
    expect(list.statusCode).toBe(200);
    const body = json(list) as unknown as {
      integrations: Record<string, unknown>[];
      available: Record<string, unknown>[];
    };
    const githubRow = body.integrations.find((r) => r["name"] === "github");
    expect(githubRow).toMatchObject({ enabled: true, categories: ["other"], secret_names: ["token"] });
    expect((githubRow!["settings"] as { fields: unknown[] }).fields.length).toBe(2);
    const mcpRow = body.integrations.find((r) => r["name"] === "test-mcp");
    expect(mcpRow).toMatchObject({ categories: ["mcp"] });

    const availableNames = body.available.map((a) => a["name"]);
    // Every compiled-in kind except the configured github is available.
    expect(availableNames).toContain("searxng");
    expect(availableNames).toContain("slack");
    expect(availableNames).not.toContain("github");
    const slack = body.available.find((a) => a["name"] === "slack") as Record<string, unknown>;
    expect(slack["categories"]).toEqual(["other"]);
    expect(slack["secret_names"]).toEqual(["bot_token"]);
    // The installed registry MCP plugin has a configured row, so it is
    // not in the available list.
    expect(availableNames).not.toContain("test-mcp");
  });

  it("lists secrets masked (values never appear) and curates tools", async () => {
    const rows = await e.env.db.query("SELECT id FROM integrations WHERE org_id = $1 AND name = 'github'", [e.orgId]);
    const rowId = rows.rows[0]!.id as string;
    // A current-format masked preview (all bullet characters) is served
    // as stored — the fake ciphertext below is never decrypted.
    await e.env.db.query(
      "INSERT INTO integration_secrets (org_id, integration, name, secret_enc, masked) VALUES ($1, 'github', 'token', 'ZmFrZS1jaXBoZXJ0ZXh0', '••••••••') " +
        "ON CONFLICT (org_id, integration, name) DO UPDATE SET masked = EXCLUDED.masked",
      [e.orgId],
    );
    const secrets = await inject("GET", `/api/v1/admin/integrations/${rowId}/secrets`, e.adminToken);
    expect(secrets.statusCode).toBe(200);
    const list = (json(secrets)["secrets"] ?? []) as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ name: "token", masked: "••••••••" });
    expect(JSON.stringify(list)).not.toContain("fake-ciphertext");
    const member = await inject("GET", `/api/v1/admin/integrations/${rowId}/secrets`, e.memberToken);
    expect(member.statusCode).toBe(403);

    const unknown = await inject("GET", `/api/v1/admin/integrations/${crypto.randomUUID()}/secrets`, e.adminToken);
    expect(unknown.statusCode).toBe(404);
  });

  it("curates one tool's per-tool config idempotently", async () => {
    const rows = await e.env.db.query("SELECT id FROM integrations WHERE org_id = $1 AND name = 'github'", [e.orgId]);
    const rowId = rows.rows[0]!.id as string;
    const put = await inject("PUT", `/api/v1/admin/integrations/${rowId}/tools/search_repositories`, e.adminToken, {
      enabled: true,
      approval: "always_ask",
    });
    expect(put.statusCode).toBe(200);
    expect(json(put)).toEqual({ name: "search_repositories", enabled: true, approval: "always_ask" });

    const stored = await e.env.db.query("SELECT config FROM integrations WHERE id = $1", [rowId]);
    expect(((stored.rows[0]!.config as Record<string, unknown>)["tools"] as Record<string, unknown>)["search_repositories"]).toEqual({
      enabled: true,
      approval: "always_ask",
    });

    // An audit event is emitted.
    const events = await e.env.db.query(
      "SELECT payload FROM events WHERE org_id = $1 AND kind = 'integration.tool_curated' ORDER BY created_at DESC LIMIT 1",
      [e.orgId],
    );
    expect((events.rows[0]!.payload as Record<string, unknown>)["tool"]).toBe("search_repositories");

    const badName = await inject("PUT", `/api/v1/admin/integrations/${rowId}/tools/bad%2Fname`, e.adminToken, { enabled: true });
    expect(badName.statusCode).toBe(400); // the path segment arrives decoded as bad/name → invalid
  });

  it("curates a tool to always_allow and reads the curation back", async () => {
    const rows = await e.env.db.query("SELECT id FROM integrations WHERE org_id = $1 AND name = 'github'", [e.orgId]);
    const rowId = rows.rows[0]!.id as string;
    const put = await inject("PUT", `/api/v1/admin/integrations/${rowId}/tools/get_file`, e.adminToken, {
      enabled: true,
      approval: "always_allow",
    });
    expect(put.statusCode).toBe(200);
    expect(json(put)).toEqual({ name: "get_file", enabled: true, approval: "always_allow" });

    const stored = await e.env.db.query("SELECT config FROM integrations WHERE id = $1", [rowId]);
    expect(((stored.rows[0]!.config as Record<string, unknown>)["tools"] as Record<string, unknown>)["get_file"]).toEqual({
      enabled: true,
      approval: "always_allow",
    });

    // The curated tool list echoes the value back (not collapsed to default).
    const list = await inject("GET", `/api/v1/admin/integrations/${rowId}/tools`, e.adminToken);
    const tool = ((json(list)["tools"] ?? []) as Record<string, unknown>[]).find((t) => t["name"] === "get_file");
    expect(tool!["approval"]).toBe("always_allow");
  });

  it("deletes an integration row with its secrets", async () => {
    const delGithub = await inject("DELETE", `/api/v1/admin/integrations/${(await e.env.db.query("SELECT id FROM integrations WHERE org_id = $1 AND name = 'github'", [e.orgId])).rows[0]!.id}`, e.adminToken);
    expect(delGithub.statusCode).toBe(200);
    // Deleting the configured row puts github back on the available list.
    const after = json(await inject("GET", "/api/v1/admin/integrations", e.adminToken)) as unknown as {
      available: { name: string }[];
    };
    expect(after.available.map((a) => a.name)).toContain("github");

    const ins = await e.env.db.query(
      "INSERT INTO integrations (id, org_id, name, config, enabled) VALUES ($1, $2, 'slack', '{}', false) RETURNING id",
      [crypto.randomUUID(), e.orgId],
    );
    const rowId = ins.rows[0]!.id as string;
    await e.env.db.query(
      "INSERT INTO integration_secrets (org_id, integration, name, secret_enc, masked) VALUES ($1, 'slack', 'bot_token', $2, '•')",
      [e.orgId, "aabbcc"],
    );
    const del = await inject("DELETE", `/api/v1/admin/integrations/${rowId}`, e.adminToken);
    expect(del.statusCode).toBe(200);
    const left = await e.env.db.query("SELECT * FROM integrations WHERE id = $1", [rowId]);
    expect(left.rows).toHaveLength(0);
    const secrets = await e.env.db.query("SELECT * FROM integration_secrets WHERE org_id = $1 AND integration = 'slack'", [e.orgId]);
    expect(secrets.rows).toHaveLength(0);
  });
});

// ----------------------------------------------------------- web serving

describe("M6 web serving", () => {
  it("serves the SPA fallback from a dist on disk, with the Rust caching rules", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "m6-web-"));
    try {
      const assets = path.join(dir, "assets");
      mkdirSync(assets);
      writeFileSync(path.join(dir, "index.html"), "<html>index</html>");
      writeFileSync(path.join(assets, "index-CLneK5BO.js"), "console.log('bundle')");
      writeFileSync(path.join(dir, "manifest.webmanifest"), "{}");
      const env = await createM6TestEnv("error", { GUILD_WEB_DIST: dir });
      try {
        const root = await env.app.inject({ method: "GET", url: "/" });
        expect(root.statusCode).toBe(200);
        expect(root.body).toBe("<html>index</html>");
        expect(root.headers["content-type"]).toBe("text/html");
        expect(root.headers["cache-control"]).toBe("no-cache");

        const deep = await env.app.inject({ method: "GET", url: "/settings/some.deep.route" });
        expect(deep.statusCode).toBe(200);
        expect(deep.body).toBe("<html>index</html>");

        const asset = await env.app.inject({ method: "GET", url: "/assets/index-CLneK5BO.js" });
        expect(asset.statusCode).toBe(200);
        expect(asset.body).toBe("console.log('bundle')");
        expect(asset.headers["content-type"]).toBe("text/javascript");
        expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

        const manifest = await env.app.inject({ method: "GET", url: "/manifest.webmanifest" });
        expect(manifest.headers["content-type"]).toBe("application/manifest+json");

        // Unmatched /api routes answer the Rust not-found envelope natively
        // (M7: the proxy and the upstream are retired — a clean 404, never
        // a connection error).
        const api = await env.app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
        expect(api.statusCode).toBe(404);
        expect(JSON.parse(api.body)).toEqual({ error: { code: "not_found", message: "no such route" } });

        // A traversal attempt is not a bundled file → index.html.
        const escape = await env.app.inject({ method: "GET", url: "/assets/../../etc/passwd" });
        expect(escape.statusCode).toBe(200);
        expect(escape.body).toBe("<html>index</html>");
      } finally {
        await env.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------- faro

describe("M6 faro ingest", () => {
  it("accepts payloads without auth; disabled endpoint answers 202", async () => {
    const res = await e.env.app.inject({
      method: "POST",
      url: "/faro/collect",
      headers: { "content-type": "application/json" },
      payload: { type: "measurement", meta: {} },
    });
    expect(res.statusCode).toBe(202);
  });

  it("forwards the exact body bytes and passes the upstream status through", async () => {
    const received: { body: Buffer; contentType: string | null }[] = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ body: Buffer.concat(chunks), contentType: req.headers["content-type"] ?? null });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const addr = collector.address() as { port: number };
    const env = await createM6TestEnv("error", { GUILD_FARO_URL: `http://127.0.0.1:${addr.port}/collect` });
    try {
      const payload = JSON.stringify({ type: "measurement", meta: { browser: "test" } });
      const res = await env.app.inject({
        method: "POST",
        url: "/faro/collect",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(res.statusCode).toBe(204);
      expect(received).toHaveLength(1);
      expect(received[0]!.contentType).toBe("application/json");
      expect(received[0]!.body.toString("utf8")).toBe(payload);
    } finally {
      await env.cleanup();
      collector.close();
    }
  });
});
