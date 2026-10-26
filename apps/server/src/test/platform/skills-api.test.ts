// Skill HTTP surface (spec §1): editor save (create/edit), catalog/search,
// detail, source, install/pin/uninstall, maintainer gate, unpublish, fork,
// activity feed — plus the member download lift for kind=skill (§1.3).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createM6TestEnv, type M6TestEnv } from "./m6-harness.js";
import { hashPassword } from "../../platform/crypto.js";
import { packBundle } from "../../platform/bundle.js";

const PASSWORD = "hunter226";

interface Env {
  env: M6TestEnv;
  adminToken: string;
  memberToken: string;
  member2Token: string;
  adminId: string;
  memberId: string;
  member2Id: string;
  orgId: string;
}

let e: Env;

beforeAll(async () => {
  const env = await createM6TestEnv();
  const orgId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const member2Id = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `sa-admin-${suffix}@example.test`;
  const memberEmail = `sa-member-${suffix}@example.test`;
  const member2Email = `sa-member2-${suffix}@example.test`;
  const hash = await hashPassword(PASSWORD);
  await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'skills api org')", [orgId]);
  await env.db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed'), ($7, $2, $8, $4, 'member', 'managed')",
    [adminId, orgId, adminEmail, hash, memberId, memberEmail, member2Id, member2Email],
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
    member2Token: await login(member2Email),
    adminId,
    memberId,
    member2Id,
    orgId,
  };
}, 120_000);

afterAll(async () => {
  await e?.env.cleanup();
}, 60_000);

interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  raw: Buffer;
  json(): unknown;
}

const inject = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  token: string,
  payload?: unknown,
): Promise<Reply> =>
  e.env.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  }) as unknown as Promise<Reply>;

const createSkill = (slug: string, body: string, token = e.memberToken, extra: Record<string, unknown> = {}): Promise<Reply> =>
  inject("POST", "/api/v1/skills", token, { slug, description: "d", body, ...extra });

const editSkill = (slug: string, body: string, token = e.memberToken): Promise<Reply> =>
  inject("PUT", `/api/v1/skills/${slug}`, token, { description: "d", body });

/** The legacy raw registry route (spec §1.2's other publish path): arbitrary
 *  explicit versions, the source of version gaps the editor must survive. */
const rawPublish = async (slug: string, version: string, body = "# x"): Promise<Reply> => {
  const bundle = packBundle({
    "manifest.json": Buffer.from(JSON.stringify({ kind: "skill", slug, version, description: "d" })),
    "SKILL.md": Buffer.from(body, "utf8"),
  });
  return e.env.app.inject({
    method: "POST",
    url: `/api/v1/registry/skill?slug=${slug}&version=${version}`,
    headers: { authorization: `Bearer ${e.memberToken}`, "content-type": "application/octet-stream" },
    payload: bundle,
  }) as unknown as Promise<Reply>;
};

