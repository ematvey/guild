// Registry and admin surfaces: the registry (incl. integration install),
// releases, projects, teams, admin users/prompts/integration reads, and the
// web UI serving + Faro ingest, against a disposable database and rustfs
// bucket.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ReleaseStore } from "../platform/store/releases.js";
import { createServer } from "node:http";

import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createObjectStoreStack, packBundle, type ObjectStoreStack } from "./support/object-store-stack.js";
import { hashPassword } from "../platform/crypto.js";
import { versionGt, toRfc3339Offset } from "../platform/http/releases.js";

const PASSWORD = "hunter226";

interface Env {
  env: ObjectStoreStack;
  adminToken: string;
  memberToken: string;
  adminId: string;
  memberId: string;
  orgId: string;
}

let e: Env;

beforeAll(async () => {
  const env = await createObjectStoreStack(
    "error",
    { GUILD_RELEASE_REPOSITORY: "alice/guild", GUILD_RELEASE_CHANNEL: "develop" },
    "m6",
  );
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
  await env.db.query("INSERT INTO machines (machine_id, org_id, user_id) VALUES ($1, $2, $3)", [
    "machine-1",
    orgId,
    memberId,
  ]);
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
      ...(payload === undefined || isBuffer ? {} : { "content-type": "application/json" }),
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
    expect(json(bare).error).toMatchObject({
      message: "approval requires reviewed_version and reviewed_bundle_sha256",
    });

    const stale = await inject("POST", "/api/v1/registry/skill/hello-skill/review", e.adminToken, {
      status: "approved",
      reviewed_version: "9.9.9",
      reviewed_bundle_sha256: "ab".repeat(32),
    });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).error).toMatchObject({ code: "reviewed_version_stale" });

    const sha = (
      (json(await inject("GET", "/api/v1/registry/skill/hello-skill", e.memberToken))["versions"] ?? []) as {
        bundle_sha256: string;
      }[]
    )[0]!.bundle_sha256;
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

