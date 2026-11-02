// Agent turn wire: POST /agents/:id/turns creates a run, submits through the
// canonical chat path, derives the thread title from the first message, and
// the run completes through the transcript projection.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "../support/gateway-stack.js";
import { agentWorkspaceSubpath } from "../../agents/workspace.js";
import { waitFor } from "../support/wait.js";

let stack: GatewayStack;
let port: number;
/** Agent workspaces land here, so the test can inspect what a turn wrote. */
const agentRoot = mkdtempSync(path.join(tmpdir(), "guild-agent-root-"));

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  stack = await setupGatewayStack({
    GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
    GUILD_AGENT_WORKSPACE_ROOT: agentRoot,
  });
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
}, 60_000);

afterAll(async () => {
  await stack.close();
  rmSync(agentRoot, { recursive: true, force: true });
}, 30_000);

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${stack.memberToken}`,
  "content-type": "application/json",
});

describe("agent turns", () => {
  it("creates a running run, derives the title and completes it", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Turn agent", model: "GLM-Test-Model" },
    });
    expect(created.statusCode).toBe(200);
    const agent = (JSON.parse(created.body) as { agent: { id: string } }).agent;

    const turn = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/turns`,
      headers: auth(),
      payload: { message: "# Hello **world**\nsecond line" },
    });
    expect(turn.statusCode).toBe(200);
    const ack = JSON.parse(turn.body) as Record<string, unknown>;
    expect(ack).toMatchObject({ accepted: true });
    expect(typeof ack.status).toBe("string");
    expect(typeof ack.user_message_id).toBe("string");

    await waitFor(async () => {
      const res = await stack.env.db.query<{ status: string; summary: string | null }>(
        "SELECT status, summary FROM agent_runs WHERE agent_id = $1",
        [agent.id],
      );
      return res.rows[0]?.status === "succeeded";
    });

    const run = await stack.env.db.query<{ status: string; summary: string | null; tokens: number }>(
      "SELECT status, summary, tokens FROM agent_runs WHERE agent_id = $1",
      [agent.id],
    );
    expect(run.rows[0]).toMatchObject({ status: "succeeded", summary: "hello" });
    expect(run.rows[0]!.tokens).toBeGreaterThan(0);

    // The default thread keeps its name; a turn into it never renames it.
    const thread = await stack.env.db.query<{ id: string; title: string; chat_id: string }>(
      "SELECT id, title, chat_id FROM agent_threads WHERE agent_id = $1 AND is_default",
      [agent.id],
    );
    expect(thread.rows[0]!.title).toBe("Main thread");
    const chat = await stack.env.db.query<{ title: string }>("SELECT title FROM chats WHERE id = $1", [
      thread.rows[0]!.chat_id,
    ]);
    expect(chat.rows[0]!.title).toBe("Main thread");

    const detail = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/runs/${(await stack.env.db.query<{ id: string }>("SELECT id FROM agent_runs WHERE agent_id = $1", [agent.id])).rows[0]!.id}`,
      headers: auth(),
    });
    expect(detail.statusCode).toBe(200);
    const body = JSON.parse(detail.body) as { run: { status: string }; steps: { type: string }[] };
    expect(body.run.status).toBe("succeeded");
    expect(body.steps.some((step) => step.type === "assistant_text")).toBe(true);
  }, 40_000);
});

describe("skills stay out of the agent workspace", () => {
  it("publishing and installing a skill copies nothing into the agent workspace", async () => {
    const published = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/skills",
      headers: auth(),
      payload: { slug: "workspace-isolation", description: "Isolation probe", body: "# Probe\nDo nothing." },
    });
    expect(published.statusCode).toBe(200);

    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Isolation agent", model: "GLM-Test-Model" },
    });
    expect(created.statusCode).toBe(200);
    const agent = (JSON.parse(created.body) as { agent: { id: string; org_id: string } }).agent;

    const turn = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/turns`,
      headers: auth(),
      payload: { message: "hello" },
    });
    expect(turn.statusCode).toBe(200);
    await waitFor(async () => {
      const res = await stack.env.db.query<{ status: string }>("SELECT status FROM agent_runs WHERE agent_id = $1", [
        agent.id,
      ]);
      return res.rows[0]?.status === "succeeded";
    });

    // The install exists for the caller, so the materialization loop had
    // work to do; the agent workspace must still hold no skill files.
    const install = await stack.env.db.query("SELECT 1 FROM skill_installs WHERE slug = 'workspace-isolation'");
    expect(install.rows).toHaveLength(1);
    const workspace = path.join(agentRoot, agentWorkspaceSubpath(agent.org_id, agent.id));
    expect(existsSync(path.join(workspace, "skills"))).toBe(false);
  }, 40_000);
});

