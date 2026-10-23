// The specialist pack: install creates three org-wide agents with a playbook
// and a notes index, a reinstall updates them without touching knowledge,
// and the route is admin-only.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "../platform/m2-harness.js";
import { AgentStore } from "../../agents/store.js";
import { SPECIALIST_PACK, installSpecialists } from "../../agents/specialists.js";
import { AGENTS_TEMPLATE, SOUL_TEMPLATE } from "../../agents/templates.js";
import { agentWorkspaceDir } from "../../agents/workspace-config.js";
import type { UserRow } from "../../platform/store/identity.js";

let stack: M2Stack;
const root = mkdtempSync(path.join(tmpdir(), "guild-specialists-"));

beforeAll(async () => {
  stack = await setupM2Stack({
    GUILD_AGENT_WORKSPACE_ROOT: root,
    GUILD_AGENT_WORKSPACE_WRITE_ROOT: root,
  });
  await stack.routeModel("GLM-Test-Model");
}, 60_000);

afterAll(async () => {
  if (stack !== undefined) await stack.close();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

async function makeOrg(): Promise<{ orgId: string; owner: UserRow }> {
  const orgId = randomUUID();
  await stack.env.db.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [orgId, "specialists-test"]);
  const id = randomUUID();
  const res = await stack.env.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES ($1, $2, $3, '', 'member', 'managed')
     RETURNING id, org_id, email, role, identity_type`,
    [id, orgId, `specialists-${id}@example.test`],
  );
  return {
    orgId,
    owner: {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    },
  };
}

describe("specialist pack", () => {
  it("the route installs the pack for an admin and refuses a member", async () => {
    const installed = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents/specialists",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    expect(installed.statusCode).toBe(200);
    const body = JSON.parse(installed.body) as { created: string[]; updated: string[] };
    expect(body.created.sort()).toEqual(SPECIALIST_PACK.map((spec) => spec.name).sort());
    expect(body.updated).toEqual([]);

    const refused = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents/specialists",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("creates three org agents with focused tools and a written playbook", async () => {
    const { orgId, owner } = await makeOrg();
    const store = new AgentStore(stack.env.db, undefined, root);
    const result = await installSpecialists(
      { store, workspaceRoot: root },
      { orgId, ownerUserId: owner.id, model: "GLM-Test-Model" },
    );
    expect(result.created.sort()).toEqual(SPECIALIST_PACK.map((spec) => spec.name).sort());
    expect(result.updated).toEqual([]);

    const agents = await store.list(owner, { includeArchived: true });
    for (const spec of SPECIALIST_PACK) {
      const agent = agents.find((item) => item.resources["specialist"] === spec.key);
      expect(agent, spec.key).toBeDefined();
      expect(agent!.visibility).toBe("org");
      expect(agent!.tools_mode).toBe("selected");
      expect(agent!.tools).toEqual(spec.tools);
      expect(agent!.model).toBe("GLM-Test-Model");

      const dir = agentWorkspaceDir(root, orgId, agent!.id);
      const playbook = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      expect(playbook.startsWith(spec.playbook)).toBe(true);
      expect(playbook).toContain("## Stop rule");
      expect(readFileSync(path.join(dir, "notes", "README.md"), "utf8")).toBe(spec.notesIndex);
      expect(readFileSync(path.join(dir, "SOUL.md"), "utf8")).toBe(SOUL_TEMPLATE);
    }
  });

  it("a second install updates in place and leaves notes intact", async () => {
    const { orgId, owner } = await makeOrg();
    const store = new AgentStore(stack.env.db, undefined, root);
    await installSpecialists(
      { store, workspaceRoot: root },
      { orgId, ownerUserId: owner.id, model: "GLM-Test-Model" },
    );

    const clients = (await store.list(owner, { includeArchived: true })).find(
      (agent) => agent.resources["specialist"] === "clients",
    )!;
    const dir = agentWorkspaceDir(root, orgId, clients.id);
    const index = path.join(dir, "notes", "README.md");
    const account = path.join(dir, "notes", "accounts", "acme.md");
    writeFileSync(index, "# Notes — edited by a human\n");
    mkdirSync(path.dirname(account), { recursive: true });
    writeFileSync(account, "# Acme\n\nRenewal in May.\n");

    const second = await installSpecialists(
      { store, workspaceRoot: root },
      { orgId, ownerUserId: owner.id, model: "GLM-Test-Model" },
    );
    expect(second.created).toEqual([]);
    expect(second.updated.sort()).toEqual(SPECIALIST_PACK.map((spec) => spec.name).sort());

    expect(readFileSync(index, "utf8")).toBe("# Notes — edited by a human\n");
    expect(readFileSync(account, "utf8")).toBe("# Acme\n\nRenewal in May.\n");
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain(
      SPECIALIST_PACK.find((spec) => spec.key === "clients")!.playbook,
    );

    const agents = await store.list(owner, { includeArchived: true });
    expect(agents.filter((agent) => agent.resources["specialist"] !== undefined)).toHaveLength(3);
  });

  it("the base template invites delegation before its red lines", () => {
    expect(AGENTS_TEMPLATE).toContain("## Delegation");
    expect(AGENTS_TEMPLATE.indexOf("## Delegation")).toBeLessThan(AGENTS_TEMPLATE.indexOf("## Red Lines"));
    expect(AGENTS_TEMPLATE).toContain("list_agents");
  });
});
