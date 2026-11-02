import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentId,
  EntryId,
  Seq,
  SubmissionId,
  Storage,
  TaskId,
} from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PgPoolDatabase, PostgresDurableStorage } from "../../storage/postgres/index.js";
import { createDisposableDatabase, dropDisposableDatabase, type DisposableDatabase } from "../support/postgres.js";

const context = BACKGROUND_CONTEXT;

describe.sequential("Postgres durable storage reopen across restart", () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;

  // State captured through the public API before the restart.
  const before = {
    conversations: new Map<ConversationId, unknown>(),
    entries: new Map<EntryId, unknown>(),
    tasks: new Map<TaskId, unknown>(),
    submissions: new Map<SubmissionId, unknown>(),
    documents: new Map<number, Map<string, unknown>>(),
    forkVisibility: undefined as { page: unknown; marker: unknown; visibleChildEntry: unknown } | undefined,
    nextId: 0,
    forkChildId: 0 as ConversationId,
  };

  beforeAll(async () => {
    database = await createDisposableDatabase();
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => {});
    await dropDisposableDatabase(database.name);
  });

  const pools: pg.Pool[] = [];

  async function open(): Promise<PostgresDurableStorage> {
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    pools.push(pool);
    return PostgresDurableStorage.open(new PgPoolDatabase(pool));
  }

  it("seeds representative durable state", async () => {
    const storage: Storage = await open();

    const childId = await storage.mintId<ConversationId>();
    const rootEntryA = await storage.mintId<EntryId>();
    const rootMarker = await storage.mintId<EntryId>();
    const rootEntryB = await storage.mintId<EntryId>();
    const answerEntry = await storage.mintId<EntryId>();
    const childEntry = await storage.mintId<EntryId>();

    await storage.commit(
      [
        { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
        {
          type: "entry",
          value: { id: rootEntryA, conversationId: ROOT_CONVERSATION_ID, kind: "user", data: { text: "first" } },
        },
        {
          type: "entry",
          value: {
            id: rootMarker,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "user",
            data: { text: "second" },
            head: rootEntryA,
          },
        },
        {
          type: "entry",
          value: {
            id: rootEntryB,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "assistant",
            data: { text: "reply" },
          },
        },
      ],
      context,
    );

    await storage.commit(
      [
        {
          type: "conversation",
          value: { id: childId, parent: { conversationId: ROOT_CONVERSATION_ID, at: rootMarker } },
        },
        { type: "entry", value: { id: childEntry, conversationId: childId, kind: "user", data: { text: "forked" } } },
      ],
      context,
    );

    const runningTaskId = await storage.mintId<TaskId<JsonValue>>();
    const waitingTaskId = await storage.mintId<TaskId<JsonValue>>();
    const terminalTaskId = await storage.mintId<TaskId<JsonValue>>();
    await storage.commit(
      [
        {
          type: "task",
          value: {
            id: runningTaskId,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "test.task",
            version: 1,
            input: { value: 1 },
            state: { status: "running", checkpoint: { phase: "effect", attempt: 2 } },
            background: false,
            abortRequested: false,
          },
        },
        {
          type: "task",
          value: {
            id: waitingTaskId,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "test.background",
            version: 1,
            input: { value: 2 },
            state: { status: "waiting", checkpoint: { phase: "next" }, on: [runningTaskId], policy: "allSettled" },
            background: true,
            abortRequested: false,
            memos: { kept: true },
          },
        },
        {
          type: "task",
          value: {
            id: terminalTaskId,
            conversationId: childId,
            kind: "test.task",
            version: 1,
            input: { value: 3 },
            state: { status: "terminal", outcome: { status: "completed", result: { done: true } } },
            background: false,
            abortRequested: true,
          },
        },
      ],
      context,
    );

    const queuedId = await storage.mintId<SubmissionId>();
    const answeredId = await storage.mintId<SubmissionId>();
    const writeId = await storage.mintId<SubmissionId>();
    await storage.commit(
      [
        {
          type: "submission",
          value: {
            id: queuedId,
            conversationId: ROOT_CONVERSATION_ID,
            requestId: "req-1",
            type: "input",
            status: "queued",
          },
        },
        {
          type: "submission",
          value: {
            id: answeredId,
            conversationId: ROOT_CONVERSATION_ID,
            requestId: "req-2",
            type: "input",
            status: "done",
            entry: rootMarker,
            answer: answerEntry,
          },
        },
        {
          type: "submission",
          value: {
            id: writeId,
            conversationId: childId,
            type: "write",
            status: "unanswered",
            reason: "closed",
            detail: { retryable: false },
          },
        },
      ],
      context,
    );

    const sessionId = await storage.mintId<DocumentId>();
    const rewindableId = await storage.mintId<DocumentId>();
    const sessionIdAt = await storage.commit(
      [
        {
          type: "document.create",
          record: { id: sessionId, kind: "test.settings", scope: { kind: "session" } },
          content: { kind: "base", version: 1, value: { theme: "dark", nested: { count: 1 } } },
        },
      ],
      context,
    );
    await storage.commit(
      [
        {
          type: "document.create",
          record: {
            id: rewindableId,
            kind: "test.notes",
            scope: { kind: "conversation", conversationId: childId },
            history: "rewindable",
            fork: "asOf",
          },
          content: { kind: "base", version: 1, value: { items: ["a"], count: 0 } },
        },
      ],
      context,
    );
    const rewindableAt = await storage.commit(
      [
        {
          type: "document.change",
          id: rewindableId,
          content: {
            kind: "delta",
            version: 1,
            ops: [
              ["p", ["items"], 1, 0, ["b"]],
              ["s", ["count"], 1],
            ],
          },
        },
      ],
      context,
    );
    await storage.commit(
      [
        {
          type: "document.copy",
          record: {
            id: await storage.mintId<DocumentId>(),
            kind: "test.notes",
            scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
            history: "rewindable",
            fork: "asOf",
          },
          source: { id: rewindableId, at: "current" },
        },
      ],
      context,
    );
    await storage.commit([{ type: "document.retire", id: sessionId }], context);

    // A mint the instance never commits is still consumed: with worker-per-
    // chat several processes mint from one id space, so every mint is durable
    // the moment it returns (the old in-memory watermark handed the same id
    // to a different process after reopen). The fresh instance continues at
    // the captured watermark, or past it when this last mint was never
    // committed (it wasn't — see the close below).
    before.nextId = Number(await storage.mintId());

    // Capture expectations before the restart.
    for (const id of [ROOT_CONVERSATION_ID, childId]) {
      before.conversations.set(id, await storage.conversation(id, context));
    }
    for (const id of [rootEntryA, rootMarker, rootEntryB, childEntry]) {
      before.entries.set(id, await storage.entry(id, context));
    }
    before.entries.set(answerEntry, undefined); // referenced by a submission, never written
    for (const id of [runningTaskId, waitingTaskId, terminalTaskId]) {
      before.tasks.set(id, await storage.task(id, context));
    }
    for (const id of [queuedId, answeredId, writeId]) {
      before.submissions.set(id, await storage.submission(id, context));
    }
    const documentPoints = new Map<string, unknown>([
      ["current", (await storage.document(rewindableId, "current", context))?.value],
      ["beforeCreationSeq", sessionIdAt],
      ["beforeCreation", (await storage.document(rewindableId, sessionIdAt, context))?.value],
      ["afterDeltaSeq", rewindableAt],
      ["afterDelta", (await storage.document(rewindableId, rewindableAt, context))?.value],
    ]);
    before.documents.set(rewindableId, documentPoints);
    before.forkChildId = childId;
    before.forkVisibility = {
      page: await storage.scanEntries({ conversationId: childId }, 10, undefined, context),
      marker: await storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context),
      visibleChildEntry: await storage.entry(childId, rootEntryA, context),
    };

    expect(before.nextId).toBeGreaterThan(0);
    await storage.close(context);
  });

  it("reads the full state back from a fresh backend on the same database", async () => {
    const reopened: Storage = await open();

    for (const [id, expected] of before.conversations) {
      expect(await reopened.conversation(id, context)).toEqual(expected);
      expect(await reopened.conversation(id, context)).not.toBe(expected);
    }

    for (const [id, expected] of before.entries) {
      expect(await reopened.entry(id, context)).toEqual(expected);
      const reread = (await reopened.entry(id, context))?.entry;
      const expectedEntry = (expected as { entry: unknown } | undefined)?.entry;
      if (expectedEntry !== undefined && reread !== undefined) expect(reread).not.toBe(expectedEntry);
    }

    // Fork-aware visibility, pagination, and head markers survive the restart.
    const childPage = await reopened.scanEntries({ conversationId: before.forkChildId }, 10, undefined, context);
    expect(childPage).toEqual(before.forkVisibility!.page);
    const marker = await reopened.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context);
    expect(marker).toEqual(before.forkVisibility!.marker);
    expect(await reopened.entry(before.forkChildId, [...before.entries.keys()][0]!, context)).toEqual(
      before.forkVisibility!.visibleChildEntry,
    );

    for (const [id, expected] of before.tasks) {
      expect(await reopened.task(id, context)).toEqual(expected);
    }
    const waitingScan = await reopened.scanTasks({ status: "waiting", background: true }, 10, undefined, context);
    expect(waitingScan.items).toHaveLength(1);
    const abortScan = await reopened.scanTasks({ status: "terminal", abortRequested: true }, 10, undefined, context);
    expect(abortScan.items).toHaveLength(1);

    for (const [id, expected] of before.submissions) {
      expect(await reopened.submission(id, context)).toEqual(expected);
    }
    expect(await reopened.submissionByRequest(ROOT_CONVERSATION_ID, "req-1", context)).toMatchObject({
      requestId: "req-1",
      status: "queued",
    });
    expect(await reopened.submissionByRequest(ROOT_CONVERSATION_ID, "req-2", context)).toMatchObject({
      status: "done",
    });

    for (const [id, points] of before.documents) {
      expect((await reopened.document(id as DocumentId, "current", context))?.value).toEqual(points.get("current"));
      expect(
        (await reopened.document(id as DocumentId, points.get("beforeCreationSeq") as Seq, context))?.value,
      ).toEqual(points.get("beforeCreation"));
      expect((await reopened.document(id as DocumentId, points.get("afterDeltaSeq") as Seq, context))?.value).toEqual(
        points.get("afterDelta"),
      );
    }
    expect(
      await reopened.findDocument(
        { kind: "test.notes", scope: { kind: "conversation", conversationId: before.forkChildId } },
        "current",
        context,
      ),
    ).toBeDefined();

    // The ID namespace never reuses an id across reopen.
    expect(Number(await reopened.mintId())).toBeGreaterThanOrEqual(before.nextId);

    await reopened.close(context);
  });

  it("rejects every operation after close", async () => {
    const reopened = await open();
    await reopened.close(context);
    await expect(reopened.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
    await expect(reopened.mintId()).rejects.toThrow("closed");
    await expect(reopened.commit([], context)).rejects.toThrow("closed");
  });
});
