// Agent turn wire: POST /agents/:id/turns creates a run, submits through the
// canonical chat path, derives the thread title from the first message, and
// the run completes through the transcript projection.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "../platform/m2-harness.js";

let stack: M2Stack;
let port: number;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupM2Stack({ GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}` });
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
}, 60_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${stack.memberToken}`,
  "content-type": "application/json",
});

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

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

    const thread = await stack.env.db.query<{ id: string; title: string; chat_id: string }>(
      "SELECT id, title, chat_id FROM agent_threads WHERE agent_id = $1 AND kind = 'default'",
      [agent.id],
    );
    expect(thread.rows[0]!.title).toBe("Hello world");
    const chat = await stack.env.db.query<{ title: string }>("SELECT title FROM chats WHERE id = $1", [
      thread.rows[0]!.chat_id,
    ]);
    expect(chat.rows[0]!.title).toBe("Hello world");

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