describe("plain chat adoption", () => {
  it("turns a plain chat into a thread of the caller's personal agent", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(),
      payload: { title: "Adopted chat" },
    });
    expect(created.statusCode).toBe(200);
    const chatId = (JSON.parse(created.body) as { id: string }).id;

    const turn = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/turns`,
      headers: auth(),
      payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "Hello there" }] },
    });
    expect(turn.statusCode).toBe(200);

    const rows = await stack.env.db.query<{ agent_id: string; user_id: string; is_personal: boolean }>(
      `SELECT t.agent_id, t.user_id, a.is_personal
       FROM agent_threads t JOIN agents a ON a.id = t.agent_id
       WHERE t.chat_id = $1`,
      [chatId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.is_personal).toBe(true);

    await waitFor(async () => {
      const run = await stack.env.db.query<{ status: string }>(
        "SELECT status FROM agent_runs WHERE thread_id = (SELECT id FROM agent_threads WHERE chat_id = $1)",
        [chatId],
      );
      return run.rows[0] !== undefined && run.rows[0].status !== "running";
    });

    // A second turn keeps the same thread: adoption is idempotent.
    const again = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/turns`,
      headers: auth(),
      payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "Second" }] },
    });
    expect(again.statusCode).toBe(200);
    const after = await stack.env.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agent_threads WHERE chat_id = $1",
      [chatId],
    );
    expect(after.rows[0]!.n).toBe(1);
  }, 30_000);
});

describe("agent picker", () => {
  it("keeps an agent's Main thread on that agent", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Picker agent", model: "GLM-Test-Model", visibility: "org" },
    });
    const agent = (JSON.parse(created.body) as { agent: { id: string } }).agent;

    const thread = await stack.env.db.query<{ chat_id: string }>(
      "SELECT chat_id FROM agent_threads WHERE agent_id = $1 AND is_default",
      [agent.id],
    );
    const chatId = thread.rows[0]!.chat_id;

    const read = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/threads/${chatId}/agent`,
      headers: auth(),
    });
    expect((JSON.parse(read.body) as { switcheable: boolean }).switcheable).toBe(false);

    const other = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Other agent", model: "GLM-Test-Model", visibility: "org" },
    });
    const otherId = (JSON.parse(other.body) as { agent: { id: string } }).agent.id;

    const moved = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/agent`,
      headers: auth(),
      payload: { agent_id: otherId },
    });
    expect(moved.statusCode).toBe(409);
    expect(JSON.parse(moved.body)).toMatchObject({ error: { code: "thread_agent_locked" } });

    // The thread still belongs to its agent.
    const after = await stack.env.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_threads WHERE chat_id = $1",
      [chatId],
    );
    expect(after.rows[0]!.agent_id).toBe(agent.id);
  }, 40_000);

  it("moves an ordinary thread to the chosen agent", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Move target", model: "GLM-Test-Model", visibility: "org" },
    });
    const agent = (JSON.parse(created.body) as { agent: { id: string } }).agent;

    const chat = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(),
      payload: { title: "Ordinary chat" },
    });
    const chatId = (JSON.parse(chat.body) as { id: string }).id;

    const first = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/agent`,
      headers: auth(),
      payload: { agent_id: agent.id },
    });
    expect(first.statusCode).toBe(200);

    const read = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/threads/${chatId}/agent`,
      headers: auth(),
    });
    expect((JSON.parse(read.body) as { switcheable: boolean }).switcheable).toBe(true);
  }, 40_000);
});

