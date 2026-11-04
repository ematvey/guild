import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { contextUsage } from "../chats/context-usage.js";

let stack: GatewayStack;
let chatId: string;
const headers = () => ({ authorization: `Bearer ${stack.memberToken}` });
const url = () => `/api/v1/threads/${chatId}/context?model=Context-Test`;

beforeAll(async () => {
  stack = await setupGatewayStack();
  await stack.routeModel("Context-Test");
  await stack.env.db.query(
    "UPDATE model_routes SET context_window = 500000, alias = 'Context Alias' WHERE org_id = $1",
    [stack.orgId],
  );
  await stack.routeModel("Context-Small");
  await stack.env.db.query(
    "UPDATE model_routes SET context_window = 10000 WHERE org_id = $1 AND model = 'Context-Small'",
    [stack.orgId],
  );
  const chat = await stack.env.app.inject({ method: "POST", url: "/api/v1/threads", headers: headers(), payload: {} });
  chatId = chat.json().id;
  await stack.env.db.query("INSERT INTO chat_conversations(chat_id,conversation_id) VALUES($1,1000)", [chatId]);
}, 30000);

afterAll(async () => {
  await stack?.close();
}, 30000);

async function assistant(id: number, totalTokens: number, stopReason = "stop") {
  await stack.env.db.query(
    "INSERT INTO entries(id,conversation_id,commit_seq,kind,record) VALUES($1,1000,1,'pi.assistant',$2)",
    [
      id,
      JSON.stringify({
        id,
        conversationId: 1000,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            model: "Context-Test",
            stopReason,
            usage: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 300, totalTokens },
          },
        ],
      }),
    ],
  );
}

describe("composer context usage from committed provider measurements", () => {
  it("leaves unmeasured usage unknown, with the selected model's real capacity", async () => {
    const response = await stack.env.app.inject({ url: url(), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tokens: null,
      max: 500000,
      model: "Context-Test",
      usage_model: null,
      usage_model_alias: null,
    });
  });

  it("includes cached input and the answer, ignores failed requests, and keeps tenant scope", async () => {
    await assistant(1001, 1420);
    await assistant(1002, 99999, "error");
    const response = await stack.env.app.inject({ url: url(), headers: headers() });
    expect(response.json()).toEqual({
      tokens: 1420,
      max: 500000,
      model: "Context-Test",
      usage_model: "Context-Test",
      usage_model_alias: "Context Alias",
    });
    expect(await contextUsage(stack.env.db, crypto.randomUUID(), chatId)).toBeNull();
    const switched = await stack.env.app.inject({
      url: `/api/v1/threads/${chatId}/context?model=Context-Small`,
      headers: headers(),
    });
    expect(switched.json()).toEqual({
      tokens: 1420,
      max: 10000,
      model: "Context-Small",
      usage_model: "Context-Test",
      usage_model_alias: "Context Alias",
    });
  });

  it("invalidates the old measurement after a head change and resumes on the next response", async () => {
    await stack.env.db.query(
      "INSERT INTO entries(id,conversation_id,head,commit_seq,kind,record) VALUES(1003,1000,1001,1,'pi.compaction',$1)",
      [JSON.stringify({ id: 1003, kind: "pi.compaction", head: 1001, model: [] })],
    );
    expect((await stack.env.app.inject({ url: url(), headers: headers() })).json().tokens).toBeNull();
    await assistant(1004, 77);
    expect((await stack.env.app.inject({ url: url(), headers: headers() })).json().tokens).toBe(77);
    await assistant(1005, 0);
    // Some providers omit the aggregate; cached reads/writes must still count.
    expect((await stack.env.app.inject({ url: url(), headers: headers() })).json().tokens).toBe(1420);
  });

  it("survives a record whose text JSONB cannot cast", async () => {
    // A tool result can carry U+0000 (an .xlsx dumped as text). The record is
    // text, so it is stored; the read path must not cast it to jsonb.
    await stack.env.db.query(
      "INSERT INTO entries(id,conversation_id,commit_seq,kind,record) VALUES(1006,1000,1,'pi.toolResult',$1)",
      [JSON.stringify({ id: 1006, kind: "pi.toolResult", data: { text: "PK\u0000binary" } })],
    );
    await assistant(1007, 321);
    const response = await stack.env.app.inject({ url: url(), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().tokens).toBe(321);
  });

  it("adds estimates of the messages posted after the last measured request", async () => {
    const before = (await stack.env.app.inject({ url: url(), headers: headers() })).json().tokens as number;
    const text = "Hourly check: one pod pending. ".repeat(20);
    await stack.env.db.query(
      "INSERT INTO entries(id,conversation_id,commit_seq,kind,record) VALUES(1008,1000,1,'guild.agent-message',$1)",
      [
        JSON.stringify({
          id: 1008,
          kind: "guild.agent-message",
          model: [
            {
              role: "assistant",
              model: "Context-Test",
              stopReason: "stop",
              content: [{ type: "text", text }],
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            },
          ],
        }),
      ],
    );
    const after = (await stack.env.app.inject({ url: url(), headers: headers() })).json().tokens as number;
    expect(after).toBeGreaterThan(before + 100);
  });

  it("requires authentication and thread ownership", async () => {
    expect((await stack.env.app.inject({ url: url() })).statusCode).toBe(401);
    const other = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: { authorization: `Bearer ${stack.adminToken}` },
      payload: {},
    });
    const response = await stack.env.app.inject({
      url: `/api/v1/threads/${other.json().id}/context`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(404);
  });
});
