// Publish extraction + gate (spec §1.2/§1.3): SKILL.md text + the file
// projection are stored at publish; the first publish owns the item;
// gated slugs refuse non-maintainer pushes; republishes emit
// registry.updated; tombstoned slugs refuse publishes until cleared and
// leave the catalog.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObjectStoreStack, packBundle, type ObjectStoreStack } from "./object-store-stack.js";
import { hashPassword } from "../../platform/crypto.js";
import { RegistryStore } from "../../platform/store/registry.js";
import { TeamStore } from "../../platform/store/teams.js";

const PASSWORD = "hunter226";

interface Env {
  env: ObjectStoreStack;
  adminToken: string;
  memberToken: string;
  member2Token: string;
  adminEmail: string;
  memberEmail: string;
  adminId: string;
  memberId: string;
  member2Id: string;
  orgId: string;
}

let e: Env;
let store: RegistryStore;
let teams: TeamStore;

beforeAll(async () => {
  const env = await createObjectStoreStack("error", {}, "skills_publish");
  const orgId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const member2Id = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `sp-admin-${suffix}@example.test`;
  const memberEmail = `sp-member-${suffix}@example.test`;
  const member2Email = `sp-member2-${suffix}@example.test`;
  const hash = await hashPassword(PASSWORD);
  await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'skills publish org')", [orgId]);
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
    adminEmail,
    memberEmail,
    adminId,
    memberId,
    member2Id,
    orgId,
  };
  store = new RegistryStore(env.db);
  teams = new TeamStore(env.db);
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

function skillManifest(slug: string, version: string, description = "d"): Record<string, unknown> {
  return { kind: "skill", slug, version, description };
}

async function publish(
  slug: string,
  version: string,
  token: string,
  md = "# x",
): Promise<Reply> {
  const bundle = await packBundle({
    "manifest.json": JSON.stringify(skillManifest(slug, version)),
    "SKILL.md": md,
  });
  return inject("POST", `/api/v1/registry/skill?slug=${slug}&version=${version}`, token, bundle);
}

