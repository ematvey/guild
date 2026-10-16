import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

const failure = { status: 404, contentType: "application/json", body: '{"detail":"Not Found"}' };
const answer = { body: 'data: {"choices":[{"delta":{"role":"assistant","content":"queued answer"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' };
async function until(probe: () => Promise<boolean>, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("queued input did not make progress");
}

describe.each(["off", "on"])("failed-run queue recovery (worker mode %s)", mode => {
  let stack: M2Stack;
  const auth = () => ({ authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" });
  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    stack = await setupM2Stack({ GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`, GUILD_WORKER_MODE: mode });
    await stack.env.app.listen({ port, host: "127.0.0.1" });
    await stack.routeModel("GLM-Test-Model");
  }, 60_000);
  afterAll(async () => { await stack.close(); }, 60_000);

  it("places the existing queued input after model_error without a new message or restart", async () => {
    const created = await stack.env.app.inject({ method: "POST", url: "/api/v1/threads", headers: auth(), payload: { title: "failed-run queue" } });
    const chatId = JSON.parse(created.body).id as string;
    stack.mock.setResponses([failure, failure, failure, failure, answer]);
    const submit = async (content: string) => {
      const res = await stack.env.app.inject({ method: "POST", url: `/api/v1/threads/${chatId}/turns`, headers: auth(), payload: { model: "GLM-Test-Model", messages: [{ role: "user", content }] } });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as { user_message_id: string };
    };
    await submit("first input");
    await until(async () => stack.mock.requests.length > 0);
    const second = await submit("input admitted during provider retry");
    const status = async () => (await stack.env.db.query<{ status: string }>("SELECT status FROM submissions WHERE request_id=$1", [JSON.stringify(second.user_message_id)])).rows[0]?.status;
    expect(await status()).toBe("queued");
    await until(async () => await status() === "done");
    await until(async () => (await stack.env.db.query<{ generating: boolean }>("SELECT generating FROM chats WHERE id=$1", [chatId])).rows[0]!.generating === false);
    const thread = await stack.env.app.inject({ method: "GET", url: `/api/v1/threads/${chatId}`, headers: auth() });
    expect(thread.body).toContain("queued answer");
    const count = await stack.env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions WHERE request_id=$1", [JSON.stringify(second.user_message_id)]);
    expect(count.rows[0]!.n).toBe(1);
  }, 45_000);
});