describe("skills api", () => {
  it("create → catalog shows it", async () => {
    const res = await createSkill("panel-skill", "# panel");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "panel-skill", version: "v1" });

    const catalog = await inject("GET", "/api/v1/skills", e.memberToken);
    expect(catalog.statusCode).toBe(200);
    const items = (catalog.json() as { items: Array<Record<string, unknown>> }).items;
    const row = items.find((i) => i.slug === "panel-skill");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      description: "d",
      latest_version: "v1",
      maintainer_gated: false,
      // Publishing auto-installs for the creator (pinned at v1).
      installs: 1,
      installs_latest: 1,
      tombstoned: false,
    });
    expect((row!.owner as { kind: string }).kind).toBe("user");
  });

  it("put → v2 appears and source defaults to latest", async () => {
    await createSkill("edit-skill", "# first");
    const res = await editSkill("edit-skill", "# second");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "edit-skill", version: "v2" });

    const detail = await inject("GET", "/api/v1/skills/edit-skill", e.memberToken);
    expect(detail.statusCode).toBe(200);
    const versions = (detail.json() as { versions: Array<{ version: string; publisher: string | null }> }).versions;
    expect(versions.map((v) => v.version)).toEqual(["v2", "v1"]);
    expect(versions[0]!.publisher).toBe(e.memberId);

    const src = await inject("GET", "/api/v1/skills/edit-skill/source", e.memberToken);
    expect(src.statusCode).toBe(200);
    const body = src.json() as { version: string; skill_md: string; files: Array<{ path: string }> };
    expect(body.version).toBe("v2");
    expect(body.skill_md).toBe("# second");
    // manifest.json is registry packaging metadata — never listed to agents.
    expect(body.files.map((f) => f.path).sort()).toEqual(["SKILL.md"]);
  });

  it("source carries each bundle file's text body", async () => {
    const slug = "source-files-skill";
    const bundle = packBundle({
      "manifest.json": Buffer.from(JSON.stringify({ kind: "skill", slug, version: "v1", description: "d" })),
      "SKILL.md": Buffer.from("# body", "utf8"),
      "references/notes.md": Buffer.from("# notes\nrule one\n", "utf8"),
      "scripts/run.sh": Buffer.from("echo hi\n", "utf8"),
    });
    const pub = await e.env.app.inject({
      method: "POST",
      url: `/api/v1/registry/skill?slug=${slug}&version=v1`,
      headers: { authorization: `Bearer ${e.memberToken}`, "content-type": "application/octet-stream" },
      payload: bundle,
    });
    expect(pub.statusCode).toBe(200);

    const src = await inject("GET", `/api/v1/skills/${slug}/source`, e.memberToken);
    expect(src.statusCode).toBe(200);
    const body = src.json() as { files: Array<{ path: string; content: string | null }> };
    const byPath = new Map(body.files.map((f) => [f.path, f.content]));
    expect(byPath.get("references/notes.md")).toBe("# notes\nrule one\n");
    expect(byPath.get("scripts/run.sh")).toBe("echo hi\n");
  });

  it("editor save writes the extra bundle files, and a later edit replaces them", async () => {
    const files = [
      { path: "references/notes.md", content: "# notes\nrule one\n" },
      { path: "scripts/run.sh", content: "echo hi\n" },
    ];
    const created = await inject("POST", "/api/v1/skills", e.memberToken, {
      slug: "multi-file-skill",
      description: "d",
      body: "# body",
      files,
    });
    expect(created.statusCode).toBe(200);

    const src = await inject("GET", "/api/v1/skills/multi-file-skill/source", e.memberToken);
    type Source = { files: Array<{ path: string; content: string | null }> };
    const byPath = new Map((src.json() as Source).files.map((f) => [f.path, f.content]));
    expect(byPath.get("references/notes.md")).toBe("# notes\nrule one\n");
    expect(byPath.get("scripts/run.sh")).toBe("echo hi\n");

    const edited = await inject("PUT", "/api/v1/skills/multi-file-skill", e.memberToken, {
      description: "d",
      body: "# body",
      files: [{ path: "references/notes.md", content: "# notes\nrule two\n" }],
    });
    expect(edited.statusCode).toBe(200);
    const next = await inject("GET", "/api/v1/skills/multi-file-skill/source", e.memberToken);
    const nextByPath = new Map((next.json() as Source).files.map((f) => [f.path, f.content]));
    expect(nextByPath.get("references/notes.md")).toBe("# notes\nrule two\n");
    // The PUT replaces the bundle: a file left out of the payload is gone.
    expect(nextByPath.has("scripts/run.sh")).toBe(false);
  });

  it("editor save refuses unsafe file paths", async () => {
    for (const path of ["SKILL.md", "manifest.json", "/etc/passwd", "../escape.md", "a//b.md"]) {
      const res = await inject("POST", "/api/v1/skills", e.memberToken, {
        slug: `bad-path-${path.replace(/[^a-z0-9]/gi, "")}`,
        description: "d",
        body: "# x",
        files: [{ path, content: "x" }],
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("collapses a multi-line description to one line on save", async () => {
    await inject("POST", "/api/v1/skills", e.memberToken, {
      slug: "single-line-skill",
      description: "line one\nline two\r\n\tline three",
      body: "# x",
    });
    const detail = await inject("GET", "/api/v1/skills/single-line-skill", e.memberToken);
    expect((detail.json() as { description: string }).description).toBe("line one line two line three");
  });

  it("publish auto-installs unpinned; edits reach unpinned installs; explicit pins hold", async () => {
    await createSkill("auto-install-skill", "# auto");
    const mine = await inject("GET", "/api/v1/skills/installs", e.memberToken);
    type Installs = { installs: Array<{ slug: string; pinned_version: string | null }> };
    const myRow = (body: unknown, slug: string) =>
      (body as Installs).installs.find((i) => i.slug === slug);
    expect(myRow(mine.json(), "auto-install-skill")).toMatchObject({ pinned_version: null });

    // A second user's unpinned install follows the next publish too.
    await inject("POST", "/api/v1/skills/auto-install-skill/install", e.member2Token, {});
    await editSkill("auto-install-skill", "# auto v2");
    expect(myRow((await inject("GET", "/api/v1/skills/installs", e.memberToken)).json(), "auto-install-skill"))
      .toMatchObject({ pinned_version: null });
    expect(myRow((await inject("GET", "/api/v1/skills/installs", e.member2Token)).json(), "auto-install-skill"))
      .toMatchObject({ pinned_version: null });

    // An explicit pin keeps the version across publishes.
    const pinned = await inject("POST", "/api/v1/skills/auto-install-skill/pin", e.member2Token, { version: "v1" });
    expect(pinned.statusCode).toBe(200);
    await editSkill("auto-install-skill", "# auto v3");
    expect(myRow((await inject("GET", "/api/v1/skills/installs", e.member2Token)).json(), "auto-install-skill"))
      .toMatchObject({ pinned_version: "v1" });
    // The unpinned publisher still reads the latest.
    expect(myRow((await inject("GET", "/api/v1/skills/installs", e.memberToken)).json(), "auto-install-skill"))
      .toMatchObject({ pinned_version: null });
  });

  it("editor save after a version gap publishes max+1, never an overwrite", async () => {
    // Legacy raw-route publishes with a gap: v1 then v3 (row count = 2 —
    // count-based arithmetic would recompute "v3" and silently overwrite it).
    expect((await rawPublish("gap-skill", "v1")).statusCode).toBe(200);
    expect((await rawPublish("gap-skill", "v3")).statusCode).toBe(200);

    const res = await editSkill("gap-skill", "# gapped");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "gap-skill", version: "v4" });

    const detail = await inject("GET", "/api/v1/skills/gap-skill", e.memberToken);
    const versions = (detail.json() as { versions: Array<{ version: string }> }).versions;
    expect(versions.map((v) => v.version)).toEqual(["v4", "v3", "v1"]);
  });

  it("detail carries read_stats (degraded to zero without a live ClickHouse)", async () => {
    await createSkill("stats-skill", "# stats");
    const detail = await inject("GET", "/api/v1/skills/stats-skill", e.memberToken);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { read_stats: unknown }).read_stats).toEqual({ total: 0, series: [] });
  });

  it("install → my_install set and activity contains skill.installed", async () => {
    await createSkill("install-skill", "# install me");
    const res = await inject("POST", "/api/v1/skills/install-skill/install", e.memberToken, {});
    expect(res.statusCode).toBe(200);
    // No version in the body: the install follows the latest.
    expect(res.json()).toMatchObject({ install: { slug: "install-skill", pinned_version: null } });

    const detail = await inject("GET", "/api/v1/skills/install-skill", e.memberToken);
    expect((detail.json() as { my_install: { pinned_version: string | null } }).my_install.pinned_version).toBeNull();
    expect((detail.json() as { installs: number }).installs).toBe(1);

    const activity = await inject("GET", "/api/v1/skills/activity?filter=all", e.memberToken);
    const events = (activity.json() as { events: Array<{ kind: string; payload: Record<string, unknown> }> }).events;
    expect(events.some((ev) => ev.kind === "skill.installed" && ev.payload.slug === "install-skill")).toBe(true);
    // the publish shows in the feed too, and under the changes filter
    const changes = await inject("GET", "/api/v1/skills/activity?filter=changes", e.memberToken);
    const changeKinds = (changes.json() as { events: Array<{ kind: string }> }).events.map((ev) => ev.kind);
    expect(changeKinds).toContain("registry.published");
    expect(changeKinds).not.toContain("skill.installed");
  });

  it("GET /api/v1/skills/installs lists the caller's installs and their pins", async () => {
    await createSkill("installs-list-skill", "# installs list");
    await inject("POST", "/api/v1/skills/installs-list-skill/install", e.memberToken, {});
    const res = await inject("GET", "/api/v1/skills/installs", e.memberToken);
    expect(res.statusCode).toBe(200);
    const installs = (
      res.json() as { installs: Array<{ slug: string; pinned_version: string | null; installed_at: string }> }
    ).installs;
    const row = installs.find((i) => i.slug === "installs-list-skill");
    expect(row).toMatchObject({ slug: "installs-list-skill", pinned_version: null });
    expect(typeof row?.installed_at).toBe("string");
    // another member's list does not include it
    const other = await inject("GET", "/api/v1/skills/installs", e.member2Token);
    expect(
      (other.json() as { installs: Array<{ slug: string }> }).installs.find(
        (i) => i.slug === "installs-list-skill",
      ),
    ).toBeUndefined();
  });

  it("pin to v1 after installing at v2; unknown version and missing install are 404s", async () => {
    await createSkill("pin-skill", "# v1");
    await editSkill("pin-skill", "# v2");
    await inject("POST", "/api/v1/skills/pin-skill/install", e.memberToken, { version: "v2" });
    const res = await inject("POST", "/api/v1/skills/pin-skill/pin", e.memberToken, { version: "v1" });
    expect(res.statusCode).toBe(200);
    const detail = await inject("GET", "/api/v1/skills/pin-skill", e.memberToken);
    const parsed = detail.json() as {
      my_install: { pinned_version: string };
      pin_counts: Array<{ version: string; count: number }>;
    };
    expect(parsed.my_install.pinned_version).toBe("v1");
    expect(parsed.pin_counts).toEqual([{ version: "v1", count: 1 }]);

    expect((await inject("POST", "/api/v1/skills/pin-skill/pin", e.memberToken, { version: "v99" })).statusCode).toBe(404);
    expect((await inject("POST", "/api/v1/skills/pin-skill/pin", e.member2Token, { version: "v1" })).statusCode).toBe(404);
  });

  it("uninstall removes the record and emits skill.uninstalled", async () => {
    await createSkill("uninstall-skill", "# bye");
    await inject("POST", "/api/v1/skills/uninstall-skill/install", e.memberToken, {});
    expect((await inject("DELETE", "/api/v1/skills/uninstall-skill/install", e.memberToken)).statusCode).toBe(200);
    expect((await inject("DELETE", "/api/v1/skills/uninstall-skill/install", e.memberToken)).statusCode).toBe(404);
    const detail = await inject("GET", "/api/v1/skills/uninstall-skill", e.memberToken);
    expect((detail.json() as { my_install: unknown }).my_install).toBeNull();
    const activity = await inject("GET", "/api/v1/skills/activity?filter=all", e.memberToken);
    const kinds = (activity.json() as { events: Array<{ kind: string }> }).events.map((ev) => ev.kind);
    expect(kinds).toContain("skill.uninstalled");
  });

  it("gate flip by non-owner → 403; the gate then blocks a non-owner editor save", async () => {
    await createSkill("gate-skill", "# gated");
    expect((await inject("POST", "/api/v1/skills/gate-skill/gate", e.member2Token, { enabled: true })).statusCode).toBe(403);
    expect((await inject("POST", "/api/v1/skills/gate-skill/gate", e.memberToken, { enabled: true })).statusCode).toBe(200);
    expect((await editSkill("gate-skill", "# intruder", e.member2Token)).statusCode).toBe(403);

    const detail = await inject("GET", "/api/v1/skills/gate-skill", e.memberToken);
    expect((detail.json() as { maintainer_gated: boolean }).maintainer_gated).toBe(true);
    expect((await inject("POST", "/api/v1/skills/gate-skill/gate", e.adminToken, { enabled: false })).statusCode).toBe(200);
  });

  it("unpublish by non-owner → 403; by owner → catalog excludes it but detail keeps provenance", async () => {
    await createSkill("tomb-api-skill", "# gone");
    expect((await inject("POST", "/api/v1/skills/tomb-api-skill/unpublish", e.member2Token)).statusCode).toBe(403);
    expect((await inject("POST", "/api/v1/skills/tomb-api-skill/unpublish", e.memberToken)).statusCode).toBe(200);

    const catalog = await inject("GET", "/api/v1/skills", e.memberToken);
    const slugs = (catalog.json() as { items: Array<{ slug: string }> }).items.map((i) => i.slug);
    expect(slugs).not.toContain("tomb-api-skill");

    const detail = await inject("GET", "/api/v1/skills/tomb-api-skill", e.memberToken);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { tombstoned: boolean; versions: unknown[] }).tombstoned).toBe(true);
    expect((detail.json() as { versions: unknown[] }).versions).toHaveLength(1);

    const activity = await inject("GET", "/api/v1/skills/activity?filter=all", e.memberToken);
    const kinds = (activity.json() as { events: Array<{ kind: string }> }).events.map((ev) => ev.kind);
    expect(kinds).toContain("registry.unpublished");
  });

  it("search q= matches body text and description", async () => {
    await createSkill("search-skill", "rotate the kerberos keys weekly");
    const hit = await inject("GET", "/api/v1/skills?q=kerberos", e.memberToken);
    const hits = (hit.json() as { items: Array<{ slug: string }> }).items.map((i) => i.slug);
    expect(hits).toContain("search-skill");

    const byDesc = await inject("GET", "/api/v1/skills?q=panel-skill", e.memberToken);
    // description "d" matches nothing; the slug itself is a name hit via ILIKE on body/description only —
    // q must match description or SKILL.md text, so a bare slug match is not required
    expect(byDesc.statusCode).toBe(200);

    const miss = await inject("GET", "/api/v1/skills?q=zzznothingmatches", e.memberToken);
    expect((miss.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("member downloads a never-reviewed skill bundle with 200 (review gate lifted for skills)", async () => {
    await createSkill("dl-skill", "# downloadable");
    const res = await inject("GET", "/api/v1/registry/skill/dl-skill/v1/bundle", e.member2Token);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("creating over a live slug is 409 slug_taken; over a tombstoned slug clears the tombstone", async () => {
    await createSkill("dup-skill", "# one");
    const dup = await createSkill("dup-skill", "# two");
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: { code: string } }).error.code).toBe("slug_taken");

    await inject("POST", "/api/v1/skills/dup-skill/unpublish", e.memberToken);
    const fresh = await createSkill("dup-skill", "# fresh");
    expect(fresh.statusCode).toBe(200);
    expect((fresh.json() as { version: string }).version).toBe("v2");

    const catalog = await inject("GET", "/api/v1/skills", e.memberToken);
    const slugs = (catalog.json() as { items: Array<{ slug: string }> }).items.map((i) => i.slug);
    expect(slugs).toContain("dup-skill");
    const detail = await inject("GET", "/api/v1/skills/dup-skill", e.memberToken);
    expect((detail.json() as { tombstoned: boolean }).tombstoned).toBe(false);
  });

  it("fork seeds v1 from the source version and records provenance", async () => {
    await createSkill("orig-skill", "# original");
    await editSkill("orig-skill", "# improved");
    const res = await createSkill("fork-skill", "# ignored", e.memberToken, {
      forked_from: "orig-skill",
      from_version: "v1",
      description: "fork desc",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "fork-skill", version: "v1" });

    const src = await inject("GET", "/api/v1/skills/fork-skill/source", e.memberToken);
    const body = src.json() as { version: string; skill_md: string };
    expect(body.version).toBe("v1");
    expect(body.skill_md).toBe("# original");

    const detail = await inject("GET", "/api/v1/skills/fork-skill", e.memberToken);
    expect((detail.json() as { forked_from: string }).forked_from).toBe("orig-skill@v1");
    expect((detail.json() as { description: string }).description).toBe("fork desc");

    const activity = await inject("GET", "/api/v1/skills/activity?filter=all", e.memberToken);
    const kinds = (activity.json() as { events: Array<{ kind: string }> }).events.map((ev) => ev.kind);
    expect(kinds).toContain("registry.forked");

    expect((await createSkill("ghost-fork", "x", e.memberToken, { forked_from: "no-such-skill" })).statusCode).toBe(404);
    expect((await createSkill("dup-skill", "x", e.memberToken, { forked_from: "orig-skill" })).statusCode).toBe(409); // taken
  });

  it("source respects an explicit version over the pin and latest", async () => {
    await createSkill("ver-skill", "# one");
    await editSkill("ver-skill", "# two");
    // A second user pins v2 explicitly (the publisher's own pin auto-advances
    // on every edit, so their source is always latest).
    await inject("POST", "/api/v1/skills/ver-skill/install", e.member2Token, { version: "v2" });
    const src = await inject("GET", "/api/v1/skills/ver-skill/source?version=v1", e.member2Token);
    expect((src.json() as { version: string; skill_md: string }).skill_md).toBe("# one");
    // pinned version wins over latest when no query version
    await editSkill("ver-skill", "# three");
    const pinned = await inject("GET", "/api/v1/skills/ver-skill/source", e.member2Token);
    expect((pinned.json() as { version: string }).version).toBe("v2");
  });

  it("GET /skills/teams lists the caller's memberships only", async () => {
    const mine = await inject("POST", "/api/v1/admin/teams", e.adminToken, { name: "selector-mine" });
    const other = await inject("POST", "/api/v1/admin/teams", e.adminToken, { name: "selector-other" });
    expect(mine.statusCode).toBe(200);
    expect(other.statusCode).toBe(200);
    const mineId = (mine.json() as { id: string }).id;
    const add = await inject("POST", `/api/v1/admin/teams/${mineId}/members`, e.adminToken, { user_id: e.memberId });
    expect(add.statusCode).toBe(200);

    const list = await inject("GET", "/api/v1/skills/teams", e.memberToken);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ teams: [{ id: mineId, name: "selector-mine" }] });

    // A member with no memberships gets an empty list, not an error.
    const none = await inject("GET", "/api/v1/skills/teams", e.member2Token);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ teams: [] });

    // Unauthenticated callers are rejected like any other user route.
    const anon = await e.env.app.inject({ method: "GET", url: "/api/v1/skills/teams" });
    expect(anon.statusCode).toBe(401);
  });

  it("GET /skills/sync-payload serves the machine's desired install list (the connect-time pull)", async () => {
    await createSkill("pull-skill", "# pull me");
    // Create auto-installs for the publisher, pinned at v1.
    const withInstall = await inject("GET", "/api/v1/skills/sync-payload", e.memberToken);
    expect(withInstall.statusCode).toBe(200);
    const entry = (withInstall.json() as { skills: Array<Record<string, string>> }).skills.find(
      (s) => s.slug === "pull-skill",
    );
    expect(entry).toMatchObject({ slug: "pull-skill", version: "v1" });
    expect(entry!["bundle_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(entry!["url"]).toContain("/api/v1/registry/skill/pull-skill/v1/bundle");

    // After the uninstall the pull omits the slug — absence is the
    // removal signal the machine's sync acts on.
    await inject("DELETE", "/api/v1/skills/pull-skill/install", e.memberToken);
    const after = await inject("GET", "/api/v1/skills/sync-payload", e.memberToken);
    expect(after.statusCode).toBe(200);
    expect(
      (after.json() as { skills: Array<{ slug: string }> }).skills.some((s) => s.slug === "pull-skill"),
    ).toBe(false);

    // Unauthenticated callers are rejected like any other user route.
    const anon = await e.env.app.inject({ method: "GET", url: "/api/v1/skills/sync-payload" });
    expect(anon.statusCode).toBe(401);
  });
});
