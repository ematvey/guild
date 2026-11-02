// WS socket-loop behavior against the real app (disposable DB): ticket
// auth gates, machine registry upsert + re-pair adoption, ownership gates,
// session revocation → AuthRequired, displaced notices over real sockets.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHubTestEnv, type HubTestEnv } from "../support/hub-env.js";
import { ScriptedClient } from "./ws-driver.js";
import crypto from "node:crypto";

let env: HubTestEnv;
let base: string;

beforeAll(async () => {
  env = await createHubTestEnv();
  base = await env.listen();
}, 60_000);

afterAll(async () => {
  await env.cleanup();
  // The drop retries under load can exceed the 10s default hook timeout.
}, 60_000);

interface Login {
  token: string;
  userId: string;
  orgId: string;
}

async function login(email = "m5-ws@example.test", password = "m5-test-password"): Promise<Login> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string; user: { id: string; org_id: string } };
  return { token: body.token, userId: body.user.id, orgId: body.user.org_id };
}

async function bootstrap(): Promise<void> {
  const res = await fetch(`${base}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "m5-ws@example.test", password: "m5-test-password" }),
  });
  if (res.status !== 200 && res.status !== 409) throw new Error(`bootstrap: ${res.status}`);
}

async function ticket(token: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/ws/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) throw new Error(`ticket mint failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { ticket: string }).ticket;
}

/** ScriptedClient takes the query string only (it builds the ws URL). */
function machineQuery(t: string, machineId: string, extra = ""): string {
  return `ticket=${t}&machine_id=${machineId}&instance_id=${crypto.randomUUID()}&resume=false${extra}`;
}

describe("ws ticket endpoint", () => {
  it("mints gst_ tickets for a live session and refuses bad tokens", async () => {
    await bootstrap();
    const bad = await fetch(`${base}/api/v1/ws/ticket`, {
      method: "POST",
      headers: { authorization: "Bearer garbage" },
    });
    expect(bad.status).toBe(401);
    const none = await fetch(`${base}/api/v1/ws/ticket`, { method: "POST" });
    expect(none.status).toBe(401);
    const l = await login();
    const t = await ticket(l.token);
    expect(t).toMatch(/^gst_[0-9a-f]{32}$/);
  });
});

describe("ws upgrade gates", () => {
  it("rejects unknown/expired tickets and dead sessions at the handshake", async () => {
    await bootstrap();
    const l = await login();
    // A used-up ticket: mint two, consume one via a real upgrade.
    const t1 = await ticket(l.token);
    const t2 = await ticket(l.token);
    const first = new ScriptedClient(base, `ticket=${t1}`);
    await first.open();
    await first.until((f) => f.kind === "text" && f.data.includes("hello"));
    first.end();
    await first.closed();
    // The same ticket again → handshake rejection (single-use).
    const reused = new ScriptedClient(base, `ticket=${t1}`);
    await reused.open().catch(() => {});
    expect(reused.upgradeFailure?.code).toBe(401);
    expect(reused.upgradeFailure?.message).toContain("invalid or expired ticket");
    // A garbage ticket likewise.
    const garbage = new ScriptedClient(base, "ticket=gst_00000000000000000000000000000000");
    await garbage.open().catch(() => {});
    expect(garbage.upgradeFailure?.code).toBe(401);
    // An unused ticket from a revoked session: the ticket was minted while
    // the session was live, but the upgrade re-checks the session.
    const t3 = await ticket(l.token);
    void t2;
    await env.db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [
      crypto.createHash("sha256").update(l.token).digest("hex"),
    ]);
    void t3;
    const revoked = new ScriptedClient(base, `ticket=${t3}`);
    await revoked.open().catch(() => {});
    expect(revoked.upgradeFailure?.code).toBe(401);
    expect(revoked.upgradeFailure?.message).toContain("session expired or revoked");
  });

  it("machine connects without instance_id are rejected (400)", async () => {
    await bootstrap();
    const l = await login();
    const t = await ticket(l.token);
    const noInstance = new ScriptedClient(base, `ticket=${t}&machine_id=some-machine`);
    await noInstance.open().catch(() => {});
    expect(noInstance.upgradeFailure?.code).toBe(400);
    expect(noInstance.upgradeFailure?.message).toContain("machine connections require instance_id");
  });

  it("a registered machine's slot is claimed only by its owner", async () => {
    await bootstrap();
    const owner = await login();
    // Register the machine durably under the owner.
    const t = await ticket(owner.token);
    const ws = new ScriptedClient(base, machineQuery(t, "owned-machine"));
    await ws.open();
    await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    ws.end();

    // A second user of the same org tries to claim it → the connection is
    // accepted (upgrade passed) but the slot is refused with an Error frame.
    await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES (gen_random_uuid(), $1, 'm5-other@example.test', '', 'member', 'managed')`,
      [owner.orgId],
    );
    // The foreign user needs a live session: mint one directly.
    const foreignToken = crypto.randomBytes(24).toString("hex");
    await env.db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, auth_generation)
       SELECT $1, id, now() + interval '1 day', auth_generation
       FROM users WHERE email = 'm5-other@example.test'`,
      [crypto.createHash("sha256").update(foreignToken).digest("hex")],
    );
    const ft = await ticket(foreignToken);
    const foreign = new ScriptedClient(base, machineQuery(ft, "owned-machine"));
    await foreign.open().catch(() => {});
    const err = await foreign.until(
      (f) => f.kind === "text" && f.data.includes('"machine belongs to another user"'),
      5_000,
    );
    expect(JSON.parse((err as { data: string }).data)).toEqual({
      type: "error",
      message: "machine belongs to another user",
    });
    await foreign.closed();
  });
});

