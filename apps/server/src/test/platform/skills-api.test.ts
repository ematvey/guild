// Skill HTTP surface (spec §1): editor save (create/edit), catalog/search,
// detail, source, install/pin/uninstall, maintainer gate, unpublish, fork,
// activity feed — plus the member download lift for kind=skill (§1.3).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createM6TestEnv, type M6TestEnv } from "./m6-harness.js";
import { hashPassword } from "../../platform/crypto.js";

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
      installs: 0,
      installs_latest: 0,
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

  it("install → my_install set and activity contains skill.installed", async () => {
    await createSkill("install-skill", "# install me");
    const res = await inject("POST", "/api/v1/skills/install-skill/install", e.memberToken, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ install: { slug: "install-skill", pinned_version: "v1" } });

    const detail = await inject("GET", "/api/v1/skills/install-skill", e.memberToken);
    expect((detail.json() as { my_install: { pinned_version: string } }).my_install.pinned_version).toBe("v1");
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

  it("GET /api/v1/skills/installs lists the caller's installs with their pins", async () => {
    await createSkill("installs-list-skill", "# installs list");
    await inject("POST", "/api/v1/skills/installs-list-skill/install", e.memberToken, {});
    const res = await inject("GET", "/api/v1/skills/installs", e.memberToken);
    expect(res.statusCode).toBe(200);
    const installs = (
      res.json() as { installs: Array<{ slug: string; pinned_version: string; installed_at: string }> }
    ).installs;
    const row = installs.find((i) => i.slug === "installs-list-skill");
    expect(row).toMatchObject({ slug: "installs-list-skill", pinned_version: "v1" });
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
    await inject("POST", "/api/v1/skills/ver-skill/install", e.memberToken, { version: "v2" });
    const src = await inject("GET", "/api/v1/skills/ver-skill/source?version=v1", e.memberToken);
    expect((src.json() as { version: string; skill_md: string }).skill_md).toBe("# one");
    // pinned version wins over latest when no query version
    await editSkill("ver-skill", "# three");
    const pinned = await inject("GET", "/api/v1/skills/ver-skill/source", e.memberToken);
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
});
