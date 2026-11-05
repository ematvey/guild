// Older-page reads for the scroll-to-top loader: GET /threads/:id/events
// returns one window of the durable log before a cursor, and the ThreadState
// frame carries only the newest window with has_more_events set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import type { PlatformContext } from "../composition.js";
import { captureThreadState, THREAD_STATE_EVENT_LIMIT } from "../chats/thread-state.js";
import { uuidv7 } from "../platform/time.js";

let stack: GatewayStack;
let platform: PlatformContext;

beforeAll(async () => {
  stack = await setupGatewayStack();
  platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
});

afterAll(async () => {
  await stack.close();
}, 30_000);

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${stack.memberToken}`,
  "content-type": "application/json",
});

async function createChat(title: string): Promise<string> {
  const created = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: auth(),
    payload: { title },
  });
  expect(created.statusCode).toBe(200);
  return (created.json() as { id: string }).id;
}

/** Bulk-appends `count` user_message events in seq order. */
async function appendUserMessages(chatId: string, count: number): Promise<void> {
  const ids = Array.from({ length: count }, () => uuidv7());
  await platform.pool.query(
    `INSERT INTO thread_events (id, chat_id, type, payload)
     SELECT u.id, $2, 'user_message',
            jsonb_build_object('type', 'user_message', 'content', (u.i - 1)::text, 'attachments', '[]'::jsonb)
     FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, i)`,
    [ids, chatId],
  );
}

interface PageBody {
  events: { seq: number; event: { content: string } }[];
  has_more: boolean;
}

async function readPage(chatId: string, query: string): Promise<PageBody> {
  const res = await stack.env.app.inject({
    method: "GET",
    url: `/api/v1/threads/${chatId}/events?${query}`,
    headers: auth(),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as PageBody;
}

describe("thread event pages", () => {
  it("walks the log backwards with before + limit", async () => {
    const chatId = await createChat("pages");
    await appendUserMessages(chatId, 5);

    const newest = await readPage(chatId, "limit=2");
    expect(newest.events.map((r) => r.event.content)).toEqual(["3", "4"]);
    expect(newest.has_more).toBe(true);

    const middle = await readPage(chatId, `before=${newest.events[0]!.seq}&limit=2`);
    expect(middle.events.map((r) => r.event.content)).toEqual(["1", "2"]);
    expect(middle.has_more).toBe(true);

    const oldest = await readPage(chatId, `before=${middle.events[0]!.seq}&limit=2`);
    expect(oldest.events.map((r) => r.event.content)).toEqual(["0"]);
    expect(oldest.has_more).toBe(false);
  });

  it("returns the whole log with no cursor when it fits", async () => {
    const chatId = await createChat("whole");
    await appendUserMessages(chatId, 3);
    const page = await readPage(chatId, "limit=100");
    expect(page.events).toHaveLength(3);
    expect(page.has_more).toBe(false);
  });

  it("rejects a bad cursor or limit", async () => {
    const chatId = await createChat("bad");
    for (const query of ["before=abc", "before=-1", "limit=0", "limit=501", "limit=abc"]) {
      const res = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/threads/${chatId}/events?${query}`,
        headers: auth(),
      });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it("pages and searches message events for the history tools", async () => {
    const chatId = await createChat("history");
    const other = await createChat("history-other");
    await platform.threads.appendEvent(chatId, { type: "user_message", content: "find 100%_needle", attachments: [] });
    await platform.threads.appendEvent(chatId, {
      type: "assistant_message",
      blocks: [{ type: "text", text: "assistant needle" }],
    } as never);
    await platform.threads.appendEvent(chatId, { type: "user_message", content: "plain", attachments: [] });
    await platform.threads.appendEvent(other, { type: "user_message", content: "other needle", attachments: [] });

    const newest = await platform.threads.messagePage(chatId, { limit: 2 });
    expect(newest.rows.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
    expect(newest.more).toBe(true);
    const older = await platform.threads.messagePage(chatId, { limit: 2, beforeSeq: newest.rows[1]!.seq });
    expect(older.rows.map((r) => r.payload.content)).toEqual(["find 100%_needle"]);
    expect(older.more).toBe(false);
    const byRole = await platform.threads.messagePage(chatId, { limit: 10, role: "assistant" });
    expect(byRole.rows.map((r) => r.type)).toEqual(["assistant_message"]);
    const byText = await platform.threads.messagePage(chatId, { limit: 10, text: "needle" });
    expect(byText.rows).toHaveLength(2);
    const escaped = await platform.threads.messagePage(chatId, { limit: 10, text: "0%_n" });
    expect(escaped.rows.map((r) => r.payload.content)).toEqual(["find 100%_needle"]);

    const hits = await platform.threads.searchOwnerMessages(chatId, "needle", 2);
    expect(hits.rows).toHaveLength(2);
    expect(hits.more).toBe(true);
    expect(hits.rows[0]!.chat_id).toBe(other);
    expect(hits.rows[0]!.title).toBe("history-other");
    expect(await platform.chats.sameOwner(chatId, other)).toBe(true);
  });

  it("trims the ThreadState window to its byte budget, oldest first", async () => {
    const chatId = await createChat("huge");
    // Three rows of ~300 KiB each: the count limit would carry all three.
    for (const tag of ["a", "b", "c"]) {
      await platform.threads.appendEvent(chatId, {
        type: "user_message",
        content: `${tag}${"x".repeat(300 * 1024)}`,
        attachments: [],
      });
    }
    const capture = await captureThreadState(platform, platform.pool, stack.orgId, chatId);
    expect(capture.events).toHaveLength(1);
    expect((capture.events[0]!.event as { content?: string }).content?.startsWith("c")).toBe(true);
    expect(capture.hasMoreEvents).toBe(true);
    const frame = Buffer.byteLength(JSON.stringify(capture.events), "utf8");
    expect(frame).toBeLessThan(400 * 1024);
  });

  it("captures only the newest window in a ThreadState", async () => {
    const chatId = await createChat("long");
    await appendUserMessages(chatId, THREAD_STATE_EVENT_LIMIT + 30);

    const capture = await captureThreadState(platform, platform.pool, stack.orgId, chatId);
    expect(capture.events).toHaveLength(THREAD_STATE_EVENT_LIMIT);
    expect(capture.hasMoreEvents).toBe(true);
    expect(capture.events.at(-1)!.event.type).toBe("user_message");
    // The window is the tail: its oldest row is past the first 30 events.
    expect((capture.events[0]!.event as { content?: string }).content).toBe("30");
  });
});
