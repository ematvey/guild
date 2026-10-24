// ScopedDurableStorage: the worker-per-chat boundary. The scheduler adopts
// every live task and queued submission its storage scan surfaces, so a
// scoped worker's view must be forced onto its own conversation — foreign
// work must be invisible to scans and refused by by-id readers.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { SharedPoolDatabase } from "../importer/durable.js";
import { PostgresDurableStorage } from "../storage/postgres/storage.js";
import { ScopedDurableStorage } from "../storage/postgres/scoped.js";

let stack: M2Stack;

beforeAll(async () => {
  stack = await setupM2Stack({});
});
afterAll(async () => {
  await stack.close();
}, 60_000);

interface SeedTask {
  id: number;
  conversationId: number;
}

/** Seed one pending task + one queued submission per conversation, in the
 *  exact row shapes the adapter parses (the scheduler's adoption scan reads
 *  these tables directly). */
async function seedWork(conversationIds: number[]): Promise<SeedTask[]> {
  const seeded: SeedTask[] = [];
  for (const conversationId of conversationIds) {
    const taskId = conversationId * 10 + 1;
    await stack.env.db.query(
      `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
       VALUES ($1, $2, 'test-kind', 'pending', false, false, $3)
       ON CONFLICT (id) DO NOTHING`,
      [taskId, conversationId, JSON.stringify({ id: taskId, conversationId, kind: "test-kind", version: 1, input: {}, background: false, abortRequested: false, state: { status: "pending" } })],
    );
    const submissionId = conversationId * 10 + 2;
    await stack.env.db.query(
      `INSERT INTO submissions (id, conversation_id, request_id, status, record)
       VALUES ($1, $2, $3, 'queued', $4)
       ON CONFLICT (id) DO NOTHING`,
      [submissionId, conversationId, JSON.stringify(`req-${conversationId}`), JSON.stringify({ id: submissionId, conversationId, type: "input", status: "queued", requestId: `req-${conversationId}`, input: {} })],
    );
    seeded.push({ id: taskId, conversationId });
  }
  return seeded;
}

describe("ScopedDurableStorage (worker-per-chat boundary)", () => {
  it("hides the other conversation's pending work from scans and by-id reads", async () => {
    const unscoped = await PostgresDurableStorage.open(new SharedPoolDatabase(stack.env.db));
    const convA = 11;
    const convB = 12;
    const seeded = await seedWork([convA, convB]);

    try {
      const scopedA = new ScopedDurableStorage(unscoped, convA as ConversationId);
      const scopedB = new ScopedDurableStorage(unscoped, convB as ConversationId);

      // The unscoped view (what the double-drive concern is about) sees both.
      const all = await unscoped.scanTasks({ status: "pending" }, 10, undefined, BACKGROUND_CONTEXT);
      expect(all.items.map((t) => t.conversationId).sort()).toEqual([convA, convB]);

      // Each scoped view sees only its own conversation's work.
      const tasksA = await scopedA.scanTasks({ status: "pending" }, 10, undefined, BACKGROUND_CONTEXT);
      expect(tasksA.items.map((t) => t.id)).toEqual([seeded[0]!.id]);
      const tasksB = await scopedB.scanTasks({ status: "pending" }, 10, undefined, BACKGROUND_CONTEXT);
      expect(tasksB.items.map((t) => t.id)).toEqual([seeded[1]!.id]);

      // A scan naming a foreign conversation is refused outright.
      const foreign = await scopedA.scanTasks(
        { status: "pending", conversationId: convB as ConversationId },
        10,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(foreign.items).toEqual([]);

      // Queued submissions: same scoping.
      const subsA = await scopedA.scanSubmissions({ status: "queued" }, 10, undefined, BACKGROUND_CONTEXT);
      expect(subsA.items.map((s) => s.conversationId)).toEqual([convA]);
      expect(await scopedA.submissionByRequest(convB as ConversationId, "req-x", BACKGROUND_CONTEXT)).toBeUndefined();
      expect((await scopedA.submissionByRequest(convA as ConversationId, `req-${convA}`, BACKGROUND_CONTEXT))?.id).toBe(convA * 10 + 2);

      // By-id readers refuse foreign records.
      expect(await scopedA.task(seeded[1]!.id as TaskId, BACKGROUND_CONTEXT)).toBeUndefined();
      expect((await scopedA.task(seeded[0]!.id as TaskId, BACKGROUND_CONTEXT))?.conversationId).toBe(convA);
      expect(await scopedA.conversation(convB as ConversationId, BACKGROUND_CONTEXT)).toBeUndefined();
    } finally {
      await unscoped.close(BACKGROUND_CONTEXT);
      for (const { id, conversationId } of seeded) {
        await stack.env.db.query("DELETE FROM tasks WHERE id = $1 AND conversation_id = $2", [id, conversationId]);
        await stack.env.db.query("DELETE FROM submissions WHERE id = $1 AND conversation_id = $2", [id + 1, conversationId]);
      }
    }
  }, 60_000);

  it("a harness over a scoped storage adopts only its conversation's tasks", async () => {
    const unscoped = await PostgresDurableStorage.open(new SharedPoolDatabase(stack.env.db));
    const convA = 21;
    const convB = 22;
    const seeded = await seedWork([convA, convB]);

    try {
      const scopedA = new ScopedDurableStorage(unscoped, convA as ConversationId);
      const harness = await Harness.open(
        scopedA,
        { models: {} as never, registry: createRegistry(), onReport: () => {} },
        BACKGROUND_CONTEXT,
      );
      try {
        // resume() re-drives what the scheduler adopts; with a scoped view
        // it can only reach convA's task. convB's row must remain exactly
        // as seeded — untouched by this harness.
        harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const rows = await stack.env.db.query<{ id: string; status: string; conversation_id: string }>(
          "SELECT id, status, conversation_id FROM tasks WHERE id = ANY($1::bigint[])",
          [seeded.map((s) => s.id)],
        );
        const byId = new Map(rows.rows.map((r) => [String(r.id), r] as const));
        expect(byId.get(String(seeded[1]!.id))?.status).toBe("pending");
        expect(byId.get(String(seeded[1]!.id))?.conversation_id).toBe(convB);
      } finally {
        await harness.close(BACKGROUND_CONTEXT).catch(() => {});
      }
    } finally {
      await unscoped.close(BACKGROUND_CONTEXT);
      for (const { id, conversationId } of seeded) {
        await stack.env.db.query("DELETE FROM tasks WHERE id = $1 AND conversation_id = $2", [id, conversationId]);
        await stack.env.db.query("DELETE FROM submissions WHERE id = $1 AND conversation_id = $2", [id + 1, conversationId]);
      }
    }
  }, 60_000);
});