describe("GitHub releases", () => {
  it("has no server-hosted upload or signing-key endpoint", async () => {
    expect((await inject("POST", "/api/v1/admin/releases", e.adminToken, {})).statusCode).toBe(404);
    expect((await inject("GET", "/api/v1/releases/signing-key", e.memberToken)).statusCode).toBe(404);
    expect((await inject("GET", "/api/v1/updates/latest.json", e.memberToken)).statusCode).toBe(204);
  });

  it("adopts complete GitHub releases atomically, preserves downloads, and isolates previews", async () => {
    const version = "0.8.0-dev.42";
    const previousVersion = e.env.config.serverVersion;
    e.env.config.serverVersion = version;
    const tag = `client-v${version}`;
    const base = `https://github.com/alice/guild/releases/download/${tag}`;
    const artifacts = ["windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64"].flatMap((platform) => {
      const names =
        platform === "windows-x86_64"
          ? [`Guild_${version}_x64-setup.exe`]
          : platform === "linux-x86_64"
            ? [`Guild-${version}-x86_64.AppImage`]
            : [
                `Guild-${version}-macos-${platform.slice(7)}.dmg`,
                `Guild-${version}-macos-${platform.slice(7)}.app.tar.gz`,
              ];
      return names.map((filename) => ({
        platform,
        filename,
        size_bytes: 10,
        sha256: "a".repeat(64),
        updater_signature: "signed-artifact",
      }));
    });
    const metadata = { version, tag, repository: "alice/guild", artifacts };
    const release = {
      tag_name: tag,
      draft: false,
      prerelease: true,
      body: "Preview release",
      assets: [
        { name: "release.json", browser_download_url: `${base}/release.json`, size: 100, digest: "sha256:metadata" },
        ...artifacts.flatMap((a) => [
          {
            name: a.filename,
            size: a.size_bytes,
            digest: `sha256:${a.sha256}`,
            browser_download_url: `${base}/${a.filename}`,
          },
          {
            name: `${a.filename}.sig`,
            size: 20,
            digest: "sha256:signature",
            browser_download_url: `${base}/${a.filename}.sig`,
          },
        ]),
      ],
    };
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/alice/guild/releases/tags/${tag}`) return Response.json(release);
      if (url === `${base}/release.json`) return Response.json(metadata);
      return realFetch(input, init);
    });
    try {
      expect((await inject("POST", "/api/v1/admin/releases/github", e.memberToken, { tag })).statusCode).toBe(403);
      e.env.config.releaseChannel = "stable";
      expect((await inject("POST", "/api/v1/admin/releases/github", e.adminToken, { tag })).statusCode).toBe(400);
      expect((await inject("GET", "/api/v1/updates/latest.json", e.adminToken)).statusCode).toBe(204);
      e.env.config.releaseChannel = "develop";
      artifacts[0]!.size_bytes = 11;
      expect((await inject("POST", "/api/v1/admin/releases/github", e.adminToken, { tag })).statusCode).toBe(400);
      artifacts[0]!.size_bytes = 10;
      const before = json(await inject("GET", "/api/v1/releases", e.adminToken)).releases as { version: string }[];
      expect(before.some((r) => r.version === version)).toBe(false);
      release.draft = true;
      expect((await inject("POST", "/api/v1/admin/releases/github", e.adminToken, { tag })).statusCode).toBe(400);
      release.draft = false;
      e.env.config.serverVersion = "0.7.0";
      expect((await inject("POST", "/api/v1/admin/releases/github", e.adminToken, { tag })).statusCode).toBe(400);
      e.env.config.serverVersion = version;
      const accepted = await inject("POST", "/api/v1/admin/releases/github", e.adminToken, { tag });
      expect(accepted.statusCode).toBe(200);
      expect(json(accepted)).toEqual({ version, artifacts: 6 });
      expect((await inject("POST", "/api/v1/admin/releases/github", e.adminToken, { tag })).statusCode).toBe(200);
      const rows = (
        json(await inject("GET", "/api/v1/releases", e.adminToken)).releases as {
          id: string;
          version: string;
          filename: string;
        }[]
      ).filter((r) => r.version === version);
      expect(rows).toHaveLength(6);
      const manifest = json(await inject("GET", "/api/v1/updates/latest.json", e.adminToken)) as {
        version: string;
        platforms: Record<string, { url: string }>;
      };
      expect(manifest.version).toBe(version);
      expect(Object.keys(manifest.platforms)).toHaveLength(4);
      expect(Object.values(manifest.platforms).every((p) => p.url.startsWith(`${base}/`))).toBe(true);
      const row = rows.find((r) => r.filename.endsWith(".AppImage"))!;
      const download = await inject("GET", `/api/v1/releases/${row.id}/download-url`, e.memberToken);
      expect(json(download).url).toBe(`${base}/${row.filename}`);
      expect((await inject("GET", `/api/v1/releases/${row.id}/download`, e.memberToken)).statusCode).toBe(302);
      expect((await inject("DELETE", `/api/v1/admin/releases/${row.id}`, e.adminToken)).statusCode).toBe(200);
      expect((await inject("GET", "/api/v1/updates/latest.json", e.adminToken)).statusCode).toBe(204);
    } finally {
      e.env.config.serverVersion = previousVersion;
      e.env.config.releaseChannel = "develop";
      fetchSpy.mockRestore();
    }
  });

  it("caps both channels, listings and download redirects at the running server version", async () => {
    const previousVersion = e.env.config.serverVersion;
    await e.env.db.query("DELETE FROM releases WHERE kind = 'desktop'");
    await e.env.db.query("DELETE FROM server_kv WHERE key LIKE 'desktop_release_version:%'");
    const put = async (version: string) => {
      const artifacts = ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"].map((platform) => {
        const filename =
          platform === "linux-x86_64"
            ? `Guild-${version}.AppImage`
            : platform === "windows-x86_64"
              ? `Guild-${version}-setup.exe`
              : `Guild-${version}-${platform}.app.tar.gz`;
        return {
          id: crypto.randomUUID(),
          version,
          platform,
          filename,
          size_bytes: 1,
          sha256: "a".repeat(64),
          updater_signature: "signature",
          notes: "",
          download_url: `https://github.com/alice/guild/releases/download/client-v${version}/${filename}`,
        };
      });
      await new ReleaseStore(e.env.db).importGithub(artifacts);
      return artifacts[0]!.id;
    };
    try {
      e.env.config.serverVersion = "0.6.128-dev.200";
      e.env.config.releaseChannel = "develop";
      await put("0.6.128");
      await put("0.6.127");
      const future = await put("0.6.128-dev.250");
      await put("0.6.128-dev.150");
      const stable = json(await inject("GET", "/api/v1/updates/latest.json?channel=stable", e.memberToken));
      const develop = json(await inject("GET", "/api/v1/updates/latest.json?channel=develop", e.memberToken));
      expect(stable.version).toBe("0.6.127");
      expect(develop.version).toBe("0.6.128-dev.150");
      expect(develop.server_version).toBe("0.6.128-dev.200");
      expect(develop.channel).toBe("develop");
      const rows = json(await inject("GET", "/api/v1/releases?channel=develop", e.memberToken)).releases as {
        kind: string;
        version: string;
      }[];
      expect([...new Set(rows.map((r) => r.version))]).toEqual(["0.6.128-dev.150"]);
      expect(
        (await inject("GET", `/api/v1/releases/${future}/download-url?channel=develop`, e.memberToken)).statusCode,
      ).toBe(404);
      expect(
        (await inject("GET", `/api/v1/releases/${future}/download?channel=develop`, e.memberToken)).statusCode,
      ).toBe(404);
      e.env.config.serverVersion = "0.6.128-dev.300";
      await e.env.db.query(
        "UPDATE server_kv SET value = '0.6.128-dev.250' WHERE key = 'desktop_release_version:develop'",
      );
      expect(
        (await inject("GET", `/api/v1/releases/${future}/download?channel=develop`, e.memberToken)).statusCode,
      ).toBe(302);
      e.env.config.serverVersion = "0.6.128-dev.200";
      expect(
        (await inject("GET", `/api/v1/releases/${future}/download?channel=develop`, e.memberToken)).statusCode,
      ).toBe(404);
      expect((await inject("GET", "/api/v1/updates/latest.json?channel=other", e.memberToken)).statusCode).toBe(400);
      e.env.config.releaseChannel = "stable";
      expect((await inject("GET", "/api/v1/updates/latest.json?channel=develop", e.memberToken)).statusCode).toBe(204);
    } finally {
      e.env.config.serverVersion = previousVersion;
      e.env.config.releaseChannel = "develop";
    }
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

    const updated = await inject("PUT", `/api/v1/projects/${pid}`, e.memberToken, {
      name: "web2",
      folder: "C:\\code\\web2",
    });
    expect(updated.statusCode).toBe(200);
    expect((JSON.parse(updated.body) as Record<string, unknown>)["name"]).toBe("web2");

    // Owner-scoping: the list is per-user — another user (even an admin)
    // sees none of it. (Rust exposes no single-project GET; /:id is
    // PUT/DELETE only, so a GET there stays proxied to the Rust 405.)
    const adminList = await inject("GET", "/api/v1/projects", e.adminToken);
    expect(adminList.statusCode).toBe(200);
    expect(((json(adminList)["projects"] ?? []) as { id: string }[]).some((p) => p.id === pid)).toBe(false);

    // Archived projects drop out of the live list and show up in the
    // Archived section (GET ?archived=1); unarchive returns them.
    const archived = await inject("PUT", `/api/v1/projects/${pid}`, e.memberToken, { archived: true });
    expect(archived.statusCode).toBe(200);
    const live = await inject("GET", "/api/v1/projects", e.memberToken);
    expect(((json(live)["projects"] ?? []) as { id: string }[]).some((p) => p.id === pid)).toBe(false);
    const archivedList = await inject("GET", "/api/v1/projects?archived=1", e.memberToken);
    expect(archivedList.statusCode).toBe(200);
    expect(((json(archivedList)["projects"] ?? []) as { id: string }[]).some((p) => p.id === pid)).toBe(true);
    const restored = await inject("PUT", `/api/v1/projects/${pid}`, e.memberToken, { archived: false });
    expect(restored.statusCode).toBe(200);
    const afterRestore = await inject("GET", "/api/v1/projects", e.memberToken);
    expect(((json(afterRestore)["projects"] ?? []) as { id: string }[]).some((p) => p.id === pid)).toBe(true);

    const del = await inject("DELETE", `/api/v1/projects/${pid}`, e.memberToken);
    expect(del.statusCode).toBe(200);
    expect(json(del)).toEqual({ ok: true });
  });

  it("refuses to bind a project to another user's machine", async () => {
    // The folder a project names is the workdir its chats execute in, so a
    // bind onto a coworker's machine would run tools on their machine.
    const res = await inject("POST", "/api/v1/projects", e.adminToken, {
      folder: "C:\\code\\not-mine",
      machine_id: "machine-1",
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatchObject({ code: "bad_request", message: "unknown machine" });
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
    const teamId = (json(created) as unknown as { id: string }).id;
    const add = await inject("POST", `/api/v1/admin/teams/${teamId}/members`, e.adminToken, { user_id: e.memberId });
    expect(add.statusCode).toBe(200);
    const addAgain = await inject("POST", `/api/v1/admin/teams/${teamId}/members`, e.adminToken, {
      user_id: e.memberId,
    });
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
    expect((json(after)["members"] ?? []) as unknown[]).toHaveLength(0);
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
    expect(json(before)).toEqual({
      prompt: null,
      default:
        'You are the assistant in m6 test org\'s Guild workspace. A user\'s "you", "we" or "us" can mean m6 test org or you; when the question is about m6 test org\'s product, customers or systems, it means m6 test org. Ask when it is unclear. Help with the user\'s tasks, including software work when asked. Lead with the answer or outcome. One to three sentences usually suffice for routine questions and completion reports. Add detail when the user asks for it or needs it to understand the result or act on it. Send progress updates when you have a meaningful finding, a change of plan, or a blocker. Skip routine narration and state each finding once.',
    });

    const set = await inject("PUT", "/api/v1/admin/assistant-prompt", e.adminToken, { prompt: "You are terse." });
    expect(set.statusCode).toBe(200);
    expect(json(set)).toEqual({ ok: true });
    expect(json(await inject("GET", "/api/v1/admin/assistant-prompt", e.adminToken))).toMatchObject({
      prompt: "You are terse.",
    });

    const reset = await inject("PUT", "/api/v1/admin/assistant-prompt", e.adminToken, { prompt: "" });
    expect(reset.statusCode).toBe(200);
    expect(json(await inject("GET", "/api/v1/admin/assistant-prompt", e.adminToken))).toMatchObject({ prompt: null });

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
      "INSERT INTO integrations (id, org_id, name, kind, config, enabled) VALUES ($1, $2, 'github', 'github', $3, true) ON CONFLICT (org_id, name) DO NOTHING",
      [crypto.randomUUID(), e.orgId, JSON.stringify({ token_config: "x" })],
    );
    const list = await inject("GET", "/api/v1/admin/integrations", e.adminToken);
    expect(list.statusCode).toBe(200);
    const body = json(list) as unknown as { items: Record<string, unknown>[] };
    const githubRow = body.items.find((r) => r["name"] === "github");
    expect(githubRow).toMatchObject({ configured: true, enabled: true, categories: ["code"], secret_names: ["token"] });
    expect((githubRow!["settings"] as { fields: unknown[] }).fields.length).toBe(2);
    const mcpRow = body.items.find((r) => r["name"] === "test-mcp");
    expect(mcpRow).toMatchObject({ categories: ["mcp"], configured: true });

    // Every plugin is in the shop; the unconfigured ones report their
    // storefront metadata.
    expect(body.items.map((r) => r["name"])).toContain("searxng");
    const slack = body.items.find((a) => a["name"] === "slack") as Record<string, unknown>;
    expect(slack).toMatchObject({ configured: false, categories: ["messaging"], secret_names: ["bot_token"] });
    expect(slack["summary"]).toBe("Slack: list channels and users, read channel history, post messages");
    expect(String(slack["logo"])).toContain("<svg");
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
    expect(
      ((stored.rows[0]!.config as Record<string, unknown>)["tools"] as Record<string, unknown>)["search_repositories"],
    ).toEqual({
      enabled: true,
      approval: "always_ask",
    });

    // An audit event is emitted.
    const events = await e.env.db.query(
      "SELECT payload FROM events WHERE org_id = $1 AND kind = 'integration.tool_curated' ORDER BY created_at DESC LIMIT 1",
      [e.orgId],
    );
    expect((events.rows[0]!.payload as Record<string, unknown>)["tool"]).toBe("search_repositories");

    const badName = await inject("PUT", `/api/v1/admin/integrations/${rowId}/tools/bad%2Fname`, e.adminToken, {
      enabled: true,
    });
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
    expect(
      ((stored.rows[0]!.config as Record<string, unknown>)["tools"] as Record<string, unknown>)["get_file"],
    ).toEqual({
      enabled: true,
      approval: "always_allow",
    });

    // The curated tool list echoes the value back (not collapsed to default).
    const list = await inject("GET", `/api/v1/admin/integrations/${rowId}/tools`, e.adminToken);
    const tool = ((json(list)["tools"] ?? []) as Record<string, unknown>[]).find((t) => t["name"] === "get_file");
    expect(tool!["approval"]).toBe("always_allow");
  });

  it("deletes an integration row with its secrets", async () => {
    const delGithub = await inject(
      "DELETE",
      `/api/v1/admin/integrations/${(await e.env.db.query("SELECT id FROM integrations WHERE org_id = $1 AND name = 'github'", [e.orgId])).rows[0]!.id}`,
      e.adminToken,
    );
    expect(delGithub.statusCode).toBe(200);
    // Deleting the configured row puts github back on the available list.
    const after = json(await inject("GET", "/api/v1/admin/integrations", e.adminToken)) as unknown as {
      items: { name: string; configured: boolean }[];
    };
    expect(after.items.find((a) => a.name === "github")!.configured).toBe(false);

    const ins = await e.env.db.query(
      "INSERT INTO integrations (id, org_id, name, kind, config, enabled) VALUES ($1, $2, 'slack', 'slack', '{}', false) RETURNING id",
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
    const secrets = await e.env.db.query(
      "SELECT * FROM integration_secrets WHERE org_id = $1 AND integration = 'slack'",
      [e.orgId],
    );
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
      const env = await createObjectStoreStack("error", { GUILD_WEB_DIST: dir }, "m6");
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
        const traversal = await env.app.inject({ method: "GET", url: "/assets/../../etc/passwd" });
        expect(traversal.statusCode).toBe(200);
        expect(traversal.body).toBe("<html>index</html>");
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
    const env = await createObjectStoreStack(
      "error",
      { GUILD_FARO_URL: `http://127.0.0.1:${addr.port}/collect` },
      "m6",
    );
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
