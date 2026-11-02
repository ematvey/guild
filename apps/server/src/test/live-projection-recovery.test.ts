import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentId, StorageWrite } from "@earendil-works/pi-durable";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgPoolDatabase, PostgresDurableStorage } from "../storage/postgres/index.js";
import { createDisposableDatabase, dropDisposableDatabase, type DisposableDatabase } from "./support/postgres.js";

let database: DisposableDatabase;
let pool: pg.Pool;
let storage: PostgresDurableStorage;
beforeAll(async () => {
  database = await createDisposableDatabase();
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  storage = await PostgresDurableStorage.open(new PgPoolDatabase(pool));
});
afterAll(async () => {
  await storage.close(BACKGROUND_CONTEXT);
  await dropDisposableDatabase(database.name);
});

async function createLive(conversationId: number, value: object = {}): Promise<DocumentId> {
  const id = await storage.mintId<DocumentId>();
  await storage.commit(
    [
      {
        type: "document.create",
        record: {
          id,
          kind: "pi.live",
          scope: { kind: "conversation", conversationId },
          history: "latest",
          fork: "initial",
        },
        content: { kind: "base", version: 1, value },
      },
    ] as StorageWrite[],
    BACKGROUND_CONTEXT,
  );
  return id;
}

async function damage(id: DocumentId): Promise<void> {
  // The incident's exact shape: {} followed by a late tool output delta.
  const seq = Number(
    (await pool.query("UPDATE durable_metadata SET next_seq=next_seq+1 RETURNING next_seq-1 AS seq")).rows[0].seq,
  );
  await pool.query("INSERT INTO document_revisions(document_id,seq,kind,version,content) VALUES ($1,$3,'delta',1,$2)", [
    id,
    JSON.stringify([["s", ["nestedTools", 0, "output"], "late output"]]),
    seq,
  ]);
}

