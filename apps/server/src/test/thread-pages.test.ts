// Older-page reads for the scroll-to-top loader: GET /threads/:id/events
// returns one window of the durable log before a cursor, and the ThreadState
// frame carries only the newest window with has_more_events set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import type { PlatformContext } from "../platform/context.js";
import { captureThreadState, THREAD_STATE_EVENT_LIMIT } from "../chats/thread-state.js";
import { uuidv7 } from "../platform/time.js";

let stack: M2Stack;
let platform: PlatformContext;

beforeAll(async () => {
  stack = await setupM2Stack();
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