describe("ws machine lifecycle", () => {
  it("registers the durable row with metadata; re-pair adoption re-keys and displaces", async () => {
    await bootstrap();
    const l = await login();
    const t1 = await ticket(l.token);
    const old = new ScriptedClient(
      base,
      machineQuery(t1, "re-old", "&machine_name=OLD&machine_fingerprint=FP-9&machine_os=Linux"),
    );
    await old.open();
    await old.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    let row = (await env.db.query("SELECT * FROM machines WHERE machine_id = 're-old'")).rows[0];
    expect(row.label).toBe("OLD");
    expect(row.hardware_fingerprint).toBe("FP-9");
    expect(row.re_paired_at).toBeNull();

    // Same physical machine re-pairs under a new local id.
    const t2 = await ticket(l.token);
    const fresh = new ScriptedClient(base, machineQuery(t2, "re-new", "&machine_name=NEW&machine_fingerprint=FP-9"));
    await fresh.open();
    await fresh.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    // The still-live old registration is displaced.
    await old.until((f) => f.kind === "text" && f.data.includes("displaced"));
    await old.closed();
    row = (await env.db.query("SELECT * FROM machines WHERE machine_id = 're-new'")).rows[0];
    expect(row.hardware_fingerprint).toBe("FP-9");
    expect(row.label).toBe("NEW"); // the fresh connect's metadata
    expect(row.re_paired_at).not.toBeNull();
    expect((await env.db.query("SELECT * FROM machines WHERE machine_id = 're-old'")).rows.length).toBe(0);
    fresh.end();
    await fresh.closed();
  });

  it("revoking the session emits AuthRequired and ends the socket", { timeout: 20_000 }, async () => {
    await bootstrap();
    const l = await login();
    const t = await ticket(l.token);
    const ws = new ScriptedClient(base, `ticket=${t}`);
    await ws.open();
    await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    await env.db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [
      crypto.createHash("sha256").update(l.token).digest("hex"),
    ]);
    const authRequired = await ws.until((f) => f.kind === "text" && f.data.includes("auth_required"), 15_000);
    expect(JSON.parse((authRequired as { data: string }).data)).toEqual({ type: "auth_required" });
    await ws.closed();
  });

  it("fs dispatch round-trips through the machine socket; offline machines 500", async () => {
    await bootstrap();
    const l = await login();
    const t = await ticket(l.token);
    const machineId = crypto.randomUUID();
    const ws = new ScriptedClient(base, machineQuery(t, machineId));
    await ws.open();
    await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));

    const post = fetch(`${base}/api/v1/machines/${machineId}/fs`, {
      method: "POST",
      headers: { authorization: `Bearer ${l.token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "fs_list", payload: { path: "/tmp" } }),
    });
    const req = await ws.until((f) => f.kind === "text" && f.data.includes("machine_request"));
    const frame = JSON.parse((req as { data: string }).data) as {
      request_id: string;
      op: string;
      payload: { path: string };
    };
    expect(frame.op).toBe("fs_list");
    expect(frame.payload).toEqual({ path: "/tmp" });
    ws.send(
      JSON.stringify({ type: "machine_response", request_id: frame.request_id, ok: true, payload: { entries: ["a"] } }),
    );
    const res = await post;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { entries: ["a"] } });

    // Offline machine: unknown id → 404; known-but-disconnected → 500.
    const unknown = await fetch(`${base}/api/v1/machines/${crypto.randomUUID()}/fs`, {
      method: "POST",
      headers: { authorization: `Bearer ${l.token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "fs_home" }),
    });
    expect(unknown.status).toBe(404);
    ws.end();
    await ws.closed();
    const offline = await fetch(`${base}/api/v1/machines/${machineId}/fs`, {
      method: "POST",
      headers: { authorization: `Bearer ${l.token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "fs_home" }),
    });
    expect(offline.status).toBe(500);
    expect(((await offline.json()) as { error: { message: string } }).error.message).toBe("machine offline");
  });
});