describe("reconstructable live projection", () => {
  it("rejects an invalid presentation delta atomically instead of poisoning reads", async () => {
    const id = await createLive(100);
    await expect(
      storage.commit(
        [
          {
            type: "document.change",
            id,
            content: { kind: "delta", version: 1, ops: [["s", ["nestedTools", 0, "output"], "late"]] },
          },
        ] as StorageWrite[],
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow();
    expect((await storage.document(id, "current", BACKGROUND_CONTEXT))?.value).toEqual({});
  });

  it("does not change the validation snapshot when an atomic batch is rejected", async () => {
    const first = await createLive(106, { nestedTools: [] });
    const second = await createLive(107);
    await expect(
      storage.commit(
        [
          {
            type: "document.change",
            id: first,
            content: { kind: "delta", version: 1, ops: [["p", ["nestedTools"], 0, 0, [{ output: "ghost" }]]] },
          },
          {
            type: "document.change",
            id: second,
            content: { kind: "delta", version: 1, ops: [["s", ["nestedTools", 0, "output"], "invalid"]] },
          },
        ] as StorageWrite[],
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow();
    await expect(
      storage.commit(
        [
          {
            type: "document.change",
            id: first,
            content: { kind: "delta", version: 1, ops: [["s", ["nestedTools", 0, "output"], "late"]] },
          },
        ] as StorageWrite[],
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow();
    expect((await storage.document(first, "current", BACKGROUND_CONTEXT))?.value).toEqual({ nestedTools: [] });
  });

  it("archives damage and reconstructs an idle projection without changing queued inputs", async () => {
    const id = await createLive(101);
    await pool.query(
      "INSERT INTO submissions(id,conversation_id,request_id,status,record) VALUES (901,101,'queued','queued',$1)",
      [JSON.stringify({ id: 901, conversationId: 101, type: "input", status: "queued", requestId: "queued" })],
    );
    await damage(id);
    await expect(storage.document(id, "current", BACKGROUND_CONTEXT)).rejects.toThrow("nestedTools");
    expect(await storage.repairLiveProjections(101 as never)).toEqual([id]);
    expect((await storage.document(id, "current", BACKGROUND_CONTEXT))?.value).toEqual({});
    expect((await storage.submission(901 as never, BACKGROUND_CONTEXT))?.status).toBe("queued");
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM live_projection_repairs WHERE document_id=$1", [id])).rows[0].n,
    ).toBe(1);
    expect(await storage.repairLiveProjections(101 as never)).toEqual([]);
  });

  it("restores run ownership from the active generation and placed submissions", async () => {
    const id = await createLive(102);
    const task = {
      id: 902,
      conversationId: 102,
      kind: "pi.generation",
      version: 1,
      input: {},
      background: false,
      abortRequested: false,
      state: { status: "pending", checkpoint: { phase: "request", attempt: 2 } },
    };
    await pool.query(
      "INSERT INTO tasks(id,conversation_id,kind,status,abort_requested,background,record) VALUES (902,102,'pi.generation','pending',false,false,$1)",
      [JSON.stringify(task)],
    );
    await pool.query("INSERT INTO submissions(id,conversation_id,status,record) VALUES (903,102,'placed',$1)", [
      JSON.stringify({ id: 903, conversationId: 102, type: "input", status: "placed", entry: 904 }),
    ]);
    await damage(id);
    await storage.repairLiveProjections(102 as never);
    expect((await storage.document(id, "current", BACKGROUND_CONTEXT))?.value).toEqual({
      run: { taskId: 902, inputs: [903] },
      generation: { attempt: 2 },
    });
    expect((await storage.submission(903 as never, BACKGROUND_CONTEXT))?.status).toBe("placed");
  });

  it("does not guess run ownership or discard revisions when placed inputs have no live owner", async () => {
    const id = await createLive(104);
    await pool.query("INSERT INTO submissions(id,conversation_id,status,record) VALUES (905,104,'placed',$1)", [
      JSON.stringify({ id: 905, conversationId: 104, type: "input", status: "placed", entry: 906 }),
    ]);
    await damage(id);
    await expect(storage.repairLiveProjections(104 as never)).rejects.toThrow("run ownership");
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM document_revisions WHERE document_id=$1", [id])).rows[0].n,
    ).toBe(2);
    expect((await storage.submission(905 as never, BACKGROUND_CONTEXT))?.status).toBe("placed");
  });

  it("rebuilds active model and nested tool slots from task checkpoints and assistant entries", async () => {
    const id = await createLive(105);
    const taskRows = [
      {
        id: 907,
        kind: "pi.generation",
        input: {},
        state: {
          status: "waiting",
          checkpoint: { phase: "tools", assistant: 910, tools: [908], pending: [] },
          on: [908],
          policy: "allSettled",
        },
      },
      {
        id: 908,
        kind: "pi.tool",
        owner: 907,
        input: { kind: "model", assistant: 910, callId: "call" },
        state: { status: "running", checkpoint: { phase: "execute", arguments: {}, replay: "unsafe" } },
      },
      {
        id: 909,
        kind: "pi.tool",
        owner: 908,
        input: {
          kind: "nested",
          parent: 908,
          parentCallId: "call",
          key: "c1",
          call: { type: "toolCall", id: "call/c1", name: "bash", arguments: { command: "sleep 30" } },
        },
        state: {
          status: "running",
          checkpoint: { phase: "execute", arguments: { command: "sleep 30" }, replay: "unsafe" },
        },
      },
    ];
    for (const row of taskRows)
      await pool.query(
        "INSERT INTO tasks(id,conversation_id,kind,status,abort_requested,background,record) VALUES ($1,105,$2,$3,false,false,$4)",
        [
          row.id,
          row.kind,
          row.state.status,
          JSON.stringify({ ...row, conversationId: 105, version: 1, background: false, abortRequested: false }),
        ],
      );
    await pool.query(
      "INSERT INTO entries(id,conversation_id,commit_seq,kind,record) VALUES (910,105,1,'pi.assistant',$1)",
      [
        JSON.stringify({
          id: 910,
          conversationId: 105,
          kind: "pi.assistant",
          model: [{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "codemode", arguments: {} }] }],
        }),
      ],
    );
    await damage(id);
    await storage.repairLiveProjections(105 as never);
    const live = (await storage.document(id, "current", BACKGROUND_CONTEXT))!.value;
    expect(live.run).toEqual({ taskId: 907, inputs: [] });
    expect(live.tools).toEqual([{ taskId: 908, callId: "call", name: "codemode", status: "running" }]);
    expect(live.nestedTools).toEqual([
      {
        taskId: 909,
        parentTaskId: 908,
        parentCallId: "call",
        callId: "call/c1",
        name: "bash",
        arguments: { command: "sleep 30" },
        status: "running",
      },
    ]);
  });

  it("fences a stale writer even when its delta could apply to the replacement state", async () => {
    const id = await createLive(103, { generation: { attempt: 1 } });
    await storage.document(id, "current", BACKGROUND_CONTEXT);
    // A competing owner advanced the persisted projection after this owner's read.
    const seq = Number(
      (await pool.query("UPDATE durable_metadata SET next_seq=next_seq+1 RETURNING next_seq-1 AS seq")).rows[0].seq,
    );
    await pool.query(
      "INSERT INTO document_revisions(document_id,seq,kind,version,content) VALUES ($1,$3,'base',1,$2)",
      [id, JSON.stringify({ generation: { attempt: 2 } }), seq],
    );
    await expect(
      storage.commit(
        [
          {
            type: "document.change",
            id,
            content: { kind: "delta", version: 1, ops: [["s", ["generation", "attempt"], 3]] },
          },
        ] as StorageWrite[],
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("stale");
  });
});
