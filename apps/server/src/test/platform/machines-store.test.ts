// Machine registry store semantics:
// reconnect refresh, foreign-user refusal, foreign-org untouched, fingerprint
// adoption re-keying (re-pair) with binding moves, bindable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createM5TestEnv, type M5TestEnv } from "./m5-harness.js";
import { MachineStore, canonicalMachineId } from "../../platform/store/machines.js";

let env: M5TestEnv;
let store: MachineStore;
let orgId: string;
let userId: string;

beforeAll(async () => {
  env = await createM5TestEnv();
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
  it("keys the row by the derived identity and refreshes metadata on reconnect (NULL never erases)", async () => {
    const first = await store.upsertConnected(orgId, userId, "s-machine", "Desk", "FP-1", "Linux", "6.1", "0.5.34", "10.0.0.1");
    const derived = canonicalMachineId(orgId, userId, "FP-1")!;
    expect(first.row.machine_id).toBe(derived);
    expect(first.adopted_from).toBeNull();

    // Reconnect with only some metadata: the rest is retained. A fresh client
    // install (new client-issued id, same hardware) lands on the same row.
    const again = await store.upsertConnected(orgId, userId, "s-machine-reinstalled", null, "FP-1", null, null, "0.5.35", "10.0.0.2");
    expect(again.row.machine_id).toBe(derived);
    expect(again.adopted_from).toBeNull();
    expect(again.row.label).toBe("Desk");
    expect(again.row.app_version).toBe("0.5.35");
    expect(again.row.last_ip).toBe("10.0.0.2");
    expect(again.row.os).toBe("Linux");
    expect(again.row.re_paired_at).toBeNull();
  });

  it("keeps the client id when the connect reports no fingerprint", async () => {
    const row = await store.upsertConnected(orgId, userId, "s-nofp", "Desk", null, "Linux", null, null, null);
    expect(row.row.machine_id).toBe("s-nofp");
  });

  it("refuses a same-org machine id claimed by another user", async () => {
    const other = await insertUser("m5-store-other@example.test");
    await expect(store.upsertConnected(orgId, other, "s-nofp", null, null, null, null, null, null)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("leaves a foreign-org machine id untouched and does not register the connect", async () => {
    const org2 = (await env.db.query<{ id: string }>("INSERT INTO orgs (id, name) VALUES (gen_random_uuid(), 'org2') RETURNING id")).rows[0]!.id;
    const otherOrgUser = await insertUser("m5-store-org2@example.test", org2);
    const result = await store.upsertConnected(org2, otherOrgUser, "s-nofp", null, null, null, null, null, null);
    expect(result.row.org_id).toBe(orgId); // the untouched foreign row
    const rows = await env.db.query("SELECT * FROM machines WHERE machine_id = 's-nofp'");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.org_id).toBe(orgId);
  });

  it("adopts a fingerprint match: re-keys the legacy row, stamps re_paired_at, moves bindings", async () => {
    // The machine's previous pairing lives under a client-issued id with the
    // same fingerprint (a row written before identities were derived).
    await store.upsertConnected(orgId, userId, "adopt-old", "Old", "FP-ADOPT", "Linux", null, null, "10.8.8.8");
    const derived = canonicalMachineId(orgId, userId, "FP-ADOPT")!;
    await env.db.query("UPDATE machines SET machine_id = 'adopt-old' WHERE machine_id = $1", [derived]);
    // A project + chat bound to the legacy id.
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
    expect(outcome.row.machine_id).toBe(derived);
    expect(outcome.row.re_paired_at).not.toBeNull();
    // The legacy id is re-keyed away…
    expect((await env.db.query("SELECT * FROM machines WHERE machine_id = 'adopt-old'")).rows.length).toBe(0);
    // …and the durable execution bindings moved with it.
    expect((await env.db.query("SELECT machine_id FROM chats WHERE id = $1", [chat])).rows[0]!.machine_id).toBe(derived);
    expect((await env.db.query("SELECT machine_id FROM projects WHERE name = 'proj'")).rows[0]!.machine_id).toBe(derived);

    // Another member's fingerprint is never adopted.
    const other = await insertUser("m5-store-fp@example.test");
    const noAdopt = await store.upsertConnected(orgId, other, "other-machine", null, "FP-ADOPT", null, null, null, null);
    expect(noAdopt.adopted_from).toBeNull();
    expect(noAdopt.row.machine_id).toBe(canonicalMachineId(orgId, other, "FP-ADOPT"));
  });

  it("lastSeen refreshes; listForUser and bindable scope to the user/org", async () => {
    await store.upsertConnected(orgId, userId, "ls-machine", "LS", null, null, null, null, null);
    const before = (await env.db.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM machines WHERE machine_id = 'ls-machine'")).rows[0]!.last_seen_at;
    await new Promise((r) => setTimeout(r, 30));
    await store.lastSeen("ls-machine");
    const after = (await env.db.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM machines WHERE machine_id = 'ls-machine'")).rows[0]!.last_seen_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    const derived = canonicalMachineId(orgId, userId, "FP-1")!;
    const list = await store.listForUser(orgId, userId);
    expect(list.some((m) => m.machine_id === "ls-machine")).toBe(true);
    expect(list.some((m) => m.machine_id === derived)).toBe(true);

    expect(await store.bindable("ls-machine", userId, orgId)).toBe(true);
    expect(await store.bindable("ls-machine", crypto.randomUUID(), orgId)).toBe(true);
    expect(await store.bindable("ls-machine", userId, crypto.randomUUID())).toBe(true);
    expect(await store.bindable("ls-machine", crypto.randomUUID(), crypto.randomUUID())).toBe(false);
    expect(await store.bindable("ghost", userId, orgId)).toBe(false);
  });
});
