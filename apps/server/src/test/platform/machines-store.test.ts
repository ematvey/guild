// Machine registry store semantics:
// reconnect refresh, foreign-user refusal, foreign-org untouched, fingerprint
// adoption re-keying (re-pair) with binding moves, bindable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createHubTestEnv, type HubTestEnv } from "../support/hub-env.js";
import { MachineStore } from "../../platform/store/machines.js";

let env: HubTestEnv;
let store: MachineStore;
let orgId: string;
let userId: string;

beforeAll(async () => {
  env = await createHubTestEnv();
  store = new MachineStore(env.db);
  await env.db.query("INSERT INTO orgs (id, name) VALUES (gen_random_uuid(), 'm5-store-org')");
  await env.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     SELECT gen_random_uuid(), id, 'm5-store@example.test', '', 'admin', 'managed' FROM orgs WHERE name = 'm5-store-org'`,
  );
  const u = await env.db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM users WHERE email = 'm5-store@example.test'",
  );
  userId = u.rows[0]!.id;
  orgId = u.rows[0]!.org_id;
}, 60_000);

afterAll(async () => {
  await env.cleanup();
});

async function insertUser(email: string, org = orgId): Promise<string> {
  const res = await env.db.query<{ id: string }>(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES (gen_random_uuid(), $2, $1, '', 'member', 'managed') RETURNING id`,
    [email, org],
  );
  return res.rows[0]!.id;
}