describe("skills publish", () => {
  it("stores SKILL.md text and the file projection, owning the first publish", async () => {
    const bundle = await packBundle({
      "manifest.json": JSON.stringify(skillManifest("test-skill", "v1", "A test")),
      "SKILL.md": "---\nname: test-skill\ndescription: A test\n---\n# hello",
      "scripts/run.sh": "echo hi",
    });
    const res = await inject("POST", "/api/v1/registry/skill?slug=test-skill&version=v1", e.memberToken, bundle);
    expect(res.statusCode).toBe(200);

    const row = await e.env.db.query<{ skill_md_text: string | null; files: unknown }>(
      "SELECT rv.skill_md_text, rv.files FROM registry_versions rv JOIN registry_items i ON i.id = rv.item_id " +
      "WHERE i.org_id = $1 AND i.kind = 'skill' AND i.slug = 'test-skill' AND rv.version = 'v1'",
      [e.orgId],
    );
    expect(row.rows[0]!.skill_md_text).toContain("# hello");
    expect((row.rows[0]!.files as { path: string }[]).map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "manifest.json",
      "scripts/run.sh",
    ]);

    const control = await store.itemControl(e.orgId, "skill", "test-skill");
    expect(control).toMatchObject({
      owner_user_id: e.memberId,
      owner_team_id: null,
      maintainer_gated: false,
      tombstoned: false,
      latest_version: "v1",
    });

    const events = await e.env.db.query<{ payload: { actor?: string; user_id?: string } }>(
      "SELECT payload FROM events WHERE org_id = $1 AND kind = 'registry.published' AND payload->>'slug' = 'test-skill'",
      [e.orgId],
    );
    expect(events.rows).toHaveLength(1);
    // The publisher's identity rides in the payload (label = display name
    // or email; these seed users have no display name).
    expect(events.rows[0]!.payload.actor).toBe(e.memberEmail);
    expect(events.rows[0]!.payload.user_id).toBe(e.memberId);
  });

  it("emits the pre-fix actorless payload for non-skill kinds (integration)", async () => {
    const bundle = await packBundle({
      "manifest.json": JSON.stringify({ kind: "integration", slug: "plain-integration", version: "v1", description: "d" }),
    });
    expect(
      (await inject("POST", "/api/v1/registry/integration?slug=plain-integration&version=v1", e.memberToken, bundle))
        .statusCode,
    ).toBe(200);
    const events = await e.env.db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE org_id = $1 AND kind = 'registry.published' AND payload->>'slug' = 'plain-integration'",
      [e.orgId],
    );
    expect(events.rows).toHaveLength(1);
    // mcp/integration emissions keep the exact pre-fix payload shape — no
    // actor fields ride along.
    expect(events.rows[0]!.payload).toEqual({ kind: "integration", slug: "plain-integration", version: "v1" });
  });

  it("refuses a non-maintainer push to a gated slug; republishes emit registry.updated", async () => {
    expect((await publish("gated-skill", "v1", e.memberToken)).statusCode).toBe(200);
    await e.env.db.query(
      "UPDATE registry_items SET maintainer_gated = true WHERE org_id = $1 AND kind = 'skill' AND slug = 'gated-skill'",
      [e.orgId],
    );
    expect((await publish("gated-skill", "v2", e.member2Token)).statusCode).toBe(403);
    expect((await publish("gated-skill", "v2", e.memberToken)).statusCode).toBe(200); // owner
    expect((await publish("gated-skill", "v3", e.adminToken)).statusCode).toBe(200); // admin bypass

    const updated = await e.env.db.query<{ payload: { version: string; actor: string } }>(
      "SELECT payload FROM events WHERE org_id = $1 AND kind = 'registry.updated' AND payload->>'slug' = 'gated-skill'",
      [e.orgId],
    );
    expect(updated.rows.map((r) => r.payload.version).sort()).toEqual(["v2", "v3"]);
    // Each republish names its actor: the owner republish, then the admin
    // bypass.
    expect(updated.rows.map((r) => r.payload.actor).sort()).toEqual([e.adminEmail, e.memberEmail]);
    const published = await e.env.db.query(
      "SELECT payload FROM events WHERE org_id = $1 AND kind = 'registry.published' AND payload->>'slug' = 'gated-skill'",
      [e.orgId],
    );
    expect(published.rows).toHaveLength(1); // only the first publish
  });

  it("gated pushes pass for owner-team members and fail after they leave the team", async () => {
    expect((await publish("team-skill", "v1", e.memberToken)).statusCode).toBe(200);
    const team = await teams.createTeam(e.orgId, "skills-publish-team");
    await teams.addMember(e.orgId, team.id, e.member2Id);
    await e.env.db.query(
      "UPDATE registry_items SET maintainer_gated = true, owner_team_id = $2 WHERE org_id = $1 AND kind = 'skill' AND slug = 'team-skill'",
      [e.orgId, team.id],
    );
    expect((await publish("team-skill", "v2", e.member2Token)).statusCode).toBe(200);

    await teams.removeMember(e.orgId, team.id, e.member2Id);
    expect((await publish("team-skill", "v3", e.member2Token)).statusCode).toBe(403);
  });

  it("tombstoned slugs refuse publishes until cleared and leave the catalog", async () => {
    expect((await publish("tomb-skill", "v1", e.memberToken)).statusCode).toBe(200);

    await store.markUnpublished(e.orgId, "skill", "tomb-skill");
    expect((await store.itemControl(e.orgId, "skill", "tomb-skill"))?.tombstoned).toBe(true);
    const listed = (await store.listItems(e.orgId, "skill")).map((r) => r.slug);
    expect(listed).not.toContain("tomb-skill");
    expect(listed).toContain("test-skill"); // live items stay listed

    expect((await publish("tomb-skill", "v2", e.memberToken)).statusCode).toBe(403);

    await store.clearTombstone(e.orgId, "skill", "tomb-skill");
    expect((await store.itemControl(e.orgId, "skill", "tomb-skill"))?.tombstoned).toBe(false);
    expect((await store.listItems(e.orgId, "skill")).map((r) => r.slug)).toContain("tomb-skill");
    expect((await publish("tomb-skill", "v2", e.memberToken)).statusCode).toBe(200);

    await expect(store.markUnpublished(e.orgId, "skill", "ghost")).rejects.toMatchObject({ status: 404 });
  });
});
