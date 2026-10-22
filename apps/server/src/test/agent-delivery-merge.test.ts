// WP0 merge spike: a pending, unplaced steer item's content can be appended
// through the inbox doc draft, and the boundary places the merged text as one
// user message.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc } from "@earendil-works/pi-durable";
import type { GuildRuntime } from "../harness/runtime.js";
import { appendToPendingSteer } from "../harness/inbox-merge.js";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

const answer = {
  body:
    'data: {"choices":[{"delta":{"role":"assistant","content":"done"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
};

async function until(probe: () => Promise<boolean>, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition did not become true");
}

describe("pending steer content merge", () => {
  let stack: M2Stack;
  const auth = () => ({ authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" });
  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    stack = await setupM2Stack({
      GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
      GUILD_ALLOW_SHELL_TOOLS: "1",
    });
    await stack.env.app.listen({ port, host: "127.0.0.1" });
    await stack.routeModel("GLM-Test-Model");
  }, 60_000);
  afterAll(async () => {
    await stack.close();
  }, 60_000);

  it("places two steers as one input after the first item's content is appended", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: auth(),
      payload: { title: "steer merge" },
    });
    const chatId = JSON.parse(created.body).id as string;
    await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/approval`,
      headers: auth(),
      payload: { default: "full_access" },
    });
    const code = JSON.stringify({ code: 'return await tools.bash({command:"sleep 3; echo boundary"});' });
    const toolBody =
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "steer-boundary", type: "function", function: { name: "codemode", arguments: code } }] } }] })}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    stack.mock.setResponses([{ body: toolBody }, answer, answer]);
    const send = async (content: string, steer = false) => {
      const sent = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chatId}/turns`,
        headers: auth(),
        payload: {
          model: "GLM-Test-Model",
          messages: [{ role: "user", content }],
          ...(steer ? { send_mode: "steer" } : {}),
        },
      });
      expect(sent.statusCode).toBe(200);
      return JSON.parse(sent.body).user_message_id as string;
    };
    const submissionId = async (requestId: string) =>
      (
        await stack.env.db.query<{ id: number }>("SELECT id FROM submissions WHERE request_id=$1", [
          JSON.stringify(requestId),
        ])
      ).rows[0]!.id;
    await send("run a slow tool");
    await until(
      async () =>
        !!(
          await stack.env.db.query(
            "SELECT 1 FROM tasks t JOIN chat_conversations c ON c.conversation_id=t.conversation_id WHERE c.chat_id=$1 AND t.kind=$2 AND t.status='running'",
            [chatId, JSON.stringify("pi.tool")],
          )
        ).rows[0],
    );
    const firstRequest = await send("first steer", true);
    const secondRequest = await send("second steer", true);
    const runtime = (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
    const conversation = await runtime.conversationForChat(chatId, stack.orgId);
    const pending = () =>
      conversation.commit(async (tx) => {
        const items = (await tx.doc(InboxDoc, conversation.id)).items;
        return items.map((item) => ({
          id: Number(item.id),
          mode: item.mode,
          content: item.mode === "write" ? "" : typeof item.content === "string" ? item.content : JSON.stringify(item.content),
        }));
      }, BACKGROUND_CONTEXT);
    await until(async () => {
      const items = await pending();
      return items.length === 2 && items.every((item) => item.mode === "steer");
    });
    const firstId = await submissionId(firstRequest);
    const secondId = await submissionId(secondRequest);
    const before = await pending();
    const secondItem = before.find(({ id }) => id === secondId)!;
    expect(secondItem.mode).toBe("steer");
    const secondText = secondItem.content;
    expect(await appendToPendingSteer(conversation, firstId, secondText)).toBe(true);
    // A delivery does not enqueue its own item: the merged source leaves the
    // queue, and the first item keeps the batch.
    await conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const index = inbox.items.findIndex((item) => Number(item.id) === secondId);
      if (index >= 0) {
        inbox.items.splice(index, 1);
        tx.settleSubmission(secondId as never, { status: "unanswered", reason: "merged" });
      }
    }, BACKGROUND_CONTEXT);
    await until(
      async () =>
        (
          await stack.env.db.query<{ status: string }>("SELECT status FROM submissions WHERE id=$1", [firstId])
        ).rows[0]?.status === "done",
    );
    const userTexts = (body: Record<string, unknown>) =>
      ((body["messages"] as { role: string; content: unknown }[] | undefined) ?? [])
        .filter((message) => message.role === "user")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
    const carrying = stack.mock.requests.filter((request) =>
      userTexts(request.body).some((text) => text.includes("first steer")),
    );
    expect(carrying).toHaveLength(1);
    expect(userTexts(carrying[0]!.body).some((text) => text.includes("second steer"))).toBe(true);
    expect(
      stack.mock.requests.filter((request) => userTexts(request.body).some((text) => text.includes("second steer"))),
    ).toHaveLength(1);
  }, 30_000);
});
