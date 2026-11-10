// The member socket's agent lists: one write burst re-reads the lists of
// every connected member in a fixed number of queries, and each member's
// list is exactly the visibility-filtered list the HTTP surface returns.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformPool } from "../../platform/db.js";
import { ChatStore } from "../../platform/store/chats.js";
import { IdentityStore, type UserRow } from "../../platform/store/identity.js";
import { AgentStore } from "../../agents/store.js";
import {
  AgentStateFeed,
  agentWire,
  type AgentStateDeps,
} from "../../hub/agent-state.js";
import { IntegrationAccessStore } from "../../platform/store/integration-access.js";
import type { WsServerMsg } from "../../hub/protocol.js";
import { waitFor } from "../support/wait.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

/** The pool with a running count of `query` calls. */
function countingPool(pool: PlatformPool): {
  pool: PlatformPool;
  count(): number;
} {
  let calls = 0;
  const counted = new Proxy(pool, {
    get(target, key) {
      if (key === "query") {
        return (...args: unknown[]) => {
          calls += 1;
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { pool: counted, count: () => calls };
}

dbDescribe("agent list feed", () => {
  let orgId: string;
  let users: UserRow[];
  let store: AgentStore;

  async function makeUser(
    email: string,
    role: "admin" | "member",
  ): Promise<UserRow> {
    const id = randomUUID();
    await env!.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, $3, '', $4, 'managed')`,
      [id, orgId, email, role],
    );
    return new IdentityStore(env!.db).getUser(id);
  }

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    orgId = randomUUID();
    await env.db.query(
      "INSERT INTO orgs (id, name) VALUES ($1, 'agent-list-feed-org')",
      [orgId],
    );
    const [owner, teamMember, granted, admin, outsider] = [
      await makeUser("feed-owner@example.test", "member"),
      await makeUser("feed-team@example.test", "member"),
      await makeUser("feed-granted@example.test", "member"),
      await makeUser("feed-admin@example.test", "admin"),
      await makeUser("feed-outsider@example.test", "member"),
    ];
    users = [owner!, teamMember!, granted!, admin!, outsider!];
    const teamId = randomUUID();
    await env.db.query(
      "INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'feed-team')",
      [teamId, orgId],
    );
    await env.db.query(
      "INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)",
      [teamId, teamMember!.id],
    );

    await store.create(owner!, { name: "Private", model: "GLM-Test" });
    await store.create(owner!, {
      name: "Org-wide",
      model: "GLM-Test",
      visibility: "org",
    });
    const teamAgent = await store.create(owner!, {
      name: "Team",
      model: "GLM-Test",
    });
    await env.db.query(
      "INSERT INTO agent_access (agent_id, team_id, level) VALUES ($1, $2, 'read')",
      [teamAgent.id, teamId],
    );
    const shared = await store.create(owner!, {
      name: "Granted",
      model: "GLM-Test",
    });
    await env.db.query(
      "INSERT INTO agent_access (agent_id, user_id, level) VALUES ($1, $2, 'read')",
      [shared.id, granted!.id],
    );
    const archived = await store.create(owner!, {
      name: "Archived",
      model: "GLM-Test",
      visibility: "org",
    });
    await store.lifecycle.archive(owner!, archived.id);
    await store.create(admin!, { name: "Admin's", model: "GLM-Test" });
    for (const user of users) {
      await env.db.query(
        `INSERT INTO agents (id, org_id, owner_user_id, name, model, tools, tools_mode, visibility, resources, is_personal)
         VALUES (gen_random_uuid(), $1, $2, 'Assistant', 'GLM-Test', '[]'::jsonb, 'all', 'private', '{}'::jsonb, true)`,
        [orgId, user.id],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("sends each member its visible list in a bounded number of queries", async () => {
    const counting = countingPool(env!.db);
    const countedStore = new AgentStore({
      pool: counting.pool,
      chats: new ChatStore(counting.pool),
    });
    const received = new Map<string, WsServerMsg[]>(
      users.map((user) => [user.id, []]),
    );
    const sinks = new Map(
      users.map((user) => [
        user.id,
        [
          {
            send: (frame: WsServerMsg) => {
              received.get(user.id)!.push(frame);
              return true;
            },
          },
        ],
      ]),
    );
    const deps = {
      hub: {
        memberUsersOfOrg: () => users.map((user) => user.id),
        memberSinksOfUser: (userId: string) => sinks.get(userId) ?? [],
      },
      agents: countedStore,
      identity: new IdentityStore(counting.pool),
      skills: {
        catalog: async () => [],
        installsForUsers: async () => new Map(),
      },
      trace: { callCounts: async () => ({}) },
      // The Integration audience reads are per org, not per member; they run
      // on the uncounted pool so the count below stays the agent reads.
      integrationAccess: new IntegrationAccessStore(env!.db),
      integrationDisplay: async () => new Map(),
    } as unknown as AgentStateDeps;
    const feed = new AgentStateFeed(deps, (_label, _key, error) => {
      throw error;
    });
    try {
      const before = counting.count();
      feed.agents({
        org_id: orgId,
        agent_id: null,
        run_id: null,
        user_id: null,
      });
      await waitFor(
        async () =>
          [...received.values()].every((frames) =>
            frames.some((frame) => frame.type === "agent_list"),
          ),
        5_000,
      );
      // The member rows, the visible ids and the org's agent rows: three
      // reads, whatever the member count.
      expect(counting.count() - before).toBe(3);
    } finally {
      feed.stop();
    }
    for (const user of users) {
      const frame = received
        .get(user.id)!
        .find((item) => item.type === "agent_list")!;
      const context = await new IntegrationAccessStore(env!.db).context(orgId);
      const expected = (await store.list(user, { includeArchived: true })).map(
        (agent) => agentWire(agent, context),
      );
      expect(frame).toEqual({ type: "agent_list", agents: expected });
      expect(expected.length).toBeGreaterThan(0);
    }
    const names = (userIndex: number) =>
      (
        received
          .get(users[userIndex]!.id)!
          .find((item) => item.type === "agent_list") as {
          agents: { name: string }[];
        }
      ).agents
        .map((agent) => agent.name)
        .sort();
    expect(names(0)).toEqual([
      "Archived",
      "Assistant",
      "Granted",
      "Org-wide",
      "Private",
      "Team",
    ]);
    expect(names(1)).toEqual(["Archived", "Assistant", "Org-wide", "Team"]);
    expect(names(2)).toEqual(["Archived", "Assistant", "Granted", "Org-wide"]);
    expect(names(3)).toEqual([
      "Admin's",
      "Archived",
      "Assistant",
      "Assistant",
      "Assistant",
      "Assistant",
      "Assistant",
      "Granted",
      "Org-wide",
      "Private",
      "Team",
    ]);
    expect(names(4)).toEqual(["Archived", "Assistant", "Org-wide"]);
  });
});