describe("turn idempotency and agent binding", () => {
  it("a retry naming another agent conflicts and leaves the chat on its agent", async () => {
    const make = async (name: string): Promise<string> => {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/agents",
        headers: auth(),
        payload: { name, model: "GLM-Test-Model", visibility: "org" },
      });
      return (JSON.parse(res.body) as { agent: { id: string } }).agent.id;
    };
    const first = await make("Retry first agent");
    const second = await make("Retry second agent");
    const chat = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(),
      payload: { title: "Retry chat" },
    });
    const chatId = (JSON.parse(chat.body) as { id: string }).id;
    const userMessageId = crypto.randomUUID();
    const send = (agentId: string) =>
      stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chatId}/turns`,
        headers: auth(),
        payload: {
          model: "GLM-Test-Model",
          agent_id: agentId,
          user_message_id: userMessageId,
          messages: [{ role: "user", content: "Once only" }],
        },
      });
    expect((await send(first)).statusCode).toBe(200);
    const retry = await send(second);
    expect(retry.statusCode).toBe(409);
    expect(JSON.parse(retry.body)).toMatchObject({ error: { code: "command_id_conflict" } });
    const bound = await stack.env.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_threads WHERE chat_id = $1",
      [chatId],
    );
    expect(bound.rows[0]!.agent_id).toBe(first);
    const same = await send(first);
    expect(same.statusCode).toBe(200);
    expect((JSON.parse(same.body) as { user_message_id: string }).user_message_id).toBe(userMessageId);
  }, 40_000);
});

describe("an agent being deleted", () => {
  it("refuses turns into its threads and new bindings with 409", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(),
      payload: { name: "Doomed agent", model: "GLM-Test-Model" },
    });
    const agent = (JSON.parse(created.body) as { agent: { id: string } }).agent;
    const chatRes = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: auth(),
      payload: { title: "Bound to the doomed agent" },
    });
    const chatId = (JSON.parse(chatRes.body) as { id: string }).id;
    const bind = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/agent`,
      headers: auth(),
      payload: { agent_id: agent.id },
    });
    expect(bind.statusCode, bind.body).toBe(200);

    const deleted = await stack.env.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agent.id}`,
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    const refusals = [
      { url: `/api/v1/agents/${agent.id}/turns`, payload: { message: "still there?" } },
      {
        url: `/api/v1/threads/${chatId}/turns`,
        payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "still there?" }] },
      },
      {
        url: `/api/v1/threads/${chatId}/turns`,
        payload: { model: "GLM-Test-Model", agent_id: agent.id, messages: [{ role: "user", content: "again" }] },
      },
      { url: `/api/v1/agents/${agent.id}/threads`, payload: { title: "a new thread" } },
    ];
    for (const refusal of refusals) {
      const res = await stack.env.app.inject({ method: "POST", headers: auth(), ...refusal });
      expect(res.statusCode, `${refusal.url}: ${res.body}`).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "agent_deleting" } });
    }
    const commands = await stack.env.db.query("SELECT 1 FROM turn_commands WHERE chat_id = $1", [chatId]);
    expect(commands.rowCount).toBe(0);
    const runs = await stack.env.db.query("SELECT 1 FROM agent_runs WHERE agent_id = $1", [agent.id]);
    expect(runs.rowCount).toBe(0);

    // A plain chat cannot be bound to it either.
    const other = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: auth(),
      payload: { title: "Another chat" },
    });
    const rebind = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${(JSON.parse(other.body) as { id: string }).id}/agent`,
      headers: auth(),
      payload: { agent_id: agent.id },
    });
    expect(rebind.statusCode).toBe(409);

    // Restoring the agent makes its threads writable again.
    const restored = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/restore`,
      headers: auth(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const bindAgain = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/agent`,
      headers: auth(),
      payload: { agent_id: agent.id },
    });
    expect(bindAgain.statusCode, bindAgain.body).toBe(200);
  }, 40_000);
});