describe("MachineStore.upsertConnected", () => {
  it("inserts a fresh row and refreshes metadata on reconnect (NULL never erases)", async () => {
    const first = await store.upsertConnected(orgId, userId, "s-machine", "Desk", "FP-1", "Linux", "6.1", "0.5.34", "10.0.0.1");
    expect(first.row.machine_id).toBe("s-machine");
    expect(first.adopted_from).toBeNull();

    // Reconnect with only some metadata: the rest is retained.
    const again = await store.upsertConnected(orgId, userId, "s-machine", null, null, null, null, "0.5.35", "10.0.0.2");
    expect(again.adopted_from).toBeNull();
    expect(again.row.label).toBe("Desk");
    expect(again.row.app_version).toBe("0.5.35");
    expect(again.row.last_ip).toBe("10.0.0.2");
    expect(again.row.os).toBe("Linux");
    expect(again.row.re_paired_at).toBeNull();
  });

  it("refuses a same-org machine id claimed by another user", async () => {
    const other = await insertUser("m5-store-other@example.test");
    await expect(store.upsertConnected(orgId, other, "s-machine", null, null, null, null, null, null)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("leaves a foreign-org machine id untouched and does not register the connect", async () => {
    const org2 = (await env.db.query<{ id: string }>("INSERT INTO orgs (id, name) VALUES (gen_random_uuid(), 'org2') RETURNING id")).rows[0]!.id;
    const otherOrgUser = await insertUser("m5-store-org2@example.test", org2);
    const result = await store.upsertConnected(org2, otherOrgUser, "s-machine", null, null, null, null, null, null);
    expect(result.row.org_id).toBe(orgId); // the untouched foreign row
    const rows = await env.db.query("SELECT * FROM machines WHERE machine_id = 's-machine'");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.org_id).toBe(orgId);
  });

  it("adopts a fingerprint match: re-keys the row, stamps re_paired_at, moves bindings, displaces", async () => {
    // The machine's previous pairing lives under the old id with the same
    // fingerprint.
    await store.upsertConnected(orgId, userId, "adopt-old", "Old", "FP-ADOPT", "Linux", null, null, "10.8.8.8");
    // A project + chat bound to the old machine id.
    await env.db.query(
      `INSERT INTO projects (id, org_id, user_id, name, folder, machine_id)
       VALUES (gen_random_uuid(), $1, $2, 'proj', 'C:\\proj', 'adopt-old')`,
      [orgId, userId],
    );
    const chat = (
      await env.db.query<{ id: string }>(
        `INSERT INTO chats (id, org_id, user_id, title, machine_id, machine_label)
         VALUES (gen_random_uuid(), $1, $2, 'c', 'adopt-old', 'Old') RETURNING id`,
        [orgId, userId],
      )
    ).rows[0]!.id;

    const outcome = await store.upsertConnected(orgId, userId, "adopt-new", "New", "FP-ADOPT", "Linux", null, null, "10.9.9.9");
    expect(outcome.adopted_from).toBe("adopt-old");
    expect(outcome.row.machine_id).toBe("adopt-new");
    expect(outcome.row.re_paired_at).not.toBeNull();
    // The old id is re-keyed away…
    expect((await env.db.query("SELECT * FROM machines WHERE machine_id = 'adopt-old'")).rows.length).toBe(0);
    // …and the durable execution bindings moved with it.
    expect((await env.db.query("SELECT machine_id FROM chats WHERE id = $1", [chat])).rows[0]!.machine_id).toBe("adopt-new");
    expect((await env.db.query("SELECT machine_id FROM projects WHERE name = 'proj'")).rows[0]!.machine_id).toBe("adopt-new");

    // Another member's fingerprint is never adopted.
    const other = await insertUser("m5-store-fp@example.test");
    const noAdopt = await store.upsertConnected(orgId, other, "other-machine", null, "FP-ADOPT", null, null, null, null);
    expect(noAdopt.adopted_from).toBeNull();
  });

  it("lastSeen refreshes; listForUser and bindable scope to the user/org", async () => {
    await store.upsertConnected(orgId, userId, "ls-machine", "LS", null, null, null, null, null);
    const before = (await env.db.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM machines WHERE machine_id = 'ls-machine'")).rows[0]!.last_seen_at;
    await new Promise((r) => setTimeout(r, 30));
    await store.lastSeen("ls-machine");
    const after = (await env.db.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM machines WHERE machine_id = 'ls-machine'")).rows[0]!.last_seen_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    const list = await store.listForUser(orgId, userId);
    expect(list.some((m) => m.machine_id === "ls-machine")).toBe(true);
    expect(list.some((m) => m.machine_id === "s-machine")).toBe(true);

    expect(await store.bindable("ls-machine", userId, orgId)).toBe(true);
    expect(await store.bindable("ls-machine", crypto.randomUUID(), orgId)).toBe(true);
    expect(await store.bindable("ls-machine", userId, crypto.randomUUID())).toBe(true);
    expect(await store.bindable("ls-machine", crypto.randomUUID(), crypto.randomUUID())).toBe(false);
    expect(await store.bindable("ghost", userId, orgId)).toBe(false);
  });
});

describe("MachineStore.deauthorize", () => {
  it("refuses while projects are bound, naming them", async () => {
    await store.upsertConnected(orgId, userId, "da-bound", "Bound", null, null, null, null, null);
    await env.db.query(
      `INSERT INTO projects (id, org_id, user_id, name, folder, machine_id)
       VALUES (gen_random_uuid(), $1, $2, 'keep-me', 'C:\\keep', 'da-bound')`,
      [orgId, userId],
    );
    const result = await store.deauthorize(orgId, userId, "da-bound");
    expect(result).toEqual({ kind: "blocked", projects: ["keep-me"] });
    expect((await env.db.query("SELECT 1 FROM machines WHERE machine_id = 'da-bound'")).rows.length).toBe(1);
  });

  it("drops the row, unbinds chats and returns the session to revoke", async () => {
    await store.upsertConnected(
      orgId, userId, "da-free", "Free", null, null, null, null, null, "session-hash-1",
    );
    const chat = (
      await env.db.query<{ id: string }>(
        `INSERT INTO chats (id, org_id, user_id, title, machine_id, machine_label)
         VALUES (gen_random_uuid(), $1, $2, 'c', 'da-free', 'Free') RETURNING id`,
        [orgId, userId],
      )
    ).rows[0]!.id;

    const result = await store.deauthorize(orgId, userId, "da-free");
    expect(result).toEqual({ kind: "removed", session_hash: "session-hash-1" });
    expect((await env.db.query("SELECT 1 FROM machines WHERE machine_id = 'da-free'")).rows.length).toBe(0);
    // The chat keeps running, on the server executor.
    const row = (
      await env.db.query<{ machine_id: string | null; machine_label: string | null }>(
        "SELECT machine_id, machine_label FROM chats WHERE id = $1",
        [chat],
      )
    ).rows[0]!;
    expect(row.machine_id).toBeNull();
    expect(row.machine_label).toBeNull();
  });

  it("reports a machine that is not the caller's", async () => {
    await store.upsertConnected(orgId, userId, "da-owner", "Mine", null, null, null, null, null);
    const other = await insertUser("m5-store-da@example.test");
    expect(await store.deauthorize(orgId, other, "da-owner")).toEqual({ kind: "missing" });
    expect(await store.deauthorize(orgId, userId, "da-absent")).toEqual({ kind: "missing" });
  });
});
