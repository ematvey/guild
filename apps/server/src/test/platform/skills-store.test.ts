// SkillStore semantics (spec §3): installs pin versions, one row per
// (user, slug), counts aggregate for the detail page.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createM5TestEnv, type M5TestEnv } from "./m5-harness.js";
import { SkillStore } from "../../platform/store/skills.js";

let env: M5TestEnv;
let store: SkillStore;
let orgId: string;
let userId: string;

beforeAll(async () => {
  env = await createM5TestEnv();
  store = new SkillStore(env.db);
  await env.db.query("INSERT INTO orgs (id, name) VALUES (gen_random_uuid(), 'skills-store-org')");
  await env.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     SELECT gen_random_uuid(), id, 'skills-store@example.test', '', 'admin', 'managed' FROM orgs WHERE name = 'skills-store-org'`,
  );
  const u = await env.db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM users WHERE email = 'skills-store@example.test'",
  );
  userId = u.rows[0]!.id;
  orgId = u.rows[0]!.org_id;
}, 60_000);

afterAll(async () => {
  await env.cleanup();
});

describe("SkillStore", () => {
  it("installs, repins, lists, uninstalls", async () => {
    const row = await store.install(orgId, userId, "sql-explorer", "v1");
    expect(row.pinned_version).toBe("v1");
    expect(row.slug).toBe("sql-explorer");
    expect((await store.listForUser(orgId, userId)).map((r) => r.slug)).toEqual(["sql-explorer"]);

    await store.setPin(orgId, userId, "sql-explorer", "v2");
    expect((await store.byUserAndSlug(orgId, userId, "sql-explorer"))?.pinned_version).toBe("v2");

    await store.install(orgId, userId, "deploy-checklist", "v1");
    expect(await store.installCount(orgId, "sql-explorer")).toBe(1);

    await store.uninstall(orgId, userId, "sql-explorer");
    expect(await store.byUserAndSlug(orgId, userId, "sql-explorer")).toBeNull();
  });

  it("re-install updates the pin instead of duplicating the row", async () => {
    await store.install(orgId, userId, "repin-skill", "v1");
    const again = await store.install(orgId, userId, "repin-skill", "v3");
    expect(again.pinned_version).toBe("v3");
    expect((await store.listForUser(orgId, userId)).filter((r) => r.slug === "repin-skill")).toHaveLength(1);
    await store.uninstall(orgId, userId, "repin-skill");
  });

  it("uninstall and setPin on a missing install are 404s", async () => {
    await expect(store.setPin(orgId, userId, "ghost", "v1")).rejects.toMatchObject({ status: 404 });
    await expect(store.uninstall(orgId, userId, "ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("counts aggregates per version and org", async () => {
    const other = await env.db.query<{ id: string }>(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES (gen_random_uuid(), $1, 'skills-store-other@example.test', '', 'member', 'managed') RETURNING id`,
      [orgId],
    );
    const otherId = other.rows[0]!.id;
    await store.install(orgId, otherId, "count-skill", "v1");
    await store.install(orgId, userId, "count-skill", "v2");
    expect(await store.installCount(orgId, "count-skill")).toBe(2);
    expect(await store.pinCounts(orgId, "count-skill")).toEqual(
      expect.arrayContaining([
        { version: "v1", count: 1 },
        { version: "v2", count: 1 },
      ]),
    );
    await store.uninstall(orgId, otherId, "count-skill");
    await store.uninstall(orgId, userId, "count-skill");
    expect(await store.installCount(orgId, "count-skill")).toBe(0);
  });
});
