// Access (docs/domain/002-access.md, "Access"): one list per item of who may
// reach it and how. Agents and Apps share the route and the levels, so this
// suite covers both kinds through the same contract: the org entry, a Team
// entry, a Member entry, `read` versus `edit`, and who may change the list.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createObjectStoreStack,
  type ObjectStoreStack,
} from "../support/object-store-stack.js";
import { hashPassword } from "../../platform/crypto.js";

const PASSWORD = "hunter228";

interface Env {
  env: ObjectStoreStack;
  adminToken: string;
  memberToken: string;
  member2Token: string;
  adminId: string;
  memberId: string;
  member2Id: string;
  teamId: string;
  orgId: string;
}

let e: Env;

beforeAll(async () => {
  const env = await createObjectStoreStack("error", {}, "access_api");
  const orgId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const member2Id = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const hash = await hashPassword(PASSWORD);
  await env.db.query(
    "INSERT INTO orgs (id, name) VALUES ($1, 'access api org')",
    [orgId],
  );
  await env.db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed'), ($7, $2, $8, $4, 'member', 'managed')",
    [
      adminId,
      orgId,
      `ax-admin-${suffix}@example.test`,
      hash,
      memberId,
      `ax-member-${suffix}@example.test`,
      member2Id,
      `ax-member2-${suffix}@example.test`,
    ],
  );
  await env.db.query(
    "INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Sales')",
    [teamId, orgId],
  );
  await env.db.query(
    "INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)",
    [teamId, member2Id],
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
    adminToken: await login(`ax-admin-${suffix}@example.test`),
    memberToken: await login(`ax-member-${suffix}@example.test`),
    member2Token: await login(`ax-member2-${suffix}@example.test`),
    adminId,
    memberId,
    member2Id,
    teamId,
    orgId,
  };
}, 120_000);

afterAll(async () => {
  await e?.env.cleanup();
}, 60_000);

interface Reply {
  statusCode: number;
  body: string;
}

const call = (
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  payload?: unknown,
) =>
  e.env.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  }) as unknown as Promise<Reply>;

const createAgent = async (name: string): Promise<string> => {
  const res = await call("POST", "/api/v1/agents", e.memberToken, {
    name,
    model: "GLM-Test-Model",
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { agent: { id: string } }).agent.id;
};

const access = (kind: "agent" | "app", id: string, token: string) =>
  call("GET", `/api/v1/access/${kind}/${id}`, token);

const put = (
  kind: "agent" | "app",
  id: string,
  token: string,
  entries: unknown[],
) => call("PUT", `/api/v1/access/${kind}/${id}`, token, { entries });

const agentVisible = async (id: string, token: string): Promise<boolean> =>
  (await call("GET", `/api/v1/agents/${id}`, token)).statusCode === 200;

describe("access lists", () => {
  it("starts empty: only the owner reaches the item", async () => {
    const id = await createAgent(`access-${crypto.randomUUID().slice(0, 8)}`);
    const own = JSON.parse((await access("agent", id, e.memberToken)).body) as {
      entries: unknown[];
      can_edit: boolean;
    };
    expect(own).toEqual({ entries: [], can_edit: true });
    expect(await agentVisible(id, e.member2Token)).toBe(false);
  });

  it("grants read by Team and by name, and edit by name", async () => {
    const id = await createAgent(`team-${crypto.randomUUID().slice(0, 8)}`);
    const res = await put("agent", id, e.memberToken, [
      { subject_kind: "team", subject_id: e.teamId, level: "read" },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(await agentVisible(id, e.member2Token)).toBe(true);
    const list = JSON.parse(
      (await access("agent", id, e.member2Token)).body,
    ) as {
      entries: { subject_kind: string; subject_label: string; level: string }[];
      can_edit: boolean;
    };
    expect(list.can_edit).toBe(false);
    expect(list.entries).toEqual([
      expect.objectContaining({ subject_kind: "team", subject_label: "Sales" }),
    ]);

    // A reader cannot change the list.
    expect(
      (
        await put("agent", id, e.member2Token, [
          { subject_kind: "org", subject_id: null, level: "read" },
        ])
      ).statusCode,
    ).toBe(403);

    // An `edit` entry manages the agent.
    await put("agent", id, e.memberToken, [
      { subject_kind: "team", subject_id: e.teamId, level: "read" },
      { subject_kind: "user", subject_id: e.member2Id, level: "edit" },
    ]);
    expect((await access("agent", id, e.member2Token)).statusCode).toBe(200);
    const edited = await call("PATCH", `/api/v1/agents/${id}`, e.member2Token, {
      description: "edited",
    });
    expect(edited.statusCode, edited.body).toBe(200);
  });

  it("shares with the whole org through the org entry", async () => {
    const id = await createAgent(`org-${crypto.randomUUID().slice(0, 8)}`);
    const res = await put("agent", id, e.memberToken, [
      { subject_kind: "org", subject_id: null, level: "read" },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(await agentVisible(id, e.member2Token)).toBe(true);
    expect(
      (await call("GET", `/api/v1/agents/${id}`, e.member2Token)).body,
    ).toContain('"can_manage":false');
    const list = JSON.parse(
      (await access("agent", id, e.memberToken)).body,
    ) as {
      entries: { subject_kind: string }[];
    };
    expect(list.entries.map((entry) => entry.subject_kind)).toEqual(["org"]);
  });

  it("refuses entries outside the org, a duplicate subject, and an editing org", async () => {
    const id = await createAgent(`bad-${crypto.randomUUID().slice(0, 8)}`);
    const outside = await put("agent", id, e.memberToken, [
      { subject_kind: "team", subject_id: crypto.randomUUID(), level: "read" },
    ]);
    expect(outside.statusCode).toBe(400);
    const duplicate = await put("agent", id, e.memberToken, [
      { subject_kind: "user", subject_id: e.member2Id, level: "read" },
      { subject_kind: "user", subject_id: e.member2Id, level: "edit" },
    ]);
    expect(duplicate.statusCode).toBe(400);
    const orgEdit = await put("agent", id, e.memberToken, [
      { subject_kind: "org", subject_id: null, level: "edit" },
    ]);
    expect(orgEdit.statusCode).toBe(400);
  });

  it("answers 404 for an item the caller cannot see, and for a stranger kind", async () => {
    const id = await createAgent(`hidden-${crypto.randomUUID().slice(0, 8)}`);
    expect((await access("agent", id, e.member2Token)).statusCode).toBe(404);
    expect(
      (await call("GET", `/api/v1/access/widget/${id}`, e.memberToken))
        .statusCode,
    ).toBe(400);
  });

  it("lists the org's people for the picker", async () => {
    const res = await call("GET", "/api/v1/access/people", e.member2Token);
    expect(res.statusCode, res.body).toBe(200);
    const people = (
      JSON.parse(res.body) as { people: { id: string; label: string }[] }
    ).people;
    expect(people.map((person) => person.id)).toContain(e.memberId);
    expect(people.every((person) => person.label.includes("@"))).toBe(true);
  });

  it("lists every team of the org for the picker, member or not", async () => {
    const res = await call("GET", "/api/v1/access/teams", e.memberToken);
    expect(res.statusCode, res.body).toBe(200);
    const teams = (
      JSON.parse(res.body) as { teams: { id: string; label: string }[] }
    ).teams;
    expect(teams).toContainEqual({ id: e.teamId, label: "Sales" });
  });
});
