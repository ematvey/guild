// Workspace config over HTTP: creating an agent seeds the template files,
// the identity line rides the payload, and the payload has no instructions
// field at all (AGENTS.md on disk is the source of truth).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "../platform/m2-harness.js";
import { agentWorkspaceDir } from "../../agents/workspace-config.js";

let stack: M2Stack;
const root = mkdtempSync(path.join(tmpdir(), "guild-agent-config-api-"));

beforeAll(async () => {
  stack = await setupM2Stack({
    GUILD_AGENT_WORKSPACE_ROOT: root,
    GUILD_AGENT_WORKSPACE_WRITE_ROOT: root,
  });
  await stack.routeModel("GLM-Test-Model");
}, 60_000);

afterAll(async () => {
  await stack.close();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${stack.memberToken}`,
  "content-type": "application/json",
});

describe("agent workspace config over HTTP", () => {
  it("seeds the templates on create and returns the identity line", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Config agent", model: "GLM-Test-Model" },
    });
    expect(created.statusCode).toBe(200);
    const agent = (JSON.parse(created.body) as {
      agent: { id: string; org_id: string; identity: { name: string | null } };
    }).agent;
    expect(agent.identity.name).toBe("Config agent");

    const dir = agentWorkspaceDir(root, agent.org_id, agent.id);
    for (const file of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "BOOTSTRAP.md"]) {
      expect(existsSync(path.join(dir, file)), file).toBe(true);
    }
    expect(existsSync(path.join(dir, "memories"))).toBe(true);
    // MEMORY.md is optional and not seeded.
    expect(existsSync(path.join(dir, "MEMORY.md"))).toBe(false);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("# AGENTS.md - Your Workspace");

    const detail = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
    });
    expect(detail.statusCode).toBe(200);
    expect((JSON.parse(detail.body) as { agent: { identity: { name: string | null } } }).agent.identity.name).toBe(
      "Config agent",
    );
  });

  it("ignores an instructions field: the file is the only source", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Patch agent", model: "GLM-Test-Model" },
    });
    const agent = (JSON.parse(created.body) as { agent: { id: string; org_id: string } }).agent;
    const patched = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
      payload: { instructions: "# AGENTS.md\n\nOnly answer in haiku.\n" },
    });
    expect(patched.statusCode).toBe(200);
    const dir = agentWorkspaceDir(root, agent.org_id, agent.id);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).not.toContain("Only answer in haiku.");
    expect(JSON.parse(patched.body).agent).not.toHaveProperty("instructions");
  });

  it("creates and patches a description with the 500-character cap", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Described agent", model: "GLM-Test-Model", description: "  Writes launch notes.  " },
    });
    expect(created.statusCode).toBe(200);
    const agent = (JSON.parse(created.body) as { agent: { id: string; description: string } }).agent;
    expect(agent.description).toBe("Writes launch notes.");

    const patched = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
      payload: { description: "  Reviews launch notes.  " },
    });
    expect(patched.statusCode).toBe(200);
    expect((JSON.parse(patched.body) as { agent: { description: string } }).agent.description).toBe(
      "Reviews launch notes.",
    );

    const atCap = "d".repeat(500);
    const boundary = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
      payload: { description: atCap },
    });
    expect(boundary.statusCode).toBe(200);
    expect((JSON.parse(boundary.body) as { agent: { description: string } }).agent.description).toBe(atCap);

    const tooLong = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
      payload: { description: "d".repeat(501) },
    });
    expect(tooLong.statusCode).toBe(400);
    const detail = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
    });
    expect((JSON.parse(detail.body) as { agent: { description: string } }).agent.description).toBe(atCap);

    const cleared = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
      payload: { description: "" },
    });
    expect(cleared.statusCode).toBe(200);
    expect((JSON.parse(cleared.body) as { agent: { description: string } }).agent.description).toBe("");
  });

  it("reports null identity fields when IDENTITY.md is blank", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Blank agent", model: "GLM-Test-Model" },
    });
    const agent = (JSON.parse(created.body) as { agent: { id: string; org_id: string } }).agent;
    const dir = agentWorkspaceDir(root, agent.org_id, agent.id);
    rmSync(path.join(dir, "IDENTITY.md"));
    const detail = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}`,
      headers: auth(),
    });
    expect((JSON.parse(detail.body) as { agent: { identity: { name: string | null } } }).agent.identity.name).toBeNull();
  });
});
